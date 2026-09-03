/* 审计：同角色不同路径的两件立绘在同一镜里同时 α>0，并归因是「作者数据」还是「我们注入」。
   family(path) = 路径去掉目录/后缀后的首词根（persicaria_dress_avg 与 persicaria_avg 同族）；
   同路径的重复件（双生机，如 helios_robotgreen 注册两件）不算，那是合法的。 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const ROOT = 'C:/Users/Administrator/Documents/GitHub/yuntu-asset';
const {parseChunk} = await import(pathToFileURL(ROOT + '/js/core/lundump.js').href);
const {execChunk, toJS} = await import(pathToFileURL(ROOT + '/js/core/lvm.js').href);
const {storyToWire} = await import(pathToFileURL(ROOT + '/js/core/avgwire.js').href);
const {emptyState, applyImages, applyShotTweens} = await import(pathToFileURL(ROOT + '/js/core/state.js').href);

const man = JSON.parse(readFileSync(join(ROOT, 'data/index/avg-scripts.json'), 'utf8'));
const list = (x) => (Array.isArray(x) ? x : Object.values(x ?? {}));
const stem = (p) => String(p ?? '').replace(/^.*\//, '').replace(/^lpic_/, '')
    .replace(/\.png$/, '').replace(/_avg$/, '');
/* 「同一角色」判据：一条路径是另一条的前缀（persicaria ⊂ persicaria_dress ⊂
   persicaria_dress2）。首词根太粗——helios_robotgreen / helios_robotred、
   undline_w1c / undline_w4c 都是不同角色，同屏合法。 */
const PATHS = [];
const famOf = new Map();
function family(p) {
  const k = stem(p);
  if (famOf.has(k)) return famOf.get(k);
  let best = k;
  for (const other of PATHS) {
    if (other !== k && (k.startsWith(other + '_') || other.startsWith(k + '_'))) {
      if (other.length < best.length) best = other;
    }
  }
  PATHS.push(k); famOf.set(k, best);
  return best;
}

/* 折叠一份镜序列，返回每镜的「同族多件同时亮」清单 */
function audit(shots, keyShift = 0) {
  const st = emptyState();
  const pathOf = new Map();
  const hits = [];
  for (const k of Object.keys(shots).sort((a, b) => +a - +b)) {
    const sh = shots[k];
    if (!sh || typeof sh !== 'object') continue;
    applyImages(st, list(sh.images));
    for (const im of list(sh.images)) {
      if (im?.imgId != null && im.imgPath && !im.delete) pathOf.set(im.imgId, im.imgPath);
      else if (im?.delete) pathOf.delete(im.imgId);
    }
    applyShotTweens(st, {...sh, imgTween: list(sh.imgTween)});
    const byFam = new Map();
    for (const [id, lane] of st.lanes) {
      if ((lane.alpha ?? 0) <= 0) continue;
      const alt = man.imgIds[id];
      const p = pathOf.get(id) ?? (Array.isArray(alt) ? alt[0] : alt);
      if (!p || !p.endsWith('_avg')) continue;      /* 只看立绘（背景路径带 /） */
      const f = family(p);
      (byFam.get(f) ?? byFam.set(f, []).get(f)).push({id, path: stem(p)});
    }
    for (const [f, items] of byFam) {
      const uniq = new Set(items.map((x) => x.path));
      if (items.length >= 2 && uniq.size >= 2) {
        hits.push({key: +k + keyShift, fam: f, items});
      }
    }
  }
  return hits;
}

let authorOnly = 0, oursOnly = 0, both = 0;
const samples = []; const oursSamples = [];
for (const s of man.stories) {
  let raw, lang;
  try {
    raw = toJS(execChunk(parseChunk(readFileSync(join(ROOT, s.cfg))))[0]);
    lang = toJS(execChunk(parseChunk(readFileSync(join(ROOT, s.lang))))[0]);
  } catch { continue; }
  const rawShots = raw?.shots ?? raw;
  if (!rawShots) continue;
  const {wire} = storyToWire(raw, lang, {heroSprites: man.heroSprites, pathOwner: man.pathOwner});
  const before = new Map(audit(rawShots).map((h) => [`${h.key}|${h.fam}`, h]));
  const after = new Map(audit(wire).map((h) => [`${h.key}|${h.fam}`, h]));
  for (const [k, h] of after) {
    if (!before.has(k)) { oursOnly++; oursSamples.push(`${s.id}#${h.key} ${h.fam}: ${h.items.map((i) => `${i.id}=${i.path}`).join(' + ')}`); }
    else { both++; }
  }
  for (const [k, h] of before) if (!after.has(k)) { authorOnly++; if (samples.length < 14) samples.push(`仅原数据就有 ${s.id}#${h.key} ${h.fam}: ${h.items.map((i) => `${i.id}=${i.path}`).join(' + ')}`); }
}
console.log(`同族不同路径两件同时亮的镜次：改前-only ${authorOnly} · 改后新增（我们造成）${oursOnly} · 两侧都有 ${both}`);
samples.forEach((x) => console.log('  · ' + x));
console.log('我们造成的样本：'); oursSamples.slice(0, 10).forEach((x) => console.log('  · ' + x));
