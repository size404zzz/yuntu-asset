/* audio.js —— M7 音频引擎（净新增：参考包对 wire 里的 audio 字段零实现，
   见冻结结论「一批 wire 字段无人读」，所以这里没有需要逐位复刻的行为，
   语义按计划的验收项设计）：
   - bgm 交叉淡入淡出：同曲不重启；换曲时旧轨在 fadeIn 内淡出、新轨淡入；
     stop:true 用 fadeOut 淡出并停。bgm 循环播放。
   - sfx 不吞：每次触发独立发声，允许叠响，绝不掐断上一条。
   - 手势前静音 + 解锁续播：AudioContext 只在 unlock()（用户手势）里创建；
     之前收到的 bgm 记为待播并累计已流逝时间，解锁后从对应偏移续播
     （loop 曲目取模），sfx 在手势前直接丢弃（补放无意义）。
   - ctx / resolve 全部可注入：单测用 FakeCtx 跑纯 Node，不碰真音频。

   wire 形态（游戏导出）：shot.audio = {bgm?: {cue, sheet, fadeIn, fadeOut,
   stop}, sfx?: {cue, sheet}}。文件解析约定 sheet/cue → url，缺失即静默跳过
   （剧情不因缺音频而卡死），log 收口给编辑器提示。 */

const DEF_FADE = 1;

export class AudioEngine {
  constructor({resolve, ctxFactory = () => new AudioContext(), log = () => {}} = {}) {
    this.resolve = resolve;
    this.ctxFactory = ctxFactory;
    this.log = log;
    this.ctx = null;
    this.master = null;
    this.volume = 1;
    this.muted = false;
    this.bgm = null;              /* {key, source, gain, startedAt} */
    this.bgmGen = 0;              /* 换轨代际：解码中被顶替的旧轨不得再开播 */
    this.pendingBgm = null;       /* 手势前的 bgm 意图 {key, url, at} */
    this.bgmBuffers = new Map();  /* key → Promise<AudioBuffer> */
    this.activeSfx = new Set();
  }

  get unlocked() { return this.ctx !== null; }

  /* 用户手势里调用；解锁后按已流逝时间续播手势前登记的 bgm。 */
  unlock() {
    if (this.ctx) return;
    this.ctx = this.ctxFactory();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    this.master.connect(this.ctx.destination);
    const pending = this.pendingBgm;
    this.pendingBgm = null;
    if (pending) {
      const elapsed = (this._now() - pending.at) / 1000;
      this._startBgm(pending.key, pending.url, elapsed);
    }
  }

  /* 镜头进入：bgm 意图 + sfx 一次性。 */
  shot(shot) {
    const a = shot?.audio;
    if (!a) return;
    if (a.bgm) this.bgmCue(a.bgm);
    if (a.sfx) this.sfxCue(a.sfx);
  }

  /* seek 语义：只落 bgm 状态，不补放沿途 sfx。 */
  bgmOnly(shot) {
    const a = shot?.audio;
    if (a?.bgm) this.bgmCue(a.bgm);
  }

  bgmCue({cue, sheet, fadeIn = DEF_FADE, fadeOut = DEF_FADE, stop = false}) {
    const key = `${sheet}/${cue}`;
    if (stop) {
      this._fadeOutBgm(fadeOut);
      return;
    }
    if (!cue) return;
    const url = this.resolve(sheet, cue);
    if (!url) {
      this.log(`缺音频解析: ${key}`);
      return;
    }
    if (!this.ctx) {
      /* 手势前：只记最新意图，流逝时间照走，解锁后续播。 */
      this.pendingBgm = {key, url, at: this.pendingBgm?.at ?? this._now()};
      return;
    }
    if (this.bgm?.key === key) return;   /* 同曲不重启、不重置淡入 */
    const prev = this.bgm;
    if (prev) this._fadeOut(prev, fadeIn);
    this._startBgm(key, url, 0, fadeIn);
  }

  sfxCue({cue, sheet}) {
    if (!this.ctx || !cue) return;       /* 手势前丢弃；解锁后才有意义 */
    const url = this.resolve(sheet, cue);
    if (!url) {
      this.log(`缺音频解析: ${sheet}/${cue}`);
      return;
    }
    const ctx = this.ctx;
    this._buffer(url).then((buffer) => {
      if (!buffer || !this.ctx) return;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const gain = ctx.createGain();
      gain.gain.value = 1;
      source.connect(gain).connect(this.master);
      source.start();                    /* 叠响即叠响，谁也不掐谁 */
      source.onended = () => this.activeSfx.delete(source);
      this.activeSfx.add(source);
    }).catch(() => this.log(`sfx 解码失败: ${sheet}/${cue}`));
  }

  /* 场景退出：淡出 bgm，掐掉在响的 sfx。 */
  stopAll({fade = DEF_FADE} = {}) {
    this.pendingBgm = null;
    this._fadeOutBgm(fade);
    for (const source of this.activeSfx) {
      try { source.stop(); } catch { /* 已结束的忽略 */ }
    }
    this.activeSfx.clear();
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.master) this._ramp(this.master.gain, muted ? 0 : this.volume, 0.1);
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.master && !this.muted) this._ramp(this.master.gain, this.volume, 0.1);
  }

  _fadeOutBgm(fade) {
    this.bgmGen++;
    if (this.bgm) {
      this._fadeOut(this.bgm, fade);
      this.bgm = null;
    }
  }

  _fadeOut({source, gain}, seconds) {
    this._ramp(gain.gain, 0, seconds);
    try { source.stop(this.ctx.currentTime + seconds); } catch { /* noop */ }
    source.onended = null;
  }

  _startBgm(key, url, offset, fadeIn = 0) {
    const ctx = this.ctx;
    const gen = ++this.bgmGen;
    this._buffer(url).then((buffer) => {
      if (!buffer || !ctx || gen !== this.bgmGen) return;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      const gain = ctx.createGain();
      gain.gain.value = fadeIn > 0 ? 0 : 1;
      source.connect(gain).connect(this.master);
      if (fadeIn > 0) this._ramp(gain.gain, 1, fadeIn);
      const duration = buffer.duration || 0;
      const start = duration > 0 ? offset % duration : 0;
      source.start(0, start);
      this.bgm = {key, source, gain, startedAt: this._now() - offset * 1000};
    }).catch(() => this.log(`bgm 解码失败: ${key}`));
  }

  _ramp(param, to, seconds) {
    const t = this.ctx.currentTime;
    param.cancelScheduledValues(t);
    param.setValueAtTime(param.value, t);
    param.linearRampToValueAtTime(to, t + seconds);
  }

  _buffer(url) {
    if (!this.bgmBuffers.has(url)) {
      this.bgmBuffers.set(url, (async () => {
        const response = await fetch(url);
        if (!response.ok) return null;
        return this.ctx.decodeAudioData(await response.arrayBuffer());
      })().catch(() => null));
    }
    return this.bgmBuffers.get(url);
  }

  _now() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }
}

/* 默认解析约定：sheet/cue → data/audio/<sheet>/<cue>.ogg（M8 素材库落地后
   换成 IndexedDB 里的用户上传映射）。 */
export function defaultAudioResolve(sheet, cue) {
  return `data/audio/${sheet}/${cue}.ogg`;
}
