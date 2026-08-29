/**
 * 骨架保真校验，两件独立的事：
 *  1) js/engine/player.js 里的 SKELETON_HTML 与参考 page.html 的 #avg-container
 *     子树结构（标签 + 属性 + 文本）逐项相等；参考件缺失时跳过。
 *  2) css/ 里被选择器引用的每个 #id 都必须存在于骨架（或登记为 JS 动态注入）。
 *     这条不依赖参考件，防的是真正的哑bug：id 打错一个字母，样式静默失效。
 *
 * 用法：node tools/test-skeleton.mjs [参考目录]
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const REF_DIR = process.argv[2]
    || join(process.env.TEMP || '/tmp', 'avgref');
const ROOT = process.cwd();

let failures = 0;
const fail = (m) => { failures++; console.log('  FAIL ' + m); };
const ok = (m) => console.log('  ok   ' + m);

const playerSrc = readFileSync(join(ROOT, 'js/engine/player.js'), 'utf8');
const skeletonMatch = playerSrc.match(
    /const SKELETON_HTML = `([\s\S]*?)`;/);
if (!skeletonMatch) {
  fail('js/engine/player.js 里找不到 SKELETON_HTML 字符串常量');
  process.exit(1);
}
const SKELETON_HTML = skeletonMatch[1];

/** 把 HTML 扁平化为 [{depth, tag, attrs, text}] 序列，便于逐项比对。 */
function flatten(html) {
  const out = [];
  let depth = 0;
  const re = /<(\/?)(\w+)([^>]*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[5] !== undefined) {
      const text = m[5].replace(/\s+/g, ' ').trim();
      if (text && out.length) out[out.length - 1].text += text;
      continue;
    }
    if (m[1] === '/') { depth--; continue; }
    const attrs = m[3].replace(/\s+/g, ' ').trim();
    out.push({depth: depth++, tag: m[2], attrs, text: ''});
    if (m[4] === '/') depth--;
  }
  return out;
}

function describe(nodes) {
  return nodes.map((n) => `${'  '.repeat(n.depth)}<${n.tag}${n.attrs ? ' ' + n.attrs : ''}>${
    n.text ? ' ' + n.text : ''}`);
}

const mine = flatten(SKELETON_HTML);

/* --- 1. 与参考抓取件比结构 --- */
const pagePath = join(REF_DIR, 'page.html');
if (!existsSync(pagePath)) {
  console.log(`\n== 骨架 vs 参考\n  --   参考件 ${pagePath} 不存在，跳过结构比对`);
} else {
  const page = readFileSync(pagePath, 'utf8');
  const start = page.indexOf('<div id="avg-container"');
  if (start < 0) {
    fail('参考 page.html 里找不到 <div id="avg-container">');
  } else {
    let depth = 0;
    let end = -1;
    const re = /<div\b|<\/div>/g;
    let m;
    while ((m = re.exec(page.slice(start))) !== null) {
      depth += m[0] === '</div>' ? -1 : 1;
      if (depth === 0) { end = start + m.index + m[0].length; break; }
    }
    if (end < 0) {
      fail('参考 #avg-container 的 div 不配对');
    } else {
      const theirs = flatten(page.slice(start, end));
      const a = describe(theirs);
      const b = describe(mine);
      const diffs = [];
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i] === b[i]) continue;
        diffs.push(`#${i} 参考=${a[i] ?? '(无)'} 移植=${b[i] ?? '(无)'}`);
      }
      if (diffs.length) {
        fail(`骨架与参考结构不一致 ${diffs.length} 处：\n         ${diffs.join('\n         ')}`);
      } else {
        ok(`骨架与参考逐元素一致（${a.length} 个元素）`);
      }
    }
  }
}

/* --- 2. CSS 引用的每个 id 都要在骨架里 --- */
const skeletonIds = new Set(
    [...SKELETON_HTML.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

/* 参考里由 AvgPlayer.js 动态创建的控件（移动端分支），静态骨架本就不含。 */
const DYNAMIC_IDS = new Set(['avg-control-fullscreen', 'avg-control-orientation']);

const cssDir = join(ROOT, 'css');
const cssIds = new Set();
for (const file of readdirSync(cssDir).filter((f) => f.endsWith('.css')
    && f !== 'app.css' /* 编辑器外壳不属于播放器保真范围 */)) {
  const css = readFileSync(join(cssDir, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ');
  for (const m of css.matchAll(/(?:^|[};{])\s*([^{}]+)\{/g)) {
    const header = m[1].trim();
    if (header.startsWith('@') && !header.includes('#')) continue;
    for (const id of header.matchAll(/#([A-Za-z][-\w]*)/g)) cssIds.add(id[1]);
  }
}

const absent = [...cssIds].filter(
    (id) => !skeletonIds.has(id) && !DYNAMIC_IDS.has(id));
if (absent.length) {
  fail(`CSS 引用了骨架里不存在的 id（样式会静默失效）：${absent.join(', ')}`);
} else {
  ok(`CSS 引用的 ${cssIds.size} 个 id 全部落在骨架（或已登记为动态注入）`);
}

const unused = [...skeletonIds].filter((id) => !cssIds.has(id));
if (unused.length) {
  console.log(`  --   骨架里这些 id 未被 css/ 选中（可能由 JS 使用）：${unused.join(', ')}`);
}

console.log(failures ? `\n存在 ${failures} 类失败` : '\n骨架保真');
process.exit(failures ? 1 : 0);
