/**
 * M4 播放器自检跑者：起本地同源宿主（serve.py）→ 无头 Chrome 打开
 * selftest-play.html（虚拟钟回放一个夹具，有基准件则对拍、无则冒烟）→ 页面把报告
 * POST 回 /freeze?scene=play_report → 读回、断言、清理。
 *
 * 用法：node tools/test-play.mjs [--port=8092] [--timeout=240]
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
const PORT = Number(flag('port', '8092'));
const ROOT = resolve(process.cwd());
const SCENE = flag('scene', 'scene2');
const OUT = join(ROOT, 'data', 'fixtures', 'expected-play_report.json');
const CHROME = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean).find(existsSync);

if (!CHROME) { console.error('找不到 Chrome/Edge，设置 CHROME_PATH'); process.exit(2); }
if (existsSync(OUT)) rmSync(OUT);
const PROFILE = join(tmpdir(), 'avg-play-profile');
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
    if (await fetch(`http://127.0.0.1:${PORT}/data/fixtures/${SCENE}.json`)
        .then((r) => r.ok).catch(() => false)) return;
  }
  throw new Error(`宿主 ${PORT} 起不来`);
};

let code = 0;
let chrome;
try {
  await waitPort();
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--hide-scrollbars', '--force-device-scale-factor=1', '--mute-audio',
    `--user-data-dir=${PROFILE}`, '--window-size=1600,1200',
    `http://127.0.0.1:${PORT}/selftest-play.html?scene=${SCENE}`,
  ], {cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit']});
  const deadline = Date.now() + Number(flag('timeout', '240')) * 1000;
  while (Date.now() < deadline) {
    await new Promise((d) => setTimeout(d, 200));
    if (existsSync(OUT) && readFileSync(OUT, 'utf8').includes('"done": true')) break;
    if (chrome.exitCode !== null) { code = 1; break; }
  }
} catch (e) { console.error(String(e)); code = 1; }
finally { chrome?.kill(); server.kill(); }

if (!existsSync(OUT)) { console.error('没拿到自检报告（页面可能抛错或素材缺失）'); process.exit(1); }
const report = JSON.parse(readFileSync(OUT, 'utf8'));
rmSync(OUT);

console.log(`  断言 ${report.asserts} 条，镜头 ${report.shotsObserved} 个`);
if (report.problems?.length) {
  code = 1;
  console.log(`  运行问题 ${report.problems.length} 条：`);
  for (const m of report.problems) console.log('    ! ' + m);
}
if (report.pageErrors?.length) {
  code = 1;
  console.log(`  页面错误 ${report.pageErrors.length} 条：`);
  for (const m of report.pageErrors) console.log('    ! ' + m);
}
if (report.failureCount) {
  code = 1;
  console.log(`  FAIL ${report.failureCount} 条：`);
  for (const m of report.failures) console.log('    - ' + m);
}
console.log(report.ok ? '\nM4 播放器通过' : '\nM4 播放器未通过');
process.exit(code);
