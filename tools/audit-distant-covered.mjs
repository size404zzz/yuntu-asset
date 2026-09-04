/* 审计：远景层（imgType 1）被「底色」盖住的镜次。
 *
 * 游戏里 img_bg（`UIAVGSystem` f5 L223-230 `ui.img_bg.color = eBgColor[actCfg.bgColor]`）
 * 是五层最底的一张图，远景（eAvgImgType.DistantView=1）在它之上；`bgColor` 只在
 * 声明的那一镜写入，之后一直沿用。播放器如果把底色写在 #avg-bg（= background 容器）
 * 上，黑/白底就会把整个远景层糊掉——23sg 这类「背景全走远景层」的剧本会整段没有背景。
 * 本审计按折叠态量化受影响的镜次。
 * 用法：node tools/audit-distant-covered.mjs [--top=20]
 */
import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {parseChunk} from '../js/core/lundump.js';
import {execChunk, toJS} from '../js/core/lvm.js';
import {storyToWire, replayChain} from '../js/core/avgwire.js';
import {emptyState, applyImages, applyShotTweens} from '../js/core/state.js';

const ROOT = resolve(process.cwd());
const argOf = (name, dflt) =>
    (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? '').split('=')[1] || dflt;
const man = JSON.parse(readFileSync(join(ROOT, 'data/index/avg-scripts.json'), 'utf8'));
const list = (x) => (Array.isArray(x) ? x : Object.values(x ?? {}));
/* eBgColor：1=clear（透明，露出舞台自身底色）2=black 3=white。 */
const OPAQUE = new Set([2, 3]);

const tot = {segs: 0, shots: 0, distantShots: 0, covered: 0, coveredSegs: 0};
const perSeg = [];
for (const s of man.stories) {
  let cfg, lang;
  try {
    cfg = toJS(execChunk(parseChunk(readFileSync(join(ROOT, s.cfg))))[0]);
    lang = toJS(execChunk(parseChunk(readFileSync(join(ROOT, s.lang))))[0]);
  } catch { continue; }
  tot.segs++;
  const {wire} = storyToWire(cfg, lang,
      {imgIds: man.imgIds, heroSprites: man.heroSprites, pathOwner: man.pathOwner});
  const st = emptyState();
  let base = null, shots = 0, distant = 0, covered = 0;
  for (const id of replayChain(wire)) {
    const shot = wire[id] ?? {};
    applyImages(st, list(shot.images));
    applyShotTweens(st, {...shot, imgTween: list(shot.imgTween)});
    if (shot.bgColor !== undefined) base = shot.bgColor;
    shots++;
    const lit = [...st.layers.values()]
        .some((l) => l.imgType === 1 && (l.alpha ?? 0) > 0);
    if (!lit) continue;
    distant++;
    if (OPAQUE.has(base)) covered++;
  }
  tot.shots += shots; tot.distantShots += distant; tot.covered += covered;
  if (covered) { tot.coveredSegs++; perSeg.push({id: s.id, distant, covered}); }
}
perSeg.sort((a, b) => b.covered - a.covered);
console.log(`段 ${tot.segs} · 镜 ${tot.shots} · 有可见远景的镜 ${tot.distantShots}`
    + ` · 其中被不透明底色盖住 ${tot.covered}`
    + `（涉及 ${tot.coveredSegs} 段）`);
console.log(`--- 被盖住最多的 ${argOf('top', 20)} 段 ---`);
for (const r of perSeg.slice(0, Number(argOf('top', 20)))) {
  console.log(`  ${r.id}  可见远景镜 ${r.distant} / 被盖 ${r.covered}`);
}
