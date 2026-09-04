/**
 * 录制剧情视频单测（纯 Node）：mime 优先级/分辨率换算/参数清洗等纯函数、
 * 自动播放驱动（假钟全流程）、采集帧率监测（fake 逐帧回调）、
 * MediaRecorder 封装（FakeRecorder 注入）、ffmpeg.wasm 转码（fake 内核注入）。
 * 用法：node tools/test-recorder.mjs
 */
import assert from 'node:assert/strict';
import {
  RECORDER_MIME_CANDIDATES, pickRecorderMimeType, isNativeMp4,
  resolutionWidth, sanitizeSettings, DEFAULT_SETTINGS, recordingFilename,
  formatDuration, formatBytes, buildMp4Args, TranscodeAborted,
  AutoDriver, createCaptureMonitor, startTabRecording, webmToMp4,
} from '../js/editor/recorder.js';

let passed = 0;
const ok = (m) => { passed++; console.log('  ok   ' + m); };

/* —— mime 优先级与分辨率换算 —— */

assert.equal(pickRecorderMimeType(() => true), RECORDER_MIME_CANDIDATES[0],
    '全支持时首选 MP4 H.264+AAC');
assert.equal(pickRecorderMimeType(
    (t) => t.startsWith('video/webm')), 'video/webm;codecs=vp9,opus',
    'Firefox 只支持 webm 时取 vp9');
assert.equal(pickRecorderMimeType(() => false), '',
    '全不支持时空串（MediaRecorder 走默认容器）');
assert.equal(pickRecorderMimeType(() => { throw new Error('boom'); }), '',
    '探测函数抛错按不支持计');
assert.ok(isNativeMp4('video/mp4;codecs=avc1.640028,mp4a.40.2'));
assert.ok(!isNativeMp4('video/webm;codecs=vp9,opus'));
ok('mime 优先级：MP4 优先 / webm 兜底 / 全缺退空');

assert.equal(resolutionWidth(480), 854);
assert.equal(resolutionWidth(720), 1280);
assert.equal(resolutionWidth(1080), 1920);
assert.equal(resolutionWidth(1440), 2560);
assert.equal(resolutionWidth(2160), 3840);
assert.equal(resolutionWidth(1000), 1778, '非标档位也向上取整到偶数');
ok('分辨率换算：16:9 且宽为偶数（到 4K）');

/* —— 参数清洗 —— */

assert.deepEqual(sanitizeSettings({}), DEFAULT_SETTINGS, '全缺省 = 默认档');
const dirty = sanitizeSettings({
  resolutionHeight: '2160', frameRate: '60', videoBitrate: '99e6',
  playbackRate: '3', dwellMs: '12000', countdownSec: '7', captureAudio: 1,
});
assert.equal(dirty.resolutionHeight, 2160, '4K 档位放行');
assert.equal(dirty.frameRate, 60, '60fps 档位放行');
assert.equal(dirty.videoBitrate, 80_000_000, '码率钳到上限 80Mbps');
assert.equal(dirty.playbackRate, 1, '倍率不在档位内落默认');
assert.equal(dirty.dwellMs, 10_000, '选项停留钳到 10s');
assert.equal(dirty.countdownSec, DEFAULT_SETTINGS.countdownSec, '倒计时不在档位内落默认');
assert.equal(dirty.captureAudio, true, 'captureAudio 数字 1 归真');
assert.equal(sanitizeSettings({resolutionHeight: '1440'}).resolutionHeight,
    1440, '2K 档位放行');
assert.equal(sanitizeSettings({videoBitrate: '0.2'}).videoBitrate, 1_000_000,
    '码率钳到下限');
assert.equal(sanitizeSettings({dwellMs: '100'}).dwellMs, 500, '选项停留钳到 0.5s');
assert.equal(sanitizeSettings({countdownSec: 0}).countdownSec, 0, '0 = 不倒计时，是合法档');
assert.equal(sanitizeSettings({videoBitrate: 'abc'}).videoBitrate,
    DEFAULT_SETTINGS.videoBitrate, '非数字落默认');
assert.equal(sanitizeSettings({captureAudio: false}).captureAudio, false);
ok('参数清洗：白名单 + 区间钳制 + 非法落默认');

/* —— 文件名 / 时长 / 体积 —— */

const at = new Date(2026, 8, 4, 22, 5, 1);
assert.equal(recordingFilename('cpt00_e_01_01', 'video/mp4;codecs=avc1', at),
    'yuntu-cpt00_e_01_01-20260904-220501.mp4');
assert.equal(recordingFilename('cpt00', 'video/webm;codecs=vp9,opus', at),
    'yuntu-cpt00-20260904-220501.webm', 'webm 落 .webm 尾缀');
