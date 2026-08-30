/* lvm.js —— AvgCfg/AvgLang 字节码的解释执行（Lua 5.3 语义子集）。
 *
 * 指令集完整实现（46 个 opcode、标准编码，见 lundump.js 头注），但按
 * 「数据脚本」的现实裁剪语义：
 *   - 数值不区分 int/float（JS number 一身二任）；位运算走 BigInt 保 64 位；
 *   - 闭包 upvalue 按值快照（不做 open-upvalue 别名）——语料 3756 文件
 *     零 CLOSURE 指令，纯表构造；census 出现 CLOSURE 时再补别名；
 *   - pairs 用插入序快照键序（5.3 本就未定义序）；
 *   - 无协程/goto（goto 编译为 JMP，天然支持）、无 __call/__lt 等元方法。
 * 崩溃面控制：步数护栏 + 明确的 LuaError 消息，坏文件不静默。
 */

export class LuaError extends Error {}

let tableSeq = 0;

export class LuaTable {
  constructor() {
    this.arr = [];            /* 整数键 1..n（可能有 nil 洞） */
    this.map = new Map();     /* 其余键（数字/字符串），插入序 */
    this.metatable = null;
    this.id = ++tableSeq;
  }

  get(k) {
    if (typeof k === 'number' && Number.isInteger(k)
        && k >= 1 && k <= this.arr.length) return this.arr[k - 1];
    return this.map.has(k) ? this.map.get(k) : null;
  }

  set(k, v) {
    if (typeof k === 'number' && Number.isInteger(k) && k >= 1) {
      if (k <= this.arr.length) { this.arr[k - 1] = v; return; }
      if (k === this.arr.length + 1) {
        if (v === null) { this.map.set(k, v); return; }   /* 头部打洞：留 map 记键 */
        this.arr.push(v);
        /* 连续尾段可能有先前打洞遗留的键，回收进数组。 */
        let next = k + 1;
        while (this.map.has(next) && this.map.get(next) !== null) {
          this.arr.push(this.map.get(next));
          this.map.delete(next);
          next++;
        }
        return;
      }
    }
    this.map.set(k, v);
  }

  /* #t：数组边界的保守取法（尾部 nil 不计）。 */
  length() {
    let n = this.arr.length;
    while (n > 0 && this.arr[n - 1] === null) n--;
    return n;
  }

  * entries() {
    for (let i = 0; i < this.arr.length; i++) {
      if (this.arr[i] !== null) yield [i + 1, this.arr[i]];
    }
    yield* this.map.entries();
  }
}

export class LuaFunction {
  constructor(proto, upvals) {
    this.proto = proto;
    this.upvals = upvals;     /* [{v}] cell 数组 */
  }
}

/* —— 值辅助 —— */

const TYPE = (v) =>
  v === null ? 'nil'
  : typeof v === 'boolean' ? 'boolean'
  : typeof v === 'number' ? 'number'
  : typeof v === 'string' ? 'string'
  : v instanceof LuaTable ? 'table'
  : 'function';

const fmt = new TextEncoder();
const strlen = (s) => fmt.encode(s).length;

function luaToString(v, /* 内部 */ _seen) {
  if (typeof v === 'string') return v;
  if (v === null) return 'nil';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (v instanceof LuaTable) return `table: 0x${v.id.toString(16).padStart(8, '0')}`;
  return `function: 0x${(v.__id ??= ++tableSeq).toString(16).padStart(8, '0')}`;
}

/* 算术的字符串弱转数（Lua 语义：十进制/0x 十六进制，容忍首尾空白）。 */
function toNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (s === '') return null;
  const hex = /^([-+])?0[xX]([0-9a-fA-F]+)$/.exec(s);
  if (hex) return (hex[1] === '-' ? -1 : 1) * parseInt(hex[2], 16);
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return Number(s);
  return null;
}

function where(v) {
  const t = TYPE(v);
  return t === 'table' ? `table 0x${v.id.toString(16)}`
    : t === 'string' ? JSON.stringify(v.length > 24 ? v.slice(0, 24) + '…' : v)
    : t;
}

function arith(kind, a, b) {
  const x = toNumber(a), y = toNumber(b);
  if (x === null || y === null) {
    throw new LuaError(`attempt to perform arithmetic on ${where(x === null ? a : b)} (${kind})`);
  }
  switch (kind) {
    case 'add': return x + y;
    case 'sub': return x - y;
    case 'mul': return x * y;
    case 'div': return x / y;
    case 'idiv': if (y === 0) throw new LuaError('attempt to perform \'n//0\''); return Math.floor(x / y);
    case 'mod': if (y === 0) throw new LuaError('attempt to perform \'n%%0\''); return x - Math.floor(x / y) * y;
    case 'pow': return x ** y;
  }
}

