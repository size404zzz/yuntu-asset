/**
 * M23 退场建议回归（纯 Node）。用法：node tools/test-fadeadvice.mjs
 *
 * 两段：
 *  A 结构断言——触发器（无说话人镜）、排除项（作者本镜亲自动过 / 不在台上）、
 *    预检分档与 needReveal、落笔条目形态与幂等、孤儿镜不参与；
 *  B 外源锚点——拿 GFWiki《无律背反》= 23carnival 39 段转写件的真实淡出
 *    （data/fixtures/wiki-fades-23carnival.json）当金标准，守住分档梯度：
 *    imminent > distant > far > silent，且各档命中有上下界。改触发器或
 *    NEAR_WINDOW/MID_WINDOW 后梯度被改坏，这里立刻红。
 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve, join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {normalizeScript} from '../js/core/script.js';
import {parseChunk} from '../js/core/lundump.js';
import {execChunk, toJS} from '../js/core/lvm.js';
import {storyToWire} from '../js/core/avgwire.js';
import {analyzeFadeAdvice, applyFadeOut, hasSpeaker, TIERS}
    from '../js/core/fadeadvice.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
const ok = (m) => { passed++; console.log('  ok   ' + m); };

/* —— A 结构 —— */
/* 1 亮 101-104；2/4 无说话人镜；3 有说话人；5-12 有说话人的填充；
   13 让 103 复亮（距 2 号镜 11 镜）；13 的 nextId 跳到 99，50 成孤儿。
   101→3 号镜复亮（距 1）· 102 再不提 · 103 距 11 · 104→4 号镜预站位（距 2） */
const wire = {
  '1': {contentType: 3, speakerHeroId: 1001, content: '甲上台',
    images: [101, 102, 103, 104].map((imgId) =>
        ({imgId, imgType: 3, imgPath: `p${imgId}`, alpha: 0})),
    imgTween: [101, 102, 103, 104].map((imgId) =>
        ({imgId, delay: 0, duration: 0.2, alpha: 1}))},
  '2': {contentType: 2, content: '旁白：四个人都在台上'},
  '3': {contentType: 3, speakerHeroId: 1001, content: '甲说话',
    imgTween: [{imgId: 101, delay: 0, duration: 0.2, alpha: 1}]},
  '4': {contentType: 2, content: '旁白：作者自己给 104 摆预站位',
    imgTween: [{imgId: 104, delay: 0, duration: 0, alpha: 0}]},
  '50': {contentType: 2, content: '孤儿镜：不在重放链上'},
  '99': {contentType: 3, speakerHeroId: 1001, content: '收尾',
    nextId: null},
};
for (let k = 5; k <= 13; k++) {
  wire[String(k)] = {contentType: 3, speakerHeroId: 1001, content: `填充 ${k}`};
}
wire['13'] = {contentType: 2, content: '旁白：乙回来了',
  imgTween: [{imgId: 103, delay: 0, duration: 0.2, alpha: 1}], nextId: 99};

const story = normalizeScript(wire);
const find = (items, index, imgId) =>
    items.find((it) => it.index === index && it.imgId === imgId);
const idxOfKey = (k) => story.wireToIndex.get(k);
const K2 = idxOfKey(2);
const K3 = idxOfKey(3);
const K4 = idxOfKey(4);

{
  assert.equal(hasSpeaker({speakerHeroId: 1001}), true);
  assert.equal(hasSpeaker({speakerHeroId: 0}), true, 'heroId 0 也算有说话人');
  assert.equal(hasSpeaker({speakerHeroId: null, speakerName: ''}), false);
  assert.equal(hasSpeaker({speakerName: '教授'}), true);
  assert.equal(hasSpeaker({}), false);
  ok('无说话人镜判定：按 speakerHeroId/speakerName，不按 contentType');
}

{
  const {items, stats} = analyzeFadeAdvice(story);
  /* 2 号镜（无说话人）上 101-104 全在台上 → 四条建议 */
  for (const imgId of [101, 102, 103, 104]) {
    assert.ok(find(items, K2, imgId), `#2 应列出 ${imgId}`);
  }
  assert.equal(items.filter((it) => it.index === K3).length, 0, '有说话人的镜不列');
  ok(`触发器：无说话人镜列滞留（#2 列 ${stats.lingering} 条次），有说话人镜不列`);
}

{
  const {items} = analyzeFadeAdvice(story);
  assert.equal(find(items, K2, 101).tier, 'imminent');
  assert.equal(find(items, K2, 101).next.kind, 'relight');
  assert.equal(find(items, K2, 101).next.distance, 1);
  assert.equal(find(items, K2, 102).tier, 'silent');
  assert.equal(find(items, K2, 102).next, null);
  assert.equal(find(items, K2, 103).tier, 'far', '距 11 镜 → far');
  assert.equal(find(items, K2, 104).tier, 'imminent');
  assert.equal(find(items, K2, 104).needReveal, true, '再来路是预站位 → 要补揭示');
  assert.equal(find(items, K2, 104).next.kind, 'preentry');
  ok('预检分档：复亮/预站位 → imminent，距 11 → far，再不提 → silent');
}

