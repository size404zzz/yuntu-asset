/* lua-disasm.mjs —— 云图自定义 Lua 5.3 字节码的带注反汇编器。
 *
 * 用法：
 *   node tools/lua-disasm.mjs <文件.lua|.dat>...          # 全量反汇编（按 proto 树）
 *   node tools/lua-disasm.mjs <文件> --list               # 只看函数索引（行号/规模/常量摘要）
 *   node tools/lua-disasm.mjs <文件> --key=0.3            # 只看指定函数（编号见 --list）
 *   node tools/lua-disasm.mjs <文件> --find=Dissolve      # 只看反汇编文本含该子串的函数
 *
 * 为什么需要它：`res/luascripts/luascripts.ab`（`--game FakeHeader`）里是游戏
 * 自己的 6402 支逻辑脚本，其中 `Game.Avg.*` 33 支就是剧情播放器的真实现——
 * 此前手上只有 wiki 转写的播放器（AvgPlayer.js）和纯数据剧本，从没读过游戏代码。
 * 这支 dump **未 strip**：行号、局部变量名、常量表都在，反汇编基本能当源码读。
 *
 * 位域与 lvm.js 同源：op=低 6 位、A=8 位、C=9 位、B=9 位，且 SETTABLE/GETTABLE/
 * GETTABUP/比较指令的 B、C 走 RK（≥256 取常量池）——本 fork 的改动，别按官方
 * 5.3 布局抄。
 *
 * AssetStudio `--export_type Raw` 的 TextAsset 前缀
 * `<u32 nameLen><name><补零对齐><u32 dataLen>` 由 stripWrapper 自动跳过。
 */
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {parseChunk} from '../js/core/lundump.js';

const OP = ['MOVE', 'LOADK', 'LOADKX', 'LOADBOOL', 'LOADNIL', 'GETUPVAL', 'GETTABUP',
  'GETTABLE', 'SETTABUP', 'SETUPVAL', 'SETTABLE', 'NEWTABLE', 'SELF', 'ADD', 'SUB',
  'MUL', 'MOD', 'POW', 'DIV', 'IDIV', 'BAND', 'BOR', 'BXOR', 'SHL', 'SHR', 'UNM',
  'BNOT', 'NOT', 'LEN', 'CONCAT', 'JMP', 'EQ', 'LT', 'LE', 'TEST', 'TESTSET', 'CALL',
  'TAILCALL', 'RETURN', 'FORLOOP', 'FORPREP', 'TFORCALL', 'TFORLOOP', 'SETLIST',
  'CLOSURE', 'VARARG'];
const ARITH = {13: '+', 14: '-', 15: '*', 16: '%', 17: '^', 18: '/', 19: '//',
  20: '&', 21: '|', 22: '~', 23: '<<', 24: '>>'};
const CMP = {31: '==', 32: '<', 33: '<='};
const NOT = {31: '~=', 32: '>=', 33: '>'};
const SBX_OFF = 131071;
const MAXRK = 256;

function stripWrapper(b) {
  for (let i = 0; i < 64; i++) {
    if (b[i] === 0x1b && b[i + 1] === 0x4c && b[i + 2] === 0x75 && b[i + 3] === 0x61) {
      return b.subarray(i, i + (i >= 4 ? b.readUInt32LE(i - 4) : b.length - i));
    }
  }
  throw new Error('未找到字节码 magic `\\x1bLua`（不是云图 Lua dump？）');
}

const lit = (c) => c == null ? 'nil'
  : c.type === 'str' ? JSON.stringify(c.value) : String(c.value);

/* RK 操作数：寄存器 or 常量 */
const rk = (x, K) => x < MAXRK ? `r${x}` : lit(K[x - MAXRK]);

/* 每个 pc 上活着的局部变量名（同槽位后声明者覆盖前一位） */
function liveAt(proto) {
  const starts = new Map();
  for (const v of proto.locVars) {
    if (!starts.has(v.startPc)) starts.set(v.startPc, []);
    starts.get(v.startPc).push(v);
  }
  const out = [];
  let live = [];
  for (let pc = 0; pc < proto.code.length; pc++) {
    live = live.filter((v) => v.endPc > pc);
    for (const v of starts.get(pc) ?? []) live.push(v);
    out[pc] = live;
  }
  return out;
}

