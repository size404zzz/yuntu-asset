/**
 * M14 剧本库单测（纯 Node）：分组/搜索纯函数、loadStory 装载链、
 * 索引增强件（steps/brief）口径。
 * 用法：node tools/test-storylib.mjs
 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {groupOf, filterStories, storyGroups, loadStory} from '../js/editor/storylib.js';

let passed = 0;
const ok = (m) => { passed++; console.log('  ok   ' + m); };
const ROOT = resolve(process.cwd());
const manifest = JSON.parse(readFileSync(join(ROOT, 'data', 'index', 'avg-scripts.json'), 'utf8'));

/* 磁盘版 fetch：路径 → 静态文件响应（与 serve.py 的仓库根同构）。
   注意 buffer 必须 slice 出精确字节——readFileSync 的 .buffer 可能带池偏移。 */
const fetchImpl = async (url) => {
  const file = join(ROOT, url.replace(/^\//, ''));
  let buf;
  try {
    buf = readFileSync(file);
  } catch {
    return {ok: false, status: 404};
  }
  return {
    ok: true, status: 200,
    arrayBuffer: async () =>
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
};

/* —— 分组与搜索 —— */

assert.equal(groupOf('cpt00_e_01_01'), 'cpt00');
assert.equal(groupOf('23spring_hb_sakuya_gift'), '23spring');
assert.equal(groupOf('dorm_hannah_02'), 'dorm');
const groups = storyGroups(manifest);
assert.ok(groups.includes('cpt00') && groups.includes('dorm') && groups.includes('23spring'),
    '分组覆盖主线章节/宿舍/活动季');
assert.equal(filterStories(manifest.stories).length, 1878);
assert.equal(filterStories(manifest.stories, {query: 'cpt00_e_01_01'}).length, 1);
assert.ok(filterStories(manifest.stories, {query: 'CPT00_E_01_01'}).length === 1,
    'ID 搜索大小写不敏感');
const dorm = filterStories(manifest.stories, {group: 'dorm'});
assert.ok(dorm.length > 0 && dorm.every((s) => groupOf(s.id) === 'dorm'));
ok(`分组/搜索：${groups.length} 组 · 过滤口径成立`);

/* —— loadStory：与 e2e 同一条装载链 —— */

{
  const {wire, stats} = await loadStory(fetchImpl,
      manifest.stories.find((s) => s.id === 'cpt00_e_01_01'));
  assert.equal(stats.shifted, false);
  assert.ok(wire['2'].content.startsWith('> 看得到吗？'));
  assert.equal(wire['1'].SkipScenario,
      '“绿洲”扇区遭到袭击。为了扭转局势，教授冒险接入绿洲的系统，为此陷入数月前的回忆。帕斯卡将教授唤醒，并请求教授指挥人形保卫绿洲。');
  ok('loadStory：cpt00 解码+映射+解引用');
}
{
  const {wire, stats} = await loadStory(fetchImpl,
      manifest.stories.find((s) => s.id === '23concert_undline_03'));
  assert.equal(stats.shifted, true, '0 起始剧本装载时平移');
  assert.ok(!('0' in wire) && wire['1'].content, '平移后键从 1 起');
  ok('loadStory：0 起始平移（23concert）');
}
{
  const bad = manifest.stories.find((s) => s.id === 'nope_missing');
  await assert.rejects(loadStory(fetchImpl, bad ?? {cfg: 'res/nope.lua', lang: 'res/nope.lua'}),
      /→ 404|nope|ENOENT/, '缺文件报错');
  ok('loadStory：坏路径明确报错');
}

/* —— 索引增强件（build-asset-index 的语料解码产物）—— */

for (const s of manifest.stories) {
  assert.equal(typeof s.steps, 'number', `${s.id} 缺 steps`);
}
const cpt00 = manifest.stories.find((s) => s.id === 'cpt00_e_01_01');
assert.equal(cpt00.steps, 48);
assert.ok(cpt00.brief?.startsWith('“绿洲”扇区遭到袭击'), 'brief = SkipScenario 简介');
const withBrief = manifest.stories.filter((s) => s.brief).length;
assert.equal(withBrief, 376, '带简介段数（SkipScenario 头部记录）');
ok(`索引增强：steps 全量 · brief ${withBrief}/1878`);

/* —— M15 语音映射（voices.json）：heroId/voiceId → VO 表 cue —— */

const voices = JSON.parse(readFileSync(join(ROOT, 'data', 'index', 'voices.json'), 'utf8'));
const audioIndex = JSON.parse(readFileSync(join(ROOT, 'data', 'index', 'audio.json'), 'utf8'));
assert.equal(Object.keys(voices.byHero).length, 93, '93 英雄全有代号');
assert.equal(voices.byHero['1002'].codename, 'anna', '安冬妮娜 → anna（皮肤表）');
assert.equal(voices.byHero['1034'].codename, 'abigail', '阿比盖尔 → abigail');
assert.equal(voices.byVoiceId['112'], 'RELATIONSHIP1', 'voiceId 112 = 好感度语音 1');
assert.equal(voices.byVoiceId['117'], 'OATH', 'voiceId 117 = 誓约');
/* 每对语料引用都必须解到 audio.json 里真实存在的 cue */
for (const m of voices.coverage.misses) {
  assert.fail(`voice ${m.heroId}:${m.voiceId} 未命中（${m.reason}）`);
}
assert.equal(voices.coverage.hit, 468, '语料 468 对 voice 引用全覆盖');
/* 抽一对端到端：1002:1 → VO_anna/anna_MORNING 真实存在 */
{
  const sheet = `VO_${voices.byHero['1002'].codename}`;
  const cue = `${voices.byHero['1002'].codename}_${voices.byVoiceId['1']}`;
  assert.ok(audioIndex.sheets[sheet]?.cues?.[cue], `${sheet}/${cue} 已转码`);
}
ok(`语音映射：93 英雄 · 语料 ${voices.coverage.hit}/${voices.coverage.pairs} 全命中`);

/* —— M15 剧情目录（story-catalog.json）—— */

const catalog = JSON.parse(readFileSync(join(ROOT, 'data', 'index', 'story-catalog.json'), 'utf8'));
assert.ok(catalog.groups.length > 1000, '目录分组规模');
const catalogIds = new Set(catalog.groups.flatMap((g) => g.stories.map((s) => s.id)));
assert.ok(catalogIds.has('cpt00_e_01_02'), '目录收录 cpt00 章节');
const manifestIds = new Set(manifest.stories.map((s) => s.id));
for (const id of catalogIds) {
  assert.ok(manifestIds.has(id), `目录 script_id ${id} 必须在语料索引里`);
}
ok(`剧情目录：${catalog.groups.length} 组 · ${catalogIds.size} 段在册（script_id 全部可装载）`);

console.log(`\n${passed} 项通过`);
