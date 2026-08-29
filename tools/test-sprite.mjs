/**
 * M3 立绘自检跑者：起本地同源宿主（serve.py，/res/ 与 /data/ 同源，
 * canvas getImageData 不污染）→ 无头 Chrome 打开 selftest-sprite.html
 * → 页面把报告 POST 回 /freeze?scene=sprite_report → 读回、断言、清理。
 *
 * 用法：node tools/test-sprite.mjs [--port=8091] [--timeout=180]
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
const PORT = Number(flag('port', '8091'));
const ROOT = resolve(process.cwd());
const OUT = join(ROOT, 'data', 'fixtures', 'expected-sprite_report.json');
const CHROME = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean).find(existsSync);

if (!CHROME) { console.error('找不到 Chrome/Edge，设置 CHROME_PATH'); process.exit(2); }
if (existsSync(OUT)) rmSync(OUT);
const PROFILE = join(tmpdir(), 'avg-sprite-profile');
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
    if (await fetch(`http://127.0.0.1:${PORT}/data/layouts/sol_avg.json`)
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
    `http://127.0.0.1:${PORT}/selftest-sprite.html`,
  ], {cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit']});
  const deadline = Date.now() + Number(flag('timeout', '180')) * 1000;
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

console.log(`  断言 ${report.asserts} 条`);
if (report.feet?.length) {
  const ys = report.feet.map((f) => f.y);
  console.log(`  脚位(pos3) ${report.feet.map((f) => `${f.name}=${f.y.toFixed(1)}px`).join(' ')}`
      + ` 极差 ${(Math.max(...ys) - Math.min(...ys)).toFixed(1)}px`);
}
if (report.derived?.length) {
  console.log(`  deriveLayout 偏差 ${report.derived.map((d) =>
    `${d.name}=${(d.err * 100).toFixed(2)}%`).join(' ')}`);
}
if (report.failureCount) {
  code = 1;
  console.log(`  FAIL ${report.failureCount} 条：`);
  for (const m of report.failures) console.log('    - ' + m);
}
console.log(report.ok ? '\nM3 立绘通过' : '\nM3 立绘未通过');
process.exit(code);
