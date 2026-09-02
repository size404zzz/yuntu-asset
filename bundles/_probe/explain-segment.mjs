/* 一次性探针：逐段解释「说话人为什么不现身」。
   用法 node bundles/_probe/explain-segment.mjs <segId> [--fade] */
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

const id = process.argv[2];
const wantFade = process.argv.includes('--fade');
const s = man.stories.find((x) => x.id === id);
if (!s) { console.log('no such segment'); process.exit(1); }
const raw = toJS(execChunk(parseChunk(readFileSync(join(ROOT, s.cfg))))[0]);
const lang = toJS(execChunk(parseChunk(readFileSync(join(ROOT, s.lang))))[0]);
const rawShots = raw.shots ?? raw;
const shift = '0' in rawShots ? 1 : 0;
const keys = Object.keys(rawShots).sort((a, b) => +a - +b);

/* 本段声明 / 悬空 tween / 说话人 */
const declared = new Map();
const tweens = new Map();          // imgId → [{key, alpha, duration, isDark, speaker}]
const shotSpeaker = new Map();
for (const k of keys) {
  const sh = rawShots[k] ?? {};
  const hid = sh.speakerHeroId;
  shotSpeaker.set(+k + shift, hid === undefined || hid === null ? null : String(hid));
  for (const im of list(sh.images)) {
    if (!im) continue;
    if (im.delete) { declared.delete(im.imgId); continue; }
    if (im.imgPath && im.imgType === 3) declared.set(im.imgId, im.imgPath);
  }
  for (const t of list(sh.imgTween)) {
    if (!t || t.imgId === undefined) continue;
    if (!tweens.has(t.imgId)) tweens.set(t.imgId, []);
    tweens.get(t.imgId).push({key: +k + shift, alpha: t.alpha, duration: t.duration,
      isDark: t.isDark, hid: shotSpeaker.get(+k + shift)});
  }
}
const speakerCount = new Map();
for (const hid of shotSpeaker.values()) {
  if (hid) speakerCount.set(hid, (speakerCount.get(hid) ?? 0) + 1);
}
console.log(`段 ${id}：${keys.length} 镜 · 说话人 ${[...speakerCount].map(([h, n]) => `${h}×${n}`).join(' ')}`);
console.log('说话人桥表：', [...speakerCount].map(([h]) => `${h}=${man.heroSprites[h] ?? '?'}`).join(' '));
console.log('本段 images[] 立绘声明：', [...declared].map(([i, p]) => `${i}:${p}`).join(' ') || '(无)');
console.log('tween 引用：');
for (const [imgId, es] of [...tweens].sort((a, b) => a[0] - b[0])) {
  const decl = declared.get(imgId);
  const est = man.imgIds[String(imgId)];
  const famOf = (p) => (p ?? '?');
  let tag = decl ? '本段声明' : (est ? `悬空→全局=${est}` : '悬空且表外');
  /* 淡出条目落在谁的镜 */
  const fades = es.filter((e) => e.alpha === 0 && (e.duration ?? 0) > 0);
  const byHid = new Map();
  for (const f of fades) byHid.set(f.hid ?? '-', (byHid.get(f.hid ?? '-') ?? 0) + 1);
  console.log(`  imgId=${imgId} ${tag} 条目${es.length} α轨迹[${es.map((e) => `${e.key}:a${e.alpha}/d${e.duration}`).join(' ')}]`
    + (fades.length ? ` 淡出落在镜的说话人 ${[...byHid].map(([h, n]) => `${h}×${n}`).join(',')}` : ''));
}
if (wantFade) {
  console.log('--- 全部淡出条目（α0 + duration>0）落在谁的说话镜 ---');
  for (const [imgId, es] of [...tweens].sort((a, b) => a[0] - b[0])) {
    for (const e of es) if (e.alpha === 0 && (e.duration ?? 0) > 0) {
      console.log(`  imgId=${imgId}(${declared.get(e.imgId) ?? man.imgIds[String(imgId)]}) key=${e.key} 本镜说话人=${e.hid ?? '旁白'}`);
    }
  }
}

/* wire 后逐镜可见度 */
const {wire} = storyToWire(raw, lang, {imgIds: man.imgIds, heroSprites: man.heroSprites, pathOwner: man.pathOwner});
const st = emptyState();
const pathOf = new Map();
let speak = 0, invis = 0;
const bad = [];
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
  if (bad.length < 40) bad.push(`  #${k} hid=${hid}(${base}) lanes=${mine.map(([i, l]) => `${i}:${pathOf.get(i)}=a${l.alpha}`).join(' ') || '无'}`);
}
console.log(`--- 映射后：说话镜 ${speak}，不可见 ${invis} ---`);
bad.forEach((x) => console.log(x));
