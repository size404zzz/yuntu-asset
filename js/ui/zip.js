/* zip.js —— STORE-only 的极简 ZIP 读写（计划拍板：不引 JSZip，~120 行）。
   我们只打包真文件（png/json/js/html），STORE 无损且免压缩 CPU；
   读侧顺带支持 method 8（走 DecompressionStream），保证能打开
   外部工具压的包。日期字段固定 1980-01-01——导出必须逐字节可复现，
   往返测试比的是全等。 */

const enc = new TextEncoder();
const dec = new TextDecoder();

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 8; k--; ) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u16(v) { return [v & 0xff, (v >>> 8) & 0xff]; }
function u32(v) { return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]; }

/* writeZip([{name, data(Uint8Array|string)}]) → Uint8Array */
export function writeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const data = typeof e.data === 'string' ? enc.encode(e.data) : e.data;
    const crc = crc32(data);
    const head = [
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0x21),                       // 固定时间：可复现
      ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(name.length), ...u16(0),
    ];
    locals.push(Uint8Array.from(head), name, data);
    const cd = [
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0x21),
      ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(name.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(0),
      ...u32(offset),
    ];
    central.push(Uint8Array.from(cd), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const tail = Uint8Array.from([
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(entries.length), ...u16(entries.length),
    ...u32(cdSize), ...u32(offset), ...u16(0),
  ]);
  const all = [...locals, ...central, tail];
  const total = all.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const b of all) { out.set(b, at); at += b.length; }
  return out;
}

/* readZip(ArrayBuffer|Uint8Array) → [{name, data(Uint8Array)}] */
export async function readZip(buf) {
  const z = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let eocd = -1;
  for (let i = z.length - 22; i >= Math.max(0, z.length - 65558); i--) {
    if (z[i] === 0x50 && z[i + 1] === 0x4b && z[i + 2] === 0x05 && z[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是 ZIP（找不到 EOCD）');
  const dv = new DataView(z.buffer, z.byteOffset, z.byteLength);
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('中央目录错位');
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(z.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    const ln = dv.getUint16(local + 26, true);
    const le = dv.getUint16(local + 28, true);
    const start = local + 30 + ln + le;
    const raw = z.subarray(start, start + size);
    out.push({
      name,
      data: method === 0 ? raw : await inflateRaw(raw),
    });
  }
  return out;
}

async function inflateRaw(raw) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([raw]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* base64 ↔ Uint8Array（工程包内联上传件用）。 */
export function b64encode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}
export function b64decode(text) {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
