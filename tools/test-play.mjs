/**
 * M4 播放器自检跑者：起本地同源宿主（serve.py）→ 无头 Chrome 打开
 * selftest-play.html（虚拟钟回放一个夹具，有基准件则对拍、无则冒烟）→ 页面把报告
 * POST 回 /freeze?scene=play_report → 读回、断言、清理。
 *
 * 用法：node tools/test-play.mjs [--port=0] [--timeout=240] [--scene=scene2]
 */
import {browserTest, flag} from './lib/run.mjs';

const SCENE = flag('scene', 'scene2');
const {code} = await browserTest({
  label: 'M4 播放器',
  scene: 'play_report',
  page: `selftest-play.html?scene=${SCENE}`,
  probe: `data/fixtures/${SCENE}.json`,
  timeout: 240,
  statsOf: (report) => [`断言 ${report.asserts} 条，镜头 ${report.shotsObserved} 个`],
});
process.exit(code);
