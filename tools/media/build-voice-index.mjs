/* build-voice-index.mjs —— 生成 data/index/voices.json：AVG 剧情 voice
   字段 {heroId, voiceId} → CRIWARE cue 的映射表。
 *
 * 机制（M15 逐层实证，全部来自游戏配置表）：
 *   heroId  → 代号：LuaConfigs.skin.lua 里该英雄默认皮肤（缺省时最小 id
 *             皮肤）的 src_id_pic 字段；如 1002→anna、1034→abigail。
 *             纯 name_en 不行（Antonina≠abigail，那是本地化名）。
 *   voiceId → 语音名：LuaConfigs.audio_voice.lua[voiceId].name，如
 *             112→RELATIONSHIP1 … 116→RELATIONSHIP5、117→OATH、1→MORNING。
 *   cue     = `<代号>_<语音名>`，落在 VO_<代号>.awb（已由 unpack-acb.mjs
 *             --voice 转码进 data/audio/VO_<代号>/，cue 名进 audio.json）。
 *
 * 用法（先解出 configs.ab 的两张表）：
 *   AssetStudio.CLI.exe <镜像>/res/luascripts/configs.ab <输出> --game FakeHeader
 *   node tools/media/build-voice-index.mjs <输出>/TextAsset
 * 产物附带 coverage：全语料 voice 引用逐对核对（cue 存在于 audio.json 才算
 * 命中），缺语音包/缺条目的对会列出来供排查。 */
