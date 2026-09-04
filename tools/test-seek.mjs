/**
 * M5 seek 自检跑者：起本地同源宿主（serve.py）→ 无头 Chrome 打开
 * selftest-seek.html（A 路逐点击驱动 vs B 路 seekShot 重放，逐字节对拍）
 * → 页面把报告 POST 回 /freeze?scene=seek_report → 读回、断言、清理。
 *
 * 用法：node tools/test-seek.mjs [--port=0] [--timeout=300] [--scene=scene2]
 *        [--speed=8] [--out=path]
 * （--scene 只跑一个夹具，约 1/2 时长。--speed=N 把 CSS 过渡 N 倍速：
 *   harness 泵 playbackRate + settle 真实等待等比缩短，A/B 同倍率对拍
 *   等价；等价性由 --speed=1 对照轮的报告逐字节对拍背书。--out 把报告
 *   落到指定路径，供加速/不加速两轮对照。）
 */
import {writeFileSync} from 'node:fs';
import {browserTest, flag} from './lib/run.mjs';

const SCENE = flag('scene', '');
const SPEED = Number(flag('speed', '8'));
const query = new URLSearchParams();
if (SCENE) query.set('scene', SCENE);
if (SPEED !== 1) query.set('speed', String(SPEED));
const qs = query.toString();

const {code, report} = await browserTest({
  label: 'M5 seek',
  scene: 'seek_report',
  page: 'selftest-seek.html' + (qs ? `?${qs}` : ''),
  /* speed=1 时全量两场景约 4-5 分钟；提速轮的真实等待缩到 1/N。 */
  timeout: SPEED === 1 ? 900 : 300,
  statsOf: (rep) =>
      [`断言 ${rep.asserts} 条，对拍 ${rep.pairs} 个到达点（speed=${SPEED}）`],
});

const out = flag('out', '');
if (out && report) writeFileSync(out, JSON.stringify(report, null, 1));
process.exit(code);
