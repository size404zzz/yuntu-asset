/* recorder.js —— 录制剧情视频：标签页采集 + 自动播放 + 导出 MP4。
 *
 * 管线（与 gfStory 0.7.4/0.7.5 同构）：
 *   requestTabCapture（getDisplayMedia，ideal 约束 + preferCurrentTab 预选本页）
 *   → startTabRecording（MediaRecorder，MP4 mime 优先，webm vp9+opus 兜底）
 *   → 原生 MP4 直接落盘（零转码）/ webmToMp4（ffmpeg.wasm，Firefox 兜底，
 *     进度推算靠 durationMs——MediaRecorder 的 webm 缺时长元数据）。
 *   abortTranscode（transcodeAbort 旗标）是转码太慢的逃生门：终止 wasm、
 *   直接导出原始 webm。preferCurrentTab 与 selfBrowserSurface:'exclude' 互斥
 *   （Chromium 同给会抛错），所以只给前者。
 *
 * 分层与 storylib 一致：纯函数/纯类（mime、分辨率、参数清洗、AutoDriver、
 * 采集监测）Node 可测；openRecorder 是唯一的浏览器会话层。两种宿主形态：
 * 编辑器把舞台搬进全屏黑底宿主（stageHostView）再录；全屏播放页
 * （record.html）页面本身就是舞台，不传视图钩子。采集的是整个视口，
 * 编辑器外壳/工具栏不能入镜——录制期间页内零指示，Esc 结束，标题栏 ● 兜底。
 */

import {h, clear, clamp} from '../ui/dom.js';
import {serializeScript} from '../core/script.js';
import {STAGE_WIDTH, STAGE_HEIGHT} from '../engine/player.js';

/* —— 纯函数层（Node 可测）—— */

/* MediaRecorder mime 候选，序即优先级：Chrome 126+/Edge/Safari 直录
   H.264+AAC MP4；Firefox 只有 webm，导出阶段再转。 */
export const RECORDER_MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export function isNativeMp4(mime) {
  return String(mime || '').split(';')[0] === 'video/mp4';
}

export function pickRecorderMimeType(supports,
    candidates = RECORDER_MIME_CANDIDATES) {
  for (const mime of candidates) {
    try {
      if (supports(mime)) return mime;
    } catch { /* 探测函数可能缺席 */ }
  }
  return '';
}

/* 16:9 换算且向上取整到偶数（编码器 yuv420p 要求偶尺寸）：
   480→854、720→1280、1080→1920、2160→3840。 */
export function resolutionWidth(height) {
  return Math.ceil((height * 16) / 9 / 2) * 2;
}

export const RESOLUTION_HEIGHTS = [2160, 1440, 1080, 720, 480];
export const FRAME_RATES = [60, 30, 24, 15];
export const PLAYBACK_RATES = [1, 2, 4, 8, 10];
export const COUNTDOWN_CHOICES = [0, 3, 5, 10];
export const AUDIO_BITRATE = 192_000;
export const BITRATE_MAX = 80_000_000;

export const DEFAULT_SETTINGS = {
  resolutionHeight: 1080,
  frameRate: 30,
  videoBitrate: 8_000_000,
  playbackRate: 1,
  dwellMs: 2000,
  countdownSec: 3,
  captureAudio: true,
};

/* 设置面板来的都是字符串：白名单档位 + 区间钳制，非法一律落默认。 */
export function sanitizeSettings(raw = {}) {
  const num = (v) => Number(v);
  const pick = (v, list, fallback) =>
      list.includes(num(v)) ? num(v) : fallback;
  const inRange = (v, fallback, min, max) => {
    const n = num(v);
    return Number.isFinite(n) ? clamp(n, min, max) : fallback;
  };
  return {
    resolutionHeight: pick(raw.resolutionHeight, RESOLUTION_HEIGHTS,
        DEFAULT_SETTINGS.resolutionHeight),
    frameRate: pick(raw.frameRate, FRAME_RATES, DEFAULT_SETTINGS.frameRate),
    videoBitrate: Math.round(inRange(raw.videoBitrate,
        DEFAULT_SETTINGS.videoBitrate, 1_000_000, BITRATE_MAX)),
    playbackRate: pick(raw.playbackRate, PLAYBACK_RATES,
        DEFAULT_SETTINGS.playbackRate),
    dwellMs: Math.round(inRange(raw.dwellMs, DEFAULT_SETTINGS.dwellMs,
        500, 10_000)),
    countdownSec: pick(raw.countdownSec, COUNTDOWN_CHOICES,
        DEFAULT_SETTINGS.countdownSec),
    captureAudio: raw.captureAudio === undefined
        ? DEFAULT_SETTINGS.captureAudio : !!raw.captureAudio,
  };
}

