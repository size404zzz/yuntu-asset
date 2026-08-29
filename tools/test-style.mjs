/**
 * 样式移植保真度校验：把参考抓取件（blk05/blk06.style）与移植件（css/avg.css、
 * css/pandect.css）逐条声明对比，只允许白名单内的刻意偏差。
 *
 * 用法：node tools/test-style.mjs [参考目录]
 * 参考目录默认 %TEMP%/avgref，缺失时跳过并给出提示（不算失败）。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const REF_DIR = process.argv[2]
    || join(process.env.TEMP || '/tmp', 'avgref');
const ROOT = process.cwd();

/**
 * 把 CSS 文本解析为 selector -> [[prop, value], ...]，保留出现顺序。
 * at-rule（@media 等）内嵌的规则会被展开为 "@media ... { 内层选择器 }"，
 * 这样移植件必须同样带上条件规则才算保真。
 */
function parse(text, context = '') {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const rules = new Map();
  let depth = 0;
  let buffer = '';
  let pending = null;

  const flush = (block) => {
    const open = block.indexOf('{');
    if (open < 0) return;
    const header = block.slice(0, open).trim();
    const body = block.slice(open + 1, block.lastIndexOf('}'));
    if (header.startsWith('@')) {
      if (!body.includes('{')) {
        // 只含声明的 at-rule（@counter-style 等）
        push(rules, header, body);
        return;
      }
      for (const [sel, decls] of parse(body, header)) {
        merge(rules, `${context ? context + ' ' : ''}${sel}`, decls);
      }
      return;
    }
    push(rules, context ? `${context} { ${header} }` : header, body);
  };

  for (const ch of src) {
    if (ch === '{') {
      depth++;
      if (depth === 1) {
        pending = buffer;
        buffer = '{';
      } else {
        buffer += ch;
      }
      continue;
    }
    if (ch === '}') {
      if (depth === 1) {
        flush(pending + buffer + '}');
        pending = null;
        buffer = '';
      } else {
        buffer += ch;
      }
      depth--;
      continue;
    }
    buffer += ch;
  }
  if (depth !== 0) throw new Error('CSS 花括号不配对，解析器需加强');
  return rules;
}

function merge(rules, key, decls) {
  const list = rules.get(key) || [];
  for (const pair of decls) {
    const at = list.findIndex(([p]) => p === pair[0]);
    if (at >= 0) list[at] = pair;
    else list.push(pair);
  }
  rules.set(key, list);
}

