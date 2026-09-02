/* 一次性实验：用「语料投票的身份表」替换命名前缀启发，测说话镜不可见率。
   两张表（都从「谁说话时哪张立绘亮着」投票，但取相反的边际）：
     pathOwner[P] = argmax_H votes(P,H)   —— 这张立绘是谁（跨立绘说话人众数）
     heroPaths[H] = {P : pathOwner[P]==H} ∪ {heroSprites[H]}  —— 这个人有哪些立绘
   悬空槽位身份：候选 = 全语料该槽声明过的路径；打分 =
     本段有说话人 owns 该路径 ? 1 : 0 → 同剧情组票数 → 全局票数。
   M1 = 说话镜但屏上无任何立绘；M2 = 说话镜但说话人立绘不可见（身份=pathOwner）。 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const ROOT = 'C:/Users/Administrator/Documents/GitHub/yuntu-asset';
const {parseChunk} = await import(pathToFileURL(ROOT + '/js/core/lundump.js').href);
const {execChunk, toJS} = await import(pathToFileURL(ROOT + '/js/core/lvm.js').href);
const {storyToWire} = await import(pathToFileURL(ROOT + '/js/core/avgwire.js').href);
const {emptyState, applyImages, applyShotTweens} = await import(pathToFileURL(ROOT + '/js/core/state.js').href);

const man = JSON.parse(readFileSync(join(ROOT, 'data/index/avg-scripts.json'), 'utf8'));
const NOGROUP = process.argv.includes('--nogroup');
const list = (x) => (Array.isArray(x) ? x : Object.values(x ?? {}));
const group = (id) => {
  let m = /^(.*?)_(?:0*\d+)$/.exec(id); if (m) return m[1];
  m = /^(.*?[a-z])0*(\d+)$/.exec(id); if (m) return m[1];
  return id;
};
const idx = (id) => { const m = /(\d+)$/.exec(id); return m ? Number(m[1]) : 0; };

/* ── 1) 解码一次，收集：投票语料（无注入的裸 fold）+ 每段声明 ── */
const segs = [];
for (const s of man.stories) {
  try {
    const raw = toJS(execChunk(parseChunk(readFileSync(join(ROOT, s.cfg))))[0]);
    const lang = toJS(execChunk(parseChunk(readFileSync(join(ROOT, s.lang))))[0]);
    const shots = raw.shots ?? raw;
    if (!shots) continue;
    segs.push({s, raw, lang, shots, g: group(s.id), i: idx(s.id)});
  } catch { /* 解码失败段跳过 */ }
}
console.log('解码成功段', segs.length);

