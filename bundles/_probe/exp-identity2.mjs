/* 一次性实验 v2：立绘身份表的选型测量（基线 = 换表前的索引 bundles/_probe/old-man.json）。
   信号对比：
     lit   = 「谁说话时这张件亮着」（会被同台聆听者污染）
     reveal= 「作者把这张件从 α≤0 揭示到 α>0 时，本镜说话人是谁」
   候选规则：
     R  纯 reveal 严格占优（tot≥3、share≥0.4、top≥1.5×次名）
     RM R + 每人补一个 lit 众数件（该件没被别人严格占有时）
     M  只用 lit 众数（旧表口径）
   悬空槽位身份：候选按声明票数降序，取第一个「归属人在本段说过话」的。
   M1 = 说话镜但屏上无任何立绘（身份无关，就是用户报的「没有立绘」）
   M2 = 说话镜但说话人自己的件不可见
   D  = 同族两件同屏（我们造成的，越少越好） */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const ROOT = 'C:/Users/Administrator/Documents/GitHub/yuntu-asset';
const {parseChunk} = await import(pathToFileURL(ROOT + '/js/core/lundump.js').href);
const {execChunk, toJS} = await import(pathToFileURL(ROOT + '/js/core/lvm.js').href);
const {storyToWire} = await import(pathToFileURL(ROOT + '/js/core/avgwire.js').href);
const {emptyState, applyImages, applyShotTweens} = await import(pathToFileURL(ROOT + '/js/core/state.js').href);

const OLD = JSON.parse(readFileSync(join(ROOT, 'bundles/_probe/old-man.json'), 'utf8'));
const list = (x) => (Array.isArray(x) ? x : Object.values(x ?? {}));
const stem = (p) => String(p ?? '').replace(/^.*\//, '').replace(/^lpic_/, '')
    .replace(/\.png$/, '').replace(/_avg\d*$/, '').split('_');
const sameFam = (a, b) => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true;
};

const segs = [];
for (const s of OLD.stories) {
  try {
    const raw = toJS(execChunk(parseChunk(readFileSync(join(ROOT, s.cfg))))[0]);
    const lang = toJS(execChunk(parseChunk(readFileSync(join(ROOT, s.lang))))[0]);
    const shots = raw.shots ?? raw;
    if (shots) segs.push({s, raw, lang, shots});
  } catch { /* 解码失败段跳过 */ }
}
console.log('解码成功段', segs.length);

/* ── 投票 ── */
const litVotes = new Map();       // hid → Map(path → {lit, dark})
const revByPath = new Map();      // path → Map(hid → n)
const declVotes = new Map();      // slot → Map(path → n)
for (const seg of segs) {
  const {wire} = storyToWire(seg.raw, seg.lang);
  const st = emptyState();
  const pathOf = new Map();
  for (const k of Object.keys(wire)) {
    const sh = wire[k];
    for (const im of list(sh.images)) {
      if (im?.imgPath && !im.delete) {
        pathOf.set(im.imgId, im.imgPath);
        if (im.imgType === 3) {
          const t = declVotes.get(im.imgId) ?? new Map();
          declVotes.set(im.imgId, t);
          t.set(im.imgPath, (t.get(im.imgPath) ?? 0) + 1);
        }
      } else if (im?.delete) pathOf.delete(im.imgId);
    }
    applyImages(st, list(sh.images));
    const before = new Map([...st.lanes].map(([i, l]) => [i, l.alpha ?? 0]));
    applyShotTweens(st, {...sh, imgTween: list(sh.imgTween)});
    const hid = sh.speakerHeroId;
    if (hid === undefined || hid === null) continue;
    const vm = litVotes.get(hid) ?? new Map();
    litVotes.set(hid, vm);
    for (const [imgId, lane] of st.lanes) {
      const p = pathOf.get(imgId);
      if (!p || (lane.alpha ?? 0) <= 0) continue;
      const c = vm.get(p) ?? {lit: 0, dark: 0};
      c[lane.isDark ? 'dark' : 'lit']++;
      vm.set(p, c);
      if ((before.get(imgId) ?? 0) > 0) continue;
      const r = revByPath.get(p) ?? new Map();
      revByPath.set(p, r);
      r.set(String(hid), (r.get(String(hid)) ?? 0) + 1);
    }
  }
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
  seg.dangling = [...tweened].filter((id) => !decl.has(id));
  seg.speakers = new Set();
  for (const k of Object.keys(seg.shots)) {
    const h = seg.shots[k]?.speakerHeroId;
    if (h !== undefined && h !== null) seg.speakers.add(String(h));
  }
}