function toInteger(v) {
  const n = toNumber(v);
  return n !== null && Number.isInteger(n) ? BigInt(n) : null;
}

function bitwise(kind, a, b) {
  const x = toInteger(a), y = toInteger(b);
  if (x === null || y === null) {
    throw new LuaError(
      kind === 'bnot' ? `attempt to perform bitwise operation on ${where(a)}`
        : `attempt to perform bitwise operation on ${where(x === null ? a : b)} (${kind})`);
  }
  const N = BigInt.asIntN(64, -1n) + 1n;      /* 2^64 */
  switch (kind) {
    case 'band': return Number(BigInt.asIntN(64, x & y));
    case 'bor': return Number(BigInt.asIntN(64, x | y));
    case 'bxor': return Number(BigInt.asIntN(64, x ^ y));
    case 'bnot': return Number(BigInt.asIntN(64, ~x));
    case 'shl': {
      if (y < 0n) return bitwise('shr', a, -y);
      return y >= 64n ? 0 : Number(BigInt.asIntN(64, x << y));
    }
    case 'shr': {
      if (y < 0n) return bitwise('shl', a, -y);
      return y >= 64n ? 0 : Number(BigInt.asIntN(64, x >> y));
    }
  }
}

function compare(kind, a, b) {
  const num = typeof a === 'number' && typeof b === 'number';
  const str = typeof a === 'string' && typeof b === 'string';
  if (!num && !str) {
    throw new LuaError(`attempt to compare ${where(a)} with ${where(b)} (${kind})`);
  }
  return kind === 'lt' ? a < b : a <= b;
}

function equals(a, b) {
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b && !(a instanceof LuaTable && b instanceof LuaTable)) return false;
  if (typeof a === 'number' || typeof a === 'string' || typeof a === 'boolean') return a === b;
  return a === b;      /* table/function 恒等 */
}

function truthy(v) { return v !== null && v !== false; }

function concat2(a, b) {
  const okA = typeof a === 'string' || typeof a === 'number';
  const okB = typeof b === 'string' || typeof b === 'number';
  if (!okA || !okB) {
    throw new LuaError(`attempt to concatenate ${where(okA ? b : a)}`);
  }
  return (typeof a === 'string' ? a : luaToString(a))
    + (typeof b === 'string' ? b : luaToString(b));
}

/* —— 索引与元方法（只认 __index/__newindex） —— */

function index(obj, key) {
  if (obj instanceof LuaTable) {
    const v = obj.get(key);
    if (v !== null) return v;
    const h = obj.metatable ? obj.metatable.get('__index') : null;
    if (h === null) return null;
    if (h instanceof LuaTable) return index(h, key);
    return callValue(h, [obj, key])[0] ?? null;
  }
  if (typeof obj === 'string') return stringLib.get(key) ?? null;
  throw new LuaError(`attempt to index a ${TYPE(obj)} value (${where(obj)})`);
}

function setIndex(obj, key, v) {
  if (!(obj instanceof LuaTable)) {
    throw new LuaError(`attempt to index a ${TYPE(obj)} value (${where(obj)})`);
  }
  if (obj.get(key) === null && obj.metatable) {
    const h = obj.metatable.get('__newindex');
    if (h instanceof LuaTable) return setIndex(h, key, v);
    if (typeof h === 'function' || h instanceof LuaFunction) {
      callValue(h, [obj, key, v]);
      return;
    }
  }
  if (key === null) throw new LuaError('table index is nil');
  obj.set(key, v);
}

/* —— 标准 library（按需的最小集） —— */

function* keysOf(t) { yield* t.entries(); }

