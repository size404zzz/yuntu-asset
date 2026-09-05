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
 *   处理器，这里照它落四条路由，按证据强度分档取用（有高档证据时低档一律让位，
 *   见 storiesOf）：
 *     档 5 直挂列      story_avg.activity_id = actId（type 10 的游戏分组列，
 *                      强于号段前缀——前缀会撞车，10010 ← 100101 深红葬场）
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
 * 的段，留给剧本库按 ID 首段兜底）。
 * 卡片上的「活动奖励 x/y」「剧情进度 x/y」不还原：分子是玩家存档态，分母的
 * 动态表部分随版本漂移，与「分类 → 年份 → 活动 → 剧本」的树无关。 */
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
/* 可选：活体剧情分类（tools/frida/dyn-config-dump.py 的 classifyAll 抓取件，
 * 经 data/index/story-classification-live.json 进入；缺席时全部退回静态路由）。 */
const loadOptionalJson = (p) => {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
};

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

/* —— story_avg：一行一段可播剧情，建反查索引 ——
   只收语料索引里真能装载的段（stories）。两处口径差：
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
const byActivity = new Map();       /* story_avg.activity_id 直挂列（语料内） */
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
  push(byActivity, r.activity_id, r);
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
  /* ⓪ 直挂列：story_avg.activity_id 就是游戏侧的活动分组列（type 10 专属剧情
     的唯一挂载点），证据最强。不看它会输给号段前缀——前缀会撞车
     （10010 薄暮葬曲 ← 100101 深红葬场）。 */
  for (const r of byActivity.get(Number(actId)) ?? []) offer(actId, 5, r);
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
          if (isStoryField(k)) {
            for (const r of rowsOfField(k, v)) offer(actId, 4, r);
          } else if (v && typeof v === 'object' && depth < 2) harvest(v, depth + 1);
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
/* yearDic 缺席时的档期年份（专属剧情整类没有 yearDic）：按活动结束时刻的年份
   归属，跨年活动归结束侧——与游戏时间轴一致（冥刃沐辉 2023-12 开启归 2024）。
   结束时刻都是 UTC+8 的深夜，+8h 后取 UTC 年份即档期年份。 */
const seasonYear = (actId) => {
  const r = activity[String(actId)] ?? {};
  const t = r.rewardEnd_time ?? r.start_time;
  return typeof t === 'number' && t > 0
      ? new Date((t + 8 * 3600) * 1000).getUTCFullYear()
      : null;
};