/* ── 规则 ── */
const strictOwner = new Map();    // path → hid
for (const [p, m] of revByPath) {
  const ranked = [...m].sort((a, b) => b[1] - a[1]);
  const tot = ranked.reduce((a, [, c]) => a + c, 0);
  const [top, second] = [ranked[0], ranked[1]];
  if (tot >= 3 && top[1] / tot >= 0.4 && top[1] >= (second?.[1] ?? 0) * 1.5) {
    strictOwner.set(p, top[0]);
  }
}
const modeOf = new Map();         // hid → lit 众数件（旧表口径的门）
const modeOfNoDark = new Map();   // hid → lit 众数件（去掉暗票门）
for (const [hid, m] of litVotes) {
  const best = [...m].sort((a, b) => b[1].lit - a[1].lit)[0];
  if (!best) continue;
  if (best[1].lit >= 3 && best[1].lit >= best[1].dark * 2) modeOf.set(String(hid), best[0]);
  if (best[1].lit >= 3) modeOfNoDark.set(String(hid), best[0]);
}
const tables = {};
const ownedBy = new Map();
for (const [p, h] of strictOwner) {
  if (!ownedBy.has(h)) ownedBy.set(h, []);
  ownedBy.get(h).push([p, revByPath.get(p).get(h)]);
}
tables.R = {};
for (const [h, l] of ownedBy) {
  tables.R[h] = l.sort((a, b) => b[1] - a[1]).map(([p]) => p);
}
const tables3 = {...tables.R};
for (const [h, p] of modeOfNoDark) tables3[h] = [...new Set([p, ...(tables3[h] ?? [])])];
tables.RM = {...tables.R};
for (const [h, p] of modeOf) {
  if (strictOwner.get(p) && strictOwner.get(p) !== h) continue;   // 别人的件不占
  tables.RM[h] = [...new Set([p, ...(tables.RM[h] ?? [])])];
}
tables.M = {};
for (const [h, p] of modeOf) tables.M[h] = [p];
tables.M2 = {};
for (const [h, p] of modeOfNoDark) tables.M2[h] = [p];
tables.RM2 = {...tables.R};
for (const [h, p] of modeOfNoDark) {
  if (strictOwner.get(p) && strictOwner.get(p) !== h) continue;   // 别人的件不占
  tables.RM2[h] = [...new Set([p, ...(tables.RM2[h] ?? [])])];
}
tables.RM3 = tables3;
const litAll = new Map();
for (const [hid, m] of litVotes) {
  const keep = [...m].filter(([, c]) => c.lit >= 3 && c.lit >= c.dark * 2)
      .sort((a, b) => b[1].lit - a[1].lit).map(([p]) => p);
  if (keep.length) litAll.set(String(hid), keep);
}
tables.L = Object.fromEntries(litAll);
const litAllNoGate = new Map();
for (const [hid, m] of litVotes) {
  const keep = [...m].filter(([, c]) => c.lit >= 3)
      .sort((a, b) => b[1].lit - a[1].lit).map(([p2]) => p2);
  if (keep.length) litAllNoGate.set(String(hid), keep);
}
tables.L2 = Object.fromEntries(litAllNoGate);
tables.LR2 = {};
for (const h of new Set([...Object.keys(tables.L2), ...Object.keys(tables.R)])) {
  tables.LR2[h] = [...new Set([...(tables.L2[h] ?? []), ...(tables.R[h] ?? [])])];
}
tables.LR = {};
for (const h of new Set([...Object.keys(tables.L), ...Object.keys(tables.R)])) {
  tables.LR[h] = [...new Set([...(tables.L[h] ?? []), ...(tables.R[h] ?? [])])];
}
tables.U = {};
for (const h of new Set([...Object.keys(tables3), ...Object.keys(OLD.heroSprites)])) {
  tables.U[h] = [...new Set([...(tables3[h] ?? []),
    ...[].concat(OLD.heroSprites[h] ?? []).filter(Boolean)])];
}
for (const k of ['R', 'L', 'L2', 'LR', 'LR2', 'RM3', 'U']) {
  console.log(`规则 ${k}: ${Object.keys(tables[k]).length} 人 · 多件 `
      + `${Object.values(tables[k]).filter((a) => a.length > 1).length}`);
}

