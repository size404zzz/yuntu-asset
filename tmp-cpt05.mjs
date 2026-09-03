import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {parseChunk} from './js/core/lundump.js';
import {execChunk, toJS} from './js/core/lvm.js';
import {storyToWire} from './js/core/avgwire.js';
const ROOT = resolve(process.cwd());
const manifest = JSON.parse(readFileSync('data/index/avg-scripts.json', 'utf8'));
const story = manifest.stories.find((s) => s.id === process.argv[2]);
const dec = (k) => toJS(execChunk(parseChunk(readFileSync(join(ROOT, story[k]))))[0]);
const raw = dec('cfg');
const a = storyToWire(dec('cfg'), dec('lang'), {imgIds: manifest.imgIds,
  heroSprites: manifest.heroSprites, pathOwner: manifest.pathOwner}).wire;
const b = storyToWire(dec('cfg'), dec('lang'), {}).wire;   /* 关层对照 */
const list = (x) => (Array.isArray(x) ? x : x && typeof x === 'object' ? Object.values(x) : []);
const fmt = (t) => `${t.imgId}:α${t.alpha}/d${t.duration}/dk${String(t.isDark)}`;
let n = 0;
for (const k of Object.keys(a)) {
  const ea = list(a[k].imgTween), eb = list(b[k].imgTween);
  if (ea.length === eb.length) continue;
  if (n++ >= 6) break;
  const added = ea.filter((t) => !eb.some((u) => u.imgId === t.imgId && u.alpha === t.alpha));
  console.log(`镜${k} contentType=${a[k].contentType ?? '-'} speakerHeroId=${a[k].speakerHeroId ?? '-'} `
      + `speaker="${(a[k].speakerName ?? a[k].speaker ?? '').toString().slice(0, 10)}"`);
  console.log(`   作者 [${eb.map(fmt).join(' ')}]`);
  console.log(`   本层多补 ${added.length} 条: ${added.map(fmt).join(' ')} · 桥表候选=${JSON.stringify(manifest.heroSprites[a[k].speakerHeroId])}`);
}
console.log(`\n该段本层与关层共 ${Object.keys(a).filter((k) => list(a[k].imgTween).length !== list(b[k].imgTween).length).length} 镜有差异`);
