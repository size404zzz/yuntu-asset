/**
 * M3 立绘自检跑者：起本地同源宿主（serve.py，/res/ 与 /data/ 同源，
 * canvas getImageData 不污染）→ 无头 Chrome 打开 selftest-sprite.html
 * → 页面把报告 POST 回 /freeze?scene=sprite_report → 读回、断言、清理。
 *
 * 用法：node tools/test-sprite.mjs [--port=0] [--timeout=180]
 */
import {browserTest} from './lib/run.mjs';

const {code} = await browserTest({
  label: 'M3 立绘',
  scene: 'sprite_report',
  page: 'selftest-sprite.html',
  probe: 'data/layouts/sol_avg.json',
  timeout: 180,
  statsOf: (report) => {
    const lines = [`断言 ${report.asserts} 条`];
    if (report.feet?.length) {
      const ys = report.feet.map((f) => f.y);
      lines.push(`脚位(pos3) ${report.feet.map((f) => `${f.name}=${f.y.toFixed(1)}px`).join(' ')}`
          + ` 极差 ${(Math.max(...ys) - Math.min(...ys)).toFixed(1)}px`);
    }
    if (report.derived?.length) {
      lines.push(`deriveLayout 偏差 ${report.derived.map((d) =>
          `${d.name}=${(d.err * 100).toFixed(2)}%`).join(' ')}`);
    }
    return lines;
  },
});
process.exit(code);