/* ── 悬空槽位候选表（票数降序）── */
const imgIdsNew = {};
for (const [slot, m] of declVotes) {
  const ranked = [...m].sort((a, b) => b[1] - a[1]);
  if ((OLD.imgIds[slot] ? 1 : 0) && ranked[0][1] > 0) imgIdsNew[slot] = ranked.map(([p]) => p);
}
const ownersOf = (tbl) => {
  const o = new Map();
  for (const [h, ps] of Object.entries(tbl)) for (const p of ps) {
    if (!o.has(p)) o.set(p, new Set());
    o.get(p).add(String(h));
  }
  return o;
};
const strictOwners = new Map();      // path → Set(hid)，只认严格 reveal 归属（身份创建侧要准）
for (const [p, h] of strictOwner) {
  if (!strictOwners.has(p)) strictOwners.set(p, new Set());
  strictOwners.get(p).add(h);
}
const arbiter = (seg, tbl, ownerMap) => {
  const o = ownerMap ?? ownersOf(tbl);
  const out = {};
  for (const slot of seg.dangling) {
    const alts = imgIdsNew[slot];
    if (!alts?.length) continue;
    out[slot] = alts.find((p) => [...(o.get(p) ?? [])].some((h) => seg.speakers.has(h))) ?? alts[0];
  }
  return out;
};

/* ── 双件同屏（同族不同路径同时亮）── */
const famKey = new Map();
function family(p) {
  const k = stem(p).join('_');
  if (famKey.has(k)) return famKey.get(k);
  let best = k;
  for (const other of famKey.values()) {
    if (other !== k && (k.startsWith(other + '_') || other.startsWith(k + '_'))) {
      if (other.length < best.length) best = other;
    }
  }
  famKey.set(k, best);
  return best;
}

function measure(label, {imgIds, tbl, arb, owner}) {
  const r = {speak: 0, m1: 0, m2: 0, dual: 0, perSeg: new Map()};
  for (const seg of segs) {
    const over = arb ? arbiter(seg, tbl, owner) : null;
    const ids = over && Object.keys(over).length ? {...imgIds, ...over} : imgIds;
    const {wire} = storyToWire(seg.raw, seg.lang, {imgIds: ids, heroSprites: tbl});
    const st = emptyState();
    const pathOf = new Map();
    let speak = 0, m1 = 0, m2 = 0, dual = 0;
    for (const k of Object.keys(wire).sort((a, b) => +a - +b)) {
      const sh = wire[k];
      for (const im of list(sh.images)) {
        if (im?.imgPath && !im.delete) pathOf.set(im.imgId, im.imgPath);
        else if (im?.delete) pathOf.delete(im.imgId);
      }
      applyImages(st, list(sh.images));
      applyShotTweens(st, {...sh, imgTween: list(sh.imgTween)});
      const lit = [...st.lanes].filter(([, l]) => (l.alpha ?? 0) > 0);
      const byFam = new Map();
      for (const [id] of lit) {
        const p = pathOf.get(id);
        if (!p || !p.endsWith('_avg')) continue;
        const f = family(p);
        if (!byFam.has(f)) byFam.set(f, new Set());
        byFam.get(f).add(p);
      }
      for (const s of byFam.values()) if (s.size > 1) dual++;
      const hid = sh.speakerHeroId;
      if (hid === undefined || hid === null) continue;
      speak++;
      if (!lit.length) m1++;
      const mine = tbl[String(hid)] ?? [];
      if (!lit.some(([id]) => mine.includes(pathOf.get(id)))) m2++;
    }
    r.speak += speak; r.m1 += m1; r.m2 += m2; r.dual += dual;
    r.perSeg.set(seg.s.id, {speak, m1, m2, dual});
  }
  console.log(`${label}: 说话镜 ${r.speak} · 屏上无立绘 ${r.m1} (${(r.m1 / r.speak * 100).toFixed(2)}%)`
      + ` · 说话人不可见 ${r.m2} (${(r.m2 / r.speak * 100).toFixed(2)}%) · 同族双件同屏 ${r.dual}`);
  return r;
}

/* —— 自举第二遍：用 v1 表跑完整映射链，再在「修好的」wire 上数亮票 ——
   退役的 revealNeverVisibleCast 当年就是靠这个把桥表喂肥的；这里把它换成
   显式的一次不动点迭代。v2 = v1 ∪ 第二遍新增的亮票件（仍要求 lit ≥3）。 */