assert.equal(recordingFilename('a b/c:d', 'video/mp4', at),
    'yuntu-a_b_c_d-20260904-220501.mp4', '非法文件名字符归下划线');
assert.equal(recordingFilename('', '', at).startsWith('yuntu-story-'), true,
    '空 ID 退 story');
assert.equal(formatDuration(0), '0秒');
assert.equal(formatDuration(4200), '4.2秒');
assert.equal(formatDuration(95_000), '1分35.0秒');
assert.equal(formatBytes(0), '0B');
assert.equal(formatBytes(512), '1KB');
assert.equal(formatBytes(1048576), '1.0MB');
assert.equal(formatBytes(5.5 * 1048576), '5.5MB');
ok('文件名/时长/体积格式化');

/* —— 转码参数 —— */

const args = buildMp4Args('in.webm', 'out.mp4', 854);
assert.deepEqual(args.slice(0, 2), ['-i', 'in.webm']);
assert.ok(args.includes('libx264') && args.includes('aac'));
assert.ok(args.at(-1) === 'out.mp4');
const vf = args[args.indexOf('-vf') + 1];
assert.ok(vf.includes('min(854'), 'scale 上限来自 maxDim（超长录像压 854）');
assert.ok(vf.includes('trunc(iw/2)*2'), '宽取偶（yuv420p 硬性要求）');
assert.ok(vf.includes(':-2'), '高等比且取偶');
assert.ok(args.includes('yuv420p'));
ok('ffmpeg 转码参数：上限 + 偶尺寸 + H.264/AAC');

/* —— 自动播放驱动（假钟）—— */

/* 假钟：advance(ms) 把 due 定时器按到期序跑完（fn 可再排新的）。 */
function fakeTimers() {
  const q = [];
  let now = 0;
  let seq = 0;
  return {
    now: () => now,
    setTimer: (fn, ms) => {
      const t = {fn, at: now + Math.max(0, ms), seq: seq++};
      q.push(t);
      return t;
    },
    clearTimer: (t) => {
      const i = q.indexOf(t);
      if (i >= 0) q.splice(i, 1);
    },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        q.sort((a, b) => a.at - b.at || a.seq - b.seq);
        const next = q[0];
        if (!next || next.at > target) break;
        q.shift();
        now = next.at;
        next.fn();
      }
      now = target;
    },
    pending: () => q.length,
  };
}

/* 假引擎：advance = 推进一镜（lineMs 后行打完）；script 决定每镜形态。
   ended 与 playerTarget 同口径：playEnd && shotEnd（末行打完才算完）。 */
function fakePlayerLike(timers, script, {lineMs = 500} = {}) {
  const s = {playEnd: false, shotEnd: true, choices: 0};
  const calls = [];
  const finishLine = () => timers.setTimer(() => { s.shotEnd = true; }, lineMs);
  return {
    s, calls,
    ended: () => s.playEnd && s.shotEnd,
    shotEnd: () => s.shotEnd,
    choiceCount: () => s.choices,
    advance() {
      calls.push(['advance', timers.now()]);
      s.shotEnd = false;
      const step = script.length ? script.shift() : null;   // null 步骤 = 普通镜
      if (step === 'choice') s.choices = 2;
      if (step === 'end') s.playEnd = true;
      if (step === 'endchoice') { s.playEnd = true; s.choices = 2; }
      finishLine();
    },
    chooseFirst() {
      calls.push(['choose', timers.now()]);
      s.choices = 0;
      s.shotEnd = false;
      const step = script.length ? script.shift() : 'end';   // 选项跳到的镜也走脚本
      if (step === 'end') s.playEnd = true;
      finishLine();
    },
  };
}

function run(script, {dwellMs = 2000, onChoice = null} = {}) {
  const timers = fakeTimers();
  const target = fakePlayerLike(timers, script);
  let finishes = 0;
  const driver = new AutoDriver(target, {
    dwellMs, pollMs: 100,
    now: timers.now, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    onChoice, onFinish: () => finishes++,
  });
  driver.start();
  timers.advance(60_000);
  return {timers, target, finishes, driver};
}

{
  const {target, finishes} = run([null, null, 'end']);
  assert.equal(target.calls.filter((c) => c[0] === 'advance').length, 3,
      '线性段逐镜推进');
  assert.equal(finishes, 1, '末行打完才收');
}
ok('驱动：线性播放直到 playEnd && shotEnd');

