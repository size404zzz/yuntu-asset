/* 重算「作者在自己说话镜把她淡出」的条数（D6 靠这个数区分画外音与丢揭示）。 */
import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {parseChunk} from './js/core/lundump.js';
import {execChunk, toJS} from './js/core/lvm.js';
import {storyToWire, replayChain} from './js/core/avgwire.js';
const ROOT = resolve(process.cwd());
const manifest = JSON.parse(readFileSync('data/index/avg-scripts.json', 'utf8'));
const dec = (p) => toJS(execChunk(parseChunk(readFileSync(join(ROOT, p))))[0]);
const list = (x) => (Array.isArray(x) ? x : x && typeof x === 'object' ? Object.values(x) : []);
const asPaths = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
let totalOut = 0, onOwnShot = 0, ownShotTotal = 0, speakerShots = 0;
let entrance = 0, autoLit = 0, exit = 0, storiesWithEntrance = 0;
const top = [];
for (const s of manifest.stories) {
  const raw = dec(s.cfg);
  /* 声明表：imgId → imgPath（按镜序，后写覆盖） */
  const keys = Object.keys(raw).filter((k) => /^-?\d+$/.test(k)).map(Number).sort((a, b) => a - b);
  const shift = keys[0] === 0 ? 1 : 0;
  const pathOf = new Map();
  const byKey = new Map();
  for (const k of keys) {
    const act = raw[String(k)];
    if (!act || typeof act !== 'object') continue;
    byKey.set(k + shift, act);
    for (const im of list(act.images)) { if (im && !im.delete && im.imgPath) pathOf.set(im.imgId, im.imgPath); else if (im?.delete) pathOf.delete(im.imgId); }
    let out = 0;
    for (const t of list(act.imgTween)) {
      if (!t || t.alpha !== 0 || !(t.duration > 0)) continue;
      out++; totalOut++;
      const hero = act.speakerHeroId ?? 2;
      const hers = new Set(asPaths(manifest.heroSprites[hero] ?? manifest.heroSprites[String(hero)]).flatMap((p) => asPaths(p)));
      if ((act.contentType ?? 2) === 3 && hers.has(pathOf.get(t.imgId))) { onOwnShot++; }
    }
    if ((act.contentType ?? 2) === 3 && act.speakerHeroId != null) { speakerShots++; if (out) ownShotTotal++; }
  }
  const {stats} = storyToWire(dec(s.cfg), dec(s.lang), {imgIds: manifest.imgIds,
    heroSprites: manifest.heroSprites, pathOwner: manifest.pathOwner});
  entrance += stats.entranceLit ?? 0; autoLit += stats.autoLit ?? 0; exit += stats.entranceExit ?? 0;
  if (stats.entranceLit) { storiesWithEntrance++; top.push([s.id, stats.entranceLit]); }
}
top.sort((a, b) => b[1] - a[1]);
console.log(`α0 且 duration>0 的淡出条目：${totalOut} 条；其中落在「她本人说话镜」的 ${onOwnShot} 条（D6 当时记的是 198）`);
console.log(`说话镜（contentType 3 且有 speakerHeroId）${speakerShots} 个，其中作者自己写了她淡出的 ${ownShotTotal} 个`);
console.log(`修复层实际改动：入场点亮 ${entrance}（${storiesWithEntrance} 段）· 复亮 ${autoLit} · 收场 ${exit}`);
console.log('入场最多的段:', top.slice(0, 8).map(([id, n]) => `${id}×${n}`).join(' '));