const votes = new Map();            // path → Map(hid → {lit, dark})
const revealVotes = new Map();      // path → Map(hid → n)  只数「揭示跳变」α≤0 → α>0
const declVotes = new Map();        // slot → Map(path → n)  （全局声明票数）
const groupDecl = new Map();        // group → Map(slot → Map(path → n))
for (const seg of segs) {
  /* 投票用裸 fold：不注入悬空、不补揭示（与 build-asset-index 同口径） */
  const {wire} = storyToWire(seg.raw, seg.lang);
  const st = emptyState();
  const pathOf = new Map();
  const own = new Map();
  for (const k of Object.keys(wire).sort((a, b) => +a - +b)) {
    const sh = wire[k];
    for (const im of list(sh.images)) {
      if (im?.imgPath && !im.delete) {
        pathOf.set(im.imgId, im.imgPath);
        own.set(im.imgId, im.imgPath);
        if (im.imgType === 3) {
          const gm = groupDecl.get(seg.g) ?? new Map(); groupDecl.set(seg.g, gm);
          const t = gm.get(im.imgId) ?? new Map(); gm.set(im.imgId, t);
          t.set(im.imgPath, (t.get(im.imgPath) ?? 0) + 1);
          const gt = declVotes.get(im.imgId) ?? new Map(); declVotes.set(im.imgId, gt);
          gt.set(im.imgPath, (gt.get(im.imgPath) ?? 0) + 1);
        }
      } else if (im?.delete) pathOf.delete(im.imgId);
    }
    applyImages(st, list(sh.images));
    const before = new Map([...st.lanes].map(([i, l]) => [i, l.alpha ?? 0]));
    applyShotTweens(st, {...sh, imgTween: list(sh.imgTween)});
    const hid = sh.speakerHeroId;
    if (hid === undefined || hid === null) continue;

    for (const [imgId, lane] of st.lanes) {
      const p = pathOf.get(imgId);
      if (!p || (lane.alpha ?? 0) <= 0) continue;
      const t = (votes.get(p) ?? new Map());
      const c = t.get(String(hid)) ?? {lit: 0, dark: 0};
      c[lane.isDark ? 'dark' : 'lit']++;
      t.set(String(hid), c);
      votes.set(p, t);
      if ((before.get(imgId) ?? 0) > 0) continue;      // 只数揭示跳变
      const r = (revealVotes.get(p) ?? new Map());
      r.set(String(hid), (r.get(String(hid)) ?? 0) + 1);
      revealVotes.set(p, r);
    }
  }
  /* 每段的「当前声明表」与「tween 引用槽」 */
  const decl = new Map();
  const tweened = new Set();
  for (const k of Object.keys(seg.shots).sort((a, b) => +a - +b)) {
    for (const im of list(seg.shots[k]?.images)) {
      if (!im) continue;
      if (im.delete) { decl.delete(im.imgId); continue; }
      if (im.imgPath && im.imgType === 3) decl.set(im.imgId, im.imgPath);
    }
    for (const t of list(seg.shots[k]?.imgTween)) if (t?.imgId !== undefined) tweened.add(t.imgId);
  }
  seg.decl = decl;
  seg.speakers = new Set();
  for (const k of Object.keys(seg.shots)) {
    const h = seg.shots[k]?.speakerHeroId;
    if (h !== undefined && h !== null) seg.speakers.add(String(h));
  }
  seg.dangling = [...tweened].filter((id) => !decl.has(id));
}

/* ── 2) 身份表 ── */
const OWNER = (process.argv.find((a) => a.startsWith('--owner=')) ?? '').slice(8) || 'hybrid';
const pathOwner = new Map();
const pathShare = new Map();
const litOf = (m) => [...m.values()].reduce((a, c) => a + (typeof c === 'number' ? c : c.lit), 0);
const topOf = (m) => [...m].sort((a, b) =>
    (typeof b[1] === 'number' ? b[1] : b[1].lit) - (typeof a[1] === 'number' ? a[1] : a[1].lit))[0];
const count = (c) => (typeof c === 'number' ? c : c.lit);
for (const [p, m] of votes) {
  const rm = revealVotes.get(p);
  const rtot = rm ? litOf(rm) : 0;
  const useReveal = OWNER !== 'lit' && rtot >= 3;
  const useLit = OWNER !== 'reveal' && (!useReveal || OWNER === 'lit');
  if (useReveal) {
    const best = topOf(rm);
    if (best && count(best[1]) / rtot >= 0.5) { pathOwner.set(p, best[0]); pathShare.set(p, count(best[1]) / rtot); }
  } else if (useLit) {
    const tot = litOf(m);
    const best = topOf(m);
    if (best && count(best[1]) >= 3 && tot >= 3 && count(best[1]) / tot >= 0.4) {
      pathOwner.set(p, best[0]); pathShare.set(p, count(best[1]) / tot);
    }
  }
}
const heroPaths = new Map();
for (const [p, h] of pathOwner) {
  const a = heroPaths.get(h) ?? []; heroPaths.set(h, a); a.push(p);
}
for (const [h, p] of Object.entries(man.heroSprites)) {
  const a = heroPaths.get(String(h)) ?? []; heroPaths.set(String(h), a);
  if (!a.includes(p)) a.unshift(p);
}
for (const [h, a] of heroPaths) a.sort((x, y) => (y === man.heroSprites[h]) - (x === man.heroSprites[h]));
const heroPathsObj = Object.fromEntries(heroPaths);
console.log(`pathOwner ${pathOwner.size} 张 · heroPaths ${heroPaths.size} 人`
  + `（桥表 ${Object.keys(man.heroSprites).length} 人 → 多出 ${heroPaths.size - Object.keys(man.heroSprites).length}）`);
