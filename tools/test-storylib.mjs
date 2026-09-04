/**
 * M14 剧本库单测（纯 Node）：分组/搜索纯函数、loadStory 装载链、
 * 索引增强件（steps/brief）口径、行动记录档案（archiveTree 剧情树）归属。
 * 用法：node tools/test-storylib.mjs
 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {groupOf, filterStories, storyGroups, archiveTree, loadStory} from '../js/editor/storylib.js';

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
/* 「活动奖励」分母 = 手册 content 行 reward_list，与截图卡片对账：
   昔影归终 0/12 · 致光态 7/8 · 热海飙运 1/3 */
assert.equal(fe.rewards.length, 12, '昔影归终 活动奖励 12 项');
assert.equal(archive.classes[0].activities.find((a) => a.id === 33005).rewards.length, 8,
    '致光态 活动奖励 8 项');
assert.equal(archive.classes[1].activities.find((a) => a.id === 58001).rewards.length, 3,
    '热海飙运 活动奖励 3 项');
assert.ok(!archive.classes[1].activities.find((a) => a.id === 39003).rewards,
    '同行礼遇 reward_list 为空 ⇒ 无奖励条（与截图一致）');
assert.ok(archive.classes[2].activities.every((a) => !a.rewards),
    '专属剧情的 content 行在动态配置里，静态无奖励数据');
const manifestIds = new Set(manifest.stories.map((s) => s.id));
const archivedIds = new Set(archive.classes.flatMap((c) => c.activities.flatMap((a) => a.stories.map((s) => s.id))));
for (const id of archivedIds) assert.ok(manifestIds.has(id), `档案段 ${id} 必须在语料索引里`);
/* 处理器路由的背书：39003 与游戏卡片「剧情进度 2/2」同口径；专属剧情 27 期全收 */
const myth = archive.classes[1].activities.find((a) => a.id === 39003);
assert.deepEqual(myth.stories.map((s) => s.id), ['24myth_00', '24myth_01']);
assert.ok(archive.classes[2].activities.every((a) => a.stories.length),
    `专属剧情有空活动：${archive.classes[2].activities.filter((a) => !a.stories.length).map((a) => a.id)}`);
ok(`行动记录：${archivedIds.size} 段归入 ${archive.classes.reduce((n, c) => n + c.activities.length, 0)} 个活动`);

/* —— 剧情树（archiveTree）：分类 → 年份/扇区/首段 → 活动 → 剧情 —— */

const tree = archiveTree(archive, manifest);
assert.deepEqual(tree.map((n) => n.name), ['大型活动', '常规活动', '专属剧情', '主线', '未归档'],
    '顶层 = 三大分类 + 主线 + 未归档');
const leaves = tree.flatMap((n) => n.groups.flatMap((g) => g.activities.flatMap((a) => a.stories)));
const treeIds = leaves.map((s) => s.id);
assert.equal(new Set(treeIds).size, treeIds.length, '同一段在树里只出现一次');
assert.equal(treeIds.length, 1878, '树叶子并起来就是全部语料段');
assert.ok(leaves.every((s) => typeof s.steps === 'number'), '每个叶子都带镜数');
/* 年份组：数字降序，大型 2024 与游戏卡片同员；专属 2024 与游戏时间轴同序同员 */
assert.deepEqual(tree[0].groups.map((g) => g.label), ['2024', '2023', '2022', '2021']);
const big24 = tree[0].groups[0];
assert.deepEqual(big24.activities.map((a) => a.name),
    ['致光态', '弹痕、飞鸟、雏菊', '境界干涉的延迟选择', '半影迹印', '昔影归终']);
const feNode = big24.activities.find((a) => a.id === 59001);
const a59001Raw = archive.classes[0].activities.find((a) => a.id === 59001);
assert.equal(feNode.stories.length, 32, '昔影归终 32 段');
assert.equal(feNode.stories[0].id, '24fe_s00');
assert.deepEqual(feNode.rewards, a59001Raw.rewards, '树活动节点带奖励条目');
/* story_avg.activity_id 直挂列修正：薄暮葬曲 = 2 真剧情 + 1 关卡章节（游戏卡片
   Create4CharAct 的 stageAvgDic 分支同构），原先被号段前缀撞车错成主线序章单段 */
const mu = tree[2].groups.find((g) => g.label === '2022').activities.find((a) => a.id === 10010);
assert.deepEqual(mu.stories.map((s) => s.id),
    ['cpt_clotho_00_01', 'cpt00_e_01_02', 'cpt_clotho_05_01'], '薄暮葬曲 2+1 段');
const hero24 = tree[2].groups[0];
assert.deepEqual(hero24.activities.map((a) => a.name),
    ['冥刃沐辉', '浮梦巡驰', '绿境探踪', '荒屿遗株', '救偶总动员', '钢冢与繁枝', '晓光共览', '归档：麦戈拉'],
    '专属剧情 2024 组（跨年档期归结束侧，与游戏时间轴一致）');
assert.ok(tree[2].groups.every((g) => /^\d{4}$/.test(g.label)), '专属剧情 27 期全有档期年份');
/* 主线/未归档：单活动组由 UI 直通剧情 */
const main0 = tree[3].groups[0];
assert.equal(main0.label, '未分扇区');
assert.equal(main0.activities[0].stories.length, 883, '主线未分扇区 883 段');
const dormGroup = tree[4].groups[0];
assert.equal(dormGroup.label, 'dorm');
assert.equal(dormGroup.activities[0].stories.length, 465, '未归档 dorm 组 465 段');
ok(`剧情树：${tree.length} 个顶层 · ${tree.flatMap((n) => n.groups).length} 个组 · ${treeIds.length} 段叶子`);

console.log(`\n${passed} 项通过`);
