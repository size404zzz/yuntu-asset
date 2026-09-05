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
/* 活体分类（story-classification-live.json）在场时 stories 以它为准：
 * 42 组展平（分歧段展开）= 60 段；小项合并再并入角色小剧场 13 + 追忆 4 = 77 */
assert.ok([32, 60, 77].includes(fe.stories.length),
    `昔影归终段数随数据源浮动（静态 32 / 活体 60 / 合并 77），实际 ${fe.stories.length}`);
assert.equal(fe.stories[0].id, '24fe_s00');
/* 档案只管「分类 → 年份 → 活动 → 剧情」：奖励/进度是玩家存档态，不还原 */
for (const act of archive.classes.flatMap((c) => c.activities)) {
  assert.ok(!('rewards' in act) && !('storyTotal' in act),
      `${act.id} 不应带奖励/进度字段`);
}
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
assert.equal(feNode.stories.length, fe.stories.length, '树与档案同源');
assert.equal(feNode.stories[0].id, '24fe_s00');
/* type 10 专属剧情按活体分类挂角色全部章节（薄暮葬曲 = clotho 章节 20 段）；
 * 活体缺席时退回静态路由（3 段：2 真剧情 + 1 关卡章节） */
const mu = tree[2].groups.find((g) => g.label === '2022').activities.find((a) => a.id === 10010);
assert.ok([3, 20].includes(mu.stories.length),
    `薄暮葬曲段数随数据源浮动（静态 3 / 活体 20），实际 ${mu.stories.length}`);
assert.equal(mu.stories[0].id, 'cpt_clotho_00_01');
const hero24 = tree[2].groups[0];
assert.deepEqual(hero24.activities.map((a) => a.name),
    ['冥刃沐辉', '浮梦巡驰', '绿境探踪', '荒屿遗株', '救偶总动员', '钢冢与繁枝', '晓光共览', '归档：麦戈拉'],
    '专属剧情 2024 组（跨年档期归结束侧，与游戏时间轴一致）');
assert.ok(tree[2].groups.every((g) => /^\d{4}$/.test(g.label)), '专属剧情 27 期全有档期年份');
/* 主线：活体分类接管后全部组有名（六大章节扇区 + sector_stage 归属 +
 * 事件组），不再有「未分扇区」大桶 */
const mainlineNode = tree[3];
assert.ok(mainlineNode.groups.length >= 20, `主线细分组数 ${mainlineNode.groups.length}`);
assert.ok(mainlineNode.groups.every((g) => g.label), '主线所有组都有名字');
assert.deepEqual(mainlineNode.groups.map((g) => g.label).slice(0, 7),
    ['罗萨姆', '基洛普斯', '赫里奥斯', '恩格玛', '庇厄里亚', '柯普利', '绿洲防线']);
const unaNode = tree[4];
const branchCount = (g) => g.activities.reduce((n, a) => n + a.stories.length, 0);
const groupWith = (id) => unaNode.groups.find((g) =>
    g.activities.some((a) => a.stories.some((s) => s.id === id)))?.label;
/* 未归档按游戏数据命名：宿舍剧情一人一组，角色名只认 hero_data
 * （avg_character 是 AVG 演出角色表，按 heroId 取会报错人）；
 * 教学/试炼/支线按事件；旧数据源（无 group 字段）退回 ID 首段分组 */
assert.equal(groupWith('dorm_eos_01'), '宿舍剧情·晨曦',
    'dorm_eos 归晨曦（Eos）——avg_character 曾错标成渡宾，那是 Dupin 的名字');
assert.equal(groupWith('dorm_dupin_01'), '宿舍剧情·渡宾', '渡宾属于 dupin');
assert.equal(groupWith('dorm_aki_01'), '宿舍剧情·秋', 'aki＝秋（dorm_hero_talk 1022）');
/* 阿比盖尔没登记进 dorm_hero_talk，靠 voices 的 codename 反查兜底 */
assert.equal(groupWith('dorm_abigail_01'), '宿舍剧情·阿比盖尔', '未登记角色走 codename 兜底');
const dormNamed = unaNode.groups.filter((g) => g.label.startsWith('宿舍剧情·'));
assert.equal(dormNamed.length, 93, `宿舍角色组 ${dormNamed.length} 个（93 英雄一人一组）`);
assert.ok(dormNamed.every((g) => branchCount(g) === 5),
    '每个角色 5 段宿舍好感度剧情');