{
  const {target, finishes} = run([null, 'choice', null, 'end']);
  const choose = target.calls.find((c) => c[0] === 'choose');
  const advanceCount = target.calls.filter((c) => c[0] === 'advance').length;
  assert.ok(choose, '遇选项停留后选了第一项');
  assert.equal(target.calls.filter((c) => c[0] === 'choose').length, 1);
  assert.ok(advanceCount >= 3, '选完继续推进');
  assert.equal(finishes, 1);
  const choiceShown = target.calls.filter((c) => c[0] === 'advance')[1];
  assert.ok(choose[1] - choiceShown[1] >= 2000 - 100,
      '选支发生在选项停留时长之后（容一个轮询节拍）');
}
ok('驱动：选项停留 dwellMs 后自动选第一项，再继续播');

{
  // 末镜是分支镜：playEnd 已置真但选项还等人选——choices 判定必须先于 ended
  const {target, finishes} = run(['endchoice']);
  const choose = target.calls.find((c) => c[0] === 'choose');
  assert.ok(choose, '末镜分支不会抢先收摊，仍走停留+选支');
  assert.equal(finishes, 1);
}
ok('驱动：choices 判定先于 ended（末镜分支也正常选）');

{
  const timers = fakeTimers();
  const target = fakePlayerLike(timers, [null, null, 'end']);
  const driver = new AutoDriver(target, {
    pollMs: 100, now: timers.now,
    setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  });
  driver.start();
  driver.stop();
  const before = target.calls.length;
  timers.advance(60_000);
  assert.equal(target.calls.length, before, 'stop 后不再驱动');
  assert.equal(driver.running, false);
}
ok('驱动：stop() 掐断轮询');

/* —— 采集帧率监测 —— */

function fakeMedia({rvfc = true, width = 1920, height = 1080} = {}) {
  const cbs = [];
  let seq = 0;
  const media = {
    t: 0,   // 虚拟媒体钟：rVFC 时间戳与它同源（浏览器里同为 HighResTimeStamp）
    videoWidth: width, videoHeight: height, plays: 0,
    play() { media.plays++; return Promise.resolve(); },
    ...(rvfc ? {
      requestVideoFrameCallback(cb) { cbs.push(cb); return ++seq; },
      cancelVideoFrameCallback(h) { cbs.splice(h - 1, 1); },
    } : {}),
    fire(ts) { media.t = ts; const cb = cbs.shift(); cb?.(ts); },
  };
  return media;
}

{
  const media = fakeMedia();
  const monitor = createCaptureMonitor(media, {now: () => media.t});
  assert.equal(media.plays, 1, '监测器负责起播探针');
  for (let i = 0; i <= 90; i++) media.fire(i * 1000 / 30);
  const report = monitor.stop();
  assert.equal(report.frames, 91);
  assert.ok(Math.abs(report.avgFps - 30) < 1, `平均帧率 ≈30（实得 ${report.avgFps}）`);
  assert.ok(Math.abs(report.minFps - 30) < 1, `1s 窗口最低帧率 ≈30（实得 ${report.minFps}）`);
  assert.equal(report.width, 1920);
  assert.equal(report.height, 1080);
  media.fire(99999);   // stop 之后回调必须哑火
  assert.equal(report.frames, 91);
}
{
  const media = fakeMedia();
  const monitor = createCaptureMonitor(media, {now: () => media.t});
  for (let i = 0; i < 30; i++) media.fire(i * 1000 / 30);   // 窗口1：30 帧 @30fps
  media.fire(1000);
  for (let i = 1; i <= 15; i++) media.fire(1000 + i * 1000 / 15);   // 窗口2：@15fps
  const report = monitor.stop();
  assert.ok(Math.abs(report.minFps - 15) < 0.5, `最低窗口帧率取 15（实得 ${report.minFps}）`);
  assert.ok(Math.abs(report.avgFps - 22.5) < 1, `全程平均 ≈22.5（实得 ${report.avgFps}）`);
}
{
  const media = fakeMedia({rvfc: false});
  const report = createCaptureMonitor(media).stop();
  assert.equal(report.frames, 0);
  assert.equal(report.avgFps, null, '无 rVFC 的浏览器退化为只报尺寸');
}
ok('采集监测：逐帧计数 / 1s 最低窗口 / 尺寸 / stop 后哑火 / rVFC 缺席降级');

/* —— MediaRecorder 封装（FakeRecorder 注入）—— */

class FakeRecorder {
  static supported = new Set();
  static isTypeSupported(t) { return FakeRecorder.supported.has(t); }
  constructor(stream, opts) {
    this.stream = stream;
    this.opts = opts;
    this.state = 'inactive';
    this.starts = 0;
  }
  start() { this.state = 'recording'; this.starts++; }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({data: {size: 123}});
    this.onstop?.();
  }
}
const stream = {id: 'fake-stream'};

