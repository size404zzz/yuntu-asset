/**
 * M10 io 往返回归跑者：exportProject → 导入 → 双路连播快照全等，
 * ZIP bundle 完整性，自动保存。用法：node tools/test-io.mjs [--port=0]
 * （这条链要经 wiki 图片代理拉 UI 素材：默认超时放宽到 560s，慢网下
 * 心跳会实时打出卡点，不再和真卡死不可区分。）
 */
import {browserTest} from './lib/run.mjs';

const {code} = await browserTest({
  label: 'M10 io 往返',
  scene: 'io_report',
  page: 'selftest-io.html',
  timeout: 560,
  windowSize: '1400,1400',
  statsOf: (report) => [`断言 ${report.asserts} · 到达点 ${report.arrivals}`
      + ` · bundle 文件 ${report.bundleFiles}`],
});
process.exit(code);
