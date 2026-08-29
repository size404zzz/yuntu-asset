/**
 * zip.js 纯 Node 单测：CRC32 已知值、STORE 往返字节全等、多文件目录、
 * 中文文件名、b64 往返。用法：node tools/test-zip.mjs
 */
import assert from 'node:assert/strict';
import {writeZip, readZip, b64encode, b64decode} from '../js/ui/zip.js';

let passed = 0;
const ok = (m) => { passed++; console.log('  ok   ' + m); };

/* CRC32("123456789") = 0xCBF43926 —— 借 writeZip→readZip 的完整性隐含校验：
   读回 data 一致 + 我们自查 crc 字段。 */
{
  const data = new TextEncoder().encode('123456789');
  const zip = writeZip([{name: 'a.txt', data}]);
  // 本地头 crc 字段在 offset 14..18
  const crc = zip[14] | zip[15] << 8 | zip[16] << 16 | zip[17] << 24;
  assert.equal(crc >>> 0, 0xcbf43926);
  ok('CRC32 已知值 0xCBF43926');
}

{
  const entries = [
    {name: 'play.html', data: '<html>ok</html>'},
    {name: 'assets/背景 一号.png', data: new Uint8Array([1, 2, 3, 255, 0])},
    {name: 'js/deep/nested/mod.js', data: new Uint8Array(1000).fill(7)},
  ];
  const zip = writeZip(entries);
  const out = await readZip(zip);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((e) => e.name), entries.map((e) => e.name));
  assert.equal(new TextDecoder().decode(out[0].data), '<html>ok</html>');
  assert.deepEqual([...out[1].data], [1, 2, 3, 255, 0]);
  assert.deepEqual([...out[2].data], [...new Uint8Array(1000).fill(7)]);
  ok('STORE 往返：3 文件（中文/嵌套/1KB）字节全等');
}

/* 可复现性：同输入两次 writeZip 逐字节相等（固定 DOS 日期生效） */
{
  const e = [{name: 'x', data: 'y'}];
  assert.deepEqual([...writeZip(e)], [...writeZip(e)]);
  ok('导出可复现：两次 writeZip 逐字节相等');
}

{
  const bytes = new Uint8Array(Array.from({length: 70000}, (_, i) => i % 256));
  assert.deepEqual([...b64decode(b64encode(bytes))], [...bytes]);
  ok('b64 往返（70KB 跨块）');
}

console.log(`\n${passed} 项通过`);
