/* scheduler.js —— epoch 计时器。engine/* 禁止裸 setTimeout：
   每次 seek/编辑失效/重开都先 bump()，旧 epoch 的回调自动哑火，
   「跳到第 N 镜预览」与「编辑后预览不干净」这类问题从根上不存在。
   timer 可注入：真实播放用 REAL_TIMER，回归测试用虚拟时钟逐毫秒推进。

   after() 同时把任务登记进 jobs 表（handle → {at, seq, fn}），于是
   flush() 能把挂着的等待按「注册时刻 + 先后」瞬间跑完 —— seek/fastForward
   的「不真等」就是它：时间坍缩，但回调顺序与真实播放逐位一致。
   flush 前先 timer.clear，任务不会在排干之后又被真实钟再发一次。 */

export const REAL_TIMER = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle),
  now: () => performance.now(),
};

export class Scheduler {
  constructor(timer = REAL_TIMER) {
    this.timer = timer;
    this.epoch = 0;
    this.jobs = new Map();
    this.seq = 0;
    /* 倍速：>1 时所有挂起时长按比例压缩（10 = 只等十分之一）。只管 JS 定时，
       CSS 过渡与 WAAPI 走真实文档时间线、不吃这份钟。默认 1 = 与参考逐位一致。 */
    this.rate = 1;
  }

  bump() {
    this.jobs.clear();
    return ++this.epoch;
  }

  /* 回调只在注册时的 epoch 仍然有效时执行。返回句柄供 clear。
     时长按注册当下的 rate 压缩（at 用压缩后的值，flush 的次序判据
     才和真实定时一致；rate 中途改了也不影响已挂起的任务）。 */
  after(ms, fn) {
    const born = this.epoch;
    const seq = this.seq++;
    const delay = Math.max(0, ms) / (this.rate || 1);
    let handle;
    const wrapped = () => {
      this.jobs.delete(handle);
      if (born === this.epoch) fn();
    };
    handle = this.timer.set(wrapped, delay);
    this.jobs.set(handle, {at: this.now() + delay, seq, fn: wrapped});
    return handle;
  }

  /* 可等待的 after。epoch 失效后永不 resolve —— 串行链里的陈旧 await
     就此停摆，不会拿着旧上下文继续写 DOM。 */
  promise(ms) {
    return new Promise((resolve) => this.after(ms, resolve));
  }

  clear(handle) {
    this.jobs.delete(handle);
    this.timer.clear(handle);
  }

  now() {
    return this.timer.now();
  }

  pending() {
    return this.jobs.size;
  }

  /* 把当前登记的任务按 (at, seq) 跑完一轮。跑的过程中新挂的任务进下一轮
     （fastForward 的循环负责追），中途被 clear 掉的跳过。 */
  flush() {
    const batch = [...this.jobs.entries()]
        .sort((a, b) => a[1].at - b[1].at || a[1].seq - b[1].seq);
    for (const [handle, job] of batch) {
      if (!this.jobs.has(handle)) continue;
      this.jobs.delete(handle);
      this.timer.clear(handle);
      job.fn();
    }
  }
}
