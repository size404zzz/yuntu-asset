/* 一次性探针：22child_02 逐镜「说话人是否现身」账目 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const ROOT = 'C:/Users/Administrator/Documents/GitHub/yuntu-asset';
const {parseChunk} = await import(pathToFileURL(ROOT + '/js/core/lundump.js').href);
const {execChunk, toJS} = await import(pathToFileURL(ROOT + '/js/core/lvm.js').href);
const {storyToWire} = await import(pathToFileURL(ROOT + '/js/core/avgwire.js').href);
const {emptyState, applyImages, applyShotTweens} = await import(pathToFileURL(ROOT + '/js/core/state.js').href);

const man = JSON.parse(readFileSync(join(ROOT, 'data/index/avg-scripts.json'), 'utf8'));
const id = process.argv[2] ?? '22child_02';
const s = man.stories.find((x) => x.id === id);
const raw = toJS(execChunk(parseChunk(readFileSync(join(ROOT, s.cfg))))[0]);
const lang = toJS(execChunk(parseChunk(readFileSync(join(ROOT, s.lang))))[0]);
const list = (x) => (Array.isArray(x) ? x : Object.values(x ?? {}));
const {wire, stats} = storyToWire(raw, lang, {imgIds: man.imgIds, heroSprites: man.heroSprites});

console.log('stats', JSON.stringify({autoLit: stats.autoLit, entranceLit: stats.entranceLit,
  entranceExit: stats.entranceExit, danglingCast: stats.danglingCast.length, bgReveal: stats.bgReveal}));

/* 注册路径直方图 */
const regPaths = new Map();
for (const k of Object.keys(wire)) {
  for (const im of list(wire[k].images)) {
    if (!im?.imgPath || im.delete) continue;
    if (!regPaths.has(im.imgPath)) regPaths.set(im.imgPath, {ids: new Set(), first: k});
    regPaths.get(im.imgPath).ids.add(im.imgId);
  }
}
console.log('--- 本段注册路径 ---');
for (const [p, v] of regPaths) console.log(`  ${p} ids=[${[...v.ids].join(',')}] firstKey=${v.first}`);

/* 折叠 wire，逐镜报告说话人可见度 */
const st = emptyState();
const pathOf = new Map();
const hs = new Map(Object.entries(man.heroSprites));
let speaking = 0, invisible = 0;
const rows = [];
for (const k of Object.keys(wire).sort((a, b) => +a - +b)) {
  const sh = wire[k];
  for (const im of list(sh.images)) {
    if (im?.imgPath && !im.delete) pathOf.set(im.imgId, im.imgPath);
    else if (im?.delete) pathOf.delete(im.imgId);
  }
  applyImages(st, list(sh.images));
  applyShotTweens(st, {...sh, imgTween: list(sh.imgTween)});
  const hid = sh.speakerHeroId;
  if (hid === undefined || hid === null) continue;
  speaking++;
  const base = hs.get(String(hid));
  const mine = [...st.lanes].filter(([id2]) => {
    const p = pathOf.get(id2);
    return p && base && (p === base || p.startsWith(base.replace(/_avg$/, '')));
  });
  const lit = mine.filter(([, l]) => (l.alpha ?? 0) > 0);
  if (!lit.length) {
    invisible++;
    rows.push(`#${k} hid=${hid} base=${base} lanes=${mine.map(([i, l]) => `${i}:a${l.alpha}`).join(',') || 'NONE'}`
      + ` entries=${list(sh.imgTween).filter((t) => mine.some(([i]) => i === t.imgId)).map((t) => `${t.imgId}/a${t.alpha}/d${t.duration}`).join(' ')}`);
  }
}
console.log(`--- 说话镜 ${speaking} 处，其中说话人不可见 ${invisible} 处 ---`);
rows.slice(0, 60).forEach((r) => console.log('  ' + r));