const STORAGE_KEY = 'yuntu-recorder-settings';

function readStoredSettings() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch { return {}; }
}

function storeSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch { /* 隐私模式等：不持久化也不致命 */ }
}

/* 冒号等非法文件名字符不进盘；时间戳本地时区（与录文件的人对表）。 */
export function recordingFilename(id, mime, at = new Date()) {
  const ext = isNativeMp4(mime) ? 'mp4'
      : String(mime || '').startsWith('video/webm') ? 'webm' : 'mp4';
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}`
      + `-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  const safe = String(id || 'story').replace(/[^\w.-]+/g, '_');
  return `yuntu-${safe}-${stamp}.${ext}`;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0秒';
  const total = Math.round(ms / 100) / 10;
  const m = Math.floor(total / 60);
  return m ? `${m}分${(total - m * 60).toFixed(1)}秒` : `${total.toFixed(1)}秒`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0B';
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)}MB`;
  return `${Math.round(bytes / 1024)}KB`;
}

export const LONG_RECORDING_MS = 15 * 60 * 1000;
export const TRANSCODE_MAX_DIM = 854;
export const TRANSCODE_IDLE_TIMEOUT_MS = 120_000;

/* webm→mp4（Firefox 兜底）的转码参数。单线程 wasm 求稳不求快；
   scale 上限 maxDim 且宽取偶（-2 收尾，奇尺寸 yuv420p 必 fail）。 */
export function buildMp4Args(input, output, maxDim = 1920) {
  return ['-i', input,
    '-c:v', 'libx264', '-preset', 'veryfast',
    '-vf', `scale=min(${maxDim}\\,trunc(iw/2)*2):-2`,
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    output];
}

export class TranscodeAborted extends Error {
  constructor() {
    super('转码已取消');
    this.name = 'TranscodeAborted';
  }
}

/* —— 自动播放驱动 ——

   录制会话的「手」：轮询目标的最小接口（ended/shotEnd/choiceCount/
   advance/chooseFirst），遇选项停留 dwellMs 再选第一项，播完回调。
   计时器可注入，Node 单测用假钟跑满全流程。Player 的接线在
   playerTarget()；ended = playEnd && shotEnd（进末镜≠播完，末行打完才算，
   否则视频会切掉最后一行），choices 先于 ended 判——末镜是分支镜时
   playEnd 已置真但选项还等人选。 */
export class AutoDriver {
  constructor(target, {
    dwellMs = 2000,
    pollMs = 150,
    now = Date.now,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
    onChoice = null,
    onFinish = null,
  } = {}) {
    this.target = target;
    this.dwellMs = dwellMs;
    this.pollMs = pollMs;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.onChoice = onChoice;
    this.onFinish = onFinish;
    this.running = false;
    this.handle = null;
    this.choiceAt = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.choiceAt = null;
    this._tick();
  }

  stop() {
    this.running = false;
    if (this.handle !== null) {
      this.clearTimer(this.handle);
      this.handle = null;
    }
  }

  _tick() {
    if (!this.running) return;
    this.handle = null;
    const t = this.target;
    const choices = t.choiceCount();
    if (choices > 0) {
      if (this.choiceAt === null) {
        this.choiceAt = this.now();
        this.onChoice?.(choices);
      }
      if (this.now() - this.choiceAt >= this.dwellMs) {
        this.choiceAt = null;
        t.chooseFirst();
      }
    } else if (t.ended()) {
      this.running = false;
      this.onFinish?.();
      return;
    } else if (t.shotEnd()) {
      t.advance();
    }
    if (this.running) {
      this.handle = this.setTimer(() => this._tick(), this.pollMs);
    }
  }
}

/* Player → 驱动目标的适配。全走 Player 公开量（refs/playShot/playEnd，
   与 main.js 连播同口径）；选支走公开入口 chooseBranch。 */
export function playerTarget(player) {
  return {
    ended: () => !!player.playEnd && !!player.shotEnd,
    shotEnd: () => !!player.shotEnd,
    choiceCount: () => (player.refs.avgChoices.className
        ? player.refs.avgChoices.querySelectorAll('.avg-choice').length : 0),
    advance: () => player.playShot(),
    chooseFirst: () => player.chooseBranch(0),
  };
}

/* —— 采集质量监测 ——

   2px 隐形 video 吃采集流，requestVideoFrameCallback 逐帧计数得真实帧率；
   1s 窗口取最低值。media 可注入 fake（Node 单测）；rVFC 缺席的浏览器
   退化为只报尺寸（fps = null）。 */
export function createCaptureMonitor(media, {now = () => performance.now()} = {}) {
  const startedAt = now();
  let frames = 0;
  let minFps = Infinity;
  let windowStart = startedAt;
  let windowFrames = 0;
  let stopped = false;
  let handle = null;
  const loop = (ts) => {
    if (stopped) return;
    frames++;
    windowFrames++;
    if (ts - windowStart >= 1000) {
      minFps = Math.min(minFps, windowFrames * 1000 / (ts - windowStart));
      windowStart = ts;
      windowFrames = 0;
    }
    handle = media.requestVideoFrameCallback?.(loop) ?? null;
  };
  handle = media.requestVideoFrameCallback?.(loop) ?? null;
  media.play?.();
  const shape = (fpsFloor) => ({
    frames,
    avgFps: frames > 0 ? frames * 1000 / Math.max(1, now() - startedAt) : null,
    minFps: minFps === Infinity ? fpsFloor : minFps,
    width: media.videoWidth ?? null,
    height: media.videoHeight ?? null,
    durationMs: now() - startedAt,
  });
  return {
    live: () => shape(null),
    stop: () => {
      stopped = true;
      if (handle != null && media.cancelVideoFrameCallback) {
        media.cancelVideoFrameCallback(handle);
      }
      return shape(null);
    },
  };
}

/* —— 浏览器管线 —— */

/* ideal 约束：浏览器按窗口能力就近满足，拿不到不报错（实测报告里见真值）。 */
export async function requestTabCapture({audio = true, resolutionHeight = 1080,
  frameRate = 30} = {}) {
  if (!globalThis.navigator?.mediaDevices?.getDisplayMedia) {
    throw new Error('此浏览器不支持屏幕/标签页采集（getDisplayMedia）');
  }
  return navigator.mediaDevices.getDisplayMedia({
    video: {
      width: {ideal: resolutionWidth(resolutionHeight)},
      height: {ideal: resolutionHeight},
      frameRate: {ideal: frameRate},
    },
    audio: audio
        ? {echoCancellation: false, noiseSuppression: false, autoGainControl: false}
        : false,
    preferCurrentTab: true,
  });
}

/* Recorder 可注入（Node 单测喂 FakeRecorder）。MP4 不给 timeslice：
   整段一个 blob，落盘即文件；错误也把已有片段导出去（有总比没有强）。 */
export function startTabRecording(stream, settings,
    {Recorder = globalThis.MediaRecorder, now = Date.now} = {}) {
  if (!Recorder) throw new Error('此浏览器不支持 MediaRecorder');
  const mime = pickRecorderMimeType(
      (t) => Recorder.isTypeSupported?.(t) === true);
  const recorder = new Recorder(stream, {
    mimeType: mime || undefined,
    videoBitsPerSecond: settings.videoBitrate,
    audioBitsPerSecond: AUDIO_BITRATE,
  });
  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data?.size) chunks.push(e.data);
  };
  recorder.start();
  const startedAt = now();
  const result = () => ({
    blob: new Blob(chunks, {type: mime || 'video/webm'}),
    mime: mime || 'video/webm',
    durationMs: now() - startedAt,
  });
  const stop = () => new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(result());
    };
    recorder.onstop = finish;
    recorder.onerror = finish;
    if (recorder.state === 'inactive') finish();
    else recorder.stop();
  });
  return {recorder, mime: mime || 'video/webm', stop};
}

const FFMPEG_URLS = {
  lib: 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js',
  util: 'https://unpkg.com/@ffmpeg/util@0.12.1/dist/umd/index.js',
  coreJs: 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js',
  coreWasm: 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.wasm',
};

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`脚本加载失败：${src}`));
    document.head.append(el);
  });
}

/* ffmpeg.wasm 单例（约 31MB 内核，首次导出才拉）。进度/日志经模块级
   sink 转发——实例复用而监听器只挂一次，避免多次导出后监听器堆积。 */
let ffmpegPromise = null;
let ffmpegProgressSink = null;
let ffmpegLogSink = null;

async function loadFFmpeg() {
  ffmpegPromise ??= (async () => {
    await loadScript(FFMPEG_URLS.lib);
    await loadScript(FFMPEG_URLS.util);
    const {FFmpeg} = globalThis.FFmpegWASM ?? {};
    const {toBlobURL} = globalThis.FFmpegUtil ?? {};
    if (!FFmpeg || !toBlobURL) throw new Error('ffmpeg UMD 加载失败');
    const inst = new FFmpeg();
    inst.on('progress', (e) => ffmpegProgressSink?.(e));
    inst.on('log', (e) => ffmpegLogSink?.(e));
    await inst.load({
      coreURL: await toBlobURL(FFMPEG_URLS.coreJs, 'text/javascript'),
      wasmURL: await toBlobURL(FFMPEG_URLS.coreWasm, 'application/wasm'),
    });
    return inst;
  })();
  try {
    return await ffmpegPromise;
  } catch (error) {
    ffmpegPromise = null;   // 失败可重试（网络抖动等）
    throw error;
  }
}

/* webm → MP4。abort() 为真或内核长时间无心跳（idle 超时）时终止 wasm
   并抛 TranscodeAborted——宿主据此退回「直接导出原始 webm」的逃生门。
   ffmpegFactory 是单测注入点；进度推算靠 durationMs（webm 缺时长元数据，
   内核自报的 progress 恒 0，只能从 log 的 time= 现算）。 */
export async function webmToMp4(blob, {durationMs = 0, maxDim = 1920,
  onStage = null, onProgress = null, abort = null, ffmpegFactory = null} = {}) {
  let lastBeat = Date.now();
  let ffmpeg = null;
  try {
    onStage?.('加载 ffmpeg 内核（约 31MB，仅首次）…');
    ffmpeg = ffmpegFactory ? await ffmpegFactory() : await loadFFmpeg();
    if (abort?.()) throw new TranscodeAborted();
    lastBeat = Date.now();
    ffmpegProgressSink = (e) => {
      lastBeat = Date.now();
      const p = Number(e?.progress);
      if (Number.isFinite(p) && p > 0) onProgress?.(clamp(p, 0, 1));
    };
    ffmpegLogSink = ({message}) => {
      const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(message));
      if (m && durationMs > 0) {
        lastBeat = Date.now();
        const t = (+m[1] * 3600 + +m[2] * 60 + +m[3]) * 1000;
        onProgress?.(clamp(t / durationMs, 0, 1));
      }
    };
    onStage?.('写入样本…');
    await ffmpeg.writeFile('in.webm', new Uint8Array(await blob.arrayBuffer()));
    if (abort?.()) throw new TranscodeAborted();
    onStage?.('转码 H.264/AAC…');
    let idle = null;
    const watchdog = new Promise((_, reject) => {
      idle = setInterval(() => {
        if (Date.now() - lastBeat > TRANSCODE_IDLE_TIMEOUT_MS) {
          reject(new Error('转码超时（内核无响应）'));
        } else if (abort?.()) {
          reject(new TranscodeAborted());
        }
      }, 500);
    });
    try {
      await Promise.race([ffmpeg.exec(buildMp4Args('in.webm', 'out.mp4', maxDim)),
        watchdog]);
    } finally {
      clearInterval(idle);
    }
    if (abort?.()) throw new TranscodeAborted();
    const data = await ffmpeg.readFile('out.mp4');
    onProgress?.(1);
    return new Blob([data], {type: 'video/mp4'});
  } catch (error) {
    /* 中止/超时/失败都要把仍在跑的内核终止掉（exec 的挂起 promise 随之
       释放）；单例复用，正常完成路径绝不 terminate。 */
    await ffmpeg?.terminate?.().catch?.(() => {});
    if (error instanceof TranscodeAborted) throw error;
    throw new Error(`转码失败：${error?.message ?? error}`);
  } finally {
    ffmpegProgressSink = null;
    ffmpegLogSink = null;
    try {
      await ffmpeg?.deleteFile?.('in.webm');
      await ffmpeg?.deleteFile?.('out.mp4');
    } catch { /* 样本可能没写进去 */ }
  }
}

/* 隐形探针 video（不 display:none——那会停掉渲染管线，rVFC 不再逐帧来）。 */
function startCaptureMonitor(stream) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.className = 'recorder-probe';
  video.srcObject = stream;
  document.body.append(video);
  const monitor = createCaptureMonitor(video);
  return {
    live: monitor.live,
    stop: () => {
      const report = monitor.stop();
      video.srcObject = null;
      video.remove();
      report.hasAudio = stream.getAudioTracks().length > 0;
      return report;
    },
  };
}

const TAIL_MS = 1500;   // 播完后让末帧在视频里站一会儿再停机

const pollMsOf = (rate) => Math.max(30, Math.round(150 / rate));

/* —— 会话层：设置模态 + 录制编排 ——

   两种宿主形态：
   - 编辑器（index.html）：舞台平时嵌在预览栏里，开录时用 stageHostView
     把它搬进全屏黑底宿主——采集的是整个视口，编辑器外壳不能入镜；
   - 全屏播放页（record.html）：页面本身就是全屏舞台，不传视图钩子即可，
     会话只管采集/驱动/导出。 */

/* 编辑器会话的舞台出画。返回键名与 openRecorder 的注入参数对齐
   （...stageHostView(player) 即插即用）；enter 返回宿主元素
   （倒计时卡片挂它上面），exit 把舞台还回预览栏并清掉行内缩放。 */
export function stageHostView(player) {
  let host = null;
  let prevParent = null;
  const fit = () => {
    if (!host) return;
    const k = Math.min(globalThis.innerWidth / STAGE_WIDTH,
        globalThis.innerHeight / STAGE_HEIGHT);
    Object.assign(player.container.style, {
      transform: `scale(${k})`,
      transformOrigin: 'center center',
    });
  };
  return {
    enterRecordView() {
      prevParent = player.container.parentNode;
      player.clearStage();
      host = h('div.recorder-stage-host');
      host.append(player.container);
      document.body.append(host);
      Object.assign(player.container.style,
          {width: `${STAGE_WIDTH}px`, maxWidth: 'none'});
      fit();
      addEventListener('resize', fit);
      return host;
    },
    exitRecordView() {
      if (!host) return;
      removeEventListener('resize', fit);
      Object.assign(player.container.style, {
        width: '', maxWidth: '', transform: '', transformOrigin: '',
      });
      prevParent?.append(player.container);
      host.remove();
      host = null;
      prevParent = null;
    },
  };
}

export function openRecorder({
  player,
  getStory,                       // () => {story, title, sector}，开录瞬间取现值
  storyId = () => 'story',
  stopPreviewPlay = () => {},
  enterRecordView = null,         // 缺省 = 舞台不动（全屏播放页自己就是舞台）
  exitRecordView = null,
  afterRestore = () => {},        // 停机后的宿主复原（编辑器：预览落回原分镜）
  fullscreenHref = null,          // 提供则在模态栏挂「全屏播放页」按钮
  onPhase = () => {},             // requesting/countdown/recording/…（全屏页藏工具栏用）
} = {}) {
  if (document.querySelector('.recorder-stage-host')) return null;  // 会话进行中

  const overlay = h('div.picker-overlay');
  const box = h('div.picker-box.picker-story-box.recorder-box');
  const body = h('div.recorder-body');
  const bar = h('div.picker-bar',
      h('b', {text: '录制剧情视频'}),
      h('span.spacer'));
  if (fullscreenHref) {
    bar.append(h('button.tiny', {
      text: '全屏播放页',
      title: '整段语料的全屏回看/录制（不经编辑器）',
      onclick: () => window.open(fullscreenHref(), '_blank'),
    }));
  }
  bar.append(h('button.tiny', {text: '关闭', onclick: () => {
    if (phase === 'processing') transcodeAbort = true;
    overlay.remove();
  }}));
  box.append(bar, body);
  overlay.append(box);
  document.body.append(overlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      if (phase === 'processing') transcodeAbort = true;
      overlay.remove();
    }
  });

  let phase = 'idle';               // idle | requesting | countdown | recording | stopping | processing | done
  let transcodeAbort = false;
  const settings = sanitizeSettings(readStoredSettings());
  const setPhase = (p) => { phase = p; onPhase(p); };
  const enterView = enterRecordView ?? (() => null);
  const exitView = exitRecordView ?? (() => {});

  const capability = probeCapability();
  if (!capability.capture) {
    body.append(h('div.recorder-tip.bad', {
      text: '此浏览器不支持屏幕/标签页采集（getDisplayMedia），无法录制。'
          + '请使用桌面版 Chrome / Edge / Firefox。',
    }));
    return overlay;
  }
  showSettings();

  function probeCapability() {
    const capture = !!globalThis.navigator?.mediaDevices?.getDisplayMedia;
    const canRecord = typeof globalThis.MediaRecorder === 'function';
    const mime = canRecord
        ? pickRecorderMimeType((t) => globalThis.MediaRecorder.isTypeSupported(t))
        : '';
    return {capture, canRecord, mime, nativeMp4: isNativeMp4(mime)};
  }

  /* —— 设置表单 —— */

  function showSettings(note = null) {
    setPhase('idle');
    clear(body);
    if (note) body.append(h('div.recorder-tip.bad', {text: note}));
    body.append(h('div.recorder-tip', {
      text: '录制走浏览器标签页采集：点「开始录制」后在浏览器弹窗里选择'
          + '「本标签页」（Chrome/Edge 会自动预选）。确认后剧情从头自动播放，'
          + '遇选项停留片刻自动选第一项；播放结束或按 Esc 停止并导出。',
    }));

    const sel = (list, fmt) => h('select.recorder-select', {},
        ...list.map((v) => h('option', {value: String(v), text: fmt(v)})));
    const resSel = sel(RESOLUTION_HEIGHTS,
        (v) => v >= 2160 ? `4K（${resolutionWidth(v)}×${v}）`
            : `${v}p（${resolutionWidth(v)}×${v}）`);
    resSel.value = String(settings.resolutionHeight);
    resSel.onchange = () => settings.resolutionHeight = Number(resSel.value);

    const fpsSel = sel(FRAME_RATES, (v) => `${v} fps`);
    fpsSel.value = String(settings.frameRate);
    fpsSel.onchange = () => settings.frameRate = Number(fpsSel.value);

    const rateSel = sel(PLAYBACK_RATES, (v) => `${v}× 倍速`);
    rateSel.value = String(settings.playbackRate);
    rateSel.onchange = () => settings.playbackRate = Number(rateSel.value);

    const bitrateLabel = h('span.recorder-inline', {
      text: `${(settings.videoBitrate / 1e6).toFixed(1)} Mbps`,
    });
    const bitrate = h('input', {type: 'range', min: '1',
      max: String(BITRATE_MAX / 1e6), step: '1',
      value: String(settings.videoBitrate / 1e6)});
    bitrate.oninput = () => {
      settings.videoBitrate = Math.round(Number(bitrate.value) * 1e6);
      bitrateLabel.textContent = `${Number(bitrate.value).toFixed(1)} Mbps`;
    };

    const dwellLabel = h('span.recorder-inline', {
      text: `${(settings.dwellMs / 1000).toFixed(1)} 秒`,
    });
    const dwell = h('input', {type: 'range', min: '0.5', max: '10',
      step: '0.5', value: String(settings.dwellMs / 1000)});
    dwell.oninput = () => {
      settings.dwellMs = Math.round(Number(dwell.value) * 1000);
      dwellLabel.textContent = `${Number(dwell.value).toFixed(1)} 秒`;
    };

    const cdSel = sel(COUNTDOWN_CHOICES, (v) => (v ? `${v} 秒` : '不倒计时'));
    cdSel.value = String(settings.countdownSec);
    cdSel.onchange = () => settings.countdownSec = Number(cdSel.value);

    const audioCheck = h('input', {type: 'checkbox'});
    audioCheck.checked = settings.captureAudio;
    audioCheck.onchange = () => settings.captureAudio = audioCheck.checked;

    const row = (label, ...controls) => h('div.recorder-row',
        h('label', {text: label}), ...controls);
    body.append(
        row('分辨率', resSel),
        row('帧率', fpsSel),
        row('码率', bitrate, bitrateLabel),
        row('播放倍速', rateSel),
        row('选项停留', dwell, dwellLabel),
        row('开录倒计时', cdSel),
        h('label.recorder-row', {style: {cursor: 'pointer'}},
            audioCheck,
            h('span', {text: '采集标签页音频（BGM / CV 语音；需允许共享音频）'})),
    );

    body.append(h('div.recorder-cap', {
      text: capability.nativeMp4
          ? '本浏览器支持直录 MP4（H.264+AAC），录完即得文件。'
          : capability.canRecord
              ? '本浏览器将先录 WebM，停止后用 ffmpeg.wasm 转码成 MP4'
                  + '（首次需从 CDN 加载约 31MB 内核，可取消并直接导 WebM）。'
              : '此浏览器不支持 MediaRecorder，无法录制。',
      className: `recorder-cap ${capability.canRecord ? '' : 'bad'}`,
    }));
    const start = h('button', {
      text: '开始录制',
      disabled: capability.canRecord ? undefined : true,
      onclick: () => {
        storeSettings(settings);
        overlay.remove();
        runSession(sanitizeSettings(settings));
      },
    });
    body.append(h('div.recorder-row', h('span.spacer'), start));
  }

  /* —— 过程/结果视图 —— */

  function showProcessing(stage, progress) {
    setPhase('processing');
    clear(body);
    const label = h('div.recorder-tip', {
      text: stage ?? '转码中…',
    });
    const bar = h('div.recorder-progress',
        h('div.recorder-progress-fill', {
          style: {width: progress == null ? '30%' : `${Math.round(progress * 100)}%`},
        }));
    const percent = h('div.recorder-cap', {
      text: progress == null ? '进度未知（WebM 缺时长元数据，按画面时间推算）'
          : `${Math.round(progress * 100)}%`,
    });
    const cancel = h('button.tiny', {text: '取消转码，直接导 WebM',
      onclick: () => transcodeAbort = true});
    body.append(label, bar, percent, h('div.recorder-row', h('span.spacer'), cancel));
    document.body.append(overlay);
  }

  function showDone({name, size, durationMs, monitorReport, path, transcodeMs,
    reason = null}) {
    setPhase('done');
    clear(body);
    const cap = monitorReport ?? {};
    const fpsText = cap.avgFps != null
        ? `平均 ${cap.avgFps.toFixed(1)} fps`
            + (cap.minFps != null ? `（最低 ${cap.minFps.toFixed(1)}）` : '')
        : '帧率未知（浏览器不支持逐帧回调）';
    const under = cap.avgFps != null && cap.avgFps < settings.frameRate * 0.8;
    const rows = [
      ['文件', `${name}（${formatBytes(size)}）`],
      ['时长', formatDuration(durationMs)],
      ['画面', `请求 ${resolutionWidth(settings.resolutionHeight)}×`
          + `${settings.resolutionHeight} @ ${settings.frameRate}fps，`
          + `实测 ${cap.width ?? '?'}×${cap.height ?? '?'}，${fpsText}`],
      ['音轨', cap.hasAudio ? '已采集标签页音频' : '无音轨（未共享音频或浏览器不支持）'],
      ['编码', path === 'native' ? '浏览器直录 MP4（H.264+AAC）'
          : path === 'transcoded'
              ? `WebM → MP4（ffmpeg.wasm 转码 ${formatDuration(transcodeMs)}）`
              : `导出原始 WebM${reason ? `：${reason}` : ''}`],
    ];
    const grid = h('div.recorder-report');
    for (const [k, v] of rows) grid.append(h('b', {text: k}), h('span', {text: v}));
    body.append(grid);
    if (under) {
      body.append(h('div.recorder-tip.bad', {
        text: '实测帧率明显低于目标：建议把分辨率或帧率调低一档再录'
            + '（采集跟不上多发生在 1080p 高码率下）。',
      }));
    }
    body.append(h('div.recorder-tip', {text: '文件已触发下载（浏览器下载栏可见）。'}));
    body.append(h('div.recorder-row', h('span.spacer'),
        h('button', {text: '完成', onclick: () => overlay.remove()})));
    document.body.append(overlay);
  }

  /* —— 会话编排 ——

     编辑器形态先 enterView 把舞台出画到全屏宿主（倒计时卡片挂宿主上）；
     全屏页形态 enterView 是空操作，卡片直接挂 body。倒计时发生在
     MediaRecorder 起跑之前，不会进视频；录制期间页内零指示——舞台内
     的点击一律吞掉（capture 截停，防误触推进毁掉整段录像）。 */
  async function runSession(raw) {
    const first = getStory?.();
    if (!first?.story?.shots?.length) {
      document.body.append(overlay);
      showSettings('当前没有可录制的剧本');
      return;
    }
    const s = sanitizeSettings(raw);
    stopPreviewPlay();
    const savedRate = player.rate;
    const savedTitle = document.title;
    let driver = null;
    let monitor = null;
    let rec = null;
    let stream = null;
    let countdownAborted = false;
    let lastError = null;

    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (phase === 'recording') void finish();
      else if (phase === 'countdown') countdownAborted = true;
    };
    addEventListener('keydown', onKey, true);
    const swallow = (e) => {
      if (player.container.contains(e.target)) e.stopPropagation();
    };
    document.addEventListener('click', swallow, true);

    const cancelSession = (note) => {
      removeEventListener('keydown', onKey, true);
      document.removeEventListener('click', swallow, true);
      document.title = savedTitle;
      player.setRate(savedRate);
      exitView();
      monitor?.stop();
      stream?.getTracks().forEach((t) => t.stop());
      document.body.append(overlay);
      showSettings(note);
    };

    setPhase('requesting');
    const viewHost = enterView();
    try {
      stream = await requestTabCapture(s);
    } catch (error) {
      cancelSession(`未开始录制：${error.message}`);
      return;
    }
    stream.getVideoTracks().forEach((t) =>
        t.addEventListener('ended', () => {
          if (phase === 'recording') void finish();
          else if (phase === 'countdown') countdownAborted = true;
        }));

    monitor = startCaptureMonitor(stream);
    setPhase('countdown');
    const card = h('div.recorder-card',
        h('div.recorder-count', {text: String(Math.max(1, s.countdownSec))}),
        h('div.recorder-card-info', {text: '等待采集流…'}),
        h('div.recorder-tip', {
          text: '开始后剧情从头自动播放，本页全屏出画；Esc 结束录制并导出。',
        }),
        h('button.tiny', {text: '取消', onclick: () => countdownAborted = true}));
    (viewHost ?? document.body).append(card);
    const countEl = card.querySelector('.recorder-count');
    const infoEl = card.querySelector('.recorder-card-info');
    const infoTimer = setInterval(() => {
      const cap = monitor.live();
      infoEl.textContent = cap.width
          ? `实际采集 ${cap.width}×${cap.height} @ `
              + `${cap.avgFps != null ? cap.avgFps.toFixed(1) : '?'} fps`
          : '等待采集流…';
    }, 300);
    for (let left = s.countdownSec; left > 0 && !countdownAborted; left--) {
      countEl.textContent = String(left);
      await new Promise((r) => setTimeout(r, 1000));
    }
    clearInterval(infoTimer);
    card.remove();
    if (countdownAborted) {
      cancelSession('已取消录制');
      return;
    }

    setPhase('recording');
    rec = startTabRecording(stream, s);
    document.title = `● ${savedTitle}`;
    player.setRate(Math.max(1, s.playbackRate));
    const ctx = getStory();                       // 开录瞬间取 doc 现值
    player.setScene(serializeScript(ctx.story),
        ctx.title ?? ctx.story.title ?? '未命名', '1', ctx.sector ?? '', '');
    driver = new AutoDriver(playerTarget(player), {
      dwellMs: s.dwellMs,
      pollMs: pollMsOf(s.playbackRate),
      onFinish: () => setTimeout(() => void finish(), TAIL_MS),
    });
    driver.start();

    async function finish() {
      if (phase !== 'recording') return;
      setPhase('stopping');
      driver?.stop();
      const monitorReport = monitor ? monitor.stop() : null;
      document.title = savedTitle;
      let recorded = null;
      try {
        recorded = await rec.stop();
      } catch (error) {
        lastError = error.message;
      }
      stream.getTracks().forEach((t) => t.stop());
      removeEventListener('keydown', onKey, true);
      document.removeEventListener('click', swallow, true);
      exitView();
      player.setRate(savedRate);
      try {
        afterRestore();
      } catch { /* 宿主复原失败不挡导出 */ }
      if (!recorded || !recorded.blob.size) {
        document.body.append(overlay);
        showSettings(`录制失败：${lastError ?? '没有采集到任何画面'}`);
        return;
      }
      await exportRecorded(recorded, s, monitorReport);
    }

    async function exportRecorded(recorded, s, monitorReport) {
      const id = storyId() || 'story';
      if (isNativeMp4(recorded.mime)) {
        saveVideo(recorded.blob, recordingFilename(id, recorded.mime));
        showDone({name: recordingFilename(id, recorded.mime),
          size: recorded.blob.size, durationMs: recorded.durationMs,
          monitorReport, path: 'native'});
        return;
      }
      transcodeAbort = false;
      const maxDim = recorded.durationMs > LONG_RECORDING_MS
          ? TRANSCODE_MAX_DIM : resolutionWidth(s.resolutionHeight);
      const startedAt = Date.now();
      try {
        const mp4 = await webmToMp4(recorded.blob, {
          durationMs: recorded.durationMs,
          maxDim,
          onStage: (stage) => showProcessing(stage, null),
          onProgress: (p) => showProcessing(null, p),
          abort: () => transcodeAbort,
        });
        const name = recordingFilename(id, 'video/mp4');
        saveVideo(mp4, name);
        showDone({name, size: mp4.size, durationMs: recorded.durationMs,
          monitorReport, path: 'transcoded',
          transcodeMs: Date.now() - startedAt});
      } catch (error) {
        const reason = error instanceof TranscodeAborted
            ? '已取消转码' : error.message;
        const name = recordingFilename(id, recorded.mime);
        saveVideo(recorded.blob, name);
        showDone({name, size: recorded.blob.size,
          durationMs: recorded.durationMs, monitorReport,
          path: 'raw', reason});
      }
    }
  }
}

function saveVideo(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