const stringLib = new LuaTable();
stringLib.set('len', (s) => strlen(s));
stringLib.set('sub', (s, i, j) => {
  const chars = [...s];          /* 按 Unicode 码点近似 Lua 字节索引（BMP 等价） */
  const n = chars.length;
  let a = i ?? 1, b = j ?? -1;
  if (a < 0) a += n + 1;
  if (b < 0) b += n + 1;
  a = Math.max(1, a);
  b = Math.min(n, b);
  if (a > b) return '';
  return chars.slice(a - 1, b).join('');
});
stringLib.set('upper', (s) => s.toUpperCase());
stringLib.set('lower', (s) => s.toLowerCase());
stringLib.set('rep', (s, n) => s.repeat(Math.max(0, n | 0)));
stringLib.set('byte', (s, i = 1) => {
  const c = s.charCodeAt(i - 1);
  return Number.isNaN(c) ? null : c;
});
stringLib.set('char', (...cs) => String.fromCharCode(...cs));
stringLib.set('format', (f, ...args) => {
  let i = 0;
  return f.replace(/%%|%[-+ #0]*\d*(?:\.\d+)?[deEfgioxXscq]/g, (m) => {
    if (m === '%%') return '%';
    const v = args[i++];
    const spec = m.slice(1);
    if (spec.endsWith('q')) return JSON.stringify(luaToString(v));
    if (spec.endsWith('s')) return luaToString(v).padStart(parseInt(spec) || 0);
    if (spec.endsWith('d') || spec.endsWith('i')) {
      const n = toNumber(v);
      if (n === null) throw new LuaError(`'${spec}' 期待数字`);
      return String(Math.trunc(n)).padStart(parseInt(spec) || 0);
    }
    if (/^[eEfg]$/.test(spec.slice(-1))) return Number(toNumber(v) ?? 0).toString();
    if (/[oxX]$/.test(spec)) {
      const n = toNumber(v);
      if (n === null) throw new LuaError(`'${spec}' 期待数字`);
      const hex = Math.trunc(n).toString(spec.endsWith('X') ? 16 : 16);
      return spec.endsWith('x') ? hex : hex.toUpperCase();
    }
    return m;
  });
});

const mathLib = new LuaTable();
mathLib.set('floor', (x) => Math.floor(x));
mathLib.set('ceil', (x) => Math.ceil(x));
mathLib.set('abs', (x) => Math.abs(x));
mathLib.set('max', (...xs) => Math.max(...xs));
mathLib.set('min', (...xs) => Math.min(...xs));
mathLib.set('fmod', (x, y) => x % y);
mathLib.set('modf', (x) => [Math.trunc(x), x - Math.trunc(x)]);
mathLib.set('tointeger', (x) => {
  const n = toNumber(x);
  return n !== null && Number.isInteger(n) ? n : null;
});
mathLib.set('type', (x) => {
  const n = toNumber(x);
  if (n === null) return null;
  return Number.isInteger(n) ? 'integer' : 'float';
});
mathLib.set('huge', Infinity);
mathLib.set('pi', Math.PI);
mathLib.set('maxinteger', Number.MAX_SAFE_INTEGER);
mathLib.set('mininteger', Number.MIN_SAFE_INTEGER);

const tableLib = new LuaTable();
tableLib.set('insert', (t, ...a) => {
  if (a.length >= 2) {
    const [pos, v] = a;
    t.arr.splice(pos - 1, 0, v);
  } else t.arr.push(a[0]);
});
tableLib.set('remove', (t, pos) => {
  const n = t.length();
  const p = pos ?? n;
  if (n === 0 && p === 0) return null;
  return t.arr.splice(p - 1, 1)[0] ?? null;
});
tableLib.set('concat', (t, sep = '', i = 1, j = t.length()) => {
  const parts = [];
  for (let k = i; k <= j; k++) parts.push(luaToString(t.get(k)));
  return parts.join(sep);
});

