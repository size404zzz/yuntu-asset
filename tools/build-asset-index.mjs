/**
 * 生成 data/asset-index.json：把 res/ 素材树索引成「小写文件名 → 仓库相对路径」。
 *
 * 为什么需要：引擎向 filePathOf 报的是 wiki 命名（Lpic_persicaria_avg.png、
 * Icon_face_persicaria_4.png、Cpt00_e_cg002.png），而本地 res/ 树的大小写与
 * 目录结构都不同（lpic_…、Character/<dir>/Face/<dir>_face_N.png、
 * Images/Avg/cpt00/cpt00_e_cg002.png）。浏览器无法列目录，纯静态工程只能
 * 靠生成的索引精确解析；这份数据也是 M8 素材库（IndexedDB）的地基。
 *
 * 脸差分额外生成别名键：本地 <dir>_face_N.png ↔ 引擎的
 * Icon_face_<dir去掉_avg尾>_N.png。
 *
 * 用法：node tools/build-asset-index.mjs            # 生成 + 夹具校验
 *       node tools/build-asset-index.mjs --validate # 只校验不写盘
 */
import {readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {parseChunk} from '../js/core/lundump.js';
import {execChunk, toJS} from '../js/core/lvm.js';
import {storyToWire} from '../js/core/avgwire.js';

const ROOT = resolve(process.cwd());
const VALIDATE_ONLY = process.argv.includes('--validate');
const FIXTURES = ['scene1', 'scene2', 'scene3'];

const index = {};

function walk(dir, filter) {
  let entries;
  try {
    entries = readdirSync(dir, {withFileTypes: true});
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path, filter);
    } else if (filter(entry.name)) {
      const rel = path.slice(ROOT.length + 1).replaceAll('\\', '/');
      index[entry.name.toLowerCase()] = rel;
    }
  }
}

/* 背景/CG：Images/Avg 下所有 png。 */
walk(join(ROOT, 'res', 'Assets', 'Res', 'Images', 'Avg'), (name) =>
    name.toLowerCase().endsWith('.png'));

/* 立绘：Character 下的 lpic_*.png 与 Face/*.png（npic/spic/技能图暂不入表）。 */
walk(join(ROOT, 'res', 'Assets', 'Res', 'Character'), (name) =>
    /^lpic_.*\.png$/i.test(name));
walkFace(join(ROOT, 'res', 'Assets', 'Res', 'Character'));

/* dump 命名适配：语料引用的立绘名是 X_avg，但拆出来的文件名有两类怪癖
   （已核对全树每个 X_avg 文件夹至多一份 lpic，无歧义）：
   - 文件名少 _avg 尾：X_avg/lpic_X.png（chelsea_avg/lpic_chelsea.png 等
     绝大多数新拆件；florence_avg 里那份叫 lpic_florence_p2.png，同文件夹
     的表情都姓 florence_avg，按文件夹口径归它）；
   - 文件夹里只有表情：身体在基础文件夹 X/lpic_X.png（hubble_avg、sold_avg
     等——游戏里 avg 变体的身体资源名本就不带尾）。
   这里把两条路都补成 lpic_X_avg.png 别名键；正式命名的同名件优先，
   永不覆盖。 */
const charRoot = join(ROOT, 'res', 'Assets', 'Res', 'Character');
for (const e of readdirSync(charRoot, {withFileTypes: true})) {
  if (!e.isDirectory() || !/_avg$/i.test(e.name)) continue;
  const key = `lpic_${e.name}.png`;
  if (index[key]) continue;                 /* 正式命名已入库 */
  const dir = join(charRoot, e.name);
  const inDir = readdirSync(dir)
      .filter((f) => /^lpic_.*\.png$/i.test(f));
  if (inDir.length === 1) {
    index[key] = relOf(join(dir, inDir[0]));
    continue;
  }
  if (inDir.length > 1) continue;           /* 歧义防御：理论上不存在 */
  const stem = e.name.replace(/_avg$/i, '');
  const baseLpic = join(charRoot, stem, `lpic_${stem}.png`);
  if (existsSync(baseLpic)) index[key] = relOf(baseLpic);
}

