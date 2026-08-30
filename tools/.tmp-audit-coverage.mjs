/* 临时审计脚本：全语料视觉解析覆盖率（跑完即删） */
import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {parseChunk} from '../js/core/lundump.js';
import {execChunk, toJS} from '../js/core/lvm.js';
import {storyToWire} from '../js/core/avgwire.js';
import {emptyState, applyImages, applyShotTweens} from '../js/core/state.js';

const ROOT = resolve(process.cwd());
const manifest = JSON.parse(readFileSync(join(ROOT, 'data/index/avg-scripts.json'), 'utf8'));
const flat = JSON.parse(readFileSync(join(ROOT, 'data/asset-index.json'), 'utf8'));
const {imgIds, heroSprites} = manifest;

const bgNames = new Map();        /* name → count */
const bgNoSlash = new Map();      /* imgPath（无斜杠） → count */
const lpicNames = new Map();      /* imgPath → count */
const faceNames = new Map();      /* name → count */
const badPosStories = new Map();  /* story → [imgId:posId] */
let decodeFail = 0;
const failIds = [];

for (const story of manifest.stories) {
  let wire;
  try {
    const cfg = toJS(execChunk(parseChunk(readFileSync(join(ROOT, story.cfg))))[0]);
    const lang = toJS(execChunk(parseChunk(readFileSync(join(ROOT, story.lang))))[0]);
    wire = storyToWire(cfg, lang, {imgIds, heroSprites}).wire;
  } catch (e) {
    decodeFail++; failIds.push(story.id);
    continue;
  }
  /* 运行时 imgPath 追踪（同 reducer：delete 清、新声明覆盖） */
  const state = emptyState();
  const pathOf = new Map();
  for (const k of Object.keys(wire)) {
    const shot = wire[k];
    for (const im of (shot.images ?? [])) {
      if (im?.imgType === 2 && im.imgPath && !im.delete) {
        if (!im.imgPath.includes('/')) {
          bgNoSlash.set(im.imgPath, (bgNoSlash.get(im.imgPath) ?? 0) + 1);
        } else {
          const name = (im.imgPath.split('/')[1] + '.png').toLowerCase();
          bgNames.set(name, (bgNames.get(name) ?? 0) + 1);
        }
      }
      if (im?.imgType === 3 && im.imgPath && !im.delete) {
        lpicNames.set(im.imgPath, (lpicNames.get(im.imgPath) ?? 0) + 1);
      }
    }
    if (shot.images?.length) {
      applyImages(state, shot.images);
      for (const im of shot.images) {
        if (im.imgPath && !im.delete) pathOf.set(im.imgId, im.imgPath);
        else if (im.delete) pathOf.delete(im.imgId);
      }
    }
    applyShotTweens(state, shot);
    for (const face of (shot.heroFace ?? [])) {
      if (!face.faceId) continue;
      const p = pathOf.get(face.imgId);
      if (!p) continue;
      const name = ('icon_face_' + p.replace(/_avg$/, '') + '_' + face.faceId + '.png').toLowerCase();
      faceNames.set(name, (faceNames.get(name) ?? 0) + 1);
    }
    for (const [imgId, lane] of state.lanes) {
      if (!(lane.posId >= 1 && lane.posId <= 5)) {
        if (!badPosStories.has(story.id)) badPosStories.set(story.id, []);
        const rec = `${k}:img${imgId}=pos${lane.posId}`;
        if (!badPosStories.get(story.id).includes(rec)) badPosStories.get(story.id).push(rec);
      }
    }
  }
}

const missBg = [...bgNames].filter(([n]) => !flat[n]);
const missLpic = [...lpicNames].filter(([p]) => !flat[('lpic_' + p + '.png').toLowerCase()]);
const missFace = [...faceNames].filter(([n]) => !flat[n]);

console.log(`解码失败 ${decodeFail}${failIds.length ? '：' + failIds.slice(0, 8).join(', ') : ''}`);
console.log(`bg 名字 ${bgNames.size} 种，未命中 ${missBg.length}：${missBg.map(([n, c]) => `${n}×${c}`).join(', ')}`);
console.log(`bg 无斜杠 imgPath：${bgNoSlash.size} 种 → ${[...bgNoSlash].slice(0, 10).map(([p, c]) => `${p}×${c}`).join(', ')}`);
console.log(`lpic imgPath ${lpicNames.size} 种，未命中 ${missLpic.length}：${missLpic.map(([p, c]) => `${p}×${c}`).join(', ')}`);
console.log(`face 名字 ${faceNames.size} 种，未命中 ${missFace.length}：${missFace.slice(0, 30).map(([n, c]) => `${n}×${c}`).join(', ')}`);
console.log(`pos 越界（非 1..5）剧本 ${badPosStories.size} 段：`);
for (const [id, recs] of [...badPosStories].slice(0, 15)) console.log(`  ${id}: ${recs.slice(0, 4).join(' ')}`);