{
  FakeRecorder.supported = new Set(RECORDER_MIME_CANDIDATES);
  const rec = startTabRecording(stream, {videoBitrate: 8_000_000},
      {Recorder: FakeRecorder});
  assert.equal(rec.mime, RECORDER_MIME_CANDIDATES[0]);
  assert.equal(rec.recorder.opts.mimeType, RECORDER_MIME_CANDIDATES[0]);
  assert.equal(rec.recorder.opts.videoBitsPerSecond, 8_000_000);
  assert.equal(rec.recorder.state, 'recording');
  const out = await rec.stop();
  assert.ok(out.blob.size > 0);
  assert.equal(out.mime, RECORDER_MIME_CANDIDATES[0]);
  assert.equal(Number.isFinite(out.durationMs), true);
}
{
  FakeRecorder.supported = new Set(['video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus', 'video/webm']);
  const rec = startTabRecording(stream, {videoBitrate: 8_000_000},
      {Recorder: FakeRecorder});
  assert.equal(rec.mime, 'video/webm;codecs=vp9,opus', 'webm 档位按优先级取 vp9');
  await rec.stop();
}
{
  FakeRecorder.supported = new Set();
  const rec = startTabRecording(stream, {videoBitrate: 8_000_000},
      {Recorder: FakeRecorder});
  assert.equal(rec.recorder.opts.mimeType, undefined, '全缺退默认容器（不传 mime）');
  const out = await rec.stop();
  assert.equal(out.mime, 'video/webm', 'blob 标 webm 型');
}
ok('录制封装：mime 协商 / 码率入参 / stop 聚合 blob');

/* —— ffmpeg.wasm 转码（fake 内核注入）—— */

function fakeFFmpeg() {
  const calls = {write: [], exec: null, read: [], removed: [], terminated: 0};
  return {
    calls,
    on() {},
    async writeFile(name, data) { calls.write.push(name); },
    async exec(args) { calls.exec = args; },
    async readFile(name) { calls.read.push(name); return new Uint8Array([1, 2, 3, 4]); },
    async deleteFile(name) { calls.removed.push(name); },
    async terminate() { calls.terminated++; },
  };
}

{
  const ffmpeg = fakeFFmpeg();
  const blob = new Blob([new Uint8Array(16)], {type: 'video/webm'});
  const out = await webmToMp4(blob, {
    durationMs: 60_000, maxDim: 854, ffmpegFactory: async () => ffmpeg,
    onProgress: (p) => { if (p === 1) ffmpeg.calls.progressDone = true; },
  });
  assert.equal(out.type, 'video/mp4');
  assert.deepEqual(ffmpeg.calls.exec, buildMp4Args('in.webm', 'out.mp4', 854));
  assert.ok(ffmpeg.calls.read.includes('out.mp4'));
  assert.ok(ffmpeg.calls.removed.includes('in.webm'), '样本清理');
  assert.equal(ffmpeg.calls.terminated, 0, '正常完成不 terminate（单例复用）');
}
{
  const ffmpeg = fakeFFmpeg();
  const blob = new Blob([new Uint8Array(16)], {type: 'video/webm'});
  await assert.rejects(
      webmToMp4(blob, {ffmpegFactory: async () => ffmpeg, abort: () => true}),
      TranscodeAborted, '开录即取消 → TranscodeAborted');
  assert.equal(ffmpeg.calls.terminated, 1, '取消路径 terminate 内核');
}
{
  const ffmpeg = fakeFFmpeg();
  const blob = new Blob([new Uint8Array(16)], {type: 'video/webm'});
  let checked = false;
  await assert.rejects(
      webmToMp4(blob, {
        ffmpegFactory: async () => ffmpeg,
        abort: () => (checked ? true : (checked = true, false)),
      }),
      TranscodeAborted, '转码中途取消 → TranscodeAborted');
  assert.equal(ffmpeg.calls.terminated, 1);
}
{
  const ffmpeg = {
    on() {},
    async writeFile() {},
    async exec() { throw new Error('segfault at 0x0'); },
    async readFile() { return new Uint8Array(0); },
    async deleteFile() {},
    async terminate() {},
  };
  await assert.rejects(
      webmToMp4(new Blob([new Uint8Array(4)], {type: 'video/webm'}),
          {ffmpegFactory: async () => ffmpeg}),
      (e) => e.message.includes('转码失败：segfault'), '内核失败包装成可读错误');
}
ok('webmToMp4：参数传递 / 取消逃生门（terminate）/ 失败包装');

console.log(`\n${passed} 组断言全部通过`);
