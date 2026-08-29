/**
 * M7 音频引擎单测：纯 Node + FakeCtx（不碰真音频、不开浏览器）。
 * 判据对着计划验收项设计：bgm 交叉淡入淡出、sfx 不吞、手势前静音 +
 * 解锁后按已流逝时间续播、换轨代际护栏、stopAll/静音/音量。
 *
 * 用法：node tools/test-audio.mjs
 */
import assert from 'node:assert/strict';
import {AudioEngine} from '../js/engine/audio.js';

let passed = 0;
const ok = (m) => { passed++; console.log('  ok   ' + m); };

/* ---------- Fake Web Audio ---------- */

class FakeParam {
  constructor(value = 0) { this.value = value; this.events = []; }
  setValueAtTime(v, t) { this.events.push(['set', v, +t.toFixed(3)]); return this; }
  linearRampToValueAtTime(v, t) { this.events.push(['ramp', v, +t.toFixed(3)]); return this; }
  cancelScheduledValues(t) { this.events.push(['cancel', +t.toFixed(3)]); return this; }
}
class FakeSource {
  constructor(ctx) { this.ctx = ctx; this.started = []; this.stopped = []; }
  connect(node) { this.connected = node; return node; }
  start(when = 0, offset = 0) { this.started.push([when, offset]); this.ctx.live.add(this); }
  stop(when = 0) { this.stopped.push(+when.toFixed(3)); this.ctx.live.delete(this); }
}
class FakeCtx {
  constructor() { this.currentTime = 0; this.live = new Set(); this.sources = []; this.gains = []; }
  createGain() {
    const g = {gain: new FakeParam(1), connect: (n) => n};
    this.gains.push(g);
    return g;
  }
  createBufferSource() {
    const s = new FakeSource(this);
    this.sources.push(s);
    return s;
  }
  decodeAudioData() { return Promise.resolve({duration: 10}); }
}

/* fetch 桩：每个 url 的解码由手动 settle 的 deferred 控制，
   以便复现「A 还在解码 B 又来」这类交错。每个用例开头清空。 */
const deferreds = [];
globalThis.fetch = (url) => {
  let settle;
  const body = new Promise((resolve) => { settle = resolve; });
  deferreds.push({url, settle});
  return Promise.resolve({ok: true, arrayBuffer: () => body});
};
const flush = () => new Promise((r) => setImmediate(() => setImmediate(r)));
const buf = () => new ArrayBuffer(8);

const makeEngine = () => {
  const ctx = new FakeCtx();
  let now = 1000;
  const logs = [];
  const engine = new AudioEngine({
    resolve: (sheet, cue) => `aud/${sheet}/${cue}`,
    ctxFactory: () => ctx,
    log: (m) => logs.push(m),
  });
  engine._now = () => now;
  deferreds.length = 0;
  return {engine, ctx, logs, setNow: (t) => { now = t; }};
};
const lastSource = (ctx) => ctx.sources[ctx.sources.length - 1];

/* ---------- 1. 手势前：不建上下文、sfx 丢弃、bgm 记待播 ---------- */
{
  const {engine, ctx} = makeEngine();
  engine.shot({audio: {bgm: {sheet: 'Mus_A', cue: 'a'}, sfx: {sheet: 'S', cue: 'x'}}});
  assert.equal(engine.ctx, null, '手势前不得创建 AudioContext');
  assert.equal(engine.unlocked, false);
  assert.equal(deferreds.length, 0, '手势前不得发起任何 fetch');
  engine.sfxCue({sheet: 'S', cue: 'y'});
  assert.equal(deferreds.length, 0, '手势前 sfx 直接丢弃');
  assert.equal(ctx.sources.length, 0);
  ok('手势前静音：无 ctx、无 fetch、sfx 丢弃');
}

/* ---------- 2. 解锁后按已流逝时间续播；同曲不重启 ---------- */
{
  const {engine, ctx, setNow} = makeEngine();
  setNow(1000);
  engine.shot({audio: {bgm: {sheet: 'Mus_A', cue: 'a'}}});
  setNow(4500);                       // 手势前已经过了 3.5s
  engine.unlock();
  assert.ok(engine.unlocked);
  deferreds[0].settle(buf());
  await flush();
  const s = lastSource(ctx);
  assert.deepEqual(s.started, [[0, 3.5]], 'loop 曲从流逝偏移 3.5s 续播');
  assert.equal(s.loop, true);
  engine.bgmCue({sheet: 'Mus_A', cue: 'a'});
  await flush();
  assert.equal(ctx.sources.length, 1, '同曲不重启');
  ok('解锁续播 offset=3.5s；同曲不重启');
}

