/**
 * M13 AvgCfg 字节码解释器回归（纯 Node）：格式解析、VM 语义锚点、
 * 全语料 0 失败与普查口径。
 * 用法：node tools/test-avgcfg.mjs
 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {parseChunk} from '../js/core/lundump.js';
import {execChunk, toJS} from '../js/core/lvm.js';
import {storyToWire, replayChain} from '../js/core/avgwire.js';
import {emptyState, applyImages, applyShotTweens} from '../js/core/state.js';

let passed = 0;
const ok = (m) => { passed++; console.log('  ok   ' + m); };
const ROOT = resolve(process.cwd());
const AVG = join(ROOT, 'res', 'Assets', 'Res', 'LuaScripts', 'Avg');
const manifest = JSON.parse(readFileSync(join(ROOT, 'data', 'index', 'avg-scripts.json'), 'utf8'));
const byId = new Map(manifest.stories.map((s) => [s.id, s]));

function decode(kind, id) {
  const story = byId.get(id);
  assert.ok(story, `剧本 ${id} 在索引里`);
  const proto = parseChunk(readFileSync(join(ROOT, kind === 'lang' ? story.lang : story.cfg)));
  return toJS(execChunk(proto)[0]);
}

/* 沿重放链折叠 lane 状态，返回「镜键 → 该立绘路径的 settled alpha」。
   修复层判的是折叠态，屏上落的也是折叠态，断言必须走同一条链。 */
function foldAlpha(wire, path) {
  const state = emptyState();
  const pathOf = new Map();
  const out = new Map();
  for (const k of replayChain(wire)) {
    const shot = wire[k];
    if (shot.images?.length) {
      applyImages(state, shot.images);
      for (const im of shot.images) {
        if (im.imgPath && !im.delete) pathOf.set(im.imgId, im.imgPath);
        else if (im.delete) pathOf.delete(im.imgId);
      }
    }
    applyShotTweens(state, shot);
    for (const [imgId, lane] of state.lanes) {
      if (pathOf.get(imgId) === path) out.set(String(k), lane.alpha);
    }
  }
  return out;
}

/* —— lundump：结构与格式护栏 —— */

const proto = parseChunk(readFileSync(join(AVG, 'AvgCfg_cpt00_e_01_01.lua')));
assert.equal(proto.code.length, 786);
assert.equal(proto.constants.length, 163);
assert.ok(proto.source.endsWith('AvgCfg_cpt00_e_01_01.lua'), 'source 串保留原路径');
assert.deepEqual(proto.upvalNames, ['_ENV']);
assert.equal(proto.isVararg, 1);
ok(`lundump：cpt00_e_01_01 结构（code 786 / 常量 163 / _ENV）`);

assert.throws(() => parseChunk(new Uint8Array(Buffer.from('not lua at all, really'))),
    /不是云图 Lua 字节码：magic 不符/);
assert.throws(() => {   // 截尾：Node 读越界（RangeError）也必须拒收
  const bytes = readFileSync(join(AVG, 'AvgCfg_cpt00_e_01_01.lua'));
  parseChunk(bytes.subarray(0, bytes.length - 10));
});
assert.throws(() => {   // 加尾：EOF 对齐校验兜底
  const bytes = readFileSync(join(AVG, 'AvgCfg_cpt00_e_01_01.lua'));
  parseChunk(Buffer.concat([bytes, Buffer.from([0xaa, 0xbb, 0xcc])]));
}, /解析结束残留/);
ok('lundump：坏 magic / 截尾 / 加尾明确报错');

/* —— VM：与之前 strings 侧写核对的真实引用 —— */

const cfg = decode('cfg', 'cpt00_e_01_01');
assert.ok(Object.keys(cfg).every((k) => /^\d+$/.test(k)), '步骤键全是数字 ID');
const step2 = cfg['2'];
assert.equal(step2.images[1].imgPath, 'cpt00/cpt00_e_bg001');
assert.equal(step2.images[0].imgPath, 'cpt00/cpt00_e_cg001');
assert.equal(step2.effect.effect1.prefabName, 'avg/FXP_Scene');
assert.equal(step2.audio.sfx.cue, 'AVG_ElecSpace');
assert.equal(step2.audio.sfx.sheet, 'AVG_gf');
assert.equal(cfg['3'].audio.bgm.cue, 'Mus_Story_Serious');
assert.equal(cfg['6'].nextId, 99);
ok('VM：AvgCfg 语义锚点（bg/CG/prefab/sfx/bgm/nextId）');

