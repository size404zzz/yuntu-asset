/* build-story-archive.mjs —— 生成 data/index/story-archive.json：游戏「行动记录」
   那套现成剧情分类的还原（三大类 → 活动 → 真剧情段 script_id）。
 *
 * 数据面（全部来自游戏配置表，2026-09-04 逐层实证，见 MEMORY 行动记录条目）：
 *   handbook_activity.lua  顶层 3 条 = 大型活动/常规活动/专属剧情；content 给活动
 *                          成员、yearDic 给年份归属（截图左侧那条时间轴）。
 *   activity.lua           actId → {name_id, type}；type = eActivityType。
 *   activity_name.lua      name_id → lang key；locale_text.lua 解出中文。
 *   story_avg.lua          一行 = 一段可播剧情：script_id + sectorId + set_place
 *                          + difficulty + name/describe（都是 lang key）。
 *   活动 → 剧情段：游戏侧是 HandBookActReviewFunc 按 eActivityType 分发的 21 个
 *   处理器，这里照它落三条路由，按证据强度分档取用（有高档证据时低档一律让位，
 *   见 storiesOf）：
 *     档 4 处理器路由  类型 → 该类型的回顾表 → 按「同系列序号」定位行，
 *                      序号 = activity[actId].activity_id（缺省即首期）
 *     档 3 号段        story_avg.sectorId 以 actId 打头。只是兜底——前缀会串到
 *                      邻居活动（致光态 33005 的真扇区是 33006X，前缀 33005 捞回
 *                      来的是致密静点的段）
 *     档 1-2 表键/外键 activity 系表里挂上来的行（显式活动外键 2，仅表键 1）
 *   三条都按同一套字段语义解到 story_avg（只收有 script_id 的真剧情段，关卡不计）：
 *     *_avg / story_id / avg_id      → story_avg.id
 *     *_sector                       → story_avg.sectorId
 *     *_stage / stage_id             → story_avg.set_place
 *   专属剧情（class 3）表里 content 为空、只有 content_count=27，成员实为
 *   activity 里 type=10(HeroGrow)/54(HeroGrowV3) 的 27 个活动，故按 type 补。
 *
 * 用法（先按 reference-game-lua-logic 解出 configs.ab 的 TextAsset）：
 *   node tools/build-story-archive.mjs <解出目录>
 * 产物三类：classes（行动记录）、mainline（story_avg 里未归入任何活动的扇区，
 * 按 sectorId 聚簇并用 sector 表解名）、unarchived（语料里连 story_avg 行都没有
 * 的段，留给剧本库按 ID 首段兜底）。 */
