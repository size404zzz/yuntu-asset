/* 剧本层的可执行回归测试：node tools/test-script.mjs
   这里断言的是"归一化必须与参考引擎的下标算术完全一致"，
   参考语义：shotId = scriptType(-1 数组 / 0 map)，推进用 nextId + scriptType，
   跳转用 jumpAct + scriptType，否则 shotId + 1。 */
import {readFileSync} from 'node:fs';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {dirname, resolve} from 'node:path';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const {
  normalizeScript, nextIndexOf, isTerminal, toWireIndex, linearOrder,
  insertShot, removeShot, moveShot, serializeScript, branchTargets,
} = await import(pathToFileURL(resolve(root, 'js/core/script.js')).href);

const load = (name) =>
    JSON.parse(readFileSync(resolve(root, `data/fixtures/${name}.json`), 'utf8'));

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}\n       ${error.message}`);
    process.exitCode = 1;
  }
}

/* 独立复刻参考的下标算术，作为交叉验证的"金标准"。 */
function referenceNext(raw, shotId) {
  const scriptType = Array.isArray(raw) ? -1 : 0;
  const shot = Array.isArray(raw) ? raw[shotId] : raw[String(shotId)];
  if (!shot) return null;
  if (shot.nextId != null) return shot.nextId + scriptType;
  return shotId + 1;
}

for (const [name, expectedFormat, expectedCount] of [
  ['scene2', 'map', 49], ['scene3', 'array', 34]]) {
  test(`${name}: 格式=${expectedFormat} shots=${expectedCount}`, () => {
    const raw = load(name);
    const story = normalizeScript(raw);
    assert.equal(story.format, expectedFormat);
    assert.equal(story.shots.length, expectedCount);
  });

  test(`${name}: 线性链与参考算术逐步一致`, () => {
    const raw = load(name);
    const story = normalizeScript(raw);
    const scriptType = story.format === 'array' ? -1 : 0;
    let shotId = scriptType + 1;
    let steps = 0;
    while (shotId != null && steps < 1000) {
      const index = toWireIndex(story, shotId - scriptType);
      assert.ok(index !== null || story.format === 'array',
          `wire ${shotId - scriptType} 无法解析 (shotId=${shotId})`);
      const mine = nextIndexOf(story, index);
      const theirs = referenceNext(raw, shotId);
      if (theirs === null) break;
      const theirsIndex = story.wireToIndex.get(theirs - scriptType);
      assert.equal(mine, theirsIndex ?? null,
          `shotId=${shotId} 我=${mine} 参考=${theirsIndex}`);
      if (isTerminal(story, index)) break;
      shotId = theirs;
      steps += 1;
    }
    assert.ok(steps > 5, `遍历步数过少: ${steps}`);
  });

  test(`${name}: 导入导出往返深度全等`, () => {
    const raw = load(name);
    assert.deepEqual(serializeScript(normalizeScript(raw)), raw);
  });
}

test('scene2: 分支 jumpAct 全部解析到有效下标', () => {
  const story = normalizeScript(load('scene2'));
  let found = 0;
  story.shots.forEach((_, i) => {
    for (const target of branchTargets(story, i)) {
      found += 1;
      assert.notEqual(target.index, null, `#${i} 的 jumpAct=${target.wire} 悬空`);
    }
  });
  assert.ok(found >= 2, `分支数过少: ${found}`);
});

test('数组格式插入分镜会重映射 nextId 与 jumpAct', () => {
  const story = normalizeScript([
    {content: 'a', nextId: 3},
    {content: 'b'},
    {content: 'c', branch: [{content: 'x', jumpAct: 2}]},
  ]);
  insertShot(story, 1, {content: 'inserted'});
  assert.deepEqual(story.shots.map((s) => s.content),
      ['a', 'inserted', 'b', 'c']);
  // 不变量：重映射后引用仍然落在原来那个分镜上。
  // shots[0].nextId 原指 'c'（wire 3），插入后 'c' 移到下标 3 = wire 4。
  assert.equal(story.shots[0].nextId, 4);
  assert.equal(story.shots[toWireIndex(story, 4)].content, 'c');
  // 'b' 从 wire 2 整体下移到 wire 3，分支引用必须跟着走。
  assert.equal(story.shots[3].branch[0].jumpAct, 3);
  assert.equal(story.shots[toWireIndex(story, 3)].content, 'b');
});

test('数组格式删除分镜会回收 nextId', () => {
  const story = normalizeScript([
    {content: 'a', nextId: 3}, {content: 'b'}, {content: 'c'},
  ]);
  removeShot(story, 0);
  assert.deepEqual(story.shots.map((s) => s.content), ['b', 'c']);
  assert.equal(toWireIndex(story, 1), 0);
});

test('map 格式重排不改动 wire 键，引用保持有效', () => {
  const story = normalizeScript({
    1: {content: 'a', nextId: 3}, 2: {content: 'b'}, 3: {content: 'c'},
  });
  moveShot(story, 1, 2);
  assert.deepEqual(story.shots.map((s) => s.content), ['a', 'c', 'b']);
  assert.equal(story.indexToWire[2], 2);
  assert.equal(toWireIndex(story, 3), 1);
  assert.equal(nextIndexOf(story, 0), 1, 'nextId=3 应仍解析到键 3 所在下标');
});

test('孤儿分镜被识别（nextId 链覆盖不到的键）', () => {
  const story = normalizeScript({1: {content: 'a'}, 9: {content: 'orphan'}});
  assert.deepEqual(story.order, [0]);
  assert.deepEqual(story.orphans, [1]);
});

test('线性遍历遇到环不会死循环', () => {
  const story = normalizeScript({1: {content: 'a', nextId: 2}, 2: {content: 'b', nextId: 1}});
  assert.deepEqual(linearOrder(story), [0, 1]);
});

console.log(`\n${passed} 项通过${process.exitCode ? '（存在失败）' : ''}`);