/* AvgLang：content-id → 台词文本（说话人名是独立条目）。 */
const lang = decode('lang', 'cpt00_e_01_01');
const texts = Object.values(lang).filter((t) => typeof t === 'string').join('\n');
assert.ok(texts.includes('云图计划'), '台词含「云图计划」');
assert.ok(texts.includes('<a href=Des:'), '台词保留富文本标记');
assert.ok(Object.keys(lang).includes(String(cfg['2'].content)), 'Cfg 的 content=20 命中 Lang 键');
const byteLen = new TextEncoder();
const longText = Object.values(decode('lang', '22child_02'))
    .filter((t) => typeof t === 'string').find((t) => byteLen.encode(t).length > 250);
assert.ok(longText, '255 转义长度路径：22child_02 有 >250 字节的台词');
ok(`VM：AvgLang 台词与富文本（长串转义命中 ${byteLen.encode(longText).length} 字节）`);

assert.equal(JSON.stringify(decode('cfg', 'cpt00_e_01_01')),
    JSON.stringify(decode('cfg', 'cpt00_e_01_01')), '解码确定性');
ok('VM：同文件两次解码逐字节一致');

/* —— 全语料：0 失败 + 普查口径 —— */

const t0 = performance.now();
let failures = 0, cfgSteps = 0, langSteps = 0, closures = 0;
const firstFails = [];
for (const story of manifest.stories) {
  for (const kind of ['cfg', 'lang']) {
    try {
      const p = parseChunk(readFileSync(join(ROOT, kind === 'lang' ? story.lang : story.cfg)));
      const countClosures = (fn) => {
        closures += fn.code.filter((ins) => (ins & 0x3F) === 44).length;
        for (const sub of fn.protos) countClosures(sub);
      };
      countClosures(p);
      const js = toJS(execChunk(p)[0]);
      /* 顶层允许空表：*_op 开场动画的 AvgLang 就没有台词。 */
      const keys = Object.keys(js);
      for (const k of keys) {
        if (/^-?\d+$/.test(k)) (kind === 'cfg' ? cfgSteps++ : langSteps++);
      }
    } catch (e) {
      failures++;
      if (firstFails.length < 5) firstFails.push(`${story.id}(${kind}): ${e.message}`);
    }
  }
}
const dt = (performance.now() - t0) / 1000;
assert.equal(failures, 0, `全语料 0 失败${firstFails.length ? '：' + firstFails.join('; ') : ''}`);
assert.equal(manifest.stories.length, 1878, '语料 1878 段（M13 口径）');
assert.equal(closures, 0, '语料零 CLOSURE（lvm 快照 upvalue 假设的前提）');
assert.equal(cfgSteps, 104844, 'Cfg 步骤总数');
assert.equal(langSteps, 107451, 'Lang 台词条总数');
console.log(`       （全语料 3756 文件 ${dt.toFixed(1)}s）`);
ok(`全语料：1878 段 0 失败 · 步骤 ${cfgSteps} · 台词条 ${langSteps} · 零闭包`);

/* —— avgwire：映射层（Lang 解引用 / 0 起始平移 / 重放链） —— */

const decodeWire = (id) => {
  const story = byId.get(id);
  return storyToWire(decodeLua2('cfg', id), decodeLua2('lang', id));
};
const decodeLua2 = (kind, id) => {
  const story = byId.get(id);
  return toJS(execChunk(parseChunk(
      readFileSync(join(ROOT, kind === 'lang' ? story.lang : story.cfg))))[0]);
};