import {readFileSync, writeFileSync, existsSync, readdirSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {parseChunk} from '../../js/core/lundump.js';
import {execChunk, toJS} from '../../js/core/lvm.js';

const ROOT = resolve(process.cwd());
const args = process.argv.slice(2);
const src = resolve(args[0] ?? '');
const OUT = join(ROOT, 'data', 'index', 'voices.json');

if (!existsSync(join(src, 'LuaConfigs.skin.lua.bytes'))) {
  console.error(`找不到 ${join(src, 'LuaConfigs.skin.lua.bytes')}——先按头注释解出 configs.ab`);
  process.exit(1);
}

const decode = (name, maxSteps = 300_000_000) =>
    toJS(execChunk(parseChunk(readFileSync(join(src, `LuaConfigs.${name}.bytes`))), {maxSteps})[0]);

const skin = decode('skin.lua');
const audioVoice = decode('audio_voice.lua');
const heroData = decode('hero_data.lua');
const heroDataNameEn = Object.fromEntries(Object.entries(heroData)
    .filter(([, h]) => h && typeof h.name_en === 'string')
    .map(([key, h]) => [String(h.id ?? key), h.name_en.toLowerCase()]));

/* —— heroId → 代号 —— */
const byHero = {};
for (const s of Object.values(skin)) {
  if (!s || typeof s !== 'object' || !s.heroId || !s.src_id_pic) continue;
  const cur = byHero[s.heroId];
  /* 默认皮肤权威；否则取最小 id 皮肤的 pic（_p2/_p3 变体去掉变体尾） */
  const better = !cur || (s.isdefault_skin && !cur.isdefault)
      || (!cur.pic && s.src_id_pic);
  if (better) {
    byHero[s.heroId] = {
      codename: s.src_id_pic,
      isdefault: !!s.isdefault_skin,
      pic: s.src_id_pic,
    };
  }
}
/* 变体尾归一：abigail_p2 → abigail（基础代号总有自己的目录/语音表） */
for (const h of Object.values(byHero)) {
  h.codename = h.codename.replace(/_p\d+$/, '');
}
/* 无皮肤条目的英雄（如 1001 帕斯卡）：name_en 小写兜底（仅当 VO 表确实存在） */
const voSheets = new Set(existsSync(join(ROOT, 'data', 'audio'))
    ? readdirSync(join(ROOT, 'data', 'audio')).filter((d) => d.startsWith('VO_')) : []);
for (const [id, h] of Object.entries(heroDataNameEn)) {
  if (!byHero[id] && voSheets.has(`VO_${h}`)) {
    byHero[id] = {codename: h, isdefault: false, pic: h, fallback: 'name_en'};
  }
}

/* —— voiceId → 语音名 —— */
const byVoiceId = {};
for (const [id, v] of Object.entries(audioVoice)) {
  if (v && typeof v === 'object' && typeof v.name === 'string') byVoiceId[id] = v.name;
}

/* —— 全语料 voice 引用核对 —— */
const manifest = JSON.parse(readFileSync(join(ROOT, 'data', 'index', 'avg-scripts.json'), 'utf8'));
const audio = existsSync(join(ROOT, 'data', 'index', 'audio.json'))
    ? JSON.parse(readFileSync(join(ROOT, 'data', 'index', 'audio.json'), 'utf8'))
    : {sheets: {}};
const pairs = new Set();
const walk = (n) => {
  if (Array.isArray(n)) return n.forEach(walk);
  if (!n || typeof n !== 'object') return;
  if (n.voice && typeof n.voice === 'object' && n.voice.heroId) {
    pairs.add(`${n.voice.heroId}:${n.voice.voiceId}`);
  }
  for (const v of Object.values(n)) walk(v);
};
for (const story of manifest.stories) {
  walk(toJS(execChunk(parseChunk(readFileSync(join(ROOT, story.cfg))))[0]));
}

let hit = 0;
const misses = [];
for (const p of pairs) {
  const [heroId, voiceId] = p.split(':');
  const hero = byHero[heroId];
  const name = byVoiceId[voiceId];
  const cue = hero && name ? `${hero.codename}_${name}` : null;
  const sheet = hero ? `VO_${hero.codename}` : null;
  const ok = !!(cue && audio.sheets?.[sheet]?.cues?.[cue]);
  if (ok) hit++;
  else misses.push({heroId: +heroId, voiceId: +voiceId, sheet, cue,
    reason: !hero ? 'no-codename' : !name ? 'no-voice-name' : 'no-cue'});
}

const out = {
  byHero: Object.fromEntries(Object.entries(byHero).map(([id, h]) =>
      [id, {codename: h.codename, sheet: `VO_${h.codename}`}])),
  byVoiceId,
  coverage: {pairs: pairs.size, hit, misses},
};
writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
console.log(`voices.json：${Object.keys(byHero).length} 英雄 · ${Object.keys(byVoiceId).length} 语音名`
    + ` · 语料核对 ${hit}/${pairs.size}`);
for (const m of misses.slice(0, 10)) {
  console.log(`  MISS ${m.heroId}:${m.voiceId} → ${m.sheet ?? '?'} ${m.cue ?? '?'}（${m.reason}）`);
}

/* —— 顺带产出剧情目录（story_avg.lua）：group_id 聚簇 + script_id 直连
   语料，接上 avg-scripts 的 brief/steps 供剧本库「剧情线」视图。
   story_avg 的条目并非全部有 script_id（无的是章节点位），只收有正文的；
   同一 script_id 重复出现的取首个。 */
const storyAvg = decode('story_avg.lua', 500_000_000);
const byScript = new Map(manifest.stories.map((s) => [s.id, s]));
const groups = new Map();
let catalogSkipped = 0;
for (const e of Object.values(storyAvg)) {
  if (!e || typeof e !== 'object' || !e.script_id || groups.has(e.script_id)) continue;
  const meta = byScript.get(e.script_id);
  if (!meta) { catalogSkipped++; continue; }   // 指向缺失剧本的死行不收
  const g = groups.get(e.group_id) ?? [];
  g.push({id: e.script_id, type: e.type ?? null,
      steps: meta?.steps ?? null, brief: meta?.brief ?? null});
  groups.set(e.group_id, g);
}
const catalog = {
  groups: [...groups.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([groupId, stories]) => ({groupId, stories})),
};
writeFileSync(join(ROOT, 'data', 'index', 'story-catalog.json'),
    JSON.stringify(catalog, null, 1) + '\n');
const cataloged = catalog.groups.reduce((n, g) => n + g.stories.length, 0);
console.log(`story-catalog.json：${catalog.groups.length} 组 · ${cataloged} 条目录`
    + `（语料 ${manifest.stories.length} 段中在册 ${new Set(catalog.groups.flatMap((g) => g.stories.map((s) => s.id))).size}）`);
