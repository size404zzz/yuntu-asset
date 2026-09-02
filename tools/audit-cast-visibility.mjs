/* 审计：全语料「说话镜有没有立绘」的三本账（换契约后立绘可见度的验收网）。
 *
 * 契约是游戏本体的「说话镜 ⇒ 说话人现身」（plan「契约切换」D6 定案），
 * 所以说话镜的立绘缺失就是缺陷。三本账：
 *   屏上无立绘   该镜一个立绘都没有 —— 用户眼里的「没有立绘」，判据与身份无关；
 *   说话人不可见 有立绘，但没有一件属于本镜说话人 —— 认错人/漏召回；
 *   同族双件同屏 同一角色的两件同时亮 —— 补揭示层的家族不变量被破。
 * 用法：node tools/audit-cast-visibility.mjs [--manifest=<索引>] [--top=15]
 */
import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {parseChunk} from '../js/core/lundump.js';
import {execChunk, toJS} from '../js/core/lvm.js';
import {storyToWire} from '../js/core/avgwire.js';
import {emptyState, applyImages, applyShotTweens} from '../js/core/state.js';

const ROOT = resolve(process.cwd());
const argOf = (name, dflt) =>
    (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? '').split('=')[1] || dflt;
const man = JSON.parse(readFileSync(join(ROOT, argOf('manifest', 'data/index/avg-scripts.json')), 'utf8'));
const TOP = Number(argOf('top', 15));
const list = (x) => (Array.isArray(x) ? x : Object.values(x ?? {}));
const asPaths = (v) => (Array.isArray(v) ? v : (v ? [v] : []));
const stem = (p) => String(p ?? '').replace(/^.*\//, '').replace(/^lpic_/, '')
    .replace(/\.png$/, '').replace(/_avg\d*$/, '');

const tot = {segs: 0, shots: 0, speak: 0, empty: 0, wrong: 0, dual: 0, emptyNoCast: 0};
const perSeg = [];
for (const s of man.stories) {
  let cfg, lang;
  try {
    cfg = toJS(execChunk(parseChunk(readFileSync(join(ROOT, s.cfg))))[0]);
    lang = toJS(execChunk(parseChunk(readFileSync(join(ROOT, s.lang))))[0]);
  } catch { continue; }
  tot.segs++;
  const {wire} = storyToWire(cfg, lang, {
    imgIds: man.imgIds, heroSprites: man.heroSprites, pathOwner: man.pathOwner});
  const st = emptyState();
  const pathOf = new Map();
  const famSeen = new Map();
  let speak = 0, empty = 0, wrong = 0, dual = 0;
  let castRegistered = false;
  for (const k of Object.keys(wire).sort((a, b) => +a - +b)) {
    const sh = wire[k];
    if (!sh || typeof sh !== 'object') continue;
    tot.shots++;
    for (const im of list(sh.images)) {
      if (im?.imgPath && !im.delete) {
        pathOf.set(im.imgId, im.imgPath);
        if (im.imgType === 3) castRegistered = true;
      } else if (im?.delete) pathOf.delete(im.imgId);
    }
    applyImages(st, list(sh.images));
    applyShotTweens(st, {...sh, imgTween: list(sh.imgTween)});
    const lit = [...st.lanes].filter(([, l]) => (l.alpha ?? 0) > 0);
    /* 同族双件：只看立绘（背景路径带 /），同路径重复件是合法双生机 */
    const byFam = new Map();
    for (const [id] of lit) {
      const p = pathOf.get(id);
      if (!p || !p.endsWith('_avg')) continue;
      const k2 = stem(p);
      if (!famSeen.has(k2)) {
        let best = k2;
        for (const other of famSeen.values()) {
          if (other !== k2 && (k2.startsWith(other + '_') || other.startsWith(k2 + '_'))) {
            if (other.length < best.length) best = other;
          }
        }
        famSeen.set(k2, best);
      }
      const fam = famSeen.get(k2);
      if (!byFam.has(fam)) byFam.set(fam, new Set());
      byFam.get(fam).add(k2);
    }
    for (const set of byFam.values()) if (set.size > 1) dual++;
    const hid = sh.speakerHeroId;
    if (hid === undefined || hid === null) continue;
    speak++;
    const mine = asPaths(man.heroSprites[String(hid)]);
    if (!lit.length) { empty++; if (!castRegistered) tot.emptyNoCast++; }
    else if (!lit.some(([id]) => mine.includes(pathOf.get(id)))) wrong++;
  }
  tot.speak += speak; tot.empty += empty; tot.wrong += wrong; tot.dual += dual;
  if (empty) perSeg.push({id: s.id, speak, empty, wrong, dual});
}
const pct = (n, d) => (d ? (n / d * 100).toFixed(2) : '0') + '%';
console.log(`索引 ${argOf('manifest', 'data/index/avg-scripts.json')}`);
console.log(`段 ${tot.segs} · 镜 ${tot.shots} · 说话镜 ${tot.speak}`);
console.log(`  屏上无立绘的说话镜   ${tot.empty} (${pct(tot.empty, tot.speak)})`
    + ` —— 其中本段从未注册任何立绘 ${tot.emptyNoCast}`
    + '（游戏里也没有 item 可现，不是映射层的锅）');
console.log(`  有立绘但不是她       ${tot.wrong} (${pct(tot.wrong, tot.speak)})`);
console.log(`  同族双件同屏的镜次   ${tot.dual}`);
perSeg.sort((a, b) => b.empty - a.empty);
console.log(`--- 屏上无立绘最多的 ${TOP} 段 ---`);
for (const r of perSeg.slice(0, TOP)) {
  console.log(`  ${r.id} 说话镜${r.speak} 无立绘${r.empty} 认错${r.wrong} 双件${r.dual}`);
}