const extra = [...heroPaths].filter(([, a]) => a.length > 1);
console.log(`多人多件 ${extra.length}，例：`, extra.slice(0, 6).map(([h, a]) => `${h}=[${a.join(',')}]`).join(' '));

/* ── 3) 悬空槽位身份：说话人仲裁 + 组内票数 + 全局票数 ── */
function resolveDangling(seg) {
  const gm = NOGROUP ? null : groupDecl.get(seg.g);
  const out = {};
  for (const slot of seg.dangling) {
    const cands = new Map([...(gm?.get(slot) ?? []), ...(declVotes.get(slot) ?? [])]
        .map(([p]) => [p, null]));
    if (!cands.size) continue;
    const score = (p) => {
      const owner = pathOwner.get(p);
      const speaks = owner && seg.speakers.has(owner) ? 1 : 0;
      return [speaks, gm?.get(slot)?.get(p) ?? 0, declVotes.get(slot)?.get(p) ?? 0, p === man.imgIds[String(slot)] ? 1 : 0];
    };
    const cmp = (a, b) => {
      const x = score(a), y = score(b);
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i];
      return 0;
    };
    const best = [...cands.keys()].sort(cmp)[0];
    if (best && best !== man.imgIds[String(slot)]) out[slot] = best;
  }
  return out;
}

/* ── 4) 两种配置下测 M1/M2 ── */
function measure(label, {est, sprites}) {
  const r = {speak: 0, m1: 0, m2: 0, perSeg: new Map()};
  for (const seg of segs) {
    const over = est ? resolveDangling(seg) : null;
    const imgIds = over && Object.keys(over).length ? {...man.imgIds, ...over} : man.imgIds;
    const {wire} = storyToWire(seg.raw, seg.lang, {imgIds, heroSprites: sprites ? heroPathsObj : man.heroSprites});
    const st = emptyState();
    const pathOf = new Map();
    let speak = 0, m1 = 0, m2 = 0;
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
      speak++;
      const lit = [...st.lanes].filter(([, l]) => (l.alpha ?? 0) > 0);
      if (!lit.length) m1++;
      const mine = (sprites ? (heroPaths.get(String(hid)) ?? []) : [man.heroSprites[String(hid)]].filter(Boolean));
      if (!lit.some(([id]) => mine.includes(pathOf.get(id)))) m2++;
    }
    r.speak += speak; r.m1 += m1; r.m2 += m2;
    r.perSeg.set(seg.s.id, {speak, m1, m2});
  }
  console.log(`${label}: 说话镜 ${r.speak} · 屏上无立绘 ${r.m1} (${(r.m1 / r.speak * 100).toFixed(2)}%)`
    + ` · 说话人不可见 ${r.m2} (${(r.m2 / r.speak * 100).toFixed(2)}%)`);
  return r;
}

const a = measure('V0 现状（全局槽位 + 单路径桥表）', {est: false, sprites: false});
const b = measure('V1 只换身份表（heroPaths）', {est: false, sprites: true});
const c = measure('V2 只换悬空槽位估计', {est: true, sprites: false});
const d = measure('V3 两者都换', {est: true, sprites: true});

for (const [label, x] of [['V1', b], ['V2', c], ['V3', d]]) {
  const better = [], worse = [];
  for (const [id, y] of a.perSeg) {
    const z = x.perSeg.get(id);
    if (z.m2 < y.m2) better.push(`${id} ${y.m2}→${z.m2}`);
    else if (z.m2 > y.m2) worse.push(`${id} ${y.m2}→${z.m2}`);
  }
  console.log(`${label}: 变好段 ${better.length} 变差段 ${worse.length}`);
  console.log('   变差 top10:', worse.sort((p, q) => (q.match(/(\d+)→(\d+)/, '') - 0)).slice(0, 10).join(' | '));
}
console.log('22child_02:', JSON.stringify(a.perSeg.get('22child_02')), '→V3', JSON.stringify(d.perSeg.get('22child_02')));
console.log('cpt_olivia_00:', JSON.stringify(a.perSeg.get('cpt_olivia_00')), '→V3', JSON.stringify(d.perSeg.get('cpt_olivia_00')));
console.log('23summer_s03:', JSON.stringify(a.perSeg.get('23summer_s03')), '→V3', JSON.stringify(d.perSeg.get('23summer_s03')));
