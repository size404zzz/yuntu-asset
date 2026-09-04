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
  /* 悬空立绘 tween 落名层（旧 materializeDanglingCast）已退役（2026-09-03）。
     修 lvm.js 的 SETLIST off-by-one（每个数组字面量丢最后一条）之后，全语料
     「被 tween 却从未声明」的立绘从 1471 处降到 0——那层补的从来就是被我们自己
     吞掉的声明。这里反向钉死它不复活：未声明的 tween 目标保持透传（= 参考的
     未注册跳过语义），stats 里不再有 danglingCast 字段。
     复核口径见 tools/audit-decode-completeness.mjs。 */
  const cfg = {
    '1': {contentType: 2, content: '开场', images: [
      {imgId: 2, imgType: 2, alpha: 0, imgPath: 'cpt00/cpt00_e_bg010', fullScreen: true}]},
    '2': {contentType: 3, content: '她说话', speakerHeroId: 147,
      imgTween: [{imgId: 147, alpha: 1, isDark: false, duration: 0.2}]},
  };
  const lang = {'1': '开场', '2': '她说话'};
  const {wire, stats} = storyToWire(structuredClone(cfg), structuredClone(lang),
      {heroSprites: {147: 'willow_avg'}, pathOwner: {willow_avg: '147'}});
  assert.ok(!Object.values(wire).some(
      (s) => (s.images ?? []).some((im) => im.imgId === 147)),
      '未声明的 tween 目标不被补进 images（透传）');
  assert.ok(!('danglingCast' in stats), '退役层的 stats 字段不再出现');
  assert.equal(wire['2'].imgTween.length, 1, '该镜条目数完全由作者数据决定');
  ok('avgwire：悬空 tween 落名层已退役（未注册即跳过）');
}
{
  /* 修复层不得改写作者自己写好的演出（1year_prologue，2026-09-03 重标）。
     旧断言把「键4 补出揭示 / 键6 补复亮」当成我们的成果——其实那些条目本来就在
     数据里，是 SETLIST 丢了数组末条才显得「只 tween 没声明」「该亮却没亮」。
     现在按新事实钉两面：本层在该段一条不补，且条目逐字透传。 */
  const raw = decodeLua2('cfg', '1year_prologue');
  const {wire, stats} = storyToWire(decodeLua2('cfg', '1year_prologue'),
      decodeLua2('lang', '1year_prologue'),
      {heroSprites: manifest.heroSprites,
        pathOwner: manifest.pathOwner});
  assert.equal(stats.entranceLit, 2, '本层在该段只补 2 处入场点亮，其余全是作者数据');
  assert.equal(stats.autoLit, 0, '作者已写复亮，本层一条不补');
  const trio = (list) => list.filter((t) => t.imgId !== undefined)
      .map((t) => `${t.alpha}/${t.isDark}/${t.duration}`).join(' ');
  for (const [key, id] of [['2', 147], ['4', 147], ['6', 147], ['17', 147],
    ['2', 101], ['6', 101], ['7', 101], ['17', 101]]) {
    assert.equal(trio(wire[key].imgTween ?? []), trio(raw[key].imgTween ?? []),
        `镜${key} 的条目原样透传（imgId ${id} 未被改写）`);
  }
  /* 作者写的正是完整节拍：键2 预站位+揭示、键4 说话镜揭示、键6 复亮、键17 退场。 */
  assert.equal(trio(raw['2'].imgTween).includes('0/false/0'), true, '键2 有预站位条目');
  assert.equal(raw['4'].speakerHeroId, 1047, '键4 确实是薇洛儿说话');
  assert.ok(trio(raw['4'].imgTween).includes('1/false/0.2'), '键4 揭示由作者写');
  assert.ok(trio(raw['6'].imgTween).includes('1/false/0.2'), '键6 帕斯卡复亮由作者写');
  assert.ok(trio(raw['17'].imgTween).includes('0/false/0.2'), '键17 退场由作者写');
  ok('avgwire：作者演出原样透传，修复层零改写（1year_prologue）');
}
{
  /* 永不可见立绘的揭示重建已合并进 autoLightCast（D6）。2026-09-03 复核：
     当年判「安吉拉（117）只有 α0 条目、揭示半拍丢失」是 SETLIST 丢数组末条
     造成的假象——作者其实写了完整两条（step 38 的 α0/d0 预站位 + α1/d0.2 揭示，
     揭示带 isDark:true 的压暗）。该段修复层四个计数器全 0，条目逐字透传。
     注意 0 起始平移：本段 shifted=true，wire 键 = 作者 step + 1。 */
  const raw = decodeLua2('cfg', '22child_01_03');
  const {wire, stats} = storyToWire(decodeLua2('cfg', '22child_01_03'),
      decodeLua2('lang', '22child_01_03'));
  const pick = (src, k) => (src[k]?.imgTween ?? []).filter((t) => t.imgId === 117)
      .map((t) => `${t.alpha}/${t.duration}/${t.isDark}`);
  assert.equal(stats.entranceLit + stats.autoLit + stats.entranceExit, 0,
      '本段修复层一条都不补（作者数据已完整）');
  assert.deepEqual(pick(wire, '39'), pick(raw, '38'), '预站位镜原样透传');
  assert.deepEqual(pick(wire, '39'), ['0/0/false', '1/0.2/true'],
      '作者写的就是预站位 + 揭示两条');
  const angela42 = wire['42'].imgTween.find((t) => t.imgId === 117);
  assert.equal(angela42.alpha, 0, '作者显式淡出条目不被升为 alpha 1');
  assert.equal(angela42.duration, 0.2, '淡出 duration 保留');
  assert.equal(angela42.isDark, true, '淡出 isDark 保留');
  const kuro = [];
  for (const shot of Object.values(wire)) {
    for (const t of (shot.imgTween ?? [])) if (t.imgId === 155) kuro.push(t.alpha);
  }
  assert.ok(Math.max(...kuro) === 1 && kuro.filter((a) => a === 0).length > 0,
      '完好轨迹不被改写');
  assert.equal(stats.revealedCast, undefined, '合并后不再产生 revealedCast 统计');
  ok(`avgwire：安吉拉揭示本就由作者写全（22child_01_03）`);
}
{
  /* 说话镜的入场揭示（M23 立的判据）。2026-09-03 复核：22child_01_03 的卡萝
     （155）键 2/32 与炽（107）键 10，`α0/d0` 预站位后面紧跟着作者自己写的
     `α1/d0.2` 揭示——当年判「丢了揭示半拍」是 SETLIST 把数组末条吞了。
     本段修复层三个计数器全 0；可观察结果仍按折叠态钉。 */
  const {wire, stats} = storyToWire(decode('cfg', '22child_01_03'),
      decode('lang', '22child_01_03'),
      {heroSprites: manifest.heroSprites, pathOwner: manifest.pathOwner});
  const pair = (k, id) => (wire[k]?.imgTween ?? []).filter((t) => t.imgId === id)
      .map((t) => `${t.alpha}/${t.duration}`);
  assert.deepEqual(pair('2', 155), ['0/0', '1/0.2'], '卡萝开口镜：预站位 + 作者写的揭示');
  assert.deepEqual(pair('10', 107), ['0/0', '1/0.2'], '炽开口镜：同样齐全');
  assert.deepEqual(pair('32', 155), ['0/0', '1/0.2'], '键 32 也不需要补');
  assert.equal(stats.entranceLit + stats.autoLit + stats.entranceExit, 0,
      '本段修复层一条都不补');
  const kuro = foldAlpha(wire, 'kuro_avg');
  assert.equal(kuro.get('2'), 1, '键 2 卡萝开口时在场');
  assert.equal(kuro.get('32'), 1, '键 32 卡萝开口时在场');
  assert.equal(kuro.get('42'), 1, '键 42 卡萝说话镜在场');
  ok('avgwire：说话镜揭示本就由作者写全（22child_01_03 三处）');
}
{
  /* 1year_prologue 的薇洛儿（1047→willow_avg=147）三连台词（M23 的用户报实例）。
     复核：键 21 的揭示同样是作者数据；键 27 她的 α 归 0 来自折叠继承，本段
     entranceExit=0 ⇒ 不存在「我们补的收场淡出」。该段修复层只剩 2 处入场点亮。 */
  const {wire, stats} = storyToWire(decode('cfg', '1year_prologue'),
      decode('lang', '1year_prologue'),
      {heroSprites: manifest.heroSprites, pathOwner: manifest.pathOwner});
  const willow21 = wire['21'].imgTween.filter((t) => t.imgId === 147);
  assert.deepEqual(willow21.map((t) => [t.alpha, t.duration]), [[0, 0], [1, 0.2]],
      '键 21 预站位 + 作者揭示成对出现');
  assert.equal((wire['27'].imgTween ?? []).filter((t) => t.imgId === 147).length, 0,
      '键 27 没有补出来的收场条目');
  const seen = foldAlpha(wire, 'willow_avg');
  assert.equal(seen.get('21'), 1, '键 21 薇洛儿在场');
  assert.equal(seen.get('24'), 1, '她的后续台词镜仍在场');
  assert.equal(seen.get('27'), 0, '键 27 不在场（折叠继承，非本层改写）');
  assert.equal(seen.get('40'), 1, '键 40 重新现身');
  assert.equal(seen.get('99'), 1, '键 99 说话镜在场');
  assert.equal(foldAlpha(wire, 'sol_avg').get('30'), 1, '键 30 苏尔由作者揭示');
  assert.equal(stats.entranceLit, 2, `该段只剩 2 处入场点亮（${stats.entranceLit}）`);
  assert.equal(stats.entranceExit, 0, '该段没有收场改写');
  ok('avgwire：1year_prologue 演出由作者数据驱动，本层仅 2 处补点亮');
}
{
  /* 桥表的剧本内改宗（M24，用户报）：heroSprites 给的是该角色全语料的众数
     立绘（1001 帕斯卡 = persicaria_avg），周年剧本里她穿 persicaria_dress_avg
     ——精确路径匹配不上就进不了 want 集，改宗后同角色的换装件顶上。
     复核：键 16 的揭示同样是作者写的（duration 0.6，不是本层补的 0.2 规格），
     本段三个计数器全 0；改宗本身仍然必要，去掉它这类的说话镜无人可召回。 */
  const {wire, stats} = storyToWire(decode('cfg', '1year_anniversary_persicaria'),
      decode('lang', '1year_anniversary_persicaria'),
      {heroSprites: manifest.heroSprites, pathOwner: manifest.pathOwner});
  const dress16 = wire['16'].imgTween.filter((t) => t.imgId === 101);
  assert.deepEqual(dress16.map((t) => [t.alpha, t.duration]), [[0, 0], [1, 0.6]],
      '换装开口镜的预站位与揭示都由作者写');
  assert.equal(stats.entranceLit + stats.autoLit + stats.entranceExit, 0,
      '本段修复层一条都不补');
  const dress = foldAlpha(wire, 'persicaria_dress_avg');
  assert.equal(dress.get('16'), 1, '键 16 帕斯卡开口时在场');
  assert.equal(dress.get('21'), 1, '在场延续到她的后续台词镜');
  /* 同剧本另备一件 dress2（1011），到键 95 才换装登场：从未点亮过的立绘不算
     替身。游戏契约下「注册即建 lane」，所以判**不可见**而不是「没有 lane」。 */
  const dress2 = foldAlpha(wire, 'persicaria_dress2_avg');
  assert.ok(!dress2.get('16'), '未登场的 dress2 不被提前立上台');
  assert.equal(dress2.get('96'), 1, 'dress2 的登场仍完全由原数据驱动');
  /* 旧的「已知漏召回」不再复现：cpt02_e_07_01 键 90 说话的是玛拉，台上残骸装，
     当年只看到 α0 条目；修 lvm 之后作者那条揭示（α1）回到原位。 */
  const mara = storyToWire(decode('cfg', 'cpt02_e_07_01'),
      decode('lang', 'cpt02_e_07_01'),
      {heroSprites: manifest.heroSprites, pathOwner: manifest.pathOwner}).wire;
  assert.deepEqual(mara['90'].imgTween.map((t) => t.alpha), [0, 1],
      '跨词根改宗的漏召回已不复现（键 90 有揭示）');
  ok('avgwire：说话者桥表的剧本内改宗（周年帕斯卡换装件）');
}
{
  /* 槽位类型门（M21）：低号 imgId 常是背景槽（10：138 段背景声明 /
     仅 2 段立绘声明），构建期按「背景票 ≥ 立绘票」滤除。
     2026-09-03 重标：修 SETLIST 丢末条之后槽 20（arrow_avg）与 100
     （oasis_01b_avg）的立绘票超过背景票、回到表内，旧十号清单不再成立。
     另注：materializeDanglingCast 退役后这张表只供编辑器查槽位归属，
     不再驱动运行时。 */
  for (const id of ['1', '2', '3', '10']) {
    assert.ok(!(id in manifest.imgIds), `背景槽 ${id} 不入全局立绘表`);
  }
  assert.equal(manifest.imgIds['20']?.[0], 'arrow_avg', '槽 20 按立绘票归表（重标）');
  assert.equal(manifest.imgIds['100']?.[0], 'oasis_01b_avg', '槽 100 按立绘票归表（重标）');
  assert.equal(manifest.imgIds['147'][0], 'willow_avg', '纯立绘槽位保留（147 首选）');
  assert.equal(manifest.imgIds['13'][0], 'riko_avg', '立绘票占优的争议槽位保留（13 首选）');
  /* 槽位是序号不是身份：同一槽在全语料被不同剧本声明成不同立绘，表给的是
     票数降序的候选集，本段就地按「谁在说话」仲裁（见下面的 22child_02 断言）。 */
  assert.ok(manifest.imgIds['105'].length > 1, '同一槽多件的槽位给出候选集（105）');
  assert.equal(manifest.imgIds['105'][0], 'croque_avg', '候选集首选 = 全局众数（105）');
  assert.ok(manifest.imgIds['105'].includes('croque_kid_avg'), '候选集含同槽的另一身份（105）');
  const {wire, stats} = storyToWire(decode('cfg', '22white_choco'),
      decode('lang', '22white_choco'),
      {heroSprites: manifest.heroSprites, pathOwner: manifest.pathOwner});
  /* 修 SETLIST 之前这段的 images 少一条，槽 10 看起来「只 tween 没声明」；
     现在作者声明回到原位：imgId 10 = pola/p_choco、imgType 2（背景件）。
     判据因此从「不被注入成立绘」升级成「只按作者声明的形态存在」。 */
  const ten = Object.values(wire).flatMap((x) => (x.images ?? [])
      .filter((im) => im?.imgId === 10).map((im) => `${im.imgType}:${im.imgPath}`));
  assert.deepEqual([...new Set(ten)], ['2:pola/p_choco'], '槽 10 只有作者声明的背景件');
  assert.ok(wire['9'].imgTween.some((t) => t.imgId === 10 && t.alpha === 1),
      '原 tween 原样保留');
  ok('avgwire：背景槽 10 只按作者声明存在（22white_choco）');
}
{
  /* 用户报（2026-09-01）：22child_02 许多键没有立绘。本段 images[] 只声明了
     4 张背景，立绘槽 105 只被 tween 从未声明；全局众数给的是成人克罗琦
     （croque_avg，84 段），而同剧情的 22child_03..06 声明的是小克罗琦
     （croque_kid_avg），且本段唯一开口的立绘角色是 hid 114。
     就地仲裁 + 说话镜揭示两层一起才补得回来：62 个说话镜从全黑到只剩 4 个
     （那 4 镜的说话人 hid 1「？？？」在全段没有任何立绘 item，游戏里也没得现）。 */
  assert.equal(manifest.pathOwner['croque_kid_avg'], '114', '揭示跳变票把小克罗琦判给 114');
  assert.notEqual(manifest.pathOwner['croque_avg'], '114', '成人克罗琦不是 114（认错人比隐身更糟）');
  const {wire} = storyToWire(decode('cfg', '22child_02'), decode('lang', '22child_02'),
      {heroSprites: manifest.heroSprites, pathOwner: manifest.pathOwner});
  const reg = Object.values(wire).flatMap((s) => (s.images ?? [])
      .filter((im) => im?.imgId === 105).map((im) => im.imgPath));
  assert.deepEqual([...new Set(reg)], ['croque_kid_avg'], '作者声明的就是小克罗琦（不需要仲裁）');
  const seen = foldAlpha(wire, 'croque_kid_avg');   // foldAlpha 只走重放链可达镜
  const speaking = replayChain(wire)
      .filter((k) => wire[k]?.speakerHeroId === 114);
  assert.ok(speaking.length > 40, `本段小克罗琦说话镜 ${speaking.length} 处`);
  assert.ok(speaking.every((k) => seen.get(k) > 0),
      '她的每个说话镜都现身（折叠态 α>0）');
  assert.ok(speaking.every((k) => !seen.get(k) || seen.get(k) > 0),
      '现身即 α>0：不存在「说话却有 α0 条目」的自相矛盾');
  ok(`avgwire：悬空槽位就地认人 + 说话镜现身（22child_02 槽 105 → croque_kid_avg）`);
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
  /* 121016 → 121722：修 SETLIST 丢数组末条之后多出的 706 处解引用。
     121722 → 121751：23sg 手机聊天 sendMsg 的 receiver/contentMsg 也是
     AvgLang 数字键（15 镜 × 至多 2 字段 = 29 处，此前原样是数字）。
     unresolved/byField/shifted 三项一字未变——补回来的都是原本就在的数据。 */
  assert.equal(resolved, 121751, '解引用命中总数');
  assert.equal(unresolved, 128, '未命中（跨剧本引用/缺词条，保数字可见）');
  assert.equal(byField.content, 125);
  assert.equal(byField.speakerName, 2);
  assert.equal(byField.SkipScenario, 1);
  assert.equal(shifted, 1555, '0 起始平移段数（21 纯视频 + 1534 混合）');
  ok(`avgwire：全语料 ${resolved} 解引用 + ${unresolved} 保数字 · 平移 ${shifted} 段`);
}

