/**
 * M10 io 往返回归跑者：exportProject → 导入 → 双路连播快照全等，
 * ZIP bundle 完整性，自动保存。用法：node tools/test-io.mjs [--port=8099]
 */
import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createConnection} from 'node:net';
import {dirname, join as j2} from 'node:path';
import {readZip, b64decode} from '../js/ui/zip.js';

const flag = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const PORT = Number(flag('port', '8099'));
const ROOT = resolve(process.cwd());
const OUT = join(ROOT, 'data', 'fixtures', 'expected-io_report.json');
const CHROME = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean).find(existsSync);

if (!CHROME) { console.error('找不到 Chrome/Edge'); process.exit(2); }
if (existsSync(OUT)) rmSync(OUT);
const PROFILE = join(tmpdir(), 'avg-io-profile');
const BUNDLE_DIR = join(ROOT, '.yuntu-bundle');
rmSync(PROFILE, {recursive: true, force: true});

const server = spawn('python', [join(ROOT, 'tools', 'ref', 'serve.py'), String(PORT)],
    {cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit']});
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

let chrome;
let code = 0;
try {
  await waitPort();
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--hide-scrollbars', '--mute-audio', `--user-data-dir=${PROFILE}`,
    '--window-size=1400,1400',
    `http://127.0.0.1:${PORT}/selftest-io.html`,
  ], {cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit']});
  const deadline = Date.now() + Number(flag('timeout', '120')) * 1000;
  while (Date.now() < deadline) {
    await new Promise((d) => setTimeout(d, 200));
    if (existsSync(OUT) && readFileSync(OUT, 'utf8').includes('"done": true')) break;
    if (chrome.exitCode !== null) break;
  }
} catch (e) { console.error(String(e)); code = 1; }
finally { chrome?.kill(); server.kill(); }

if (!existsSync(OUT)) { console.error('没拿到报告'); process.exit(1); }
const report = JSON.parse(readFileSync(OUT, 'utf8'));
rmSync(OUT);
console.log(`  断言 ${report.asserts}`);
for (const m of (report.failures || [])) console.log('    - ' + m);
for (const m of (report.problems || [])) console.log('    ! ' + m);
console.log(report.ok ? '\nM10 io 往返通过' : '\nM10 io 往返未通过');
process.exit(report.ok ? 0 : 1);
