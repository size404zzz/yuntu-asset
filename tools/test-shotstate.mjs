/**
 * 检查器「舞台状态」折叠回归（纯 Node）。用法：node tools/test-shotstate.mjs
 *
 * 口径：shotstate.foldShotState 沿 story.order（真实推进链）折叠 0..本镜，
 * 每个在场元素带「出处」= 调用发生的镜号（注册/起响/起播），被调用覆盖的
 * 每一镜都要注明该调用仍存在且起于哪一镜——这是检查器 0 区的数据契约：
 *   - 立绘：注册镜起在场；delete 后重注册出处换镜；可见度/明暗/槽位/表情取末镜落定值；
 *   - bgm：起响镜起延续，stop 镜终止；无 cue 无 stop 不动现状；
 *   - effect：起播镜起延续，stopList 停；bgColor / ppv 同为延续态；
 *   - sfx / voice / vedioPath / contentShake：本镜一次性，不延续；
 *   - 本镜 imgTween 提到的 imgId 记 touched（「本镜有动」）；
 *   - 孤儿镜（不在推进链上）按数组前缀折叠。
 */
import assert from 'node:assert/strict';
import {normalizeScript} from '../js/core/script.js';
import {foldShotState, foldPath} from '../js/core/shotstate.js';

let passed = 0;
const ok = (m) => { passed++; console.log('  ok   ' + m); };

const sprite = (imgId, path = `p${imgId}`, extra = {}) =>
    ({imgId, imgType: 3, imgPath: path, alpha: 0, ...extra});

/* —— 1 立绘出处与落定值 —— */
{
  const story = normalizeScript([
    /* 0：注册 101，无 tween（预站位，未揭示） */
    {content: '一', images: [sprite(101)]},
    /* 1：揭示 101（α1，槽 2） */
    {content: '二', imgTween: [{imgId: 101, alpha: 1, posId: 2, delay: 0, duration: 0.2}]},
    /* 2：压暗 */
    {content: '三', imgTween: [{imgId: 101, alpha: 1, isDark: true, delay: 0, duration: 0}]},
  ]);
  const s0 = foldShotState(story, 0);
  assert.equal(s0.sprites.length, 1);
  assert.equal(s0.sprites[0].since, 0, '注册镜 = 0');
  assert.equal(s0.sprites[0].entered, false, '无 tween = 未揭示');
  assert.equal(s0.sprites[0].alpha, 0);

  const s1 = foldShotState(story, 1);
  assert.equal(s1.sprites[0].since, 0, '第 1 镜仍注明于第 0 镜起');
  assert.equal(s1.sprites[0].entered, true);
  assert.equal(s1.sprites[0].alpha, 1);
  assert.equal(s1.sprites[0].posId, 2);
  assert.equal(s1.sprites[0].touched, true, '本镜 tween 过 = 本镜有动');

  const s2 = foldShotState(story, 2);
  assert.equal(s2.sprites[0].since, 0);
  assert.equal(s2.sprites[0].isDark, true, '明暗是赋值且延续');
  assert.equal(s2.sprites[0].alpha, 1);
  assert.equal(s2.sprites[0].touched, true);
  ok('立绘：注册镜作出处，跨镜延续可见度/槽位/明暗');
}

/* —— 2 delete 后重注册：出处换镜，落定值重算 —— */
{
  const story = normalizeScript([
    {content: '一', images: [sprite(101)],
      imgTween: [{imgId: 101, alpha: 1, isDark: true, delay: 0, duration: 0.2}]},
    /* 1：换装 = 回收后重建全新条目 */
    {content: '二', images: [sprite(101, 'p101_dress'), {imgId: 101, delete: true}],
      imgTween: [{imgId: 101, alpha: 1, delay: 0, duration: 0.2}]},
  ]);
  const s = foldShotState(story, 1);
  assert.equal(s.sprites.length, 1);
  assert.equal(s.sprites[0].imgPath, 'p101_dress');
  assert.equal(s.sprites[0].since, 1, '重注册后出处 = 新镜');
  assert.equal(s.sprites[0].isDark, false, '新条目不继承旧明暗');
  ok('立绘：delete+重注册 = 出处换镜、明暗重算');
}

/* —— 3 bgm 延续与停止 —— */
{
  const story = normalizeScript([
    {content: '0', audio: {bgm: {cue: 'Mus_a', sheet: 'sheet_a', fadeIn: 0.5}}},
    {content: '1'},
    {content: '2', audio: {bgm: {cue: 'Mus_b', sheet: 'sheet_b'}}},
    {content: '3', audio: {bgm: {stop: true, fadeOut: 2}}},
    {content: '4'},
    /* 5：无 cue 无 stop = 不动现状（bgmCue 的 no-op 分支） */
    {content: '5', audio: {bgm: {fadeIn: 1}}},
  ]);
  assert.equal(foldShotState(story, 1).bgm?.cue, 'Mus_a');
  assert.equal(foldShotState(story, 1).bgm.since, 0, '第 1 镜注明 bgm 于第 0 镜起');
  assert.equal(foldShotState(story, 2).bgm?.cue, 'Mus_b');
  assert.equal(foldShotState(story, 2).bgm.since, 2);
  const s3 = foldShotState(story, 3);
  assert.equal(s3.bgm, null);
  assert.equal(s3.bgmStop?.since, 3, '停止出处 = stop 镜');
  const s4 = foldShotState(story, 4);
  assert.equal(s4.bgm, null);
  assert.equal(s4.bgmStop?.since, 3, '停止态也延续');
  assert.equal(foldShotState(story, 5).bgm, null, 'no-op 条目不复活 bgm');
  ok('bgm：起响镜起逐镜延续，stop 终止，no-op 不动现状');
}