/* 主环境：脚本引用未定义全局返回 nil（Lua 语义），不预炸。 */
export function makeStdEnv() {
  const env = new LuaTable();
  env.set('_G', env);
  env.set('_VERSION', 'Lua 5.3 (yuntu custom dump)');
  env.set('type', (v) => TYPE(v));
  env.set('tostring', (v) => luaToString(v));
  env.set('tonumber', (v, base) => {
    if (base !== undefined && base !== 10) {
      const s = String(v).trim();
      const n = parseInt(s, base);
      return Number.isNaN(n) ? null : n;
    }
    const n = toNumber(v);
    return n;
  });
  env.set('rawget', (t, k) => t.get(k));
  env.set('rawset', (t, k, v) => { t.set(k, v); return t; });
  env.set('rawequal', (a, b) => equals(a, b));
  env.set('rawlen', (t) => typeof t === 'string' ? strlen(t) : t.length());
  env.set('setmetatable', (t, mt) => { t.metatable = mt; return t; });
  env.set('getmetatable', (t) => t.metatable ?? null);
  env.set('assert', (v, msg) => {
    if (!truthy(v)) throw new LuaError(msg !== undefined && msg !== null ? luaToString(msg) : 'assertion failed!');
    return v;
  });
  env.set('error', (msg) => { throw new LuaError(luaToString(msg)); });
  env.set('pcall', (f, ...args) => {
    try { return [true, ...callValue(f, args)]; }
    catch (e) { return [false, e instanceof LuaError ? e.message : String(e)]; }
  });
  env.set('select', (n, ...args) => {
    if (n === '#') return args.length;
    return args.slice(n - 1);
  });
  env.set('ipairs', (t) => {
    const iter = (tbl, i) => {
      const v = tbl.get(i + 1);
      return v === null ? null : [i + 1, v];
    };
    return [iter, t, 0];
  });
  env.set('pairs', (t) => {
    const keys = [...keysOf(t)];         /* 插入序快照 */
    const iter = (_, k) => {
      const i = k === null ? 0 : keys.findIndex(([kk]) => equals(kk, k)) + 1;
      return i < keys.length ? keys[i].slice() : null;
    };
    return [iter, t, null];
  });
  env.set('string', stringLib);
  env.set('math', mathLib);
  env.set('table', tableLib);
  return env;
}

/* —— 执行 —— */

const FPF = 50;                 /* SETLIST 每块字段数 */
const SBX_OFF = 131071;

function callValue(f, args) {
  if (typeof f === 'function') return normalize(f(...args));
  return run(f.proto, f.upvals, args);
}

/* JS 内建返回数组或单值；统一成数组。 */
function normalize(ret) {
  if (Array.isArray(ret)) return ret;
  return ret === undefined ? [] : [ret];
}

