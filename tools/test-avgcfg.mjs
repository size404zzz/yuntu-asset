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
