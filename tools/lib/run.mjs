/* run.mjs —— 浏览器型回归跑者的公共库（跑者侧对应页面侧的 js/test/report.js）。
 *
 * 收口四段曾复制十来份的样板：
 * 1. Chrome/Edge 探测；2. serve.py 宿主（默认临时端口，支持并发多套宿主）；
 * 3. 冻结报告轮询——等 done:true，途中记录页面心跳 {done:false, step}，
 *    超时诊断打印「卡在哪一步」而不是哑超时；4. 统一的报告结论打印。
 *
 * 页面侧约定：selftest 页长链路里 post 心跳，结束时发整份报告；
 * 报告字段口径：ok / asserts / failureCount / failures / problems / pageErrors。
 */
import {spawn} from 'node:child_process';
import {existsSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createConnection} from 'node:net';

export const ROOT = resolve(process.cwd());
export const FIXTURES = join(ROOT, 'data', 'fixtures');

export const flag = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const CHROME_CANDIDATES = () => [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

export function findChrome() {
  const bin = CHROME_CANDIDATES().find(existsSync);
  if (!bin) {
    console.error('找不到 Chrome/Edge，设置 CHROME_PATH 指向可执行文件');
    process.exit(2);
  }
  return bin;
}

/* 每轮独立 profile：避免与用户浏览器抢单例锁，也让多跑者并发互不串台。 */
export function freshProfile(name) {
  const profile = join(tmpdir(), `avg-${name}-profile`);
  rmSync(profile, {recursive: true, force: true});
  return profile;
}

/* 起宿主：port 缺省 0（由内核分配），从 serve.py 的横幅解析实际端口。
   stderr 不再 inherit（/images/ 代理日志刷屏），留 tail 供失败时打印。 */
export async function startHost({
  port = 0,
  probe = 'data/fixtures/scene2.json',
  quiet = true,
} = {}) {
  const child = spawn('python', [join(ROOT, 'tools', 'ref', 'serve.py'), String(port)],
      {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
  const tail = [];
  const collect = (chunk) => {
    tail.push(String(chunk));
    if (tail.length > 20) tail.shift();
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  let realPort = null;
  const banner = /reference oracle on http:\/\/127\.0\.0\.1:(\d+)\//;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const hit = tail.find((line) => banner.test(line));
    if (hit) realPort = Number(banner.exec(hit)[1]);
    if (realPort !== null && await fetch(`http://127.0.0.1:${realPort}/${probe}`)
        .then((r) => r.ok).catch(() => false)) {
      return {
        port: realPort,
        kill: () => child.kill(),
        dump: () => { if (!quiet) console.log(tail.join('')); },
      };
    }
    await new Promise((d) => setTimeout(d, 60));
  }
  child.kill();
  throw new Error(`宿主起不来（port=${port}）：\n${tail.join('')}`);
}

/* 无头 Chrome 开一轮页面。返回子进程，供轮询时判提前退出。 */
export function launchPage({
  chrome, port, page, profile,
  windowSize = '1600,1200', extraFlags = [],
}) {
  return spawn(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--hide-scrollbars', '--force-device-scale-factor=1', '--mute-audio',
    ...extraFlags, `--user-data-dir=${profile}`, `--window-size=${windowSize}`,
    `http://127.0.0.1:${port}/${page}`,
  ], {cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit']});
}

/* 轮询冻结报告直到 done:true。页面心跳（done:false 的中间快照）随到随记、
   变步时打到一行；超时抛出的错误带最后心跳与 Chrome 退出态——
   「慢」和「卡死」从此可区分。返回解析后的报告并清掉冻结文件。 */
export async function waitForReport({
  out, timeoutS, chrome = null, step = '等待报告',
} = {}) {
  rmSync(out, {force: true});
  const deadline = Date.now() + timeoutS * 1000;
  let lastStep = null;
  while (Date.now() < deadline) {
    await new Promise((d) => setTimeout(d, 200));
    if (existsSync(out)) {
      let parsed = null;
      try { parsed = JSON.parse(readFileSync(out, 'utf8')); } catch { /* 写一半 */ }
      if (parsed?.done === true) {
        rmSync(out, {force: true});
        return parsed;
      }
      if (parsed?.step && parsed.step !== lastStep) {
        lastStep = parsed.step;
        console.log(`    … ${step}: ${lastStep}`);
      }
    }
    if (chrome?.exitCode !== null && chrome?.exitCode !== undefined) {
      throw new Error(`页面进程提前退出（code=${chrome.exitCode}）`
          + (lastStep ? `，最后心跳：${lastStep}` : ''));
    }
  }
  throw new Error(`等 ${out} 超时（${timeoutS}s），`
      + (lastStep ? `最后心跳：${lastStep}` : '页面没发过心跳（可能还没跑到第一个 step）'));
}

/* 统一结论打印：统计行 + 运行问题/页面错误/失败清单 + 通过与否。
   返回退出码。statsOf(report) 由跑者提供自己的统计行（可选）。 */
export function printOutcome(report, {okLine, statsOf = null} = {}) {
  let code = 0;
  if (statsOf) {
    for (const line of statsOf(report)) console.log('  ' + line);
  }
  for (const [title, items] of [
    ['运行问题', report.problems ?? []],
    ['页面错误', report.pageErrors ?? []],
    ['FAIL', report.failures ?? []],
  ]) {
    if (!items.length) continue;
    code = 1;
    console.log(`  ${title} ${items.length} 条：`);
    for (const m of items) console.log(`    ${title === 'FAIL' ? '-' : '!'} ` + m);
  }
  if (report.ok === false && code === 0) code = 1;
  console.log(report.ok ? `\n${okLine}通过` : `\n${okLine}未通过`);
  return code;
}

/* 一段式浏览器回归（适合「开一轮页面 → 等报告 → 判定」的跑者）。
   statsOf(report) → 额外统计行；after(report, host) 在宿主仍活着时跑
   跑者专属的后续阶段（如 test-assets 的编辑器冒烟），可改 report。
   返回 {code, report}（report 供跑者追加落盘/对照，如 seek 的 --out）；
   宿主/浏览器的清理由本函数兜底。 */
export async function browserTest({
  label, scene, page, timeout = 240, windowSize, extraFlags = [], probe,
  statsOf = null, after = null,
}) {
  const out = join(FIXTURES, `expected-${scene}.json`);
  const chrome = findChrome();
  const host = await startHost({probe, port: Number(flag('port', '0'))});
  let code = 1;
  let report = null;
  try {
    const child = launchPage({chrome, port: host.port, page,
      profile: freshProfile(scene.replace(/_report$/, '')),
      windowSize, extraFlags});
    report = await waitForReport({out, timeoutS: flag('timeout', String(timeout)),
      chrome: child, step: label});
    if (after) await after(report, host, chrome);
    code = printOutcome(report, {okLine: label, statsOf});
  } catch (e) {
    console.error(String(e.message ?? e));
  } finally {
    host.kill();
  }
  return {code, report};
}
