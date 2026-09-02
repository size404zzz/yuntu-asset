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
  /* 揭示时机（契约切换 D6 后）：原版是「说话镜 ⇒ 说话人现身」，所以预站位镜
     （键2）**不就地补揭示**，而是在她首个说话镜（键4，speakerHeroId=1047）点亮；
     键6 的原揭示条目与键17 的退场条目都保持原样。
     （旧断言钉的是 materializeDanglingCast 的补半拍行为——该行为与
     revealNeverVisibleCast 一起退役，点亮权收归 autoLightCast 一层。） */
  const w2 = wire['2'].imgTween.filter((t) => t.imgId === 147);
  assert.deepEqual(w2.map((t) => t.alpha), [0], '预站位镜不被就地补揭示');
  const w4 = wire['4'].imgTween.filter((t) => t.imgId === 147);
  assert.deepEqual(w4.map((t) => t.alpha), [1], '她的首个说话镜补出揭示');
  assert.equal(w4[0].isDark, false, '入场按亮重建');
  assert.equal(wire['4'].speakerHeroId, 1047, '键4 确实是薇洛儿说话');
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
  /* 两类归类都真实存在，且必须分对：键6 的 101 是「已在台上但被听教授时压暗」
     ⇒ 复亮（autoLit），只有 α0 的那才叫入场（entranceLit）。分错的代价不只是
     计数难看——入场分支会把该件记进 `ours`（只由本层点亮的集合），换景收场据此
     才允许淡出它；把作者点亮的件误记成 ours，下一场就会被我们偷偷收掉。 */
  assert.ok(stats.autoLit >= 1, `已在场者归为复亮（autoLit=${stats.autoLit}）`);
  assert.equal(wire['6'].imgTween.filter((t) => t.imgId === 101 && t.isDark === false).length, 1,
      '复亮只补一条点亮条目');
  /* 钉折叠态而不是钉条目：键8 她已经亮着，修复不该再补一条（补了会把
     作者点亮的件记进 ours，下一场被我们偷偷收掉）。 */
  assert.equal(foldAlpha(wire, 'persicaria_avg').get('8'), 1,
      '键8 她说话时同样是亮的（沿用键6 的点亮）');
  const plain = storyToWire(decodeLua2('cfg', '1year_prologue'),
      decodeLua2('lang', '1year_prologue')).wire;
  assert.ok(!Object.values(plain).some((s) => (s.images ?? []).some((im) => im.imgId === 147)),
      '无 imgIds 时保持原样不注');
  ok(`avgwire：悬空立绘 tween 落名（1year_prologue 147→willow_avg）`);
}
{
  /* 永不可见立绘的揭示重建已合并进 autoLightCast（D6）：22child_01_03 的安吉拉
     （117）只有 alpha 0 条目（step 38 预站位 / step 41 灯光），揭示半拍丢失——
     旧版 revealNeverVisibleCast 会在预站位后补揭示、后续 alpha 0 升 1；合并后
     不再单独修：α0+duration>0 视为作者显式画外（键 42 的灯光淡出），不越权覆盖；
     完好轨迹（kuro 155）不动。 */
  const {wire, stats} = storyToWire(decodeLua2('cfg', '22child_01_03'),
      decodeLua2('lang', '22child_01_03'));
  const angela39 = wire['39'].imgTween.filter((t) => t.imgId === 117);
  assert.equal(angela39.length, 1, '预站位镜不再就地补揭示');
  assert.equal(angela39[0].alpha, 0, '预站位 alpha 0 保留');
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
  ok(`avgwire：永不可见立绘揭示重建已合并（22child_01_03 安吉拉）`);
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
      {imgIds: manifest.imgIds, heroSprites: manifest.heroSprites, pathOwner: manifest.pathOwner});
  const kuro2 = wire['2'].imgTween.filter((t) => t.imgId === 155);
  assert.deepEqual(kuro2.map((t) => t.alpha), [0, 1], '卡萝开口镜补出揭示半拍');
  assert.equal(kuro2[1].duration, 0.2, '揭示 duration 0.2');
  assert.equal(kuro2[1].isDark, false, '揭示按亮重建（说话=亮）');
  const chelsea10 = wire['10'].imgTween.filter((t) => t.imgId === 107);
  assert.deepEqual(chelsea10.map((t) => t.alpha), [0, 1], '炽开口镜补出揭示半拍');
  const kuro32 = wire['32'].imgTween.filter((t) => t.imgId === 155);
  assert.deepEqual(kuro32.map((t) => t.alpha), [0, 1], '预站位后无揭示的说话镜也补');
  /* 入场计数从 20 降到 7：不是少补了揭示，而是「已在台上、只是被压暗」的那
     十几处本来就该记复亮而不是入场（旧口径把两者混在一起，见上面的 ours 说明）。
     可观察结果由上面三条 + 下面三条折叠态断言钉。 */
  assert.ok(stats.entranceLit >= 7 && stats.autoLit >= 1,
      `入场/复亮分开计数（entrance=${stats.entranceLit} relight=${stats.autoLit}）`);
  /* 折叠态复核：预站位说话镜可见；合并后说话镜一律揭示（除非本镜有显式淡出）。 */
  const kuro = foldAlpha(wire, 'kuro_avg');
  assert.equal(kuro.get('2'), 1, '键 2 卡萝开口时在场');
  assert.equal(kuro.get('32'), 1, '键 32 卡萝开口时在场');
  assert.equal(kuro.get('42'), 1, '键 42 卡萝说话镜被揭示（合并后说话=亮）');
  ok(`avgwire：说话镜入场揭示补齐（22child_01_03 三处，淡出退场保留）`);
}
{
  /* 用户报的实例（M23）：1year_prologue 键 21 薇洛儿（1047→willow_avg=147）
     开口「从哪里开始好呢」，本镜只有 `147 α0/dur0/posId3` 的预站位，数据里
     下一次揭示拖到键 51——上一轮「揭示必须在紧邻下一镜」的判据漏掉这类。
     同镜的 bg α1 与她的三连台词（键 21/22/24）都该看见人。
     合并后行为：说话镜一律揭示，键 99 薇洛儿开口即亮（除非本镜有显式淡出）。 */
  const {wire, stats} = storyToWire(decode('cfg', '1year_prologue'),
      decode('lang', '1year_prologue'),
      {imgIds: manifest.imgIds, heroSprites: manifest.heroSprites, pathOwner: manifest.pathOwner});
  const willow21 = wire['21'].imgTween.filter((t) => t.imgId === 147);
  assert.deepEqual(willow21.map((t) => [t.alpha, t.duration]), [[0, 0], [1, 0.2]],
      '键 21 预站位后补出揭示（原数据揭示远在键 51）');
  assert.equal(willow21[1].isDark, false, '补的揭示按亮');
  const seen = foldAlpha(wire, 'willow_avg');
  assert.equal(seen.get('21'), 1, '键 21 薇洛儿在场');
  assert.equal(seen.get('24'), 1, '补的揭示延续到她的后续台词镜');
  assert.equal(seen.get('99'), 1, '键 99 薇洛儿说话镜被揭示（合并后说话=亮）');
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
  assert.equal(sol.get('34'), 0, '合并后苏尔在键 34 已淡出（家族不变量或换景收场）');
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
      {imgIds: manifest.imgIds, heroSprites: manifest.heroSprites, pathOwner: manifest.pathOwner});
  const dress16 = wire['16'].imgTween.filter((t) => t.imgId === 101);
  assert.deepEqual(dress16.map((t) => [t.alpha, t.duration]), [[0, 0], [1, 0.2]],
      '换装开口镜补出揭示半拍');
  const dress = foldAlpha(wire, 'persicaria_dress_avg');
  assert.equal(dress.get('16'), 1, '键 16 帕斯卡开口时在场');
  assert.equal(dress.get('21'), 1, '揭示延续到她的后续台词镜');
  /* 同剧本另备一件 dress2（1011），到键 95 才换装登场：从未点亮过的立绘不算
     替身。游戏契约下「注册即建 lane」（InitAvgHeroPicParam 当场写 color.a），
     所以这里判的是**不可见**而不是「没有 lane」——两种写法都能挡住替身，但只有
     前者与 state.js 的真实折叠一致。 */
  const dress2 = foldAlpha(wire, 'persicaria_dress2_avg');
  assert.ok(!dress2.get('16'), '未登场的 dress2 不被提前立上台（注册也只到 α=0）');
  assert.equal(dress2.get('96'), 1, 'dress2 的登场仍完全由原数据驱动');
  /* 70 → 个位数：旧口径把「她已在台上、只是听别人时压暗」的每一镜都重记成
     一次入场（并把她写进 ours），现在这类归复亮、且不重复注入。可观察结果由
     上面四条折叠态断言钉。 */
  assert.ok(stats.entranceLit >= 5, `全段入场揭示计数（${stats.entranceLit}）`);
  /* 已知边界：词列第二格不同即判不同角色，mara_weapon 不认 mara_wrecked——
     这里确实漏召回（说话的是玛拉、台上是残骸装）。但反过来按首词归类会把
     burbank_npc1 / fool_mie / odile_b3 / helios_robotyellow 全当成同一个人，
     幻影比隐身更难发现，这种缺口留给编辑器人工补。 */
  const mara = storyToWire(decode('cfg', 'cpt02_e_07_01'),
      decode('lang', 'cpt02_e_07_01'),
      {imgIds: manifest.imgIds, heroSprites: manifest.heroSprites, pathOwner: manifest.pathOwner}).wire;
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
  assert.equal(manifest.imgIds['147'][0], 'willow_avg', '纯立绘槽位保留（147 首选）');
  assert.equal(manifest.imgIds['13'][0], 'riko_avg', '立绘票占优的争议槽位保留（13 首选）');
  /* 槽位是序号不是身份：同一槽在全语料被不同剧本声明成不同立绘，表给的是
     票数降序的候选集，本段就地按「谁在说话」仲裁（见下面的 22child_02 断言）。 */
  assert.ok(manifest.imgIds['105'].length > 1, '同一槽多件的槽位给出候选集（105）');
  assert.equal(manifest.imgIds['105'][0], 'croque_avg', '候选集首选 = 全局众数（105）');
  assert.ok(manifest.imgIds['105'].includes('croque_kid_avg'), '候选集含同槽的另一身份（105）');
  const {wire, stats} = storyToWire(decode('cfg', '22white_choco'),
      decode('lang', '22white_choco'),
      {imgIds: manifest.imgIds, heroSprites: manifest.heroSprites, pathOwner: manifest.pathOwner});
  assert.ok(!Object.values(wire).some((s) =>
      (s.images ?? []).some((im) => im.imgId === 10)),
      '背景槽 10 不被注入为立绘（22white_choco）');
  assert.ok(!stats.danglingCast.some((c) => c.imgId === 10), 'stats 无 10 的注入留痕');
  assert.ok(wire['9'].imgTween.some((t) => t.imgId === 10 && t.alpha === 1),
      '原 tween 原样保留（未注册跳过，参考语义）');
  ok(`avgwire：槽位类型门（22white_choco 背景槽 10 不注入）`);
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
      {imgIds: manifest.imgIds, heroSprites: manifest.heroSprites, pathOwner: manifest.pathOwner});
  const reg = Object.values(wire).flatMap((s) => (s.images ?? [])
      .filter((im) => im?.imgId === 105).map((im) => im.imgPath));
  assert.deepEqual([...new Set(reg)], ['croque_kid_avg'], '悬空槽 105 就地认成小克罗琦');
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
  assert.equal(resolved, 121016, '解引用命中总数');
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
