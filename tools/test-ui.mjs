/**
 * M6 UI 对拍跑者：读 expected-ui_sceneN.json（uidriver.mjs 在参考包上冻结，
 * 重新生成见文件尾注释）→ 起宿主跑 selftest-ui.html（虚拟钟驱动我们的
 * Player 走同一套交互脚本）→ 逐字段对拍报告。
 *
 * 用法：node tools/test-ui.mjs [--port=8096] [--timeout=420] [--scene=scene1]
 * 重生成冻结件（需 wiki 可达）：
 *   harness.html?scene=scene1&ui=1 / ?scene=scene2&ui=1 用无头 Chrome 真实
 *   时钟跑一遍（不带 --virtual-time-budget，预算模式会扭曲定时器交错）。
 */
import {spawn} from 'node:child_process';
import {existsSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createConnection} from 'node:net';

const flag = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const PORT = Number(flag('port', '8096'));
const ROOT = resolve(process.cwd());
const OUT = join(ROOT, 'data', 'fixtures', 'expected-ui_report.json');
const ONLY = flag('scene', '');
const SCENES = ONLY ? [ONLY] : ['scene1', 'scene2'];
const CHROME = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean).find(existsSync);

if (!CHROME) { console.error('找不到 Chrome/Edge，设置 CHROME_PATH'); process.exit(2); }
for (const s of SCENES) {
  const f = join(ROOT, 'data', 'fixtures', `expected-ui_${s}.json`);
  if (!existsSync(f)) {
    console.error(`缺冻结件 ${f}，先按本文件头注释重生成`);
    process.exit(2);
  }
}
if (existsSync(OUT)) rmSync(OUT);
const PROFILE = join(tmpdir(), 'avg-ui-profile-test');
rmSync(PROFILE, {recursive: true, force: true});

const server = spawn('python', [join(ROOT, 'tools', 'ref', 'serve.py'), String(PORT)],
    {cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit']});
const waitPort = async () => {
  for (let left = 100; left--; ) {
    await new Promise((d) => {
      const s = createConnection(PORT, '127.0.0.1');
      s.on('connect', () => s.destroy(d));
      s.on('error', () => setTimeout(d, 60));
    });
    if (await fetch(`http://127.0.0.1:${PORT}/data/fixtures/scene1.json`)
        .then((r) => r.ok).catch(() => false)) return;
  }
  throw new Error(`宿主 ${PORT} 起不来`);
};

let code = 0;
let totalAsserts = 0;
let totalFailures = 0;
try {
  await waitPort();
  for (const scene of SCENES) {
    const chrome = spawn(CHROME, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
      '--hide-scrollbars', '--force-device-scale-factor=1', '--mute-audio',
      `--user-data-dir=${PROFILE}`, '--window-size=1600,1200',
      `http://127.0.0.1:${PORT}/selftest-ui.html?scene=${scene}`,
    ], {cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit']});
    const deadline = Date.now() + Number(flag('timeout', '420')) * 1000;
    while (Date.now() < deadline) {
      await new Promise((d) => setTimeout(d, 200));
      if (existsSync(OUT) && readFileSync(OUT, 'utf8').includes('"done": true')) break;
      if (chrome.exitCode !== null) break;
    }
    chrome.kill();
    if (!existsSync(OUT)) { console.error(`${scene}: 没拿到报告`); code = 1; break; }
    const report = JSON.parse(readFileSync(OUT, 'utf8'));
    rmSync(OUT);
    totalAsserts += report.asserts;
    totalFailures += report.failureCount;
    console.log(`  ${scene}: 断言 ${report.asserts}，步 ${report.stepsCaptured}`);
    for (const m of (report.failures || [])) console.log('    - ' + m);
    for (const m of (report.problems || [])) console.log('    ! ' + m);
    for (const m of (report.pageErrors || [])) console.log('    ! ' + m);
    if (!report.ok) code = 1;
  }
} catch (e) { console.error(String(e)); code = 1; }
finally { server.kill(); }

console.log(`\n合计 ${totalAsserts} 断言 / ${totalFailures} 失败：`
    + (code === 0 ? 'M6 UI 对拍通过' : 'M6 UI 对拍未通过'));
process.exit(code);