/* —— 4 effect 延续 / stopList 停止 / 本镜停止清单 —— */
{
  const story = normalizeScript([
    {content: '0', effect: {1: {prefabName: 'FXP_AVG_Snow', pos: [0, 0, 0], layer: 2}}},
    {content: '1', effect: {2: {prefabName: 'FXP_AVG_Hit-knife'}}},
    {content: '2', effect: {stopList: [1]}},
    {content: '3'},
  ]);
  const s1 = foldShotState(story, 1);
  assert.deepEqual(s1.effects.map((e) => e.prefab),
      ['FXP_AVG_Snow', 'FXP_AVG_Hit-knife']);
  assert.equal(s1.effects[0].since, 0, '特效于第 0 镜起仍在台上');
  const s2 = foldShotState(story, 2);
  assert.deepEqual(s2.effects.map((e) => e.id), ['2']);
  assert.deepEqual(s2.stopNow, ['1'], '本镜 stopList 记入「本镜停止」');
  assert.equal(foldShotState(story, 3).stopNow.length, 0, '停止清单只属本镜');
  ok('特效：起播镜起延续，stopList 停，停止清单只属本镜');
}

/* —— 5 bgColor / ppv 延续；未知底色值被忽略 —— */
{
  const story = normalizeScript([
    {content: '0', bgColor: 2},
    {content: '1', ppv: {cg: {saturation: 0.5}}},
    {content: '2', bgColor: 7},
    {content: '3', bgColor: 3},
  ]);
  const s1 = foldShotState(story, 1);
  assert.deepEqual(s1.bgColor, {value: 2, since: 0});
  assert.deepEqual(s1.ppv, {since: 1});
  assert.deepEqual(foldShotState(story, 2).bgColor, {value: 2, since: 0},
      '引擎不认 bgColor=7，现状不动');
  assert.deepEqual(foldShotState(story, 3).bgColor, {value: 3, since: 3});
  ok('bgColor/ppv：延续态，未知底色值按引擎口径忽略');
}

/* —— 6 一次性触发不延续 —— */
{
  const story = normalizeScript([
    {content: '0', audio: {sfx: {cue: 'AVG_door', sheet: 's'}},
      voice: {heroId: 7, voiceId: 3}, vedioPath: 'avg/x.mp4', contentShake: true},
    {content: '1'},
  ]);
  const s0 = foldShotState(story, 0);
  assert.equal(s0.sfx?.cue, 'AVG_door');
  assert.deepEqual(s0.voice, {heroId: 7, voiceId: 3});
  assert.equal(s0.vedioPath, 'avg/x.mp4');
  assert.equal(s0.contentShake, true);
  const s1 = foldShotState(story, 1);
  assert.equal(s1.sfx, null);
  assert.equal(s1.voice, null);
  assert.equal(s1.vedioPath, undefined);
  assert.equal(s1.contentShake, undefined);
  ok('sfx/CV/视频/抖动：只属本镜，下一镜不再出现');
}

/* —— 7 表情出处 —— */
{
  const story = normalizeScript([
    {content: '0', images: [sprite(101)],
      imgTween: [{imgId: 101, alpha: 1, delay: 0, duration: 0.2}]},
    {content: '1', heroFace: [{imgId: 101, faceId: 4}]},
    {content: '2', heroFace: [{imgId: 101, faceId: 0}]},
  ]);
  const s1 = foldShotState(story, 1);
  assert.equal(s1.sprites[0].faceId, 4);
  assert.equal(s1.sprites[0].since, 0, '立绘出处仍是注册镜');
  assert.equal(foldShotState(story, 2).sprites[0].faceId, 0, 'faceId 0 = 默认脸');
  ok('表情：落定值逐镜延续（0 = 还原默认脸）');
}

/* —— 8 推进链路径与孤儿镜退化 —— */
{
  const story = normalizeScript({
    1: {content: 'a', nextId: 3},
    2: {content: '孤儿'},
    3: {content: 'b'},
  });
  /* 线性链 0→2（下标）；孤儿 = 下标 1。 */
  assert.deepEqual(foldPath(story, 2), [0, 2]);
  assert.deepEqual(foldPath(story, 1), [0, 1], '孤儿镜退化为数组前缀');
  /* 孤儿镜上的调用不污染链上状态： */
  const story2 = normalizeScript({
    1: {content: 'a', nextId: 3, images: [sprite(101)],
      imgTween: [{imgId: 101, alpha: 1, delay: 0, duration: 0.2}]},
    2: {content: '孤儿', images: [sprite(102)],
      imgTween: [{imgId: 102, alpha: 1, delay: 0, duration: 0.2}]},
    3: {content: 'b'},
  });
  const s = foldShotState(story2, 2);
  assert.deepEqual(s.sprites.map((sp) => sp.imgId), [101],
      '链上第 2 镜看不到孤儿镜注册的 102');
  ok('折叠路径：沿推进链走，孤儿镜退化数组前缀且不污染链上状态');
}

/* —— 9 全空场 —— */
{
  const story = normalizeScript([{content: '独白', contentType: 1}, {content: '二'}]);
  const s = foldShotState(story, 1);
  assert.equal(s.sprites.length, 0);
  assert.equal(s.layers.length, 0);
  assert.equal(s.bgm, null);
  assert.equal(s.effects.length, 0);
  ok('空场：无立绘/图层/音乐/特效');
}

console.log(`shotstate: ${passed} 组断言全过`);
