/**
 * M2 markup 自检跑者：起本地同源宿主 → 无头 Chrome 打开 selftest-markup.html
 * → 页面把报告 POST 回 /freeze?scene=markup_report → 读回、断言、清理。
 *
 * 用无头浏览器是因为 reformat 依赖真实 HTML 解析（与参考同一条路），
 * 纯 Node 里没有 DOM，无法等价复现。
 *
 * 用法：node tools/test-markup.mjs [--port=0] [--timeout=120]
 */
import {browserTest} from './lib/run.mjs';

const {code} = await browserTest({
  label: 'M2 markup',
  scene: 'markup_report',
  page: 'selftest-markup.html',
  timeout: 120,
  windowSize: '1400,1000',
  statsOf: (report) => {
    const lines = [`页数 ${report.pages} · 断言 ${report.asserts}`];
    for (const m of (report.skipped ?? [])) lines.push('跳写：' + m);
    return lines;
  },
});
process.exit(code);