const litVotes2 = new Map();
for (const seg of segs) {
  const over = arbiter(seg, tables.LR2, strictOwners);
  const ids = Object.keys(over).length ? {...OLD.imgIds, ...over} : OLD.imgIds;
  const {wire} = storyToWire(seg.raw, seg.lang, {imgIds: ids, heroSprites: tables.LR2});
  const st = emptyState();
  const pathOf = new Map();
  for (const k of Object.keys(wire)) {
    const sh = wire[k];
    for (const im of list(sh.images)) {
      if (im?.imgPath && !im.delete) pathOf.set(im.imgId, im.imgPath);
      else if (im?.delete) pathOf.delete(im.imgId);
    }
    applyImages(st, list(sh.images));
    applyShotTweens(st, {...sh, imgTween: list(sh.imgTween)});
    const hid = sh.speakerHeroId;
    if (hid === undefined || hid === null) continue;
    const vm = litVotes2.get(String(hid)) ?? new Map();
    litVotes2.set(String(hid), vm);
    for (const [imgId, lane] of st.lanes) {
      const p = pathOf.get(imgId);
      if (!p || (lane.alpha ?? 0) <= 0) continue;
      vm.set(p, (vm.get(p) ?? 0) + 1);
    }
  }
}
tables.V2 = {};
for (const h of new Set([...Object.keys(tables.LR2), ...litVotes2.keys()])) {
  const add = [...(litVotes2.get(h) ?? [])].filter(([, c]) => c >= 3)
      .sort((a, b) => b[1] - a[1]).map(([p]) => p);
  tables.V2[h] = [...new Set([...add, ...(tables.LR2[h] ?? [])])];
}
console.log(`规则 V2 自举: ${Object.keys(tables.V2).length} 人 · 多件 `
    + `${Object.values(tables.V2).filter((a) => a.length > 1).length}`);
const vV2 = measure('V2+严仲裁 自举第二遍亮票 ∪ LR2', {imgIds: OLD.imgIds, tbl: tables.V2, arb: true, owner: strictOwners});

const base = measure('V0 旧表（lit 众数 + 全局槽位）',
    {imgIds: OLD.imgIds, tbl: Object.fromEntries(Object.entries(OLD.heroSprites).map(([h, p]) => [h, [p]])), arb: false});
const v3 = measure('RM3+仲裁 众数件不受否决 + 就地仲裁', {imgIds: OLD.imgIds, tbl: tables.RM3, arb: true});
const vU = measure('U+仲裁 上界：再并旧表件 + 就地仲裁', {imgIds: OLD.imgIds, tbl: tables.U, arb: true});
const vL = measure('L+仲裁 密 lit 票（每人全部过门件）+ 就地仲裁', {imgIds: OLD.imgIds, tbl: tables.L, arb: true});
const vLR = measure('LR+仲裁 密 lit 票 ∪ 严格 reveal + 就地仲裁', {imgIds: OLD.imgIds, tbl: tables.LR, arb: true});
const vL2 = measure('LR2+严仲裁 亮票不设暗率门 ∪ 严格 reveal', {imgIds: OLD.imgIds, tbl: tables.LR2, arb: true, owner: strictOwners});
const vLS = measure('LR+严仲裁 密 want 集，但槽位身份只认严格 reveal', {imgIds: OLD.imgIds, tbl: tables.LR, arb: true, owner: strictOwners});

for (const [label, x] of [['RM3+仲裁', v3], ['U+仲裁', vU], ['L+仲裁', vL], ['LR+仲裁', vLR], ['LR+严仲裁', vLS], ['LR2+严仲裁', vL2], ['V2+严仲裁', vV2]]) {
  const better = [], worse = [];
  for (const [id, y] of base.perSeg) {
    const z = x.perSeg.get(id);
    if (z.m1 < y.m1) better.push(`${id} ${y.m1}→${z.m1}`);
    else if (z.m1 > y.m1) worse.push(`${id} ${y.m1}→${z.m1}`);
  }
  console.log(`${label}: 按「屏上无立绘」变好 ${better.length} 段 / 变差 ${worse.length} 段`);
  if (worse.length) console.log('   变差:', worse.slice(0, 12).join(' | '));
  if (label === 'V2+严仲裁') {
    const d = (x) => { const m = /(\d+)→(\d+)/.exec(x); return Number(m[2]) - Number(m[1]); };
    const w = worse.sort((a, b) => d(b) - d(a));
    console.log('   变差全量（按增幅降序）:', w.join(' | '));
    const b = better.sort((a, x) => d(a) - d(x));
    console.log('   变好 top20（按减幅降序）:', b.slice(0, 20).join(' | '));
  }
}
for (const id of ['22child_02', 'cpt_olivia_00', '23summer_s03', 'cpt_inola_01', 'end_00']) {
  console.log(`  ${id}: V0 ${JSON.stringify(base.perSeg.get(id))} → RM3 ${JSON.stringify(v3.perSeg.get(id))} → LR严 ${JSON.stringify(vLS.perSeg.get(id))} → LR2严 ${JSON.stringify(vL2.perSeg.get(id))} → V2 ${JSON.stringify(vV2.perSeg.get(id))}`);
}
