/* utf.mjs —— CRI @UTF 表解析（ACB/ACF/AWB 元数据通用）。
   列标志低 4 位为类型，0x10 位表示该列是常量（默认值内联在 schema 里）。 */

const TYPE_SIZES = {0:1,1:1,2:2,3:2,4:4,5:4,6:8,7:8,8:4,9:8,10:4,11:8,12:16};

export function parseUtf(buf, base = 0) {
  if (buf.toString('latin1', base, base + 4) !== '@UTF') throw new Error(`not @UTF at ${base}`);
  const rowsOff = base + 8 + buf.readUInt32BE(base + 8);
  const stringsOff = base + 8 + buf.readUInt32BE(base + 12);
  const dataOff = base + 8 + buf.readUInt32BE(base + 16);
  const numRows = buf.readUInt16BE(base + 24);
  const rowSize = buf.readUInt16BE(base + 26);

  const str = (off) => {
    const s = stringsOff + off;
    const e = buf.indexOf(0, s);
    return buf.toString('utf8', s, e < 0 ? buf.length : e);
  };
  const value = (pos, type) => {
    switch (type) {
      case 0: return buf.readUInt8(pos);
      case 1: return buf.readInt8(pos);
      case 2: return buf.readUInt16BE(pos);
      case 3: return buf.readInt16BE(pos);
      case 4: return buf.readUInt32BE(pos);
      case 5: return buf.readInt32BE(pos);
      case 6: return Number(buf.readBigUInt64BE(pos));
      case 7: return Number(buf.readBigInt64BE(pos));
      case 8: return buf.readFloatBE(pos);
      case 9: return buf.readDoubleBE(pos);
      case 10: return str(buf.readUInt32BE(pos));
      case 11: return {offset: dataOff + buf.readUInt32BE(pos), length: buf.readUInt32BE(pos + 4)};
      case 12: return buf.subarray(pos, pos + 16);
      default: throw new Error(`bad column type ${type}`);
    }
  };

  /* schema 区：从 base+0x20 到 rowsOff */
  const columns = [];
  let p = base + 0x20;
  while (p < rowsOff) {
    const flags = buf.readUInt8(p); p += 1;
    const name = str(buf.readUInt32BE(p)); p += 4;
    const type = flags & 0x0f;
    const size = TYPE_SIZES[type];
    if (size === undefined) throw new Error(`bad column type ${flags} (${name})`);
    let def = undefined;
    if (flags & 0x10) { def = value(p, type); p += size; }
    columns.push({name, type, flags, def, size});
  }

  const rowCols = columns.filter((c) => c.def === undefined);
  const rows = [];
  for (let r = 0; r < numRows; r++) {
    let rp = rowsOff + r * rowSize;
    const row = {};
    for (const c of columns) row[c.name] = c.def;
    for (const c of rowCols) { row[c.name] = value(rp, c.type); rp += c.size; }
    rows.push(row);
  }
  return {columns, rows, dataOff, base};
}