function disasmFunction(proto, key, lines) {
  const K = proto.constants;
  /* 条件指令后面按惯例紧跟一条 JMP；返回它的落点，读分支就不用手算了。 */
  const jumpTarget = (p) => {
    const ins = proto.code[p];
    if (ins === undefined || (ins & 0x3F) !== 30) return `<非JMP@${p}>`;
    return String(p + 1 + ((ins >>> 14) - SBX_OFF));
  };
  const uvName = (i) => proto.upvalNames[i] ?? `u${i}`;
  const uv = (i) => `U[${uvName(i)}]`;
  const live = liveAt(proto);
  lines.push(`\n; ──── f${key} 行 ${proto.linedefined}..${proto.lastLineDefined}`
      + ` 参数=${proto.numParams}${proto.isVararg ? ' vararg' : ''}`
      + ` 栈=${proto.maxStack} upvals=[${proto.upvalNames.join(', ')}]`);
  const rows = [];
  for (let pc = 0; pc < proto.code.length; pc++) {
    const ins = proto.code[pc];
    const op = ins & 0x3F;
    const A = (ins >>> 6) & 0xFF;
    const C = (ins >>> 14) & 0x1FF;
    const B = (ins >>> 23) & 0x1FF;
    const Bx = ins >>> 14;
    const sBx = Bx - SBX_OFF;
    let t;
    if (ARITH[op]) t = `r${A} = ${rk(B, K)} ${ARITH[op]} ${rk(C, K)}`;
    else switch (op) {
      case 0: t = `r${A} = r${B}`; break;
      case 1: t = `r${A} = ${lit(K[Bx])}`; break;
      case 2: t = `r${A} = ${lit(K[(proto.code[pc + 1] >>> 6) & 0x3FFFFFF])} ;+extra`; break;
      case 3: t = `r${A} = ${B !== 0}${C ? ' ;然后 pc++' : ''}`; break;
      case 4: t = `r${A}${B ? `..r${A + B}` : ''} = nil`; break;
      case 5: t = `r${A} = ${uv(B)}`; break;
      case 6: t = `r${A} = ${uv(B)}[${rk(C, K)}]`; break;
      case 7: t = `r${A} = r${B}[${rk(C, K)}]`; break;
      case 8: t = `${uv(A)}[${rk(B, K)}] = ${rk(C, K)}`; break;  /* 键也按 RK 编码（+256） */
      case 9: t = `${uv(B)} = r${A}`; break;
      case 10: t = `r${A}[${rk(B, K)}] = ${rk(C, K)}`; break;
      case 11: t = `r${A} = {}  ;预分配 数组${B}/哈希${C}`; break;
      case 12: t = `r${A + 1} = r${B} ｜ r${A} = r${B}[${rk(C, K)}]  ;SELF`; break;
      case 25: t = `r${A} = -r${B}`; break;
      case 26: t = `r${A} = ~r${B}`; break;
      case 27: t = `r${A} = not r${B}`; break;
      case 28: t = `r${A} = #r${B}`; break;
      case 29: t = `r${A} = concat r${B}..r${C}`; break;
      case 30: t = `goto ${pc + 1 + sBx}`; break;
      case 31: case 32: case 33:
        /* 实测（AvgImgTweenUntil 行 17/53 与指令十六进制对拍）：比较指令的 A 是取反
           标志而不是寄存器号，操作数是 rk(B) 与 rk(C)：
             if (rk(B) CMP rk(C)) != A then pc++     -- pc++ 跳过紧跟的 JMP = 落到 then
           所以 A=1 时读作反比较（~= / >= / >）。 */
        t = `if ${rk(B, K)} ${A ? NOT[op] : CMP[op]} ${rk(C, K)}`
            + ` 则落到 ${pc + 2}，否则 goto ${jumpTarget(pc + 1)}`;
        break;
      case 34: t = `if ${C ? 'not ' : ''}r${A}`
          + ` 则落到 ${pc + 2}，否则 goto ${jumpTarget(pc + 1)}`; break;
      case 35: t = `if r${B}${C ? ' not' : ''} truthy then r${A} = r${B} else pc++`; break;
      case 36: t = `${C === 1 ? '' : C === 0 ? `r${A}..top = ` : `r${A}${C > 2 ? `..r${A + C - 2}` : ''} = `}`
          + `r${A}(${B === 0 ? `r${A + 1}..top` : B > 1 ? `r${A + 1}..r${A + B - 1}` : ''})`; break;
      case 37: t = `return r${A}(${B === 0 ? '...' : B > 1 ? `r${A + 1}..r${A + B - 1}` : ''}) ;tailcall`; break;
      case 38: t = `return${B === 1 ? '' : B === 0 ? ` r${A}..top` : ` r${A}..r${A + B - 2}`}`; break;
      case 39: t = `r${A} += step; if 未越界 then r${A + 3} = r${A}; pc += sBx`
          + `  ;for i=r${A}..r${A + 3} 数值循环`; break;
      case 40: t = `for 预备 r${A}..r${A + 3}（空则跳过循环体）`; break;
      case 41: t = `r${A + 3}..(+${C}) = r${A}(r${A + 1}, r${A + 2})`
          + '  ;通用 for 一次迭代'; break;
      case 42: t = `if r${A + 1} ~= nil then r${A} = r${A + 1}; pc += sBx`
          + '  ;通用 for 回边'; break;
      case 43: t = `r${A}[...] = {r${A + 1}..${B === 0 ? 'top' : `r${A + B - 1}`}} ;SETLIST 块${C}`; break;
      case 44: t = `r${A} = function <f${key}.${Bx}>`; break;
      case 45: t = `r${A}.. = vararg${B ? ` (${B - 1})` : ''}`; break;
      default: t = `?op${op} A=${A} B=${B} C=${C} Bx=${Bx} sBx=${sBx}`;
    }
    let target = '';
    if (op === 39 || op === 40 || op === 42) target = ` ;→${pc + 1 + sBx}`;
    const names = (live[pc] ?? []).slice(0, 12)
        .map((v) => v.name).filter((n) => n && n !== '(for control)');
    rows.push(`${String(pc).padStart(4)} L${String(proto.lineInfo[pc] ?? 0).padStart(4)}`
        + `  ${(OP[op] ?? `OP${op}`).padEnd(9)} ${t.padEnd(52)}`
        + `${(names.length ? `; ${names.join(' ')}` : '')}${target}`);
  }
  lines.push(...rows);
}