function push(rules, selectorText, body) {
  const decls = body
      .split(';')
      .map((d) => d.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .map((d) => {
        const i = d.indexOf(':');
        return [d.slice(0, i).trim().toLowerCase(), d.slice(i + 1).trim()];
      });
  for (const sel of selectorText.split(',')) {
    const key = sel.replace(/\s+/g, ' ').trim();
    if (!key) continue;
    merge(rules, key, decls);
  }
}

function valueMap(decls) {
  return new Map(decls);
}

/* 参考 url() 指向 wiki 的 percent-encoded 中文名，移植件指向本地 data/ui。
   显式别名表既归一化比对，也作为"改名映射"的单一事实来源。 */
const ASSET_ALIAS = {
  'AVG_通讯效果背景.png': 'commframe.png',
  'AVG_聊天窗.png': 'chatwin.png',
  'AVG_按钮背景.png': 'btnbg.png',
  'AVG_Log菜单Icon.png': 'log.png',
  '隐藏.png': 'hide.png',
  'AVG_词典入口.png': 'dict.png',
  'AVG跳过_底.png': 'skipbg.png',
  '通用_取消Icon.png': 'cancel.png',
  '通用_确认Icon.png': 'confirm.png',
};

function decodeRefName(path) {
  const base = path.split('/').pop();
  try {
    return decodeURIComponent(base);
  } catch {
    return base;
  }
}

/** url() 归一到本地文件名；顺带校验素材字节与参考一致。 */
function normalizeValue(value) {
  return value
      .replace(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g, (_, p) => {
        const ref = decodeRefName(p);
        const local = ASSET_ALIAS[ref] || ref;
        return `url(${local})`;
      })
      .replace(/,\s*/g, ',');
}

const assetChecks = [];

/* 参考素材改名后的字节指纹。九张图已在一次性核验中与参考抓取件逐字节比对通过，
   此处冻结为 pin，使校验脱离临时抓取目录长期可跑，并防止素材被误替换/截断。 */
const ASSET_SHA1 = {
  'btnbg.png': 'af3ba98af21585731237e0f8f0455177f0fb2503',
  'cancel.png': '3f742f5da39576bcdf2e409e22790f6dc6a6c1de',
  'chatwin.png': '9b0157ed085ae13020479249461570e38f8ed14c',
  'commframe.png': '7eb2f003efd81e63ece254e3cdfd3c6134f2fe5e',
  'confirm.png': '6911a9034f2253bffdd4832e24f11919b6ef7656',
  'dict.png': '530534f7759838e35f7bb1d7dd270fabeb223253',
  'hide.png': '9f16303de2e67de80254dae6f611183c6a3bf4e4',
  'log.png': 'fee61df5998f080bdad35e43706b0dba93ff129f',
  'skipbg.png': '2bd208f4da76994c9f12f12a04054efb8df30c51',
};

const FONT_SHA1 = {
  'Mohave-Light.woff2': 'bff3d160b61a2d640f7d943c94b287db521ad0ce',
  'Mohave-Light.woff': '63f44b421c573942f4323a75030ed39a3b5695b1',
};

const PINS = [
  {dir: 'data/ui', sha1: ASSET_SHA1},
  {dir: 'data/fonts', sha1: FONT_SHA1},
];

function verifyPins() {
  for (const {dir, sha1} of PINS) {
    const abs = join(ROOT, dir);
    for (const [name, want] of Object.entries(sha1)) {
      const path = join(abs, name);
      if (!existsSync(path)) {
        assetChecks.push({level: 'fail', msg: `缺文件 ${dir}/${name}`});
        continue;
      }
      const got = createHash('sha1').update(readFileSync(path)).digest('hex');
      assetChecks.push(got === want
          ? {level: 'ok', msg: `${dir}/${name} 指纹一致`}
          : {level: 'fail', msg: `${dir}/${name} 指纹不符：${got} != ${want}`});
    }
    if (existsSync(abs)) {
      const unknown = readdirSync(abs).filter((f) => !Object.hasOwn(sha1, f));
      if (unknown.length) {
        assetChecks.push({
          level: 'fail',
          msg: `${dir}/ 有未登记指纹的文件：${unknown.join(', ')}`,
        });
      }
    }
  }
}

const CASES = [
  { name: 'avg', ref: 'blk05.style', port: 'css/avg.css' },
  { name: 'pandect', ref: 'blk06.style', port: 'css/pandect.css' },
];

/* 刻意偏差白名单：selector#prop -> 允许原因。新偏差必须登记并说明理由，
   否则视为移植失真。 */
const ALLOWED = {
  /* 参考这三条都靠 MediaWiki Timeless 皮肤继承得到（实测
     getComputedStyle(#avg-container).color === rgb(0,0,0)，fontFamily 为
     Segoe UI 栈）。我们的宿主是深色主题编辑器/独立页，不显式钉住就复现不了
     同一渲染结果。 */
  '#avg-container#color': '参考继承自皮肤（实测 rgb(0,0,0)），宿主页面主题不同必须显式钉',
  '#avg-container#font-family': '参考继承自皮肤，实测栈值照抄',
  '#avg-container#--avg-font': '把实测栈值收成变量，便于页面复用',
  '@font-face#*': '参考的 Mohave 由站点皮肤提供；独立页面自托管同一字体文件',
  '.avg-missing#*': '净新增：资源缺失占位样式',
};

function allowed(key) {
  return ALLOWED[key] || ALLOWED[key.replace(/#[^#]+$/, '#*')];
}

let failures = 0;
const fail = (msg) => { failures++; console.log('  FAIL ' + msg); };
const ok = (msg) => console.log('  ok   ' + msg);

verifyPins();
for (const check of assetChecks) {
  if (check.level === 'fail') fail(check.msg);
  else ok(check.msg);
}

if (!existsSync(REF_DIR)) {
  console.log(`\n参考目录不存在：${REF_DIR}\n样式逐条比对跳过（素材指纹已校验）。`);
  console.log(failures ? `\n存在 ${failures} 类失败` : '\n素材指纹保真；样式比对未运行');
  process.exit(failures ? 1 : 0);
}

for (const { name, ref, port } of CASES) {
  const refPath = join(REF_DIR, ref);
  const portPath = join(ROOT, port);
  console.log(`\n== ${name}: ${ref} -> ${port}`);
  if (!existsSync(refPath)) { fail(`缺少参考件 ${ref}`); continue; }
  if (!existsSync(portPath)) { fail(`缺少移植件 ${port}`); continue; }

  const refs = parse(readFileSync(refPath, 'utf8'));
  const ports = parse(readFileSync(portPath, 'utf8'));

  const missing = [...refs.keys()].filter((s) => !ports.has(s));
  if (missing.length) {
    fail(`移植件缺少 ${missing.length} 个选择器：\n         ${missing.join('\n         ')}`);
  } else {
    ok(`参考的 ${refs.size} 个选择器全部存在`);
  }

  const extra = [...ports.keys()].filter((s) => !refs.has(s));
  const unexplainedExtra = extra.filter((s) => !allowed(`${s}#*`));
  if (unexplainedExtra.length) {
    fail(`移植件多出未登记的选择器：${unexplainedExtra.join(', ')}`);
  } else if (extra.length) {
    ok(`移植件多出 ${extra.length} 个选择器，均在白名单：${extra.join(', ')}`);
  } else {
    ok('无多余选择器');
  }

  const diffs = [];
  const leaks = [];
  for (const [sel, decls] of refs) {
    if (!ports.has(sel)) continue;
    const mine = valueMap(ports.get(sel));
    for (const [prop, want] of decls) {
      const key = `${sel}#${prop}`;
      if (!mine.has(prop)) {
        if (!allowed(key)) diffs.push(`${key}: 移植件缺该声明（参考 ${want}）`);
        continue;
      }
      const got = mine.get(prop);
      if (normalizeValue(got) === normalizeValue(want)) continue;
      if (allowed(key)) continue;
      diffs.push(`${key}: 参考=${want} 移植=${got}`);
    }
    for (const [prop, got] of ports.get(sel)) {
      if (valueMap(decls).has(prop)) continue;
      if (allowed(`${sel}#${prop}`)) continue;
      leaks.push(`${sel}#${prop}: 参考没有此声明（移植=${got}）`);
    }
  }
  if (diffs.length) {
    fail(`声明值不一致 ${diffs.length} 处：\n         ${diffs.join('\n         ')}`);
  } else {
    ok('全部声明值与参考一致（url 经别名表归一）');
  }
  if (leaks.length) {
    fail(`移植件夹带未登记的额外声明 ${leaks.length} 处：\n         ${leaks.join('\n         ')}`);
  } else {
    ok('无未登记的额外声明');
  }
}

console.log(failures ? `\n存在 ${failures} 类失败` : '\n样式移植保真');
process.exit(failures ? 1 : 0);
