/**
 * 23sg 专属演出回归：Node 侧验 wire 通道（contentStyle/sgMobile/sgLineChange
 * 透传 + sendMsg Lang 解引用 + 终端镜只能显式标注 + sgMobile 字段集覆盖），
 * 浏览器侧 selftest-sg.html 在合成场上逐镜验 CRT 终端帧、手机窗开合/发信/
 * 确认/收信横幅、世界线特效与 404 帧降级。
 * 游戏侧真值见 res/.../_logic/Game.Avg.SteinsGate.*。
 *
 * 用法：node tools/test-sg.mjs [--port=0] [--timeout=120]
 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {parseChunk} from '../js/core/lundump.js';
import {execChunk, toJS} from '../js/core/lvm.js';
import {storyToWire, replayChain} from '../js/core/avgwire.js';
import {browserTest, ROOT} from './lib/run.mjs';

/* —— Node 侧：wire 通道与语料口径 —— */

const man = JSON.parse(readFileSync(join(ROOT, 'data', 'index', 'avg-scripts.json'), 'utf8'));
const dec = (p) => toJS(execChunk(parseChunk(readFileSync(join(ROOT, p))))[0]);
const wireOf = (id) => {
  const meta = man.stories.find((s) => s.id === id);
  return storyToWire(dec(meta.cfg), dec(meta.lang),
      {imgIds: man.imgIds, heroSprites: man.heroSprites, pathOwner: man.pathOwner});
};

let passed = 0;
const ok = (m) => { passed++; console.log('  ok   ' + m); };

{
  const {wire} = wireOf('23sg_a00_1');
  assert.equal(wire['1'].contentStyle, 1, 'contentStyle 透传（0 起始平移后键 1）');
  ok('contentStyle 透传并随 0 起始平移');
}
{
  const {wire, stats} = wireOf('23sg_a05');
  const shot = Object.values(wire).find((s) => s.sgMobile?.sendMsg);
  assert.ok(shot, 'a05 有 sendMsg 镜');
  assert.equal(shot.sgMobile.sendMsg.receiver, '电话微波炉（暂定）');
  assert.ok(String(shot.sgMobile.sendMsg.contentMsg).startsWith('老式电脑的硬件'),
      '消息体解引用');
  assert.ok(stats.unresolved.every((u) => !u.field.startsWith('sgMobile')),
      'sgMobile 解引用零悬空');
  ok('sendMsg 收信人/消息体 Lang 解引用（电话微波炉（暂定））');
}
{
  const {wire} = wireOf('23sg_a01');
  const chain = [...replayChain(wire)];
  assert.equal(chain.findIndex((k) => wire[k].contentType !== 1), 8,
      'a01 开场 Chapter 连排 = 前 8 镜（sg_theme_001..008 文本对位的依据）');
  assert.ok(chain.every((k) => wire[k].sgMonitorFrame === undefined),
      '语料里没有 sgMonitorFrame：终端镜只能由标注层显式点亮');
  ok('a01 开场 8 镜连排是语料事实；终端镜触发权在标注层，引擎不猜');
}
{
  /* 全量口径护栏：74/16/4 段 + sgMobile 字段集必须被引擎吃满。 */
  let cs = 0, mob = 0, lc = 0;
  const mobileKeys = new Set();
  for (const meta of man.stories) {
    if (!meta.id.includes('23sg')) continue;
    const cfg = dec(meta.cfg);
    const flags = new Set();
    for (const st of Object.values(cfg)) {
      if (!st || typeof st !== 'object') continue;
      if (st.contentStyle !== undefined) flags.add('cs');
      if (st.sgMobile !== undefined) flags.add('mob');
      if (st.sgLineChange !== undefined) flags.add('lc');
      if (st.sgMobile && typeof st.sgMobile === 'object') {
        for (const k of Object.keys(st.sgMobile)) mobileKeys.add(k);
      }
    }
    cs += flags.has('cs');
    mob += flags.has('mob');
    lc += flags.has('lc');
  }
  assert.equal(cs, 74, 'contentStyle 段数');
  assert.equal(mob, 16, 'sgMobile 段数');
  assert.equal(lc, 4, 'sgLineChange 段数');
  assert.deepEqual([...mobileKeys].sort(), [
    'hideImmediate', 'sendMsg', 'sendMsgConfirm', 'showReceiveNewMsg',
    'showSgMobile',
  ].sort(), `sgMobile 字段集漂移：${[...mobileKeys].join(',')}`);
  ok(`语料口径：contentStyle ${cs} 段 · sgMobile ${mob} 段 · sgLineChange ${lc} 段`);
  ok(`sgMobile ${mobileKeys.size} 种字段全覆盖（含单用的 hideImmediate）`);
}

/* —— 浏览器侧：合成场逐镜行为 —— */

console.log(`\n  Node 侧 ${passed} 项通过`);
const {code} = await browserTest({
  label: '23sg 专属演出',
  scene: 'sg_report',
  page: 'selftest-sg.html',
  timeout: Number(process.env.SG_TIMEOUT ?? 120),
  probe: 'res/Assets/Res/Images/Avg/sg/sg_theme_001.png',
  statsOf: (rep) => [`断言 ${rep.asserts}`],
});
process.exit(code);
