/**
 * 无头截图助手：内置浏览器面板隐藏时无法目视验证，用本机 Chrome/Edge 补齐这条通道。
 *
 * 用法：node tools/shot.mjs <url> <out.png> [--w=1280] [--h=620] [--wait=5000]
 *   --wait 传给 --virtual-time-budget（毫秒虚拟时间），确保 ES module 与
 *   document.fonts.ready 之后才拍；否则会得到字体回落、排版未定的图。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

const bin = CANDIDATES.find(existsSync);
if (!bin) {
  console.error('找不到 Chrome/Edge。设置 CHROME_PATH 指向可执行文件。');
  process.exit(2);
}

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flag = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
if (positional.length < 2) {
  console.error('用法：node tools/shot.mjs <url> <out.png> [--w] [--h] [--wait]');
  process.exit(2);
}
const [url, out] = positional;
const width = flag('w', '1280');
const height = flag('h', '620');
mkdirSync(join(out, '..'), {recursive: true});

// 独立 profile：避免与用户正在运行的浏览器实例抢单例锁。
const profile = join(tmpdir(), 'avg-shot-profile');
const args = [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--no-first-run',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  `--user-data-dir=${profile}`,
  `--virtual-time-budget=${flag('wait', '5000')}`,
  `--window-size=${width},${height}`,
  `--screenshot=${resolve(out)}`,
  url,
];
const stderr = execFileSync(bin, args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
const noise = stderr.split('\n').filter(
    (l) => l && !/installwebapp|DevTools|GPU|dbus|Fontconfig|bluetooth/i.test(l));
console.log(`shot -> ${out} (${width}x${height})`);
if (noise.length) console.log(noise.join('\n'));