const classDefs = hb.map((cls, i) => {
  const classId = cls?.id ?? i + 1;
  const years = new Map();
  for (const [y, ids] of Object.entries(cls?.yearDic ?? {})) {
    for (const id of (Array.isArray(ids) ? ids : Object.values(ids ?? {}))) years.set(Number(id), +y);
  }
  const content = cls?.content ?? {};
  let members = Object.keys(content).map(Number);
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
    content,
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

/* —— 活体剧情分类（最高优先级数据源）——
 * story-classification-live.json 由 tools/frida/dyn-config-dump.py 在运行中的
 * 游戏里直接调用 HandBookActReviewFunc[type] 处理器取得：每组带 groupName/
 * groupENName 和 AvgIdList（story_avg 行 id），就是游戏「行动记录」卡片点
 * 「查看」后显示的分组。存在时 stories 以它为准（组序 = 游戏显示序），缺席
 * 的段（语料外）跳过，静态路由退居兜底。 */
const liveClassification = loadOptionalJson(join(ROOT, 'data', 'index', 'story-classification-live.json'));
const liveByAct = new Map((liveClassification ?? []).map((x) => [Number(x.actId), x]));
const byScript = new Map(storyRows.map((r) => [r.script_id, r]));
const storiesFor = (actId) => {
  const live = liveByAct.get(Number(actId));
  if (live?.groups?.length) {
    const seen = new Set();
    const rows = [];
    for (const g of live.groups) {
      for (const s of g.stories) {
        if (!s.script || seen.has(s.script)) continue;
        seen.add(s.script);
        const row = byScript.get(s.script);
        if (row) rows.push(row);
      }
    }
    if (rows.length) return rows;
  }
  return storiesOf(actId);
};
const classes = classDefs.map((def) => ({
  classId: def.classId,
  name: def.name,
  activities: def.members.map((id) => {
    const stories = storiesFor(id);
    for (const s of stories) claimed.add(s.script_id);
    return {
      id,
      name: actName(id),
      year: def.years.get(id) ?? seasonYear(id),
      type: actType(id),
      stories: stories.map((s) => ({
        id: s.script_id, name: text(s.name), brief: text(s.story_review_describe ?? s.describe),
      })),
    };
  }),
}));

/* —— 未归入行动记录的 story_avg 行：按扇区聚成「主线/其他」 ——
 * sectorId 为空的行做两级细分（游戏里它们没有统一的回顾入口，触发登记是
 * 登录后按账号从服务器推送的 OnRecvNewAvgTask，属账号态）：
 *   ① set_place → sector_stage.sector（关卡归属，游戏权威数据）→ 归入扇区；
 *   ② 剩余按段前缀的语义建事件组（誓约/节日角色剧情/彩蛋小游戏/后日谈…），
 *      这些在当前版本已无游戏内入口，名称取自脚本前缀的公认事件语义。 */
const sectorStage = decode('sector_stage');
/* 段前缀 → 事件组（当前版本游戏内已无入口的散段，按脚本前缀的公认事件语义归组） */
const MAINLINE_EVENT_GROUPS = [
  ['23oath_', '誓约剧情'],
  ['24oath_', '誓约剧情'],
  ['22white', '2022圣诞·角色剧情'],
  ['22tana', '2022七夕·角色剧情'],
  ['22christ', '2022圣诞·小游戏'],
  ['23april', '2023愚人节'],
  ['cpt_return', '回归活动'],
  ['24fe2', '昔影归终·角色小剧场'],
  ['24fe_zhiyuan', '昔影归终·追忆'],
  ['24fe2_zhiyuan', '昔影归终·追忆'],
  ['23sg_cafe', '境界干涉·咖啡厅'],
  ['24idol', '2023偶像祭'],
  ['23concert_piano', '星海巡音·钢琴曲'],
  ['23winter_s', '悬光升变·补充剧情'],
  ['23carnival_00', '无律背反·OP'],
  ['23summer_0', '致密静点·OP'],
  ['22summer_s', '临界爆震·结尾'],
  ['22hallo_e', '诡海迷航·后日谈'],
  ['23spring_hb', '迎春闹园记·补充'],
  ['23christ_florence', '2022圣诞·弗洛伦斯'],
  ['cpt00', '序章·教学'],
  ['cpt05', '柯普利·后日谈'],
  ['cpt_jiangyu', '战棋玩法'],
  ['cpt_erika', '角色章节·补充'],
  ['cpt_undline', '角色章节·补充'],
  ['cpt_sp', '特别篇'],
  ['1year', '周年庆'],
  ['2year', '周年庆'],
];
const mainlineEventOf = (r) => {
  const st = r.set_place != null ? sectorStage[String(r.set_place)] : null;
  if (st?.sector != null) return {sector: Number(st.sector)};
  for (const [prefix, label] of MAINLINE_EVENT_GROUPS) {
    if (r.script_id.startsWith(prefix)) return {event: label};
  }
  return null;
};
const leftoverSectors = new Map();
const leftoverSeen = new Set();
for (const r of storyRows) {
  if (claimed.has(r.script_id) || leftoverSeen.has(r.script_id)) continue;
  leftoverSeen.add(r.script_id);
  let key = r.sectorId;
  if (key == null) {
    const hit = mainlineEventOf(r);
    if (hit?.sector != null) key = hit.sector;
    else if (hit?.event != null) key = `event:${hit.event}`;
  }
  const list = leftoverSectors.get(key) ?? [];
  list.push(r);
  leftoverSectors.set(key, list);
}
const mainline = [...leftoverSectors.entries()]
    .map(([sectorId, rows]) => ({
      sectorId: typeof sectorId === 'number' ? sectorId : null,
      event: typeof sectorId === 'string' ? sectorId.slice('event:'.length) : undefined,
      name: sectorId != null
          ? (typeof sectorId === 'number'
              ? text(sector?.[String(sectorId)]?.name)
              : sectorId.slice('event:'.length))
          : null,
      stories: rows.sort((a, b) => (a.number ?? 0) - (b.number ?? 0))
          .map((s) => ({id: s.script_id, name: text(s.name)})),
    }))
    .sort((a, b) => (a.sectorId ?? 999999) - (b.sectorId ?? 999999));

/* —— 语料里连 story_avg 行都没有的段 ——
 * 按游戏数据细分命名：
 *   dorm_*：宿舍互动剧情，dorm_hero_talk.talk_list 按英雄登记（93 英雄），
 *           角色名用 hero_data[heroId].name 解（阿比盖尔未登记进 talk 表，
 *           走 voices 的 codename 反查，特例 1034）；
 *   其余：教学关/活动关卡/支线/测试段，按前缀映射到章节与活动的语义组。 */
const archived = new Set(storyRows.map((r) => r.script_id));
const dormHeroTalk = decode('dorm_hero_talk');
/* 角色名只认 hero_data：avg_character 是 AVG 演出角色表，它的 name 不按 heroId
 * 对位（实测 90 个宿舍角色里 48 个报错人：dorm_eos_* 属 hero 1068＝晨曦，
 * avg_character 却给成渡宾——那是 Dupin 的名字）。 */
const heroData = decode('hero_data');
const scriptHeroKey = new Map();
for (const [heroId, row] of Object.entries(dormHeroTalk)) {
  for (const s of (row?.talk_list ?? [])) scriptHeroKey.set(s, heroId);
}
/* talk 表未登记的后期角色（阿比盖尔）：codename → heroId（voices 索引）→ hero_data 名 */
const codenameHero = new Map();
for (const [heroId, info] of Object.entries(loadOptionalJson(join(ROOT, 'data', 'index', 'voices.json'))?.byHero ?? {})) {
  if (info?.codename) codenameHero.set(String(info.codename), heroId);
}
const UNARCHIVED_EVENT_GROUPS = [
  ['cpt00_tutorial', '序章·教学'],
  ['cpt00_e', '序章·主线'],
  ['cpt02_tutorial', '基洛普斯·教学'],
  ['cpt05_tutorial', '柯普利·教学'],
  ['cpt06_tutorial', '神导异论·教学'],
  ['survivors_tutorial', '幸存者·教学'],
  ['cpt_imr', '逆波共振·试炼剧情'],
  ['cpt_hb', '抑质链·关卡剧情'],
  ['22hallo_e', '诡海迷航·后日谈'],
  ['23carnival', '无律背反·支线'],
  ['23summer', '致密静点·支线'],
  ['23winter_defend', '悬光升变·守卫战'],
  ['24spring_persicaria', '迎春闹园记·佩里卡'],
  ['1year_anniversary', '周年庆'],
  ['22christ_hall', '2022圣诞·小游戏'],
  ['23Music_live', '星海巡音·演唱会'],
  ['cpt_challenge', '挑战关卡'],
  ['oath_', '誓约剧情'],
  ['cpt_inner', '主线·内传'],
  ['cpt_longtail', '主线·教学'],
  ['cpt_dupin_chess', '战棋玩法'],
  ['cpt_undline_chess', '战棋玩法'],
  ['cpt_yousei', '角色章节·补充'],
  ['blackhole_demo', '测试与演示'],
  ['personaltest', '测试与演示'],
  ['testdemo', '测试与演示'],
  ['Test', '测试与演示'],
];
const CHAPTER_NAMES = {1: '罗萨姆', 2: '基洛普斯', 3: '赫里奥斯', 4: '恩格玛', 5: '柯普利', 6: '神导异论'};
const unarchivedGroupOf = (id) => {
  if (id.startsWith('dorm_')) {
    const codename = id.split('_')[1] ?? '';
    const heroKey = scriptHeroKey.get(id) ?? codenameHero.get(codename);
    /* 新角色的中文名可能在静态语言表缺席（版本差），回退游戏英文代号 */
    const heroName = text(heroData[String(heroKey)]?.name)
        ?? (codenameHero.has(codename) ? codename.toUpperCase() : null);
    return heroName ? `宿舍剧情·${heroName}` : '宿舍剧情';
  }
  for (const [prefix, label] of UNARCHIVED_EVENT_GROUPS) {
    if (id.startsWith(prefix)) return label;
  }
  const chapter = id.match(/^cpt0([1-6])_(e|h)(?:_|$)/);
  if (chapter) {
    return `${CHAPTER_NAMES[chapter[1]] ?? `第${chapter[1]}章`}·${chapter[2] === 'e' ? '支线剧情' : '隐藏剧情'}`;
  }
  return null;
};
const unarchived = manifest.stories.map((s) => s.id).filter((id) => !archived.has(id))
    .map((id) => ({id, group: unarchivedGroupOf(id) ?? `未归类·${id.split('_')[0]}`}));

/* —— 小项合并：事件组/未归档组按前缀语义并入对应大项 ——
 * 「逆波共振·试炼剧情」「抑质链·关卡剧情」这类小项，其前缀就是某个活动的
 * 名字：并入该活动（大型活动-年份-逆波共振 的容器里看到全部剧情）。优先级：
 *   ① 活动名 === 前缀，或活动名以前缀开头（境界干涉 → 境界干涉的延迟选择）；
 *   ② 主线扇区组与前缀同名（基洛普斯·教学 → 主线-基洛普斯）；
 *   ③ 主线事件组与前缀同名（未归档-序章·教学 → 主线-序章·教学）。
 * 无宿主的小项（誓约剧情/测试与演示/宿舍剧情·角色…）原地保留。 */
const activityByName = new Map();
for (const c of classes) for (const a of c.activities) if (a.name) activityByName.set(a.name, a);
const activityByBase = (base) => activityByName.get(base)
    ?? [...activityByName.values()].find((a) => base.length >= 3 && a.name.startsWith(base));
const baseOf = (label) => label.split(/[·\-]/)[0].trim();
const absorb = (target, rows) => {
  const seen = new Set(target.stories.map((s) => s.id));
  for (const s of rows) if (!seen.has(s.id)) { seen.add(s.id); target.stories.push(s); }
};

/* ① 未归档组 → 活动 / 主线扇区组 / 主线同名事件组 */
const unarchivedGroups = new Map();
for (const e of unarchived) {
  const list = unarchivedGroups.get(e.group) ?? [];
  list.push(e);
  unarchivedGroups.set(e.group, list);
}
const keptUnarchived = [];
for (const [label, entries] of unarchivedGroups) {
  const base = baseOf(label);
  const rows = entries.map((e) => ({id: e.id, name: null}));
  if (base !== label) {
    const act = activityByBase(base);
    if (act) { absorb(act, rows); continue; }
    const sectorGroup = mainline.find((m) => m.sectorId != null && m.name === base);
    if (sectorGroup) { absorb(sectorGroup, rows); continue; }
    const eventGroup = mainline.find((m) => m.event === label);
    if (eventGroup) { absorb(eventGroup, rows); continue; }
  }
  for (const e of entries) keptUnarchived.push(e);
}
unarchived.length = 0;
unarchived.push(...keptUnarchived);

/* ② 主线事件组/扇区组 → 活动（无律背反-困难模式 → 无律背反 等）；
 *    事件组前缀命中主线扇区组（柯普利·后日谈 → 柯普利）也并入 */
const sectorGroupByName = new Map();
for (const m of mainline) if (m.sectorId != null && m.name) sectorGroupByName.set(m.name, m);
const mergedMainline = [];
for (const m of mainline) {
  const base = baseOf(m.name ?? '');
  const act = base && base !== (m.name ?? '') ? activityByBase(base) : null;
  if (act) { absorb(act, m.stories); continue; }
  const sectorGroup = base && base !== (m.name ?? '') ? sectorGroupByName.get(base) : null;
  if (sectorGroup && sectorGroup !== m) { absorb(sectorGroup, m.stories); continue; }
  mergedMainline.push(m);
}
mainline.length = 0;
mainline.push(...mergedMainline);

/* ③ 未归档组与主线组同名（不同数据源的同类段，如 战棋玩法）→ 并入主线组 */
const mainlineByName = new Map();
for (const m of mainline) if (m.name) mainlineByName.set(m.name, m);
const keptUnarchived2 = [];
const survivedGroups = new Map();
for (const e of keptUnarchived) {
  survivedGroups.set(e.group, [...(survivedGroups.get(e.group) ?? []), e]);
}
for (const [label, entries] of survivedGroups) {
  const target = mainlineByName.get(label);
  if (target) { absorb(target, entries.map((e) => ({id: e.id, name: null}))); continue; }
  for (const e of entries) keptUnarchived2.push(e);
}
unarchived.length = 0;
unarchived.push(...keptUnarchived2);

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