{
  const {wire, stats} = decodeWire('cpt00_e_01_01');
  assert.ok(wire['2'].content.startsWith('> 看得到吗？'), 'content 已解引用为台词');
  assert.equal(wire['1'].SkipScenario, '“绿洲”扇区遭到袭击。为了扭转局势，教授冒险接入绿洲的系统，为此陷入数月前的回忆。帕斯卡将教授唤醒，并请求教授指挥人形保卫绿洲。');
  assert.equal(stats.shifted, false, '1 起始剧本不平移');
  const chain = replayChain(wire);
  assert.equal(chain[0], '1');
  assert.ok(chain.includes('99') && chain.includes('114'), 'nextId 跳转目标在重放链上');
  ok(`avgwire：cpt00 解引用 + 重放链（${chain.length} 节点）`);
}
{
  const {wire, stats} = decodeWire('23concert_undline_03');
  assert.equal(stats.shifted, true, '0 起始剧本 +1 平移');
  assert.ok(!('0' in wire) && '1' in wire, '平移后键从 1 起');
  const ids = Object.keys(wire);
  assert.equal(ids.length, 10, '平移不丢镜');
  const branchShot = Object.values(wire).find((s) => s.branch);
  assert.ok(Array.isArray(branchShot.branch), 'branch 对象形态已展平为数组');
  ok(`avgwire：0 起始平移 + branch 展平（23concert）`);
}
{
  /* 悬空立绘 tween 落名（M16）：147 全语料声明众数 = willow_avg，
     1year_prologue 里它只被 tween 从未声明——注入后首镜 images 带
     willow_avg 声明，stats 留痕；不给 imgIds 时保持透传不注。 */
  const imgIds = {147: 'willow_avg', 103: 'sol_avg'};
  const heroSprites = {1001: 'persicaria_avg', 1047: 'willow_avg'};
  const {wire, stats} = storyToWire(decodeLua2('cfg', '1year_prologue'),
      decodeLua2('lang', '1year_prologue'), {imgIds, heroSprites});
  const first = wire[Object.keys(wire).find((k) => k !== '0')];
  const injected = (first.images ?? []).find((im) => im.imgId === 147);
  assert.ok(injected, '悬空 147 已注入首镜 images');
  assert.equal(injected.imgPath, 'willow_avg', '注入名取全局表众数');
  assert.equal(injected.imgType, 3, '注入的是立绘声明');
  assert.ok((first.images ?? []).some((im) => im.imgId === 103 && im.imgPath === 'sol_avg'),
      '多张悬空一并注入');
  assert.ok(stats.danglingCast.some((c) => c.imgId === 147), 'stats 留痕');
  /* 入场揭示缺失修补：薇洛儿预站位在键 2、原揭示拖到键 6（中间她有
     台词）——补相邻揭示半拍；键 6 的原条目与键 17 的退场保持原样。 */
  const w2 = wire['2'].imgTween.filter((t) => t.imgId === 147);
  assert.deepEqual(w2.map((t) => t.alpha), [0, 1], '预站位后相邻补揭示');
  assert.equal(w2[1].isDark, false, '入场按亮重建');
  const w6 = wire['6'].imgTween.find((t) => t.imgId === 147);
  assert.equal(w6.alpha, 1, '原揭示条目不动');
  assert.equal(w6.isDark, true, '原条目灯光语义不动');
  const w17 = wire['17'].imgTween.find((t) => t.imgId === 147);
  assert.equal(w17.alpha, 0, '退场条目不被改写');
  /* 说话者复亮（M16）：帕斯卡(1001→persicaria_avg) 在键 3 听教授切暗，
     键 6/8 自己说话却无复亮条目——autoLight 补亮；教授说话的键 3/7 与
     聆听压暗一概不动。 */
  const p6 = wire['6'].imgTween.filter((t) => t.imgId === 101);
  assert.ok(p6.some((t) => t.alpha === 1 && t.isDark === false),
      '帕斯卡说话镜补复亮');
  assert.ok(!wire['3'].imgTween.some((t) => t.imgId === 101 && t.isDark === false),
      '教授说话镜不补亮（聆听压暗保留）');
  assert.equal(stats.autoLit, 1, '只有键 6 需要复亮（键 8 沿用修正后状态）');
  const plain = storyToWire(decodeLua2('cfg', '1year_prologue'),
      decodeLua2('lang', '1year_prologue')).wire;
  assert.ok(!Object.values(plain).some((s) => (s.images ?? []).some((im) => im.imgId === 147)),
      '无 imgIds 时保持原样不注');
  ok(`avgwire：悬空立绘 tween 落名（1year_prologue 147→willow_avg）`);
}
{
  /* 永不可见立绘的揭示重建（M16）：22child_01_03 的安吉拉（117）只有
     alpha 0 条目（step 38 预站位 / step 41 灯光），揭示半拍丢失——
     修复后首条目同镜补揭示、后续 alpha 0 升 1；完好轨迹（kuro 155）不动。 */
  const {wire, stats} = storyToWire(decodeLua2('cfg', '22child_01_03'),
      decodeLua2('lang', '22child_01_03'));
  const angela = wire['39'].imgTween.filter((t) => t.imgId === 117);
  assert.equal(angela.length, 2, '预站位后补出揭示条目');
  assert.deepEqual(angela.map((t) => t.alpha), [0, 1], '揭示 alpha 1');
  assert.equal(angela[1].duration, 0.2, '揭示 duration 0.2');
  const dark = wire['42'].imgTween.find((t) => t.imgId === 117);
  assert.equal(dark.alpha, 1, '后续 alpha 0 条目升为 1');
  assert.equal(dark.isDark, false, '丢失条目按「亮」重建（说话=亮）');
  const kuro = [];
  for (const shot of Object.values(wire)) {
    for (const t of (shot.imgTween ?? [])) if (t.imgId === 155) kuro.push(t.alpha);
  }
  assert.ok(Math.max(...kuro) === 1 && kuro.filter((a) => a === 0).length > 0,
      '完好轨迹不被改写');
  assert.equal(stats.revealedCast, 1, '全剧本只修安吉拉一个');
  ok(`avgwire：永不可见立绘揭示重建（22child_01_03 安吉拉）`);
}
{
  /* 说话镜的入场揭示补齐（M23）：判据是「隐身来路」而不是「下一镜有没有揭示」——
     alpha 0 且 duration 0 的条目（以及按 alpha 0 的 images[] 注册）是预站位，
     它只把立绘摆到槽位上等揭示半拍；duration>0 的 alpha 0 是真淡出退场。
     只召回前者：22child_01_03 卡萝（1055→kuro_avg=155）键 2/32、炽
     （1007→chelsea_avg=107）键 10 都属丢了揭示；键 34 把 kuro 淡出后她
     键 42/43/46 的台词是画外音，不越权召回。 */
  const {wire, stats} = storyToWire(decode('cfg', '22child_01_03'),
      decode('lang', '22child_01_03'),
      {imgIds: manifest.imgIds, heroSprites: manifest.heroSprites});
  const kuro2 = wire['2'].imgTween.filter((t) => t.imgId === 155);
  assert.deepEqual(kuro2.map((t) => t.alpha), [0, 1], '卡萝开口镜补出揭示半拍');
  assert.equal(kuro2[1].duration, 0.2, '揭示 duration 0.2');
  assert.equal(kuro2[1].isDark, false, '揭示按亮重建（说话=亮）');
  const chelsea10 = wire['10'].imgTween.filter((t) => t.imgId === 107);
  assert.deepEqual(chelsea10.map((t) => t.alpha), [0, 1], '炽开口镜补出揭示半拍');
  const kuro32 = wire['32'].imgTween.filter((t) => t.imgId === 155);
  assert.deepEqual(kuro32.map((t) => t.alpha), [0, 1], '预站位后无揭示的说话镜也补');
  assert.equal(stats.entranceLit, 3, '全剧本补这三处入场揭示');
  /* 折叠态复核：预站位说话镜可见；被 duration>0 淡出过的仍按数据隐身。 */
  const kuro = foldAlpha(wire, 'kuro_avg');
  assert.equal(kuro.get('2'), 1, '键 2 卡萝开口时在场');
  assert.equal(kuro.get('32'), 1, '键 32 卡萝开口时在场');
  assert.equal(kuro.get('42'), 0, '键 34 淡出后卡萝画外说话不动（反打镜头）');
  ok(`avgwire：说话镜入场揭示补齐（22child_01_03 三处，淡出退场保留）`);
}
{
  /* 用户报的实例（M23）：1year_prologue 键 21 薇洛儿（1047→willow_avg=147）
     开口「从哪里开始好呢」，本镜只有 `147 α0/dur0/posId3` 的预站位，数据里
     下一次揭示拖到键 51——上一轮「揭示必须在紧邻下一镜」的判据漏掉这类。
     同镜的 bg α1 与她的三连台词（键 21/22/24）都该看见人。
     边界：键 92 把她 duration 0.2 淡出后，键 99 起的台词是画外，不召回。 */
  const {wire, stats} = storyToWire(decode('cfg', '1year_prologue'),
      decode('lang', '1year_prologue'),
      {imgIds: manifest.imgIds, heroSprites: manifest.heroSprites});
  const willow21 = wire['21'].imgTween.filter((t) => t.imgId === 147);
  assert.deepEqual(willow21.map((t) => [t.alpha, t.duration]), [[0, 0], [1, 0.2]],
      '键 21 预站位后补出揭示（原数据揭示远在键 51）');
  assert.equal(willow21[1].isDark, false, '补的揭示按亮');
  const seen = foldAlpha(wire, 'willow_avg');
  assert.equal(seen.get('21'), 1, '键 21 薇洛儿在场');
  assert.equal(seen.get('24'), 1, '补的揭示延续到她的后续台词镜');
  assert.equal(seen.get('99'), 0, '键 92 淡出后键 99 仍画外（不越权）');
  assert.ok(stats.entranceLit >= 15, `全段入场揭示补齐计数（${stats.entranceLit}）`);
  /* 换景收场：补出来的余晖不许淌进下一场。键 27 重排（帕斯卡+苏尔摆预站位）
     → 收掉只由修复点亮的薇洛儿。作者自己点亮的苏尔**不收**（她键 34 还赖在
     台上）：这是原稿缺退场条目，三种候选判据误清率都在 23% 上下，留给编辑器
     人工补，不猜。 */
  assert.equal(seen.get('27'), 0, '键 27 换景收掉薇洛儿');
  const willow27 = wire['27'].imgTween.filter((t) => t.imgId === 147);
  assert.deepEqual(willow27.map((t) => [t.alpha, t.duration]), [[0, 0.2]],
      '收场补的是 duration 0.2 淡出');
  assert.equal(seen.get('40'), 1, '收场不丢注册：键 40 薇洛儿还能被重新揭示');
  const sol = foldAlpha(wire, 'sol_avg');
  assert.equal(sol.get('30'), 1, '键 30 苏尔在场（作者自己揭示的）');
  assert.equal(sol.get('34'), 1, '已知边界：作者点亮却没写退场的苏尔不自动收场');
  assert.ok(stats.entranceExit >= 1, `全段收场淡出计数（${stats.entranceExit}）`);
  ok(`avgwire：说话镜入场揭示补齐 + 修复自点亮者收场（1year_prologue 键 21/27）`);
}
{
  /* 桥表的剧本内改宗（M24，用户报）：heroSprites 给的是该角色全语料的众数
     立绘（1001 帕斯卡 = persicaria_avg），周年剧本里她穿 persicaria_dress_avg
     —— 精确路径匹配不上，键 16 的 α0/dur0 预站位永远等不到补揭示，气泡框
     开口连说六句人却隐身。改宗后同角色的换装件顶上，揭示落回开口镜。 */
  const {wire, stats} = storyToWire(decode('cfg', '1year_anniversary_persicaria'),
      decode('lang', '1year_anniversary_persicaria'),
      {imgIds: manifest.imgIds, heroSprites: manifest.heroSprites});
  const dress16 = wire['16'].imgTween.filter((t) => t.imgId === 101);
  assert.deepEqual(dress16.map((t) => [t.alpha, t.duration]), [[0, 0], [1, 0.2]],
      '换装开口镜补出揭示半拍');
  const dress = foldAlpha(wire, 'persicaria_dress_avg');
  assert.equal(dress.get('16'), 1, '键 16 帕斯卡开口时在场');
  assert.equal(dress.get('21'), 1, '揭示延续到她的后续台词镜');
  /* 同剧本另备一件 dress2（1011），到键 95 才换装登场：从未点亮过的立绘
     不算替身，改宗前她连 lane 都没有，不会被立成第二个帕斯卡。 */
  const dress2 = foldAlpha(wire, 'persicaria_dress2_avg');
  assert.equal(dress2.get('16'), undefined, '未登场的 dress2 不被提前立上台');
  assert.equal(dress2.get('96'), 1, 'dress2 的登场仍完全由原数据驱动');
  assert.equal(stats.entranceLit, 3, '全段入场揭示补齐三处');
  /* 已知边界：词列第二格不同即判不同角色，mara_weapon 不认 mara_wrecked——
     这里确实漏召回（说话的是玛拉、台上是残骸装）。但反过来按首词归类会把
     burbank_npc1 / fool_mie / odile_b3 / helios_robotyellow 全当成同一个人，
     幻影比隐身更难发现，这种缺口留给编辑器人工补。 */
  const mara = storyToWire(decode('cfg', 'cpt02_e_07_01'),
      decode('lang', 'cpt02_e_07_01'),
      {imgIds: manifest.imgIds, heroSprites: manifest.heroSprites}).wire;
  assert.deepEqual(mara['90'].imgTween.map((t) => t.alpha), [0],
      'mara_weapon 不跨词根改宗到 mara_wrecked（已知漏召回）');
  ok(`avgwire：说话者桥表的剧本内改宗（周年帕斯卡换装件，跨词根不认）`);
}
{
  /* 槽位类型门（M21）：低号 imgId 常是背景槽（10：138 段背景声明 /
     仅 2 段立绘声明），把它们注入成立绘会凭空冒出幻影、真背景黑掉。
     构建期按「背景票 ≥ 立绘票」滤除；纯立绘槽位（147/13）保留。 */
  for (const id of ['1', '2', '3', '10', '20']) {
    assert.ok(!(id in manifest.imgIds), `背景槽 ${id} 不入全局立绘表`);
  }
  assert.equal(manifest.imgIds['147'], 'willow_avg', '纯立绘槽位保留（147）');
  assert.equal(manifest.imgIds['13'], 'riko_avg', '立绘票占优的争议槽位保留（13）');
  const {wire, stats} = storyToWire(decode('cfg', '22white_choco'),
      decode('lang', '22white_choco'),
      {imgIds: manifest.imgIds, heroSprites: manifest.heroSprites});
  assert.ok(!Object.values(wire).some((s) =>
      (s.images ?? []).some((im) => im.imgId === 10)),
      '背景槽 10 不被注入为立绘（22white_choco）');
  assert.ok(!stats.danglingCast.some((c) => c.imgId === 10), 'stats 无 10 的注入留痕');
  assert.ok(wire['9'].imgTween.some((t) => t.imgId === 10 && t.alpha === 1),
      '原 tween 原样保留（未注册跳过，参考语义）');
  ok(`avgwire：槽位类型门（22white_choco 背景槽 10 不注入）`);
}
{
  /* alpha 缺省 = 继承（M21）：抖动/灯光拍不带 alpha 时保持可见度，
     不再记 undefined（旧口径判不可见，DOM 却仍可见——态屏分裂，
     autoLightCast 等按折叠态判可见性的修复层跟着误判）。 */
  const state = emptyState();
  applyImages(state, [{imgId: 7, imgType: 3, imgPath: 'x_avg', posId: 3}]);
  applyShotTweens(state, {imgTween: [
    {imgId: 7, delay: 0, duration: 0.2, alpha: 0.8, posId: 3, isDark: true}]});
  assert.equal(state.lanes.get(7).alpha, 0.8);
  applyShotTweens(state, {imgTween: [
    {imgId: 7, delay: 1.2, duration: 0.2, posId: 3, isDark: false}]});
  assert.equal(state.lanes.get(7).alpha, 0.8, '缺省 alpha 继承 0.8');
  assert.equal(state.lanes.get(7).isDark, false, 'isDark 照常翻转');
  const s2 = emptyState();
  applyImages(s2, [{imgId: 9, imgType: 3, imgPath: 'y_avg'}]);
  applyShotTweens(s2, {imgTween: [
    {imgId: 9, delay: 0, duration: 0.2, posId: 2, isDark: false}]});
  assert.equal(s2.lanes.get(9).alpha, 0, '入场缺省 alpha 保持初始 0');
  const s3 = emptyState();
  applyImages(s3, [{imgId: 1, imgType: 2, imgPath: 'g/bg001'}]);
  applyShotTweens(s3, {imgTween: [{imgId: 1, delay: 0, duration: 1, alpha: 1}]});
  applyShotTweens(s3, {imgTween: [{imgId: 1, delay: 0, duration: 0.6, shake: true}]});
  assert.equal(s3.bg.alpha, 1, 'bg 缺省 alpha 继承');
  ok(`引擎折叠：alpha 缺省 = 继承（立绘入场/续条 + bg 三态）`);
}
{
  /* pos/scale 扩展演出折叠（M21）：lane 记录绝对坐标/缩放，缺省条目保持，
     [0] 脏形态拒收（语料 23carnival_s18/s21 各一条）。 */
  const state = emptyState();
  applyImages(state, [{imgId: 5, imgType: 3, imgPath: 'z_avg', posId: 2}]);
  applyShotTweens(state, {imgTween: [
    {imgId: 5, delay: 0, duration: 0.6, alpha: 1,
      pos: [430, -410], scale: [1.5, 1.5]}]});
  assert.deepEqual(state.lanes.get(5).pos, [430, -410]);
  assert.deepEqual(state.lanes.get(5).scale, [1.5, 1.5]);
  applyShotTweens(state, {imgTween: [
    {imgId: 5, delay: 0, duration: 0.2, alpha: 1, isDark: true}]});
  assert.deepEqual(state.lanes.get(5).pos, [430, -410], 'pos 缺省继承');
  assert.deepEqual(state.lanes.get(5).scale, [1.5, 1.5], 'scale 缺省继承');
  applyShotTweens(state, {imgTween: [
    {imgId: 5, delay: 0, duration: 0.2, alpha: 0, pos: [0]}]});
  assert.deepEqual(state.lanes.get(5).pos, [430, -410], '[0] 脏形态拒收');
  applyShotTweens(state, {imgTween: [
    {imgId: 5, delay: 0, duration: 0.4, alpha: 1, posId: 2}]});
  assert.equal(state.lanes.get(5).pos, null, '回槽消费绝对定位');
  assert.equal(state.lanes.get(5).scale, null, '回槽消费缩放');
  ok(`引擎折叠：pos/scale 绝对坐标（继承 + 脏形态守卫）`);
}
{
  /* 全语料映射口径（M13 普查）：解引用命中/未命中与 0 起始段数。 */
  let resolved = 0, unresolved = 0, shifted = 0;
  const byField = {};
  for (const story of manifest.stories) {
    const cfg = toJS(execChunk(parseChunk(readFileSync(join(ROOT, story.cfg))))[0]);
    const lang = toJS(execChunk(parseChunk(readFileSync(join(ROOT, story.lang))))[0]);
    const {wire, stats} = storyToWire(cfg, lang);
    resolved += stats.resolved;
    unresolved += stats.unresolved.length;
    for (const u of stats.unresolved) byField[u.field] = (byField[u.field] ?? 0) + 1;
    if (stats.shifted) shifted++;
    if (!Object.keys(wire).length && !/(_op|Music_live)/.test(story.id)) {
      throw new Error(`${story.id} 顶层空表`);
    }
  }
  assert.equal(resolved, 121016, '解引用命中总数');
  assert.equal(unresolved, 128, '未命中（跨剧本引用/缺词条，保数字可见）');
  assert.equal(byField.content, 125);
  assert.equal(byField.speakerName, 2);
  assert.equal(byField.SkipScenario, 1);
  assert.equal(shifted, 1555, '0 起始平移段数（21 纯视频 + 1534 混合）');
  ok(`avgwire：全语料 ${resolved} 解引用 + ${unresolved} 保数字 · 平移 ${shifted} 段`);
}

console.log(`\n${passed} 项通过`);
