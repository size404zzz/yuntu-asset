/**
 * M9 编辑器回归跑者：真实时钟（过渡起值属渲染器时间线，虚拟钟/预算模式
 * 都测不了它）。用法：node tools/test-editor.mjs [--port=0] [--timeout=240]
 */
import {browserTest} from './lib/run.mjs';

const {code} = await browserTest({
  label: 'M9 编辑器回归',
  scene: 'editor_report',
  page: 'selftest-editor.html',
  timeout: 240,
  windowSize: '1400,1400',
  statsOf: (report) => [`断言 ${report.asserts}`],
});
process.exit(code);
