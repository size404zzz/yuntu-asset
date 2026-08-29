/**
 * M9 文档层单测（纯 Node）：失效分级表、快照撤销、400ms 同字段折叠、
 * 结构操作、redo。用法：node tools/test-doc.mjs
 */
import assert from 'node:assert/strict';
import {Doc, levelOf, setPath, getPath, L1, L2, L3} from '../js/core/doc.js';

let passed = 0;
const ok = (m) => { passed++; console.log('  ok   ' + m); };

const mkDoc = () => new Doc({shots: [
  {contentType: 4, speakerName: '甲', content: '一'},
  {imgTween: [{imgId: 101, alpha: 0, delay: 0, duration: 1}]},
]});

/* 分级表 */
assert.equal(levelOf('content'), L3);
assert.equal(levelOf('audio.bgm.fadeIn'), L3);
assert.equal(levelOf('imgTween'), L2);
assert.equal(levelOf('heroFace'), L2);
assert.equal(levelOf('images'), L1);
assert.equal(levelOf('branch'), L1);
assert.equal(levelOf('nextId'), L1);
assert.equal(levelOf('whateverUnknown'), L1, '未知字段保守 L1');
ok('失效分级：L3 文案/音频、L2 tween/表情/posId、未知一律 L1');

/* patch + 事件 */
{
  const d = mkDoc();
  const seen = [];
  d.subscribe((e) => seen.push(e));
  assert.equal(d.patch(0, 'speakerName', '乙'), true);
  assert.equal(d.story.shots[0].speakerName, '乙');
  assert.equal(seen.length, 1);
  assert.deepEqual([seen[0].index, seen[0].level], [0, L3]);
  assert.equal(d.patch(0, 'speakerName', '乙'), false, '同值不产生步骤');
  assert.equal(d.version, 1);
  ok('patch：写入 + 事件 + 同值空操作');
}

/* 点路径 */
{
  const d = mkDoc();
  d.patch(0, 'audio.bgm.cue', 'Mus_X');
  assert.equal(getPath(d.story.shots[0], 'audio.bgm.cue'), 'Mus_X');
  d.patch(0, 'audio.bgm.cue', undefined);
  assert.equal(d.story.shots[0].audio.bgm.cue, undefined, 'undefined 删键');
  ok('嵌套字段：点路径读写与删除');
}

/* 折叠：同字段 400ms 内一步；跨字段两步；超时两步 */
{
  const d = mkDoc();
  d.patch(0, 'content', 'a');
  d.patch(0, 'content', 'ab');
  d.patch(0, 'content', 'abc');
  assert.equal(d.undoStack.length, 1, '同字段连打折叠成一步');
  d.patch(0, 'speakerName', 'x');
  assert.equal(d.undoStack.length, 2, '换字段开新步');
  d.undo();
  assert.equal(d.story.shots[0].content, 'abc', 'content 保留（属于上一个批）');
  assert.equal(d.story.shots[0].speakerName, '甲', 'undo 掉 speakerName 批 = 回到批前');
  ok('折叠：400ms 同字段一步，换字段另起');
}

/* 折叠批的起点值 */
{
  const d = mkDoc();
  d.patch(0, 'content', 'a');
  d.patch(0, 'content', 'ab');
  d.undo();
  assert.equal(d.story.shots[0].content, '一', 'undo 回到批前原值');
  assert.equal(d.canRedo, true);
  d.redo();
  assert.equal(d.story.shots[0].content, 'ab', 'redo 到批末值（折叠整体前进）');
  ok('undo/redo 以批为单位往返');
}

/* 结构操作 */
{
  const d = mkDoc();
  const seen = [];
  d.subscribe((e) => seen.push(e));
  d.structure((s) => s.shots.splice(1, 0, {contentType: 2}), {label: '插入'});
  assert.equal(d.story.shots.length, 3);
  assert.equal(seen[0].level, L1);
  assert.equal(seen[0].kind, 'structure');
  d.undo();
  assert.equal(d.story.shots.length, 2, 'undo 恢复结构');
  ok('structure：L1 事件 + 可撤销');
}

/* 60 条上限 */
{
  const d = mkDoc();
  for (let i = 0; i < 70; i++) {
    d.patch(0, i % 2 ? 'content' : 'speakerName', `v${i}`);
    if (i % 2 === 0) d._batch = null;   // 模拟超时不折叠
  }
  assert.equal(d.undoStack.length, 60, '栈上限 60');
  ok('撤销栈 60 条上限');
}

void setPath;
console.log(`\n${passed} 项通过`);