function run(proto, upvals, args, opts = {}) {
  const maxSteps = opts.maxSteps ?? 20_000_000;
  const code = proto.code;
  const K = proto.constants;
  const R = new Array(proto.maxStack).fill(null);
  let pc = 0;
  let top = proto.maxStack;     /* 开放表达式（B/C=0）的栈顶 */
  let varargs = proto.isVararg ? args : [];
  let steps = 0;

  const rk = (x) => x < 256 ? R[x] : K[x - 256].value;
  const results = [];

  for (;;) {
    if (++steps > maxSteps) {
      const opNames = ['MOVE', 'LOADK', 'LOADKX', 'LOADBOOL', 'LOADNIL', 'GETUPVAL',
        'GETTABUP', 'GETTABLE', 'SETTABUP', 'SETUPVAL', 'SETTABLE', 'NEWTABLE', 'SELF',
        'ADD', 'SUB', 'MUL', 'MOD', 'POW', 'DIV', 'IDIV', 'BAND', 'BOR', 'BXOR', 'SHL',
        'SHR', 'UNM', 'BNOT', 'NOT', 'LEN', 'CONCAT', 'JMP', 'EQ', 'LT', 'LE', 'TEST',
        'TESTSET', 'CALL', 'TAILCALL', 'RETURN', 'FORLOOP', 'FORPREP', 'TFORCALL',
        'TFORLOOP', 'SETLIST', 'CLOSURE', 'VARARG'];
      throw new LuaError(`步数超限：疑似死循环 pc=${pc - 1}`
          + ` op=${opNames[code[pc - 1] & 0x3F] ?? '?'}`
          + ` line=${proto.lineInfo[pc - 1] ?? '?'}`);
    }
    const ins = code[pc++];
    const op = ins & 0x3F;
    const A = (ins >>> 6) & 0xFF;
    const C = (ins >>> 14) & 0x1FF;
    const B = (ins >>> 23) & 0x1FF;
    const Bx = ins >>> 14;
    const sBx = Bx - SBX_OFF;

    switch (op) {
      case 0: R[A] = R[B]; break;                                    /* MOVE */
      case 1: R[A] = K[Bx].value; break;                             /* LOADK */
      case 2: R[A] = K[(code[pc++] >>> 6) & 0x3FFFFFF].value; break; /* LOADKX */
      case 3:                                                        /* LOADBOOL */
        R[A] = B !== 0;
        if (C !== 0) pc++;
        break;
      case 4:                                                        /* LOADNIL */
        for (let i = 0; i <= B; i++) R[A + i] = null;
        break;
      case 5: R[A] = upvals[B].v; break;                             /* GETUPVAL */
      /* GETTABUP 的 C 也是 RK（cpt_hb_h04 的 C=408→K[152] 验证；
         全语料仅此 1 条 GETTABUP）。 */
      case 6: R[A] = index(upvals[B].v, rk(C)); break;               /* GETTABUP */
      case 7: R[A] = index(R[B], rk(C)); break;                      /* GETTABLE */
      case 8: setIndex(upvals[A].v, K[B].value, rk(C)); break;       /* SETTABUP */
      case 9: upvals[B].v = R[A]; break;                             /* SETUPVAL */
      /* SETTABLE/GETTABLE 的 B/C 是 RK（≥256 取常量池）——本 fork 的改动，
         表构造因此几乎不用 LOADK；寄存器操作数（<256）两种解读等价。 */
      case 10: setIndex(R[A], rk(B), rk(C)); break;                  /* SETTABLE */
      case 11: R[A] = new LuaTable(); break;                         /* NEWTABLE */
      case 12:                                                       /* SELF */
        R[A + 1] = R[B];
        R[A] = index(R[B], rk(C));
        break;
      case 13: R[A] = arith('add', rk(B), rk(C)); break;
      case 14: R[A] = arith('sub', rk(B), rk(C)); break;
      case 15: R[A] = arith('mul', rk(B), rk(C)); break;
      case 16: R[A] = arith('mod', rk(B), rk(C)); break;
      case 17: R[A] = arith('pow', rk(B), rk(C)); break;
      case 18: R[A] = arith('div', rk(B), rk(C)); break;
      case 19: R[A] = arith('idiv', rk(B), rk(C)); break;
      case 20: R[A] = bitwise('band', rk(B), rk(C)); break;
      case 21: R[A] = bitwise('bor', rk(B), rk(C)); break;
      case 22: R[A] = bitwise('bxor', rk(B), rk(C)); break;
      case 23: R[A] = bitwise('shl', rk(B), rk(C)); break;
      case 24: R[A] = bitwise('shr', rk(B), rk(C)); break;
      case 25: {                                                     /* UNM */
        const n = toNumber(R[B]);
        if (n === null) throw new LuaError(`attempt to perform arithmetic on ${where(R[B])} (unm)`);
        R[A] = -n;
        break;
      }
      case 26: R[A] = bitwise('bnot', R[B]); break;                  /* BNOT */
      case 27: R[A] = !truthy(R[B]); break;                          /* NOT */
      case 28:                                                       /* LEN */
        R[A] = typeof R[B] === 'string' ? strlen(R[B]) : R[B].length();
        break;
      case 29: {                                                     /* CONCAT */
        let s = R[B];
        for (let i = B + 1; i <= A; i++) s = concat2(s, R[i]);
        R[A] = s;
        break;
      }
      case 30: pc += sBx; break;                                     /* JMP */
      case 31:                                                       /* EQ */
        if (equals(R[A], rk(B)) !== (C !== 0)) pc++;
        break;
      case 32:                                                       /* LT */
        if (compare('lt', R[A], rk(B)) !== (C !== 0)) pc++;
        break;
      case 33:                                                       /* LE */
        if (compare('le', R[A], rk(B)) !== (C !== 0)) pc++;
        break;
      case 34:                                                       /* TEST */
        if (truthy(R[A]) !== (C !== 0)) pc++;
        break;
      case 35:                                                       /* TESTSET */
        if (truthy(R[B]) === (C !== 0)) R[A] = R[B];
        else pc++;
        break;
      case 36: {                                                     /* CALL */
        const f = R[A];
        const callArgs = B === 0 ? R.slice(A + 1, top) : R.slice(A + 1, A + B);
        const ret = callValue2(f, callArgs, proto, pc, opts);
        if (C === 0) { top = A + ret.length; }
        else {
          for (let i = 0; i < C - 1; i++) R[A + i] = ret[i] ?? null;
        }
        break;
      }
      case 37: {                                                     /* TAILCALL */
        const f = R[A];
        const callArgs = B === 0 ? R.slice(A + 1, top) : R.slice(A + 1, A + B);
        return callValue2(f, callArgs, proto, pc, opts);
      }
      case 38:                                                       /* RETURN */
        results.push(...(B === 0 ? R.slice(A, top) : R.slice(A, A + B - 1)));
        return results;
      case 39: {                                                     /* FORLOOP */
        const idx = R[A] + R[A + 2];
        const limit = R[A + 1];
        if (R[A + 2] > 0 ? idx <= limit : idx >= limit) {
          R[A] = idx;
          R[A + 3] = idx;
          pc += sBx;
        }
        break;
      }
      case 40: {                                                     /* FORPREP */
        const init = toNumber(R[A]), limit = toNumber(R[A + 1]), step = toNumber(R[A + 2]);
        if (init === null || limit === null || step === null) {
          throw new LuaError('\'for\' 初值/终值/步长必须是数字');
        }
        if (step === 0) throw new LuaError('\'for\' step is zero');
        if (step > 0 ? init > limit : init < limit) {
          pc += sBx + 1;             /* 跳过循环：落过 FORLOOP */
          break;
        }
        R[A] = init - step;          /* FORLOOP 先自增 */
        R[A + 3] = init;
        pc += sBx;
        break;
      }
      case 41: {                                                     /* TFORCALL */
        const f = R[A];
        const ret = callValue2(f, [R[A + 1], R[A + 2]], proto, pc, opts);
        for (let i = 0; i < C; i++) R[A + 3 + i] = ret[i] ?? null;
        break;
      }
      case 42:                                                       /* TFORLOOP */
        /* A = base+2（R[A]=控制变量、R[A+1]=迭代器刚吐出的 k），
           与 TFORCALL 的 A=base 错开两格——AvgCfg 语料零循环，
           首次暴露于 configs.ab 的 pairs 循环。 */
        if (R[A + 1] !== null) {
          R[A] = R[A + 1];
          pc += sBx;
        }
        break;
      case 43: {                                                     /* SETLIST */
        const t = R[A];
        if (!(t instanceof LuaTable)) throw new LuaError('SETLIST 目标不是 table');
        const n = B === 0 ? top - A - 1 : B - 1;
        let c = C;
        if (c === 0) c = (code[pc++] >>> 6) & 0x3FFFFFF;   /* 块序号在 extra arg */
        const base = (c - 1) * FPF;
        for (let i = 0; i < n; i++) t.set(base + i + 1, R[A + 1 + i]);
        break;
      }
      case 44: {                                                     /* CLOSURE */
        const p = proto.protos[Bx];
        const uv = p.upvalues.map((u) =>
          u.instack ? {v: R[u.idx]} : upvals[u.idx]);
        R[A] = new LuaFunction(p, uv);
        break;
      }
      case 45: {                                                     /* VARARG */
        const n = B === 0 ? varargs.length : B - 1;
        for (let i = 0; i < n; i++) R[A + i] = varargs[i] ?? null;
        if (B === 0) top = A + n;
        break;
      }
      default:
        throw new LuaError(`未知 opcode ${op} @pc${pc - 1}`);
    }
  }
}

