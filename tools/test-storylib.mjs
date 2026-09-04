/**
 * M14 剧本库单测（纯 Node）：分组/搜索纯函数、loadStory 装载链、
 * 索引增强件（steps/brief）口径、行动记录档案（archiveRows）归属。
 * 用法：node tools/test-storylib.mjs
 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {groupOf, filterStories, storyGroups, storyLabels, archiveRows, loadStory} from '../js/editor/storylib.js';

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
const groupNames = groups.map((g) => g.label);
assert.ok(groupNames.includes('cpt00') && groupNames.includes('dorm')
    && groupNames.includes('23spring'), '无档案时分组退回 ID 首段');
assert.equal(groups.reduce((n, g) => n + g.count, 0), 1878, '各组段数并起来就是全量');
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

/* —— M16 行动记录档案（story-archive.json）—— */

const archive = JSON.parse(readFileSync(join(ROOT, 'data', 'index', 'story-archive.json'), 'utf8'));
assert.deepEqual(archive.classes.map((c) => c.name), ['大型活动', '常规活动', '专属剧情']);
assert.equal(archive.classes[0].activities.length, 13, '大型活动 13 个');
assert.equal(archive.classes[2].activities.length, 27, '专属剧情 27 个');
const fe = archive.classes[0].activities.find((a) => a.id === 59001);
assert.equal(fe.name, '昔影归终');
assert.equal(fe.year, 2024);
assert.equal(fe.stories.length, 32, '昔影归终 32 段真剧情（关卡不计）');
assert.equal(fe.stories[0].id, '24fe_s00');
const manifestIds = new Set(manifest.stories.map((s) => s.id));
const archivedIds = new Set(archive.classes.flatMap((c) => c.activities.flatMap((a) => a.stories.map((s) => s.id))));
for (const id of archivedIds) assert.ok(manifestIds.has(id), `档案段 ${id} 必须在语料索引里`);
/* 处理器路由的背书：39003 与游戏卡片「剧情进度 2/2」同口径；专属剧情 27 期全收 */
const myth = archive.classes[1].activities.find((a) => a.id === 39003);
assert.deepEqual(myth.stories.map((s) => s.id), ['24myth_00', '24myth_01']);
assert.ok(archive.classes[2].activities.every((a) => a.stories.length),
    `专属剧情有空活动：${archive.classes[2].activities.filter((a) => !a.stories.length).map((a) => a.id)}`);
ok(`行动记录：${archivedIds.size} 段归入 ${archive.classes.reduce((n, c) => n + c.activities.length, 0)} 个活动`);

/* —— 分组下拉：档案归属名优先，无档可归的退 ID 首段 —— */

const labels = storyLabels(archive);
assert.equal(labels.get('24fe_s00'), '昔影归终', '活动段挂活动名');
const sector = archive.mainline.find((m) => m.name);
assert.equal(labels.get(sector.stories[0].id), sector.name, '主线段挂扇区名');
assert.ok(!labels.has('cpt00_e_01_01'), '无扇区主线段不挂名，交给 groupOf 兜底');
const named = storyGroups(manifest, labels);
assert.equal(named.reduce((n, g) => n + g.count, 0), 1878, '分组名不吞段');
assert.ok(!named.some((g) => g.label.startsWith('无扇区')),
    '883 段无扇区主线已拆回 ID 首段，不再是巨型组');
assert.ok(named.every((g) => g.label), '组名非空');
const feRows = filterStories(manifest.stories, {group: '昔影归终', labels});
assert.equal(feRows.length, 32, '按活动名筛回整个活动的段');
assert.ok(feRows.every((s) => labels.get(s.id) === '昔影归终'));
assert.ok(filterStories(manifest.stories, {group: 'dorm', labels})
    .every((s) => groupOf(s.id) === 'dorm'), '未挂档段仍按 ID 首段筛');
ok(`分组下拉：${named.length} 组 · 前 3 = ${named.slice(0, 3).map((g) => `${g.label}(${g.count})`).join(' ')}`);

/* —— archiveRows：档案 → 浏览行 —— */

const rows = archiveRows(archive, manifest);
const sections = rows.filter((r) => r.section);
const dataRows = rows.filter((r) => !r.section);
assert.ok(sections.length > 30 && dataRows.length > 1000, '分区与行都有量');
assert.ok(!dataRows.some((r) => r.steps == null), '每行都带镜数');
assert.equal(new Set(dataRows.map((r) => r.id)).size, dataRows.length, '同一段不重复列');
assert.equal(sections[0].section, '大型活动｜神导异论 · 2021');
assert.ok(sections.some((s) => s.section.startsWith('主线｜')), '主线扇区成段');
const bucketIds = new Set([...archivedIds,
    ...archive.mainline.flatMap((m) => m.stories.map((s) => s.id)), ...archive.unarchived]);
assert.equal(bucketIds.size, archivedIds.size
    + new Set(archive.mainline.flatMap((m) => m.stories.map((s) => s.id))).size
    + new Set(archive.unarchived).size, '三段互不重叠');
assert.equal(dataRows.length, bucketIds.size, '三段并起来就是全部行');
ok(`档案浏览行：${sections.length} 个分区 · ${dataRows.length} 行（含未归档 ${archive.unarchived.length}）`);

console.log(`\n${passed} 项通过`);
