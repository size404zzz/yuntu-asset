/**
 * 一键跑参考行为冻结：起本地同源宿主 → 无头 Chrome 跑 oracle → 收结果。
 *
 * 内置浏览器面板处于隐藏态时 rAF 和定时器都会被节流，参考实现又完全靠
 * setTimeout 链驱动，所以只能走本机无头 Chrome 这条通道（和 tools/shot.mjs 同源）。
 *
 * 用法：node tools/ref/freeze.mjs [--scene=scene1] [--max=6] [--port=8081]
 *                                     [--timeout=600] [--keep-server]
 */
import {spawn} from 'node:child_process';
import {createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync} from 'node:fs';
import {createConnection} from 'node:net';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

const flag = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const SCENE = flag('scene', 'scene1');
const PORT = Number(flag('port', '8081'));
const ROOT = resolve(process.cwd());
const OUT = join(ROOT, 'data', 'fixtures', `expected-${SCENE}.json`);
const ORACLE_LOG = join(ROOT, 'tools', 'ref', 'cache', 'oracle.log');
const PROFILE = join(tmpdir(), 'avg-oracle-profile');
const CHROME = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean).find(existsSync);

if (!CHROME) {
  console.error('找不到 Chrome/Edge。设置 CHROME_PATH。');
  process.exit(2);
}
for (const needed of ['harness.html', 'AvgPlayer.js', 'driver.mjs']) {
  if (!existsSync(join(ROOT, 'tools', 'ref', needed))) {
    console.error(`harness 未就绪，先跑 node tools/ref/setup.mjs（缺 ${needed}）`);
    process.exit(2);
  }
}

const startedAt = Date.now();
if (existsSync(OUT)) rmSync(OUT);
rmSync(PROFILE, {recursive: true, force: true});

const server = spawn('python', [join(ROOT, 'tools', 'ref', 'serve.py'), String(PORT)],
    {cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit']});

const waitPort = async () => {
  for (let left = 100; left--; ) {
    await new Promise((done) => {
      const socket = createConnection(PORT, '127.0.0.1');
      socket.on('connect', () => socket.destroy(done));
      socket.on('error', () => setTimeout(done, 60));
    });
    const probe = await fetch(`http://127.0.0.1:${PORT}/data/fixtures/${SCENE}.json`)
        .then((response) => response.ok).catch(() => false);
    if (probe) return;
  }
  throw new Error(`宿主 ${PORT} 起不来`);
};

let code = 0;
let chrome;
try {
  await waitPort();
  const query = new URLSearchParams({scene: SCENE});
  if (flag('max', '')) query.set('max', flag('max'));
  if (flag('trace', '')) query.set('trace', flag('trace'));
  const live = !!flag('live', '');
  if (live) query.set('live', '1');
  chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--mute-audio',
    /* 页面里的 console.info / 未捕获异常是唯一能看出「卡在哪一镜」的通道。 */
    '--enable-logging=stderr',
    /* 固定 profile，开跑前先删：既避免与用户自己的浏览器抢单例锁，
       又不会每轮在 %TEMP% 里留一个几百 MB 的目录。 */
    `--user-data-dir=${PROFILE}`,
    /* headless 的 --window-size 算的是「窗口」，虚拟浏览器 UI 还要吃掉
       24×155，容器又带 max-width:100% —— 窗口给足，舞台才不会被夹到 1176。 */
    `--window-size=${flag('win', '1280,800')}`,
    `http://127.0.0.1:${PORT}/tools/ref/harness.html?${query}`,
  ], {cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe']});
  mkdirSync(join(ROOT, 'tools', 'ref', 'cache'), {recursive: true});
  chrome.stderr.pipe(createWriteStream(ORACLE_LOG));

  const deadline = startedAt + Number(flag('timeout', '600')) * 1000;
  let pending = -1;
  while (Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 500));
    if (existsSync(OUT)) {
      if (live) {
        if (readFileSync(OUT, 'utf8').includes('"done": true')) break;
      } else {
        const size = statSync(OUT).size;
        if (size > 2 && size === pending) break;
        pending = size;
      }
    }
    if (chrome.exitCode !== null) {
      console.error(`无头浏览器提前退出 code=${chrome.exitCode}`);
      code = 1;
      break;
    }
  }
} catch (error) {
  console.error(String(error));
  code = 1;
} finally {
  chrome?.kill();
  if (!flag('keep-server', '')) server.kill();
}

if (!existsSync(OUT)) {
  console.error(`没有拿到 ${OUT}`);
  const tail = (existsSync(ORACLE_LOG)
      ? readFileSync(ORACLE_LOG, 'utf8').trim().split('\n').slice(-12) : [])
      .join('\n');
  console.error(`${ORACLE_LOG} 末尾：\n${tail || '(空)'}`);
  process.exit(1);
}
const freeze = JSON.parse(readFileSync(OUT, 'utf8'));
console.log(`冻结完成 ${OUT}  ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
console.log(`  观测 ${freeze.summary.observed}/${freeze.summary.contentShots} 镜`
    + ` · 舞台 ${freeze.meta.stage.width}×${freeze.meta.stage.height}`
    + ` · 字号 ${freeze.meta.stage.fontSize}`);
if (freeze.problems.length) console.log('  问题：\n   - ' + freeze.problems.join('\n   - '));
if (freeze.pageErrors?.length) {
  console.log('  页面异常：\n   - ' + freeze.pageErrors.slice(0, 8).join('\n   - '));
}
process.exit(code);
