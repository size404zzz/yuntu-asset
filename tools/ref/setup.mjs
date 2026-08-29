/**
 * 组装参考实现离线 harness：把抓取件里的参考三件套原样落到 tools/ref/，
 * 只改「独立页面必须改」的东西，并且逐条记录改了什么。
 *
 * oracle 的身份要求它和被测实现零共享：这里的 CSS、骨架、引擎都不引用本仓库
 * 的任何模块，M4/M5 拿它当断言才有意义。
 *
 * 用法：node tools/ref/setup.mjs [参考目录]
 */
import {copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync}
    from 'node:fs';
import {join} from 'node:path';

const REF = process.argv[2] || join(process.env.TEMP || '/tmp', 'avgref');
const OUT = join(process.cwd(), 'tools', 'ref');
const VENDOR = join(OUT, 'vendor');

if (!existsSync(join(REF, 'AvgPlayer.js'))) {
  console.error(`参考目录 ${REF} 里没有 AvgPlayer.js，先完成侦察抓取`);
  process.exit(1);
}
mkdirSync(VENDOR, {recursive: true});

/* 参考件里没有 jQuery，模块 import 路径也是 wiki 绝对路径。 */
function rewriteEngine(from, to, edits) {
  const src = readFileSync(join(REF, from), 'utf8');
  let text = src;
  for (const [re, repl, why] of edits) {
    if (!re.test(text)) {
      console.error(`引擎改写失手：${from} 里找不到 ${re}\n${why}`);
      process.exit(1);
    }
    text = text.replace(re, repl);
  }
  writeFileSync(join(OUT, to), text);
  return edits.map(([, , why]) => `  · ${to}：${why}`);
}

const notes = [];

notes.push(...rewriteEngine('AvgPlayer.js', 'AvgPlayer.js', [
  [/^import \{ nounDes \} from '[^']*';$/m,
   "import {nounDes} from './NounDes.js';",
   'wiki 绝对 import 路径 → 本地同名模块（依赖不变）'],
]));
notes.push(...rewriteEngine('noun.js', 'NounDes.js', [
  [/fetch\('\/images\/5\/51\/Noun_des\.json'\)/,
   "fetch('/images/Noun_des.json')",
   '词典数据改由同源代理解析（同一份文件，同一 md5 目录）'],
]));

for (const [from, to] of [
  ['blk05.style', 'avg.css'],
  ['blk06.style', 'pandect.css'],
  ['blk07.style', 'nav.css'],
]) {
  copyFileSync(join(REF, from), join(OUT, to));
}
notes.push('  · avg.css / pandect.css / nav.css：逐字节照抄，零改写');

/* --- 骨架：直接从参考 page.html 抠，不复用本仓库的移植件 --- */
const page = readFileSync(join(REF, 'page.html'), 'utf8');

function balanced(html, start, tag) {
  const re = new RegExp(`<${tag}\\b|</${tag}>`, 'g');
  let depth = 0;
  let m;
  while ((m = re.exec(html.slice(start))) !== null) {
    depth += m[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return start + m.index + m[0].length;
  }
  return -1;
}

const containerStart = page.indexOf('<div id="avg-container"');
const containerEnd = balanced(page, containerStart, 'div');
const templateStart = page.indexOf('<template id="avg-log-tpl">');
const templateEnd = page.indexOf('</template>', templateStart) + '</template>'.length;
if (containerStart < 0 || containerEnd < 0 || templateStart < 0) {
  console.error('参考 page.html 里抠不出骨架');
  process.exit(1);
}
const SKELETON = [
  page.slice(templateStart, templateEnd),
  page.slice(containerStart, containerEnd),
  '<style id="chara-img-styles"></style>',
].join('\n');
writeFileSync(join(OUT, 'skeleton.html'), SKELETON);

/* --- harness 页面 --- */
if (!existsSync(join(VENDOR, 'jquery.min.js'))) {
  const url = 'https://code.jquery.com/jquery-3.7.1.min.js';
  console.log(`下载 jQuery ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    console.error(`jQuery 下载失败 ${response.status}`);
    process.exit(1);
  }
  writeFileSync(join(VENDOR, 'jquery.min.js'), Buffer.from(await response.arrayBuffer()));
}

/* wiki 上 #avg-container 的 color/font-family 由 Timeless 皮肤继承而来，
   参考样式表本身不写。这里补的是「环境」，不是引擎行为 —— 数值取自实测。 */
const SKIN_STANDIN = `
  html, body { margin: 0; background: #1b1b1b; }
  /* 无头页的默认滚动条会占掉 24px，#avg-container 的 max-width:100% 就把舞台
     夹成 1176 —— 而 transX 是按 clientWidth 算的，整张冻结表都会跟着偏。 */
  html { overflow: hidden; }
  body {
    color: black;
    font-family: "Segoe UI", "Segoe UI Emoji", "Segoe UI Symbol", Lato,
        "Liberation Sans", "Noto Sans", "Helvetica Neue", Helvetica, sans-serif;
  }
  @font-face {
    font-family: 'Mohave'; font-style: normal; font-weight: 300;
    font-display: block;
    src: url(/data/fonts/Mohave-Light.woff2) format('woff2'),
         url(/data/fonts/Mohave-Light.woff) format('woff');
  }
`;

writeFileSync(join(OUT, 'harness.html'), `<!DOCTYPE html>
<html lang="zh-Hans">
<head>
<meta charset="utf-8">
<title>avg reference oracle</title>
<link rel="stylesheet" href="/tools/ref/avg.css">
<link rel="stylesheet" href="/tools/ref/pandect.css">
<link rel="stylesheet" href="/tools/ref/nav.css">
<style>${SKIN_STANDIN}</style>
</head>
<body>
${SKELETON}
<script src="/tools/ref/vendor/jquery.min.js"></script>
<script type="module" src="/tools/ref/driver.mjs"></script>
</body>
</html>
`);

console.log(`参考 harness 就绪：${OUT}`);
for (const note of notes) console.log(note);