function walkFace(dir) {
  let entries;
  try {
    entries = readdirSync(dir, {withFileTypes: true});
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    /* 表情图两代布局：老库收在 <dir>/Face/ 子目录，新拆件平铺在 <dir> 根。
       只收 _face_<N>.png 命名的文件（根上还有 lpic 等别的图）。 */
    for (const faceDir of [join(path, 'Face'), path]) {
      let faces;
      try {
        faces = readdirSync(faceDir, {withFileTypes: true});
      } catch {
        continue;
      }
      for (const face of faces) {
        if (face.isDirectory() || !/_face_\d+\.png$/i.test(face.name)) continue;
        const rel = join(faceDir, face.name).slice(ROOT.length + 1)
            .replaceAll('\\', '/');
        index[face.name.toLowerCase()] = rel;
        /* 别名：Icon_face_<stem>_<fid>.png ← <dir>_face_<fid>.png。 */
        const alias = face.name.replace(/^_*/, '');
        const m = /^(.+)_face_(\d+)\.png$/i.exec(alias);
        if (m) {
          const stem = m[1].replace(/_avg$/i, '');
          index[`icon_face_${stem}_${m[2]}`.toLowerCase() + '.png'] = rel;
        }
      }
    }
  }
}
walkFace(join(ROOT, 'res', 'Assets', 'Res', 'Character'));

/* —— M8 可浏览索引：data/index/{backgrounds,characters}.json ——
   扁平 asset-index.json 管「引擎报名 → 路径」的精确解析；
   这两份管「人来找素材」：分类、分组、搜索、layout 标定状态。 */

function relOf(abs) {
  return abs.slice(ROOT.length + 1).replaceAll('\\', '/');
}

function scanBackgrounds() {
  const out = [];
  (function dirWalk(dir, group) {
    let entries;
    try {
      entries = readdirSync(dir, {withFileTypes: true});
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) dirWalk(join(dir, e.name), group ? group : e.name);
      else if (/\.png$/i.test(e.name) && group) {
        out.push({
          name: e.name.replace(/\.png$/i, ''),
          group,
          path: relOf(join(dir, e.name)),
        });
      }
    }
  })(join(ROOT, 'res', 'Assets', 'Res', 'Images', 'Avg'), null);
  out.sort((a, b) => a.path < b.path ? -1 : 1);
  return out;
}

function scanCharacters(knownLayouts) {
  const root = join(ROOT, 'res', 'Assets', 'Res', 'Character');
  const out = [];
  let entries;
  try {
    entries = readdirSync(root, {withFileTypes: true});
  } catch {
    entries = [];
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = join(root, e.name);
    const files = readdirSync(dir);
    /* lpic 与 flat 索引同口径：文件夹内有就用（名字可缺 _avg 尾），
       没有退基础文件夹 X/lpic_X.png（hubble_avg 等身体在 X/ 里）。 */
    const stem = e.name.replace(/_avg$/i, '');
    const inDir = files.find((f) => f.toLowerCase() === `lpic_${e.name}.png`)
        ?? files.find((f) => /^lpic_.*\.png$/i.test(f));
    let lpic = inDir ? join(dir, inDir) : null;
    if (!lpic) {
      const baseLpic = join(root, stem, `lpic_${stem}.png`);
      if (existsSync(baseLpic)) lpic = baseLpic;
    }
    if (!lpic) continue;
    /* 表情两代布局：老库 Face/ 子目录，新拆件平铺在根。 */
    const faceIds = new Set();
    for (const f of files) {
      const n = Number(/_face_(\d+)\.png$/i.exec(f)?.[1]);
      if (Number.isFinite(n)) faceIds.add(n);
    }
    try {
      for (const f of readdirSync(join(dir, 'Face'))) {
        const n = Number(/_face_(\d+)\.png$/i.exec(f)?.[1]);
        if (Number.isFinite(n)) faceIds.add(n);
      }
    } catch { /* 无 Face/ 子目录（新拆件平铺在根） */ }
    const faces = [...faceIds].sort((a, b) => a - b);
    out.push({
      id: e.name,
      lpic: relOf(lpic),
      faces,
      layout: knownLayouts.has(e.name),
      avg: /_avg$/i.test(e.name),
    });
  }
  out.sort((a, b) => a.id < b.id ? -1 : 1);
  return out;
}

