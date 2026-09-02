/* 一次性审计：全语料「说话镜说话人不可见」的归因账目（不改数据，只测量）
   身份判据独立于 avgwire：imgPath 家族 = 去掉 `_avg` 尾后按 `_` 切词列，
   两家族互为前缀 ⇒ 同一角色（croque ⊂ croque_kid ⊂ croque_kid2）。 */
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

const only = process.argv[2];
const tot = {segs: 0, shots: 0, speak: 0, invis: 0, invisNoLane: 0, invisLane0: 0,
  invisWrongPath: 0, segsAffected: 0, danglingConflict: 0, danglingConflictSegs: 0};
const perSeg = [];
const samples = [];
const conflictSamples = [];

for (const s of man.stories) {
  if (only && s.id !== only) continue;
  let raw, lang;
  try {
    raw = toJS(execChunk(parseChunk(readFileSync(join(ROOT, s.cfg))))[0]);
    lang = toJS(execChunk(parseChunk(readFileSync(join(ROOT, s.lang))))[0]);
  } catch { continue; }
  const rawShots = raw.shots ?? raw;
  if (!rawShots) continue;
  tot.segs++;

  /* —— 原数据侧：本段声明过的 imgId、悬空 tween id、说话人集合 —— */
  const declared = new Map();                 // imgId → path（本段声明）
  const tweenIds = new Set();
  const speakers = new Set();
  for (const k of Object.keys(rawShots)) {
    const sh = rawShots[k] ?? {};
    if (sh.speakerHeroId !== undefined && sh.speakerHeroId !== null) speakers.add(String(sh.speakerHeroId));
    for (const im of list(sh.images)) {
      if (!im) continue;
      if (im.delete) { declared.delete(im.imgId); continue; }
      if (im.imgPath && im.imgType === 3) declared.set(im.imgId, im.imgPath);
    }
    for (const t of list(sh.imgTween)) if (t?.imgId !== undefined) tweenIds.add(t.imgId);
  }
  const dangling = [...tweenIds].filter((id) => !declared.has(id) && man.imgIds[String(id)]);
  /* 悬空 id 的全局估计路径与本段某说话人的桥表路径同族但不等 ⇒ 身份歧义 */
  let segConflict = 0;
  for (const id of dangling) {
    const est = stem(man.imgIds[String(id)]);
    for (const hid of speakers) {
      const p = man.heroSprites[hid];
      if (!p) continue;
      const sp = stem(p);
      if (fam(est, sp) && man.imgIds[String(id)] !== p) {
        segConflict++;
        if (conflictSamples.length < 25) {
          conflictSamples.push(`${s.id} imgId=${id} 全局=${man.imgIds[String(id)]} 本段说话人 hid=${hid} 桥表=${p}`);
        }
      }
    }
  }
  tot.danglingConflict += segConflict;
  if (segConflict) tot.danglingConflictSegs++;

  /* —— 走 wire 后逐镜测量说话人可见度（家族判据，不看 claimed）—— */
  const {wire} = storyToWire(raw, lang, {imgIds: man.imgIds, heroSprites: man.heroSprites, pathOwner: man.pathOwner});
  const st = emptyState();
  const pathOf = new Map();
  let segSpeak = 0, segInvis = 0, noLane = 0, lane0 = 0, wrongPath = 0;
  for (const k of Object.keys(wire).sort((a, b) => +a - +b)) {
    const sh = wire[k];
    if (!sh || typeof sh !== 'object') continue;
    tot.shots++;
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
    segSpeak++;
    const bs = stem(base);
    const mine = [...st.lanes].filter(([id]) => { const p = pathOf.get(id); return p && fam(bs, stem(p)); });
    if (mine.some(([, l]) => (l.alpha ?? 0) > 0)) continue;
    segInvis++;
    if (!mine.length) {
      noLane++;
      /* 有别的家族件在台但说话人这件从未注册 ⇒ 身份/路径没接上 */
      const litOther = [...st.lanes].filter(([id, l]) => (l.alpha ?? 0) > 0 && pathOf.get(id));
      if (samples.length < 30 && litOther.length === 0) {
        samples.push(`${s.id}#${k} hid=${hid}(${base}) 无 lane；本段立绘注册=[${[...declared].map(([i, p]) => `${i}:${p}`).join(' ') || '空'}]`);
      }
    } else if (mine.every(([, l]) => (l.alpha ?? 0) <= 0)) lane0++;
  }
  tot.speak += segSpeak; tot.invis += segInvis;
  tot.invisNoLane += noLane; tot.invisLane0 += lane0; tot.invisWrongPath += wrongPath;
  if (segInvis) { perSeg.push({id: s.id, speak: segSpeak, invis: segInvis, noLane, lane0}); tot.segsAffected++; }
}

console.log(JSON.stringify(tot, null, 1));
console.log(`说话镜不可见占比 ${(tot.invis / tot.speak * 100).toFixed(2)}%`);
perSeg.sort((a, b) => b.invis - a.invis);
console.log('--- 重灾段 top 30（按不可见镜数）---');
perSeg.slice(0, 30).forEach((r) => console.log(`  ${r.id} 说话镜${r.speak} 不可见${r.invis} (无lane ${r.noLane} / laneα0 ${r.lane0})`));
console.log('--- 无 lane 样本 ---');
samples.forEach((x) => console.log('  · ' + x));
console.log('--- 悬空 id 身份歧义样本 ---');
conflictSamples.forEach((x) => console.log('  · ' + x));
