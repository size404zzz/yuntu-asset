/**
 * M2 markup 自检跑者：起本地同源宿主 → 无头 Chrome 打开 selftest-markup.html
 * → 页面把报告 POST 回 /freeze?scene=markup_report → 读回、断言、清理。
 *
 * 用无头浏览器是因为 reformat 依赖真实 HTML 解析（与参考同一条路），
 * 纯 Node 里没有 DOM，无法等价复现。
 *
 * 用法：node tools/test-markup.mjs [--port=8090] [--timeout=120]
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
const PORT = Number(flag('port', '8090'));
const ROOT = resolve(process.cwd());
const OUT = join(ROOT, 'data', 'fixtures', 'expected-markup_report.json');
const CHROME = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean).find(existsSync);

if (!CHROME) { console.error('找不到 Chrome/Edge，设置 CHROME_PATH'); process.exit(2); }
if (existsSync(OUT)) rmSync(OUT);
const PROFILE = join(tmpdir(), 'avg-markup-profile');
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
    if (await fetch(`http://127.0.0.1:${PORT}/data/fixtures/scene2.json`)
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
    `--user-data-dir=${PROFILE}`, '--window-size=1400,1000',
    `http://127.0.0.1:${PORT}/selftest-markup.html`,
  ], {cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit']});
  const deadline = Date.now() + Number(flag('timeout', '120')) * 1000;
  while (Date.now() < deadline) {
    await new Promise((d) => setTimeout(d, 200));
    if (existsSync(OUT) && readFileSync(OUT, 'utf8').includes('"done": true')) break;
    if (chrome.exitCode !== null) { code = 1; break; }
  }
} catch (e) { console.error(String(e)); code = 1; }
finally { chrome?.kill(); server.kill(); }

if (!existsSync(OUT)) { console.error('没拿到自检报告（页面可能抛错）'); process.exit(1); }
const report = JSON.parse(readFileSync(OUT, 'utf8'));
rmSync(OUT);

console.log(`  页数 ${report.pages} · 断言 ${report.asserts}`);
for (const m of (report.skipped ?? [])) console.log('    · 跳写：' + m);
if (report.failureCount) {
  code = 1;
  console.log(`  FAIL ${report.failureCount} 条：`);
  for (const m of report.failures) console.log('    - ' + m);
}
console.log(report.ok ? '\nM2 markup 通过' : '\nM2 markup 未通过');
process.exit(code);