const unarchivedTotal = tree[4].groups
    .reduce((n, g) => n + g.activities.reduce((m, a) => m + a.stories.length, 0), 0);
assert.ok([609, 476].includes(unarchivedTotal),
    `未归档段数随小项合并浮动（合并前 609 / 后 476），实际 ${unarchivedTotal}`);
ok(`剧情树：${tree.length} 个顶层 · ${tree.flatMap((n) => n.groups).length} 个组 · ${treeIds.length} 段叶子`);

/* —— 手动覆盖层：lib-editor 保存件（story-archive-manual.json）——
 * 结构与生成档案同形，storylib 优先加载；改名/移动/新增活动直接反映到树。 */
const manual = {
  classes: [{classId: 1, name: '大型活动', activities: [
    {id: 17001, name: '逆波共振（合并版）', year: 2022, type: 17, stories: [
      {id: '22carnival_op', name: 'OP'},
      {id: 'cpt_imr_s01', name: null},
    ]},
    {id: 'manual-1', name: '手工活动', year: 2025, type: null, stories: []},
  ]}],
  mainline: [{sectorId: null, name: '誓约剧情', stories: [
    {id: '24oath_betty', name: null}, {id: 'oath_sol', name: null},
  ]}],
  unarchived: [
    {id: 'dorm_persicaria_01', group: '宿舍剧情·帕斯卡'},
    {id: '22christ_hall', group: '2022圣诞·小游戏'},
  ],
};
const manualTree = archiveTree(manual, manifest);
const nodeOf = (name) => manualTree.find((n) => n.name === name);
const manualYear = nodeOf('大型活动').groups.find((g) => g.label === '2022');
assert.ok(manualYear, '手动档案年份组照常成立');
const manualAct = manualYear.activities[0];
assert.equal(manualAct.name, '逆波共振（合并版）', '活动改名生效');
assert.equal(manualAct.stories.length, 2, '活动条目按手动档案');
assert.ok(nodeOf('大型活动').groups.some((g) => g.label === '2025'), '新增活动自带年份组（2025）');
assert.equal(nodeOf('主线').groups[0].label, '誓约剧情', '主线事件组改名生效');
assert.equal(nodeOf('主线').groups[0].activities[0].stories.length, 2);
assert.equal(nodeOf('未归档').groups[0].label, '2022圣诞·小游戏', '未归档命名组生效');
assert.equal(nodeOf('未归档').groups[1].label, '宿舍剧情·帕斯卡');
ok(`手动覆盖层：改名/移动/新增活动全部反映到树`);

/* —— 无年份分类（宿舍剧情/其他剧情这类手工分类）与空节点 —— */
const yearless = archiveTree({
  classes: [
    {classId: 4, name: '宿舍剧情', activities: [
      {id: 'dorm-1', name: '渡宾', year: null, stories: [{id: 'dorm_persicaria_01'}]},
      {id: 'dorm-2', name: '帕斯卡', year: null, stories: [{id: 'dorm_pascal_01'}]},
    ]},
    {classId: 5, name: '空分类', activities: []},
  ],
  mainline: [],
  unarchived: [],
}, manifest);
const dormNode = yearless.find((n) => n.name === '宿舍剧情');
assert.ok(dormNode, '无年份分类照样成顶层节点');
assert.deepEqual(dormNode.groups.map((g) => g.label), ['渡宾', '帕斯卡'],
    '活动本身即中层组，不劈「年份未定」');
assert.ok(dormNode.groups.every((g) => g.activities.length === 1
    && g.activities[0].name === g.label), '单同名活动壳＝picker 直通到剧情');
assert.ok(!yearless.some((n) => n.name === '空分类'), '空分类不进树');
assert.ok(!yearless.some((n) => n.name === '未归档'), '未归档空了就不留空节点');
assert.equal(yearless.length, 1, `只剩有内容的节点：${yearless.map((n) => n.name)}`);
ok('无年份分类：活动即分支 · 空节点剔除');

console.log(`
${passed} 项通过`);