/* 与 callValue 相同，但把「被调不是函数」的错误带到调用方上下文。 */
function callValue2(f, args, callerProto, pc, opts) {
  if (f === null) {
    const line = callerProto.lineInfo[Math.min(pc - 1, callerProto.lineInfo.length - 1)] ?? 0;
    throw new LuaError(`attempt to call a nil value (${callerProto.source ?? '?'}:${line})`);
  }
  if (typeof f === 'function') return normalize(f(...args));
  if (f instanceof LuaFunction) return run(f.proto, f.upvals, args, opts);
  throw new LuaError(`attempt to call a ${TYPE(f)} value`);
}

/* 执行 chunk 主函数，返回结果数组。env 缺省给最小标准库；
   maxSteps 供巨型生成表配置（audio_voice 等）放宽护栏。 */
export function execChunk(proto, {env, maxSteps} = {}) {
  const environment = env ?? makeStdEnv();
  const main = new LuaFunction(proto, [{v: environment}]);
  return run(proto, main.upvals, [], maxSteps ? {maxSteps} : undefined);
}

/* Lua 值 → 纯 JS（JSON 可序列化）。table 若为 1..n 连续序列出数组，
   否则出对象（数字键转字符串）；环引用抛错。 */
export function toJS(v, _seen = new Set(), _path = '$') {
  if (v === null || typeof v !== 'object') return v;
  if (!(v instanceof LuaTable)) throw new Error(`toJS：${_path} 含函数，不可序列化`);
  if (_seen.has(v)) throw new Error(`toJS：${_path} 出现环引用`);
  _seen.add(v);
  const keys = [...v.entries()];
  const isSeq = v.map.size === 0
    && v.arr.every((x) => x !== null)
    && keys.every(([k]) => typeof k === 'number');
  const out = isSeq ? [] : {};
  for (const [k, val] of keys) {
    const key = isSeq ? k - 1 : String(k);
    out[key] = toJS(val, _seen, `${_path}.${k}`);
  }
  _seen.delete(v);
  return out;
}