import {readFileSync, writeFileSync, existsSync, readdirSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {parseChunk} from '../js/core/lundump.js';
import {execChunk, toJS} from '../js/core/lvm.js';

const ROOT = resolve(process.cwd());
const src = resolve(process.argv[2] ?? '');
const OUT = join(ROOT, 'data', 'index', 'story-archive.json');

if (!existsSync(join(src, 'LuaConfigs.handbook_activity.lua.bytes'))) {
  console.error(`找不到 ${join(src, 'LuaConfigs.handbook_activity.lua.bytes')}`
      + `——先按 reference-game-lua-logic 解出 configs.ab 的 TextAsset`);
  process.exit(1);
}

const cache = new Map();
const decode = (name, maxSteps = 2_000_000_000) => {
  if (!cache.has(name)) {
    const path = join(src, `LuaConfigs.${name}.lua.bytes`);
    if (!existsSync(path)) throw new Error(`缺表 ${name}`);
    cache.set(name, toJS(execChunk(parseChunk(readFileSync(path)), {maxSteps})[0]));
  }
  return cache.get(name);
};
const lang = decode('locale_text');
const text = (key) => (key == null ? null : lang[String(key)] ?? null);

/* —— story_avg：一行一段可播剧情，建三张反查索引 ——
   只收语料索引里真能装载的段。两处口径差：
   ① story_avg 有 1270 段带 script_id，其中 203 段的 AvgCfg 不在本仓库语料里
      （缺件死行），列进档案只会点了报错；
   ② 202 段写成「<容器>.<段名>」（23sg.23sg_a01、24winter.24winter_s00…），
      语料按 AvgCfg 文件名收，不含容器前缀 ⇒ 归一化后才是可装载的 id。 */
const manifest = JSON.parse(readFileSync(join(ROOT, 'data', 'index', 'avg-scripts.json'), 'utf8'));
const corpus = new Set(manifest.stories.map((s) => s.id));
const inCorpus = (id) => {
  if (corpus.has(id)) return id;
  const tail = id.split('.').slice(1).join('.');
  return tail && corpus.has(tail) ? tail : null;
};
const storyRows = [];
for (const r of Object.values(decode('story_avg'))) {
  if (!r || typeof r !== 'object' || !r.script_id) continue;
  const id = inCorpus(r.script_id);
  if (id) storyRows.push({...r, script_id: id});
}
const byAvgId = new Map();
const bySector = new Map();
const byStage = new Map();
const push = (map, key, row) => {
  if (key == null) return;
  const list = map.get(key) ?? [];
  list.push(row);
  map.set(key, list);
};
for (const r of storyRows) {
  push(byAvgId, r.id, r);
  push(bySector, r.sectorId, r);
  push(byStage, r.set_place, r);
}

const flatten = (v, out = []) => {
  if (v == null) return out;
  if (Array.isArray(v)) for (const x of v) flatten(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) flatten(x, out);
  else out.push(v);
  return out;
};

/* 一条 activity_*_main 行 → 该行的剧情段。字段语义见头注。 */
const SECTOR_RE = /_sector$|^sector$|^sectorId$/;
const STAGE_RE = /_stage$|^stage_id$/;
const AVG_RE = /_avg$|^avg_id$|^story_id$|^story_ids$/;
const rowsOfField = (key, val) => {
  const ids = flatten(val).filter((x) => typeof x === 'number' && x > 0);
  if (SECTOR_RE.test(key)) return ids.flatMap((i) => bySector.get(i) ?? []);
  if (STAGE_RE.test(key)) return ids.flatMap((i) => byStage.get(i) ?? []);
  if (AVG_RE.test(key)) return ids.flatMap((i) => byAvgId.get(i) ?? []);
  return [];
};

/* —— 活动 → 剧情段：一次把 activity 系表按 actId 归组，再逐活动查 —— */
const ACT_TABLE_RE = /^(activity|act_|sign_theater|delivery_activity|hero_)/;
/* 行归属信号：显式的活动外键，或「表键就是这行的 id」（静态表按 actId 建键）。 */
const OWNER_RE = /^(activity_id|activity_tech_type|lobby_id|act_id)$/;

const decodeOpt = (name) => {
  const path = join(src, `LuaConfigs.${name}.lua.bytes`);
  if (!existsSync(path)) return null;
  try { return decode(name); } catch { return null; }
};

/* actId → 该活动在这些表里的行（带证据强度：显式活动外键 2 分，仅表键 1 分） */
const rowsByAct = new Map();
const attach = (actId, row, score) => {
  if (actId == null || !row || typeof row !== 'object' || Array.isArray(row)) return;
  const list = rowsByAct.get(Number(actId)) ?? [];
  rowsByAct.set(Number(actId), list);
  const cur = list.find((e) => e.row === row);
  if (cur) cur.score = Math.max(cur.score, score);
  else list.push({row, score});
};
const tableNames = readdirSync(src)
    .map((f) => f.match(/^LuaConfigs\.(.+)\.lua\.bytes$/)?.[1])
    .filter((n) => n && ACT_TABLE_RE.test(n));
for (const t of tableNames) {
  const tbl = decodeOpt(t);
  for (const [key, v] of Object.entries(tbl ?? {})) {
    for (const row of Array.isArray(v) ? v : [v]) {
      if (!row || typeof row !== 'object') continue;
      for (const [k, val] of Object.entries(row)) {
        if (OWNER_RE.test(k)) attach(val, row, 2);
      }
      attach(key, row, 1);                         /* 静态表：表键即 actId */
    }
  }
}

/* actId → script_id → {score, row}：同一活动内按段去重、保留更强证据。
   跨活动允许多归属——重制复刻活动（handbook_activity.repeat_remaster_act_id）
   与原作共用同一批 script_id，游戏侧两张卡片也确实都列这些剧情。 */
const owned = new Map();
const offer = (actId, score, row) => {
  if (!row.script_id) return;
  const d = owned.get(Number(actId)) ?? new Map();
  owned.set(Number(actId), d);
  const cur = d.get(row.script_id);
  if (!cur || score > cur.score) d.set(row.script_id, {score, row});
};

/* 第三条、也是唯一与游戏侧同构的路由：eActivityType → 该类型的回顾表
   （照 HandBookActReviewFunc 的 21 个处理器逐个抄自反汇编）。回顾表的行按
   「同系列序号」建，序号 = activity[actId].activity_id，缺省即首期。 */
const TYPE_TABLE = {
  9: 'activity_time_limit', 10: 'activity_hero', 11: 'activity_winter',
  13: 'activity_refresh_dungeon', 17: 'activity_carnival',
  18: 'activity_tiny_game_main', 19: 'activity_dailychallenge',
  20: 'activity_summer_main', 22: 'activity_hallowmas_main',
  24: 'activity_spring_main', 25: 'activity_winter23_main',
  31: 'activity_season_main', 33: 'activity_carnival23_main',
  39: 'sign_theater_main', 40: 'activity_anniversary_main',
  45: 'activity_23steinsgate_storyline', 51: 'activity_treasurehunt_main',
  54: 'activity_herolite_avg', 56: 'activity_carnival24_main',
  58: 'delivery_activity_main', 59: 'activity_anniversary24_main',
};
/* 回顾表之外还要读一张的：同行礼遇的剧情挂在按序号归组的任务表上。 */
const TYPE_EXTRA = {39: 'sign_theater_task_condition'};

const isStoryField = (k) => SECTOR_RE.test(k) || STAGE_RE.test(k) || AVG_RE.test(k);
const seriesRow = (tbl, series) => (Array.isArray(tbl)
    ? tbl[series - 1] : (tbl ?? {})[String(series)]);

const collect = (actId) => {
  /* ① 处理器路由：类型 → 回顾表 → 该活动在那张表里的那一行 */
  const meta = activity[String(actId)];
  const table = TYPE_TABLE[meta?.type];
  if (table) {
    const series = meta.activity_id ?? 1;
    for (const name of [table, TYPE_EXTRA[meta.type]].filter(Boolean)) {
      let row = seriesRow(decodeOpt(name), series);
      /* 序号归组的数组表（sign_theater_task_condition）：行内再挑 activity_id 相等者 */
      if (Array.isArray(row)) row = row.filter((r) => (r?.activity_id ?? series) === series);
      const harvest = (node, depth) => {
        for (const [k, v] of Object.entries(node ?? {})) {
          if (isStoryField(k)) { for (const r of rowsOfField(k, v)) offer(actId, 4, r); }
          else if (v && typeof v === 'object' && depth < 2) harvest(v, depth + 1);
        }
      };
      for (const one of (Array.isArray(row) ? row : [row])) if (one) harvest(one, 0);
    }
  }
  /* ② 通用字段路由：activity 系表里按显式外键/表键挂上来的行 */
  for (const {row, score} of rowsByAct.get(Number(actId)) ?? []) {
    for (const [k, val] of Object.entries(row)) {
      if (!isStoryField(k)) continue;
      for (const r of rowsOfField(k, val)) offer(actId, score, r);
    }
  }
  /* ③ 号段路线：story_avg 的 sectorId 直接以 actId 打头（59001 → 590011/590012）。
     同一段的普通/困难两难度会重复出现，按 script_id 归并后只剩真剧情段。 */
  const id = String(actId);
  for (const r of storyRows) {
    const s = String(r.sectorId ?? '');
    if (s.length > id.length && s.startsWith(id)) offer(actId, 3, r);
  }
};

/* —— 行动记录三类的成员与顺序 —— */
const hb = decode('handbook_activity');
const activity = decode('activity');
const activityName = decode('activity_name');
const sector = decode('sector');

const actName = (actId) => {
  const row = activity[String(actId)];
  const an = row ? activityName[String(row.name_id)] : null;
  return an ? text(an.name) : null;
};
const actType = (actId) => activity[String(actId)]?.type ?? null;

const classDefs = hb.map((cls, i) => {
  const classId = cls?.id ?? i + 1;
  const years = new Map();
  for (const [y, ids] of Object.entries(cls?.yearDic ?? {})) {
    for (const id of (Array.isArray(ids) ? ids : Object.values(ids ?? {}))) years.set(Number(id), +y);
  }
  let members = Object.keys(cls?.content ?? {}).map(Number);
  if (!members.length) {                          /* 专属剧情：按 eActivityType 补成员 */
    members = Object.entries(activity)
        .filter(([, r]) => r && (r.type === 10 || r.type === 54))
        .map(([id]) => Number(id));
  }
  return {
    classId,
    name: text(cls?.activity_class)
        ?? (classId === 2 ? '常规活动' : classId === 1 ? '大型活动' : '专属剧情'),
    years,
    members: members.sort((a, b) => a - b),
  };
});

for (const def of classDefs) for (const id of def.members) collect(id);

const claimed = new Set();
/* 分档取用：处理器路由(4)是游戏侧同构的证据，有它就不再要号段前缀——号段按
   actId 数字前缀匹配，会串到邻居活动（33005 致光态真扇区是 33006X）。 */
const storiesOf = (actId) => {
  const all = [...(owned.get(actId) ?? []).values()];
  for (const min of [4, 2, 1]) {
    const tier = all.filter((e) => e.score >= min);
    if (tier.length) {
      return tier.map((e) => e.row).sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
    }
  }
  return [];
};
const classes = classDefs.map((def) => ({
  classId: def.classId,
  name: def.name,
  activities: def.members.map((id) => {
    const stories = storiesOf(id);
    for (const s of stories) claimed.add(s.script_id);
    return {
      id,
      name: actName(id),
      year: def.years.get(id) ?? null,
      type: actType(id),
      stories: stories.map((s) => ({
        id: s.script_id, name: text(s.name), brief: text(s.story_review_describe ?? s.describe),
      })),
    };
  }),
}));

/* —— 未归入行动记录的 story_avg 行：按扇区聚成「主线/其他」 —— */
const leftoverSectors = new Map();
const leftoverSeen = new Set();
for (const r of storyRows) {
  if (claimed.has(r.script_id) || leftoverSeen.has(r.script_id)) continue;
  leftoverSeen.add(r.script_id);
  const list = leftoverSectors.get(r.sectorId) ?? [];
  list.push(r);
  leftoverSectors.set(r.sectorId, list);
}
const mainline = [...leftoverSectors.entries()]
    .map(([sectorId, rows]) => ({
      sectorId: sectorId ?? null,
      name: sectorId != null ? text(sector?.[String(sectorId)]?.name) : null,
      stories: rows.sort((a, b) => (a.number ?? 0) - (b.number ?? 0))
          .map((s) => ({id: s.script_id, name: text(s.name)})),
    }))
    .sort((a, b) => (a.sectorId ?? 0) - (b.sectorId ?? 0));

/* —— 语料里连 story_avg 行都没有的段 —— */
const archived = new Set(storyRows.map((r) => r.script_id));
const unarchived = manifest.stories.map((s) => s.id).filter((id) => !archived.has(id));

writeFileSync(OUT, JSON.stringify({classes, mainline, unarchived}, null, 1) + '\n');

for (const c of classes) {
  console.log(`${c.name}（class ${c.classId}）：${c.activities.length} 个活动 · `
      + `${c.activities.reduce((n, a) => n + a.stories.length, 0)} 段剧情`
      + ` · 空活动 ${c.activities.filter((a) => !a.stories.length).map((a) => a.id).join(',') || '无'}`);
}
console.log(`主线/其他：${mainline.length} 个扇区 · `
    + `${mainline.reduce((n, m) => n + m.stories.length, 0)} 段`);
console.log(`无档段：${unarchived.length}`);
console.log(`story_avg 有档 ${archived.size} 段，行动记录收 ${claimed.size} 段`);
