/**
 * M8 素材库浏览器回归跑者：serve.py 宿主 + 无头 Chrome 打开
 * selftest-assets.html（IndexedDB 往返 / 上传覆盖 / 标定持久化 / R13），
 * 轮询 assets_report。用法：node tools/test-assets.mjs [--port=8097]
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
const PORT = Number(flag('port', '8097'));
const ROOT = resolve(process.cwd());
const OUT = join(ROOT, 'data', 'fixtures', 'expected-assets_report.json');
const CHROME = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean).find(existsSync);

if (!CHROME) { console.error('找不到 Chrome/Edge'); process.exit(2); }
if (existsSync(OUT)) rmSync(OUT);
const PROFILE = join(tmpdir(), 'avg-assets-profile');
rmSync(PROFILE, {recursive: true, force: true});
rmSync(PROFILE + '-ed', {recursive: true, force: true});

const server = spawn('python', [join(ROOT, 'tools', 'ref', 'serve.py'), String(PORT)],
    {cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit']});
const waitPort = async () => {
  for (let left = 100; left--; ) {
    await new Promise((d) => {
      const s = createConnection(PORT, '127.0.0.1');
      s.on('connect', () => s.destroy(d));
      s.on('error', () => setTimeout(d, 60));
    });
    if (await fetch(`http://127.0.0.1:${PORT}/data/index/backgrounds.json`)
        .then((r) => r.ok).catch(() => false)) return;
  }
  throw new Error(`宿主 ${PORT} 起不来`);
};

let chrome;
const report = await (async () => {
  try {
    await waitPort();
    chrome = spawn(CHROME, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
      '--hide-scrollbars', '--user-data-dir=' + PROFILE,
      `http://127.0.0.1:${PORT}/selftest-assets.html`,
    ], {cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit']});
    const deadline = Date.now() + Number(flag('timeout', '120')) * 1000;
    while (Date.now() < deadline) {
      await new Promise((d) => setTimeout(d, 200));
      if (existsSync(OUT) && readFileSync(OUT, 'utf8').includes('"done": true')) break;
      if (chrome.exitCode !== null) break;
    }
    if (!existsSync(OUT)) { console.error('没拿到报告'); return {ok: false}; }
    const rep = JSON.parse(readFileSync(OUT, 'utf8'));
    rmSync(OUT);
    console.log(`  断言 ${rep.asserts}`);
    for (const m of (rep.failures || [])) console.log('    - ' + m);
    for (const m of (rep.problems || [])) console.log('    ! ' + m);
    if (!rep.ok) return rep;

    /* 编辑器冒烟：boot（含 IDB 注册表）+ 首帧 seek + 顶栏状态行。
       宿主必须还活着——这一段曾在 finally 之后跑，POST 进了死端口。 */
    const SMOKE = join(ROOT, 'data', 'fixtures', 'expected-editor_smoke.json');
    if (existsSync(SMOKE)) rmSync(SMOKE);
    const chrome2 = spawn(CHROME, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
      '--hide-scrollbars', '--mute-audio', '--user-data-dir=' + PROFILE + '-ed',
      `http://127.0.0.1:${PORT}/index.html?smoke=1`,
    ], {cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit']});
    const deadline2 = Date.now() + 60000;
    while (Date.now() < deadline2) {
      await new Promise((d) => setTimeout(d, 200));
      if (existsSync(SMOKE) && readFileSync(SMOKE, 'utf8').includes('"done": true')) break;
    }
    chrome2.kill();
    if (!existsSync(SMOKE)) { console.error('    ! 编辑器冒烟没回报'); rep.ok = false; }
    else {
      const smoke = JSON.parse(readFileSync(SMOKE, 'utf8'));
      rmSync(SMOKE);
      const bad = [];
      if (!smoke.pos.startsWith('#1')) bad.push(`tp-pos=${smoke.pos}`);
      if (!smoke.storage.includes('731')) bad.push(`storage=${smoke.storage}`);
      if (smoke.shots < 50) bad.push(`shots=${smoke.shots}`);
      if (smoke.storylib?.error) bad.push(`剧本库装载：${smoke.storylib.error}`);
      if (smoke.storylib?.id !== 'cpt00_e_01_01') {
        bad.push(`storylib.id=${smoke.storylib?.id ?? '缺席'}`);
      }
      if (smoke.storylib?.shots !== 48) bad.push(`storylib.shots=${smoke.storylib?.shots}`);
      if (!smoke.storylib?.brief?.startsWith('“绿洲”扇区')) {
        bad.push(`storylib.brief=${smoke.storylib?.brief}`);
      }
      if (smoke.storylib?.logCloses !== true) {
        bad.push(`storylib.logCloses=${smoke.storylib?.logCloses}`);
      }
      /* M23 退场建议：按钮接线 + 面板可开（行数随映射结果浮动，不硬断）。 */
      if (smoke.fadeAdvice?.error) bad.push(`退场建议：${smoke.fadeAdvice.error}`);
      if (!smoke.fadeAdvice?.opened) bad.push('退场建议面板没开');
      if (bad.length) { console.log('    - 编辑器冒烟：' + bad.join(' | ')); rep.ok = false; }
      else console.log(`  编辑器冒烟：${smoke.storage} · 剧本库 ${smoke.storylib.id} ${smoke.storylib.shots} 镜 · log 收起 · 退场建议面板 ✓`);
    }
    return rep;
  } catch (e) { console.error(String(e)); return {ok: false}; }
  finally { chrome?.kill(); server.kill(); }
})();
console.log(report.ok ? '\nM8 素材库通过' : '\nM8 素材库未通过');
process.exit(report.ok ? 0 : 1);