function collect(proto, path, out) {
  out.push({proto, key: path.join('.')});
  proto.protos.forEach((p, i) => collect(p, [...path, i], out));
  return out;
}

const args = process.argv.slice(2);
const flag = (n) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const files = args.filter((a) => !a.startsWith('--'));
const wantKey = flag('key');
const wantFind = flag('find');
const listOnly = args.includes('--list');

if (!files.length) {
  console.error('用法：node tools/lua-disasm.mjs <文件.lua|.dat>... [--list|--key=0.3|--find=子串]');
  process.exit(2);
}

for (const f of files) {
  const main = parseChunk(stripWrapper(readFileSync(resolve(f))));
  const all = collect(main, [], []);
  if (listOnly) {
    console.log(`\n===== ${f}  (${all.length} 个函数)`);
    for (const {proto, key} of all) {
      const strs = proto.constants.filter((c) => c.type === 'str').map((c) => c.value);
      console.log(`  f${key.padEnd(8)} code=${String(proto.code.length).padStart(5)}`
          + ` 行 ${String(proto.linedefined).padStart(5)}-${String(proto.lastLineDefined).padStart(5)}`
          + ` 参=${proto.numParams} 栈=${String(proto.maxStack).padStart(2)}`
          + ` up=[${proto.upvalNames.join(',')}]. K[${strs.slice(0, 3).join('/')}]`);
    }
    continue;
  }
  console.log(`\n############## ${f}`);
  for (const {proto, key} of all) {
    if (wantKey && key !== wantKey) continue;
    const lines = [];
    disasmFunction(proto, key, lines);
    if (wantFind && !lines.join('\n').includes(wantFind)) continue;
    console.log(lines.join('\n'));
  }
}
