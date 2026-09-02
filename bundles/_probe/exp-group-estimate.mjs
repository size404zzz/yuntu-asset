/* 一次性实验：把悬空槽位的路径估计从「全语料众数」换成「同剧情组众数（回退全局）」
   看说话镜不可见率怎么变。身份判据独立于 avgwire（家族前缀，不剥数字尾）。 */
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
    .replace(/\.png$/, '').replace(/_avg\d*$/, '').split('_');
const fam = (a, b) => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true;
};
const group = (id) => {
  let m = /^(.*?)_(?:0*\d+)$/.exec(id); if (m) return m[1];
  m = /^(.*?[a-z])0*(\d+)$/.exec(id); if (m) return m[1];
  return id;
};

/* 1) 解码全语料一次，收集每段声明 */
const segs = [];
for (const s of man.stories) {
  try {
    const raw = toJS(execChunk(parseChunk(readFileSync(join(ROOT, s.cfg))))[0]);
    const lang = toJS(execChunk(parseChunk(readFileSync(join(ROOT, s.lang))))[0]);
    const shots = raw.shots ?? raw;
    if (!shots) continue;
    const decl = new Map();
    for (const k of Object.keys(shots)) {
      for (const im of list(shots[k]?.images)) {
        if (!im) continue;
        if (im.delete) { decl.delete(im.imgId); continue; }
        if (im.imgPath && im.imgType === 3) decl.set(im.imgId, im.imgPath);
      }
    }
    segs.push({s, raw, lang, shots, decl, g: group(s.id)});
  } catch { /* 解码失败段跳过 */ }
}

/* 2) 组内 / 全局槽位直方图 */
const globalVotes = new Map();      // slot → Map(path → n)
const groupVotes = new Map();       // group → Map(slot → Map(path → n))
const addVote = (m, slot, path) => {
  const t = m.get(slot) ?? new Map();
  t.set(path, (t.get(path) ?? 0) + 1);
  m.set(slot, t);
};
for (const seg of segs) {
  const gm = groupVotes.get(seg.g) ?? new Map();
  groupVotes.set(seg.g, gm);
  for (const [slot, path] of seg.decl) {
    addVote(globalVotes, slot, path);
    addVote(gm, slot, path);
  }
}
const mode = (m) => (m ? [...m].sort((a, b) => b[1] - a[1])[0][0] : undefined);

/* 3) 两种估计下的可见度 */
function measure(label, estOf) {
  const tot = {speak: 0, invis: 0, noLane: 0, lane0: 0, segsAffected: new Set(), changed: 0};
  const perSeg = new Map();
  for (const seg of segs) {
    const est = estOf(seg);
    const {wire} = storyToWire(seg.raw, seg.lang, {imgIds: est, heroSprites: man.heroSprites});
    const st = emptyState();
    const pathOf = new Map();
    let speak = 0, invis = 0, noLane = 0, lane0 = 0;
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
      const base = man.heroSprites[String(hid)];
      if (!base) continue;
      speak++;
      const bs = stem(base);
      const mine = [...st.lanes].filter(([i]) => { const p = pathOf.get(i); return p && fam(bs, stem(p)); });
      if (mine.some(([, l]) => (l.alpha ?? 0) > 0)) continue;
      invis++;
      if (!mine.length) noLane++; else lane0++;
    }
    tot.speak += speak; tot.invis += invis; tot.noLane += noLane; tot.lane0 += lane0;
    if (invis) tot.segsAffected.add(seg.s.id);
    perSeg.set(seg.s.id, {speak, invis, noLane, lane0});
  }
  console.log(`${label}: 说话镜 ${tot.speak} · 不可见 ${tot.invis} (${(tot.invis / tot.speak * 100).toFixed(2)}%)`
    + ` [无lane ${tot.noLane} / laneα0 ${tot.lane0}] · 受影响段 ${tot.segsAffected.size}`);
  return {tot, perSeg};
}

const globalEst = () => man.imgIds;
const groupEst = (seg) => {
  const gm = groupVotes.get(seg.g);
  const out = {...man.imgIds};
  for (const slot of Object.keys(man.imgIds)) {
    if (seg.decl.has(Number(slot))) continue;
    const p = mode(gm?.get(Number(slot)));
    if (p && p !== man.imgIds[slot]) { out[slot] = p; }
  }
  return out;
};

const a = measure('A 全局众数（现状）', globalEst);
const b = measure('B 组内众数（回退全局）', groupEst);

/* 差异段 */
const worse = [], better = [];
for (const [id, x] of a.perSeg) {
  const y = b.perSeg.get(id);
  if (y.invis < x.invis) better.push(`${id} ${x.invis}→${y.invis}`);
  if (y.invis > x.invis) worse.push(`${id} ${x.invis}→${y.invis}`);
}
console.log(`变好段 ${better.length}：`, better.slice(0, 25).join(' | '));
console.log(`变差段 ${worse.length}：`, worse.slice(0, 25).join(' | '));
console.log('22child_02:', JSON.stringify(a.perSeg.get('22child_02')), '→', JSON.stringify(b.perSeg.get('22child_02')));