const knownLayouts = new Set(existsSync(join(ROOT, 'data', 'layouts'))
    ? readdirSync(join(ROOT, 'data', 'layouts'))
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, ''))
    : []);
const backgrounds = scanBackgrounds();
const characters = scanCharacters(knownLayouts);

/* —— M13 剧本清单：res/Assets/Res/LuaScripts 下的 AvgCfg/AvgLang 语料 ——
   AssetStudio 从 avgconfig.ab 解出的 Lua 5.3 字节码（1878 段剧情 ×
   演出指令 + 中文台词），加 configs.ab 里剧情相关的 storyline 入口。
   播放器引擎按 wiki 命名解析图片，剧本则按剧情 ID 枚举，所以单独
   出一份 {id, cfg, lang} 清单给后续的剧情库/解释器用；缺席（R13
   无 res/ 树）时输出空清单，不参与验收。 */
function scanAvgScripts() {
  const dir = join(ROOT, 'res', 'Assets', 'Res', 'LuaScripts');
  const stories = new Map();
  const configs = [];
  const cfgRe = /^AvgCfg_(.+)\.lua$/i;
  const langRe = /^AvgLang_(.+)_ZH_CN\.lua$/i;
  for (const sub of ['Avg', 'Configs']) {
    let files;
    try {
      files = readdirSync(join(dir, sub), {withFileTypes: true});
    } catch {
      continue;
    }
    for (const e of files) {
      if (e.isDirectory()) continue;
      const rel = relOf(join(dir, sub, e.name));
      const cfg = cfgRe.exec(e.name);
      const lang = langRe.exec(e.name);
      if (cfg) {
        const s = stories.get(cfg[1]) ?? {id: cfg[1], cfg: null, lang: null};
        s.cfg = rel;
        stories.set(cfg[1], s);
      } else if (lang) {
        const s = stories.get(lang[1]) ?? {id: lang[1], cfg: null, lang: null};
        s.lang = rel;
        stories.set(lang[1], s);
      } else if (sub === 'Configs') {
        configs.push({name: e.name.replace(/\.lua$/i, ''), path: rel});
      }
    }
  }
  return {stories: [...stories.values()].sort((a, b) => a.id < b.id ? -1 : 1), configs};
}
const avgScripts = scanAvgScripts();

/* 验收口径（随库基线走）：全量拆包件 731 背景；_avg 立绘目录（含 lpic）
   ≥514。非 _avg（boss/庆典等）也全部入索引，编辑器可用，但不计验收。 */
const indexProblems = [];
const avgCount = characters.filter((c) => c.avg).length;
if (backgrounds.length !== 731) {
  indexProblems.push(`背景数 ${backgrounds.length} != 计划口径 731`);
}
if (avgCount < 514) {
  indexProblems.push(`_avg 立绘数 ${avgCount} < 计划口径 514`);
}
for (const name of knownLayouts) {
  if (!characters.some((c) => c.id === name)) {
    indexProblems.push(`已知 layout ${name} 在素材树里没有对应立绘目录`);
  }
}

/* M14 剧本库增强：全语料现场解码 → 每段补 steps（镜数）与 brief（简介），
 * 同时把「解码+映射 0 失败」升格为构建门槛——索引生成本身就是一次
 * 全语料回归。解码失败的段记入 indexProblems（构建 exit 1）。 */