/* —— lvm.js：EQ/LT/LE/SETTABUP 字节码语义锚点（bug 修复回归） —— */
{
  /* 手工构造最小 Proto 直接验证 opcode 语义。数据脚本（AvgCfg/AvgLang）
     不触发这四个 opcode 故全语料绿，但 Game.Avg.* 逻辑脚本会中招
    （EQ 404 / LT 28 / LE 3 / SETTABUP 14 条，见 tools/_scan-opcodes.mjs）。
     旧实现：EQ/LT/LE 的 A（标志位）与 C（操作数）角色互换；
             SETTABUP 的 B 硬取 K[B] 而非 rk(B)。 */
  const iABx = (op, A, Bx) => (op & 0x3F) | ((A & 0xFF) << 6) | ((Bx & 0x3FFFF) << 14);
  const iABC = (op, A, B, C) => (op & 0x3F) | ((A & 0xFF) << 6) | ((C & 0x1FF) << 14) | ((B & 0x1FF) << 23);
  const SBX = 131071;
  const KC = (v) => ({value: v});
  const P = {LOADK:1, GETTABUP:6, SETTABUP:8, JMP:30, EQ:31, LT:32, LE:33, RETURN:38};

  function runRaw(code, constants, maxStack) {
    return execChunk({code, constants, maxStack, isVararg:1,
      lineInfo: new Array(code.length).fill(0), source:'=test', protos:[], upvalues:[]});
  }

  /* EQ A=0：1==1 → 跳过 JMP → "yes"
     旧代码 equals(R[A=0], rk(B=0)) = equals(R[0], R[0]) = true，
     (C=1!==0)=true, true!==true=false → 不跳 → JMP → "no"（错）。 */
  assert.equal(runRaw([
    iABx(P.LOADK, 0, 0), iABx(P.LOADK, 1, 0),
    iABC(P.EQ, 0, 0, 1), iABx(P.JMP, 0, SBX+2),
    iABx(P.LOADK, 2, 1), iABC(P.RETURN, 2, 2),
    iABx(P.LOADK, 2, 2), iABC(P.RETURN, 2, 2),
  ], [KC(1), KC('yes'), KC('no')], 4)[0], 'yes',
    'EQ A=0：1==1 跳过 JMP');

  /* EQ A=1：1==1 → 不跳 → JMP → "no"（A=1 期望不等，相等走 else） */
  assert.equal(runRaw([
    iABx(P.LOADK, 0, 0), iABx(P.LOADK, 1, 0),
    iABC(P.EQ, 1, 0, 1), iABx(P.JMP, 0, SBX+2),
    iABx(P.LOADK, 2, 1), iABC(P.RETURN, 2, 2),
    iABx(P.LOADK, 2, 2), iABC(P.RETURN, 2, 2),
  ], [KC(1), KC('yes'), KC('no')], 4)[0], 'no',
    'EQ A=1：1==1 不跳（期望不等）');

  /* LT A=0：1<2 → 跳过 JMP → "yes" */
  assert.equal(runRaw([
    iABx(P.LOADK, 0, 0), iABx(P.LOADK, 1, 1),
    iABC(P.LT, 0, 0, 1), iABx(P.JMP, 0, SBX+2),
    iABx(P.LOADK, 2, 2), iABC(P.RETURN, 2, 2),
    iABx(P.LOADK, 2, 3), iABC(P.RETURN, 2, 2),
  ], [KC(1), KC(2), KC('yes'), KC('no')], 4)[0], 'yes',
    'LT A=0：1<2 跳过 JMP');

  /* LE A=0：1<=1 → 跳过 JMP → "yes"
     旧代码 compare(R[A=0], rk(B=0)) = 1<=1=true，(C=1!==0)=true，
     true!==true=false → 不跳 → "no"（错）。 */
  assert.equal(runRaw([
    iABx(P.LOADK, 0, 0), iABx(P.LOADK, 1, 0),
    iABC(P.LE, 0, 0, 1), iABx(P.JMP, 0, SBX+2),
    iABx(P.LOADK, 2, 1), iABC(P.RETURN, 2, 2),
    iABx(P.LOADK, 2, 2), iABC(P.RETURN, 2, 2),
  ], [KC(1), KC('yes'), KC('no')], 4)[0], 'yes',
    'LE A=0：1<=1 跳过 JMP');

  /* SETTABUP 常量键（B=256→K[0]）：env["greeting"]="hello"，读回验证。
     旧代码 K[B=256] 越界 → 崩溃。 */
  assert.equal(runRaw([
    iABx(P.LOADK, 0, 1),          /* R0 = K1 = "hello" */
    iABC(P.SETTABUP, 0, 256, 0),  /* env[K[0]] = R0 */
    iABC(P.GETTABUP, 0, 0, 256),  /* R0 = env[K[0]] */
    iABC(P.RETURN, 0, 2),         /* return R0 */
  ], [KC('greeting'), KC('hello')], 2)[0], 'hello',
    'SETTABUP 常量键写入 + GETTABUP 读回');

  /* SETTABUP 寄存器键（B=1→R[1]）：R[1]="greeting"（≠K[1]="wrong"），
     验证取 R[1] 而非 K[1] 作键。旧代码 K[1]="wrong" → 读 env["greeting"]=nil。 */
  assert.equal(runRaw([
    iABx(P.LOADK, 0, 0),          /* R0 = K0 = "hello" */
    iABx(P.LOADK, 1, 2),          /* R1 = K2 = "greeting" */
    iABC(P.SETTABUP, 0, 1, 0),    /* env[R[1]] = R0 → env["greeting"] = "hello" */
    iABC(P.GETTABUP, 2, 0, 258),  /* R2 = env[K[2]] = env["greeting"] */
    iABC(P.RETURN, 2, 2),         /* return R2 */
  ], [KC('hello'), KC('wrong'), KC('greeting')], 4)[0], 'hello',
    'SETTABUP 寄存器键（R[1]≠K[1]，验证取 R 而非 K）');

  ok('lvm：EQ/LT/LE/SETTABUP 语义锚点（手工 Proto 验证 bug 修复）');
}

console.log(`\n${passed} 项通过`);
