/* lundump.js —— 云图 AvgCfg/AvgLang 的 Lua 5.3 字节码解析器（lundump 对应物）。
 *
 * 游戏用的不是官方 luac 输出，而是一支自定义 dump（M13 逐字节破解，语料
 * 3756 文件全量 EOF 对齐验证）：
 *   - 头部 32 字节：magic `\x1bLua` + version 0x53 + format 0x01 +
 *     LUAC_DATA(6) + **四个**尺寸字节（Instruction=4 / DumpInt=4 /
 *     lua_Number=8 / lua_Integer=8，官方 5.3 只有三个）+
 *     LUAC_INT 0x5678(8B) + LUAC_NUM 370.5(8B)；
 *   - 头后多一个顶层字节：主闭包 upvalue 数（官方 5.3 没有，5.4 才有）；
 *   - 字符串长度 = len+1，通常 1 字节；**255 是转义符**，后跟 4 字节 LE
 *     的 len+1（长台词用，214 个文件命中）——官方是 4 字节裸 size_t；
 *   - 指令编码、常量标签、upvalue(2B)、debug 区与官方 5.3 一致，
 *     opcode 无洗牌，但 SETTABLE/GETTABLE/GETTABUP 的操作数改用 RK
 *     编码（见 lvm.js）。
 *
 * 本模块只还原结构（Proto 树）；执行在 lvm.js，互不 import。
 */

const LUAC_HDR_ERR = '不是云图 Lua 字节码';
const UTF8 = new TextDecoder();

/* 只依赖 DataView/TextDecoder：同一份代码跑 Node（readFileSync 的 Buffer
   也是 Uint8Array）与浏览器（fetch arrayBuffer），没有 Node 专属 API。 */
class Reader {
  constructor(bytes) {
    this.b = bytes;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.o = 0;
  }

  byte() { return this.dv.getUint8(this.o++); }

  int() { const v = this.dv.getUint32(this.o, true); this.o += 4; return v; }

  /* lua_Integer 常量：8 字节；语料里都是小整数，Number 足够（<2^53）。 */
  integer() { const v = this.dv.getBigInt64(this.o, true); this.o += 8; return Number(v); }

  float() { const v = this.dv.getFloat64(this.o, true); this.o += 8; return v; }

  string() {
    let n = this.byte();
    if (n === 0) return null;
    /* 长度 = len+1：单字节 1..254；255 是转义符，后跟 4 字节 LE 的 len+1
       （22child_02 等 214 个含长台词的文件验证）。 */
    if (n === 255) { n = this.dv.getUint32(this.o, true); this.o += 4; }
    const s = UTF8.decode(this.b.subarray(this.o, this.o + n - 1));
    this.o += n - 1;
    return s;
  }
}

function readFunction(r, depth) {
  if (depth > 200) throw new Error(`${LUAC_HDR_ERR}：proto 嵌套过深`);
  const source = r.string();
  const linedefined = r.int();
  const lastLineDefined = r.int();
  const numParams = r.byte();
  const isVararg = r.byte();
  const maxStack = r.byte();

  const code = new Uint32Array(r.int());
  for (let i = 0; i < code.length; i++, r.o += 4) code[i] = r.dv.getUint32(r.o, true);

  const constants = new Array(r.int());
  for (let i = 0; i < constants.length; i++) {
    const tag = r.byte();
    switch (tag) {
      case 0x00: constants[i] = {type: 'nil', value: null}; break;
      case 0x01: constants[i] = {type: 'bool', value: r.byte() !== 0}; break;
      case 0x03: constants[i] = {type: 'float', value: r.float()}; break;
      case 0x13: constants[i] = {type: 'int', value: r.integer()}; break;
      case 0x04:
      case 0x14: constants[i] = {type: 'str', value: r.string()}; break;
      default:
        throw new Error(`${LUAC_HDR_ERR}：未知常量标签 0x${tag.toString(16)} @${r.o - 1}`);
    }
  }

  const upvalues = new Array(r.int());
  for (let i = 0; i < upvalues.length; i++) {
    const instack = r.byte();
    if (instack > 1) {
      throw new Error(`${LUAC_HDR_ERR}：upvalue instack=${instack} @${r.o - 1}`);
    }
    upvalues[i] = {instack, idx: r.byte()};
  }

  const protos = new Array(r.int());
  for (let i = 0; i < protos.length; i++) protos[i] = readFunction(r, depth + 1);

  const lineInfo = new Uint32Array(r.int());
  for (let i = 0; i < lineInfo.length; i++, r.o += 4) lineInfo[i] = r.dv.getUint32(r.o, true);

  const locVars = new Array(r.int());
  for (let i = 0; i < locVars.length; i++) {
    locVars[i] = {name: r.string(), startPc: r.int(), endPc: r.int()};
  }

  const upvalNames = new Array(r.int());
  for (let i = 0; i < upvalNames.length; i++) upvalNames[i] = r.string();

  return {source, linedefined, lastLineDefined, numParams, isVararg, maxStack,
    code, constants, upvalues, protos, lineInfo, locVars, upvalNames};
}

/* 解析整个 chunk，返回主 Proto。bytes: Uint8Array / Buffer。 */
export function parseChunk(bytes) {
  const r = new Reader(bytes);
  const sig = [0x1b, 0x4c, 0x75, 0x61];
  for (let i = 0; i < 4; i++) {
    if (r.byte() !== sig[i]) throw new Error(`${LUAC_HDR_ERR}：magic 不符`);
  }
  if (r.byte() !== 0x53) throw new Error(`${LUAC_HDR_ERR}：版本非 5.3`);
  if (r.byte() !== 0x01) throw new Error(`${LUAC_HDR_ERR}：format 非 0x01`);
  const data = [0x19, 0x93, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 6; i++) {
    if (r.byte() !== data[i]) throw new Error(`${LUAC_HDR_ERR}：LUAC_DATA 不符`);
  }
  for (const want of [4, 4, 8, 8]) {
    if (r.byte() !== want) throw new Error(`${LUAC_HDR_ERR}：尺寸字节非 ${want}`);
  }
  if (r.integer() !== 0x5678) throw new Error(`${LUAC_HDR_ERR}：LUAC_INT 不符`);
  if (r.float() !== 370.5) throw new Error(`${LUAC_HDR_ERR}：LUAC_NUM 不符`);
  const nupvals = r.byte();
  if (nupvals !== 1) throw new Error(`${LUAC_HDR_ERR}：顶层 upvalue 数 ${nupvals} ≠ 1`);

  const proto = readFunction(r, 0);
  if (r.o !== bytes.length) {
    throw new Error(`${LUAC_HDR_ERR}：解析结束残留 ${bytes.length - r.o} 字节 @${r.o}`);
  }
  return proto;
}