/* ---------- 3. 换曲交叉淡入淡出 ---------- */
{
  const {engine, ctx} = makeEngine();
  engine.unlock();
  engine.bgmCue({sheet: 'Mus_A', cue: 'a'});
  deferreds[0].settle(buf());
  await flush();
  const first = lastSource(ctx);
  ctx.currentTime = 7;
  engine.bgmCue({sheet: 'Mus_B', cue: 'b', fadeIn: 2});
  deferreds[1].settle(buf());
  await flush();
  const second = lastSource(ctx);
  assert.notEqual(second, first, '新轨是新源');
  const oldGain = ctx.gains[1].gain;
  const newGain = ctx.gains[2].gain;
  assert.equal(oldGain.events.at(-1)[0], 'ramp');
  assert.deepEqual(oldGain.events.at(-1), ['ramp', 0, 9], '旧轨 2s 淡出到 0');
  assert.deepEqual(first.stopped, [9]);
  assert.equal(newGain.value, 0, '新轨从静音起步');
  assert.deepEqual(newGain.events.at(-1), ['ramp', 1, 9], '新轨 2s 淡入到 1');
  assert.deepEqual(second.started, [[0, 0]]);
  assert.equal(engine.bgm.key, 'Mus_B/b');
  ok('换曲交叉淡入淡出（fadeIn 同时长、旧轨到点停）');
}

/* ---------- 4. 快速连切：代际护栏只留最后一轨 ---------- */
{
  const {engine, ctx} = makeEngine();
  engine.unlock();
  engine.bgmCue({sheet: 'Mus_A', cue: 'a'});
  deferreds[0].settle(buf());
  await flush();                                   // A 开播
  engine.bgmCue({sheet: 'Mus_B', cue: 'b'});       // B 开始解码
  engine.bgmCue({sheet: 'Mus_C', cue: 'c'});       // C 顶掉 B
  deferreds[1].settle(buf());
  deferreds[2].settle(buf());
  await flush();
  const started = ctx.sources.filter((s) => s.started.length);
  assert.equal(started.length, 2, 'A 与 C 开播，B 被代际取消');
  assert.equal(engine.bgm.key, 'Mus_C/c');
  ok('换轨代际：解码中被顶替的 B 不再开播');
}

/* ---------- 5. sfx 不吞：两条都在响 ---------- */
{
  const {engine, ctx} = makeEngine();
  engine.unlock();
  engine.sfxCue({sheet: 'S', cue: 'one'});
  engine.sfxCue({sheet: 'S', cue: 'two'});
  deferreds[0].settle(buf());
  deferreds[1].settle(buf());
  await flush();
  const sfx = ctx.sources.filter((s) => s.started.length);
  assert.equal(sfx.length, 2);
  assert.equal(sfx.filter((s) => s.stopped.length).length, 0, '后一条不得掐前一条');
  ok('sfx 不吞：两条叠响、零掐断');
}

/* ---------- 6. stop:true 淡出 + stopAll ---------- */
{
  const {engine, ctx} = makeEngine();
  engine.unlock();
  engine.bgmCue({sheet: 'Mus_A', cue: 'a', fadeIn: 1});
  deferreds[0].settle(buf());
  await flush();
  const bgm = lastSource(ctx);
  ctx.currentTime = 5;
  engine.bgmCue({sheet: 'Mus_A', cue: 'a', stop: true, fadeOut: 3});
  assert.equal(engine.bgm, null);
  assert.deepEqual(bgm.stopped, [8], 'stop:true → currentTime+fadeOut 处停');
  engine.sfxCue({sheet: 'S', cue: 'x'});
  deferreds[1].settle(buf());
  await flush();
  const sfx = lastSource(ctx);
  engine.stopAll({fade: 0.5});
  assert.equal(sfx.stopped.length, 1, 'stopAll 掐掉在响的 sfx');
  ok('stop:true 淡出停轨；stopAll 清场');
}

/* ---------- 7. 静音与音量走 master 增益 ---------- */
{
  const {engine, ctx} = makeEngine();
  engine.unlock();
  const master = ctx.gains[0];                    // unlock 里第一个 gain 是 master
  engine.setMuted(true);
  assert.deepEqual(master.gain.events.at(-1), ['ramp', 0, 0.1]);
  engine.setMuted(false);
  assert.deepEqual(master.gain.events.at(-1), ['ramp', 1, 0.1]);
  engine.setVolume(0.4);
  assert.deepEqual(master.gain.events.at(-1), ['ramp', 0.4, 0.1]);
  engine.setVolume(7);
  assert.equal(engine.volume, 1, '音量钳在 [0,1]');
  ok('静音/音量：master 线性斜坡 + 钳位');
}

/* ---------- 8. 解析缺失：记日志不炸 ---------- */
{
  const {engine, logs} = makeEngine();
  engine.resolve = () => null;
  engine.unlock();
  engine.shot({audio: {bgm: {sheet: 'X', cue: 'y'}, sfx: {sheet: 'S', cue: 'z'}}});
  assert.equal(logs.length, 2, 'bgm 与 sfx 各记一条缺解析');
  ok('缺素材：静默跳过 + 日志');
}

console.log(`\n${passed} 项通过`);
