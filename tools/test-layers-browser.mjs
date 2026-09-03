/* 五层舞台浏览器冒烟：验证 Player 的动态 parent、缺视频占位、
 * 多背景、effect、ppv、bgColor 和对白仍在同一条 compose 链落地。 */
import {spawn} from 'node:child_process';
import {existsSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createConnection} from 'node:net';

const ROOT = resolve(process.cwd());
const PORT = 8096;
const OUT = join(ROOT, 'data', 'fixtures', 'expected-layers_report.json');
const CHROME = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean).find(existsSync);
if (!CHROME) { console.error('找不到 Chrome/Edge'); process.exit(2); }

rmSync(OUT, {force: true});
const server = spawn('python', [join(ROOT, 'tools', 'ref', 'serve.py'), String(PORT)],
    {cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit']});
const waitPort = async () => {
  for (let left = 100; left--; ) {
    await new Promise((done) => {
      const s = createConnection(PORT, '127.0.0.1');
      s.on('connect', () => s.destroy(done));
      s.on('error', () => setTimeout(done, 60));
    });
    if (await fetch(`http://127.0.0.1:${PORT}/selftest-layers.html`)
        .then((r) => r.ok).catch(() => false)) return;
  }
  throw new Error('宿主起不来');
};

let chrome;
try {
  await waitPort();
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--hide-scrollbars', '--force-device-scale-factor=1', '--mute-audio',
    `--user-data-dir=${join(tmpdir(), 'avg-layers-profile')}`, '--window-size=1600,800',
    `http://127.0.0.1:${PORT}/selftest-layers.html`,
  ], {cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit']});
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    if (existsSync(OUT)) break;
    if (chrome.exitCode !== null) break;
  }
} finally {
  chrome?.kill();
  server.kill();
}
if (!existsSync(OUT)) { console.error('没拿到五层报告'); process.exit(1); }
const report = JSON.parse(readFileSync(OUT, 'utf8'));
rmSync(OUT, {force: true});
if (!report.ok) {
  console.error('五层舞台未通过：' + report.failures.join(', '));
  process.exit(1);
}
console.log('五层舞台浏览器冒烟通过');