{
  const {items} = analyzeFadeAdvice(story);
  /* 4 号镜作者自己写了 104 的预站位 → 本镜不插嘴 */
  assert.equal(find(items, K4, 104), undefined, '本镜作者动过 → 不列');
  /* 孤儿镜 50 不在重放链上 → 折叠不看它 */
  assert.equal(items.some((it) => it.index === idxOfKey(50)), false,
      '孤儿镜不产生建议');
  ok('排除项：作者本镜亲自动过的不列；孤儿镜（不在重放链）不列');
}

{
  const shot = story.shots[K2];
  const before = shot.imgTween;
  const next = applyFadeOut(shot, 101);
  assert.equal(next.length, 1);
  assert.deepEqual(next[0],
      {imgId: 101, delay: 0, duration: 0.2, alpha: 0, isDark: false});
  assert.equal(before, shot.imgTween, '原数组不被就地改');
  /* 落笔后该条建议消失（本镜已动过 101）：幂等，不会重复建议 */
  story.shots[K2].imgTween = next;
  assert.equal(find(analyzeFadeAdvice(story).items, K2, 101), undefined,
      '落笔后不再重复建议');
  story.shots[K2].imgTween = before;
  ok('落笔：追加 α0/d0.2（不就地改），落笔后不再重复建议');
}

{
  const {items} = analyzeFadeAdvice(story);
  const ranks = items.map((it) => TIERS[it.tier].rank);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), '按分档排序');
  ok('排序：按分档（imminent→distant→far→silent），同档按镜序');
}

/* —— B 外源锚点 —— */
{
  let manifest;
  let fixture;
  try {
    manifest = JSON.parse(readFileSync(
        join(ROOT, 'data/index/avg-scripts.json'), 'utf8'));
    fixture = JSON.parse(readFileSync(
        join(ROOT, 'data/fixtures/wiki-fades-23carnival.json'), 'utf8'));
  } catch {
    console.log('  skip 外源锚点（缺语料索引或 wiki 淡出夹具）');
  }
  if (manifest && fixture) {
    const byId = new Map(manifest.stories.map((s) => [s.id, s]));
    const decode = (path) => {
      const proto = parseChunk(readFileSync(join(ROOT, path)));
      return toJS(execChunk(proto)[0]);
    };
    const rate = {n: 0, hit: 0, hit1: 0};
    const tiers = {};
    let sugN = 0;
    for (const [id, truth] of Object.entries(fixture.stories)) {
      const meta = byId.get(id);
      if (!meta) continue;
      const cfg = decode(meta.cfg);
      const lang = meta.lang ? decode(meta.lang) : {};
      const {wire: mapped} = storyToWire(cfg, lang,
          {imgIds: manifest.imgIds, heroSprites: manifest.heroSprites});
      const st = normalizeScript(mapped);
      const fades = new Set(truth.fades.map(([k, i]) => `${k}|${i}`));
      const {items} = analyzeFadeAdvice(st);
      for (const it of items) {
        sugN++;
        const e = tiers[it.tier] ?? (tiers[it.tier] = {n: 0, hit: 0, hit1: 0});
        e.n++; rate.n++;
        const hit = fades.has(`${it.wire}|${it.imgId}`);
        /* ±1：容转写者把淡出写在相邻镜 */
        const hit1 = hit
            || [it.wire - 1, it.wire + 1].some((k) => fades.has(`${k}|${it.imgId}`));
        if (hit) { e.hit++; rate.hit++; }
        if (hit1) { e.hit1++; rate.hit1++; }
      }
    }
    const p = (e) => e.hit1 / e.n;
    console.log(`  外源：39 段共 ${sugN} 条建议，各档 ±1 命中率`
        + Object.entries(tiers).map(([k, e]) =>
            ` ${k} ${(p(e) * 100).toFixed(1)}%(n=${e.n})`).join(' ·'));
    assert.ok(sugN > 800 && sugN < 1500, `建议总数 ${sugN} 落在 800-1500`);
    assert.ok(p(tiers.imminent) >= 0.55, 'imminent ±1 命中 ≥55%');
    assert.ok(p(tiers.distant) >= 0.33 && p(tiers.distant) <= 0.60,
        'distant ±1 命中 33-60%');
    assert.ok(p(tiers.far) <= 0.30, 'far ±1 命中 ≤30%');
    assert.ok(p(tiers.silent) <= 0.15, 'silent ±1 命中 ≤15%');
    assert.ok(p(tiers.imminent) > p(tiers.distant)
        && p(tiers.distant) > p(tiers.far) && p(tiers.far) > p(tiers.silent),
        '梯度单调：imminent > distant > far > silent');
    ok('外源锚点：wiki 淡出真值下的分档梯度成立（改判据会红）');
  }
}

console.log(`\n${passed} 项通过`);