const corpusT0 = Date.now();
let corpusFail = 0;
for (const story of avgScripts.stories) {
  try {
    const cfg = toJS(execChunk(parseChunk(readFileSync(join(ROOT, story.cfg))))[0]);
    const lang = toJS(execChunk(parseChunk(readFileSync(join(ROOT, story.lang))))[0]);
    const {wire} = storyToWire(cfg, lang);
    story.steps = Object.keys(wire).length;
    const brief = wire['1']?.SkipScenario;
    story.brief = typeof brief === 'string' ? brief : null;
  } catch (e) {
    corpusFail++;
    indexProblems.push(`剧本 ${story.id} 解码失败：${e.message}`);
  }
}
console.log(`可浏览索引：背景 ${backgrounds.length} · 立绘 ${characters.length}`
    + `（_avg ${avgCount}）· 已标定 layout ${knownLayouts.size}`
    + ` · 剧本 ${avgScripts.stories.length} 段 + ${avgScripts.configs.length} 份剧情配置`
    + ` · 语料解码 ${corpusFail ? corpusFail + ' 段失败' : '全通过'}`
    + `（${((Date.now() - corpusT0) / 1000).toFixed(1)}s）`);
for (const m of indexProblems) console.log('  FAIL ' + m);

/* —— 夹具校验：按引擎的同款变换推出素材名，逐个查索引 —— */

function neededNames(id) {
  const raw = JSON.parse(readFileSync(join(ROOT, 'data', 'fixtures', id + '.json'), 'utf8'));
  const shots = Array.isArray(raw)
      ? raw : Object.keys(raw).sort((a, b) => a - b).map((k) => raw[k]);
  const need = new Set();
  const imgPathOf = new Map();
  for (const shot of shots) {
    for (const img of shot.images ?? []) {
      imgPathOf.set(img.imgId, img.imgPath);
      if (img.imgType === 2) {
        need.add((img.imgPath.split('/')[1] + '.png').toLowerCase());
      }
      if (img.imgType === 3) {
        need.add(('lpic_' + img.imgPath + '.png').toLowerCase());
      }
    }
  }
  for (const shot of shots) {
    for (const face of shot.heroFace ?? []) {
      if (!face.faceId) continue;               // 0 = 还原默认脸，不取图
      const imgPath = imgPathOf.get(face.imgId);
      if (imgPath) {
        need.add(('icon_face_' + imgPath.replace(/_avg$/, '') + '_' + face.faceId
            + '.png').toLowerCase());
      }
    }
  }
  return [...need];
}

let misses = 0;
for (const id of FIXTURES) {
  const names = neededNames(id);
  const bad = names.filter((name) => !index[name]);
  misses += bad.length;
  console.log(`${id}  需要 ${names.length} 项  未命中 ${bad.length}${bad.length ? '：' + bad.join(', ') : ''}`);
}
console.log(`索引共 ${Object.keys(index).length} 项`);
if ((misses || indexProblems.length) && !VALIDATE_ONLY) {
  console.log('有缺口仍写出索引（缺的条目在编辑器里 404，走 /images 兜底）');
}
if (!VALIDATE_ONLY) {
  writeFileSync(join(ROOT, 'data', 'asset-index.json'),
      JSON.stringify(index, null, 1) + '\n');
  mkdirSync(join(ROOT, 'data', 'index'), {recursive: true});
  writeFileSync(join(ROOT, 'data', 'index', 'backgrounds.json'),
      JSON.stringify(backgrounds, null, 1) + '\n');
  writeFileSync(join(ROOT, 'data', 'index', 'characters.json'),
      JSON.stringify(characters, null, 1) + '\n');
  writeFileSync(join(ROOT, 'data', 'index', 'avg-scripts.json'),
      JSON.stringify(avgScripts, null, 1) + '\n');
  console.log('写出 data/asset-index.json + data/index/{backgrounds,characters,avg-scripts}.json');
}
process.exit(misses || indexProblems.length ? 1 : 0);
