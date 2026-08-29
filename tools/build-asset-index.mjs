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

function walkFace(dir) {
  let entries;
  try {
    entries = readdirSync(dir, {withFileTypes: true});
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (!entry.isDirectory()) continue;
    const faceDir = join(path, 'Face');
    let faces;
    try {
      faces = readdirSync(faceDir, {withFileTypes: true});
    } catch {
      continue;
    }
    for (const face of faces) {
      if (!/\.png$/i.test(face.name)) continue;
      const rel = join(faceDir, face.name).slice(ROOT.length + 1).replaceAll('\\', '/');
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
    const lpic = files.find((f) => f.toLowerCase() === `lpic_${e.name}.png`)
        ?? files.find((f) => /^lpic_.*\.png$/i.test(f));
    if (!lpic) continue;
    let faces = [];
    try {
      faces = readdirSync(join(dir, 'Face'))
          .map((f) => Number(/_face_(\d+)\.png$/i.exec(f)?.[1]))
          .filter((n) => Number.isFinite(n))
          .sort((a, b) => a - b);
    } catch { /* 无脸图目录 */ }
    out.push({
      id: e.name,
      lpic: relOf(join(dir, lpic)),
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

/* M8 验收口径：639 背景；_avg 立绘目录（含 lpic）≥496。
   非 _avg（boss/庆典等）也全部入索引，编辑器可用，但不计验收。 */
const indexProblems = [];
const avgCount = characters.filter((c) => c.avg).length;
if (backgrounds.length !== 639) {
  indexProblems.push(`背景数 ${backgrounds.length} != 计划口径 639`);
}
if (avgCount < 496) {
  indexProblems.push(`_avg 立绘数 ${avgCount} < 计划口径 496`);
}
for (const name of knownLayouts) {
  if (!characters.some((c) => c.id === name)) {
    indexProblems.push(`已知 layout ${name} 在素材树里没有对应立绘目录`);
  }
}
console.log(`可浏览索引：背景 ${backgrounds.length} · 立绘 ${characters.length}`
    + `（_avg ${avgCount}）· 已标定 layout ${knownLayouts.size}`);
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
  console.log('写出 data/asset-index.json + data/index/{backgrounds,characters}.json');
}
process.exit(misses || indexProblems.length ? 1 : 0);
