/* harness.js —— 自检页共用的观测件（M4 播放对拍 / M5 seek 对拍同源）。
   从 selftest-play.html 原样抽出：虚拟时钟、变更时间线、settle、snapshot。
   两套回归用**同一份**代码抓快照，字节级对拍才有意义。
   语义备忘（三条硬规则，各造成过一次整轮误报）：
   - CSS 过渡不吃虚拟钟，settle 末尾要真实等一手（最长 1s 的 left/filter）；
   - 时间线必须逐点击重置（startWindow），相位才是「本镜内」的相对时刻；
   - 画布采样盒按画布尺寸等比（48px 是 2048 上的值）。 */

export class VirtualTimer {
  constructor() {
    this.nowMs = 0;
    this.nextId = 1;
    this.jobs = new Map();
  }
  set(fn, ms) {
    const id = this.nextId++;
    this.jobs.set(id, {at: this.nowMs + Math.max(0, ms), fn});
    return id;
  }
  clear(id) { this.jobs.delete(id); }
  now() { return this.nowMs; }
  nextDelay() {
    let best = Infinity;
    for (const job of this.jobs.values()) best = Math.min(best, job.at - this.nowMs);
    return best;
  }
  /* 把 [now, now+ms] 内的定时任务按时刻跑完；任务回调里再挂的任务同窗内继续。
     每跑一个任务让出一轮微任务：await 链与 MutationObserver 投递都插得进来。 */
  async advance(ms) {
    const target = this.nowMs + ms;
    for (;;) {
      await Promise.resolve();
      let pick = null;
      for (const [id, job] of this.jobs) {
        if (job.at <= target && (!pick || job.at < pick.job.at)) pick = {id, job};
      }
      if (!pick) break;
      this.nowMs = pick.job.at;
      this.jobs.delete(pick.id);
      pick.job.fn();
    }
    this.nowMs = target;
  }
}

const PLAINER = document.createElement('div');
export function plain(html) {
  PLAINER.innerHTML = html;
  return PLAINER.textContent;
}

/* 变更时间线：只观察不改引擎。startWindow() = 逐镜重置相位原点。 */
export function createTimeline(container, clock) {
  const WATCH = new Set([
    'height-tester', 'avg-bg', 'avg-bg-overlay', 'avg-charas', 'avg-dialog',
    'avg-speaker', 'avg-line', 'avg-choices', 'avg-log-box', 'avg-overlay',
  ]);
  const events = [];
  let timelineFrom = 0;
  const observer = new MutationObserver((list) => {
    const at = clock.now();
    for (const record of list) {
      let node = record.target.nodeType === 1
          ? record.target : record.target.parentElement;
      while (node && !WATCH.has(node.id)) node = node.parentElement;
      events.push({
        at,
        where: node ? node.id : 'other',
        kind: record.type,
        attr: record.attributeName || null,
      });
    }
  });
  observer.observe(container, {
    childList: true, attributes: true, characterData: true, subtree: true,
  });
  const since = () => events.filter((e) => e.at >= timelineFrom);
  return {
    events,
    startWindow() {
      observer.takeRecords();
      events.length = 0;
      timelineFrom = clock.now();
    },
    since,
    at: (name, last = false) => {
      const hits = since().filter((e) => e.where === name);
      if (!hits.length) return null;
      return Math.round(((last ? hits[hits.length - 1] : hits[0]).at - timelineFrom) * 10) / 10;
    },
    atAttr: (name, attr) => {
      const hits = since().filter((e) => e.where === name && e.attr === attr);
      return hits.length
          ? Math.round((hits[hits.length - 1].at - timelineFrom) * 10) / 10 : null;
    },
    ticks: (name) => since().filter((e) => e.where === name).length,
  };
}

export function charaSignature(refs) {
  return [...refs.avgCharas.children]
      .map((el) => `${el.dataset.imgId}:${el.className}:${el.style.opacity}`).join('|');
}

export function readCanvas(canvas) {
  const context = canvas.getContext('2d');
  const samples = {};
  const spots = {face: [.5, .27], chest: [.5, .5], hem: [.5, .78]};
  for (const [key, [fx, fy]] of Object.entries(spots)) {
    /* 采样盒按画布尺寸等比（冻结件是 2048 上的 48px）——绝对 48px 在 1024
       画布上会覆盖两倍归一化区域，把 .78 以下的脚尖误判成墨水。 */
    const size = Math.round(48 * canvas.width / 2048);
    const data = context.getImageData(
        Math.round(canvas.width * fx - size / 2),
        Math.round(canvas.height * fy - size / 2), size, size).data;
    let ink = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 8) ink++;
    samples[key] = ink;
  }
  return {size: canvas.width, samples};
}

export function makeSnapshotter({player, timeline}) {
  const refs = player.refs;
  return function snapshot(shot, index, settleMs) {
    const bgStyle = getComputedStyle(refs.avgBg);
    return {
      shot: index,
      contentType: shot?.contentType ?? null,
      wire: {
        speakerName: shot?.speakerName ?? null,
        speakerHeroId: shot?.speakerHeroId ?? null,
        speakerHeroPosId: shot?.speakerHeroPosId ?? null,
        heroFace: shot?.heroFace ?? null,
        imgTween: shot?.imgTween ?? null,
        contentShake: shot?.contentShake ?? null,
        effect: shot?.effect ?? null,
        autoContinue: shot?.autoContinue ?? null,
        audio: shot?.audio ?? null,
      },
      class: {
        container: player.container.className,
        stage: refs.avgStage.className,
        dialog: refs.avgDialog.className,
        overlay: refs.avgOverlay.className,
        choices: refs.avgChoices.className,
        bgOverlay: refs.avgBgOverlay.className,
      },
      dialogMinHeight: refs.avgDialog.style.minHeight || null,
      lineMinHeight: refs.avgLine.style.minHeight || null,
      speaker: refs.avgSpeaker.innerHTML,
      lineHTML: refs.avgLine.innerHTML,
      lineText: refs.avgLine.textContent,
      bg: {
        image: bgStyle.backgroundImage,
        size: bgStyle.backgroundSize,
        position: bgStyle.backgroundPosition,
        opacity: refs.avgBg.style.opacity || null,
        transition: refs.avgBg.style.transition || null,
        overlayTransition: refs.avgBgOverlay.style.transition || null,
      },
      charas: [...refs.avgCharas.children].map((el) => {
        const style = getComputedStyle(el);
        const comm = el.children[1] ? getComputedStyle(el.children[1]) : null;
        return {
          imgId: el.dataset.imgId,
          posId: el.dataset.posId ?? null,
          cls: el.className,
          opacity: el.style.opacity || null,
          transition: el.style.transition || null,
          left: style.left, bottom: style.bottom,
          width: style.width, height: style.height,
          transform: style.transform,
          filter: style.filter,
          comm: comm && {
            left: comm.left, bottom: comm.bottom,
            width: comm.width, height: comm.height, transform: comm.transform,
          },
          canvas: readCanvas(el.children[0]),
        };
      }),
      choices: [...refs.avgChoices.children].map((el) =>
          ({text: el.textContent, jumpAct: el.dataset.jumpAct})),
      logEntries: refs.avgLogBox.children.length,
      phase: {
        dialogAt: timeline.at('avg-dialog'),
        dialogClassAt: timeline.atAttr('avg-dialog', 'class'),
        bgAt: timeline.at('avg-bg'),
        bgOverlayAt: timeline.at('avg-bg-overlay'),
        charaAt: timeline.at('avg-charas'),
        lineAt: timeline.at('avg-line'),
        lineEndAt: timeline.at('avg-line', true),
        lineTicks: timeline.ticks('avg-line'),
        heightTesterTicks: timeline.ticks('height-tester'),
        tweenHorizonMs: (shot?.imgTween?.length
            ? Math.max(...shot.imgTween.map((t) => t.delay + t.duration)) : 0) * 1000,
      },
      settleMs,
    };
  };
}

/* settle：打全 + 静止 + 尾巴（虚拟钟版）。label 只进问题文案。
   「打全」必须是硬条件：compose 链等 tween 的空档里 DOM 本来就静止，
   光看静止会在 tween 镜提前返回（M4 冻结期踩过）。 */
export function makeSettler({player, clock, problems}) {
  const refs = player.refs;
  return async function settle(shot, label = '?', lineBefore = null) {
    const pages = Array.isArray(shot?.content) && shot.content.length
        ? shot.content.map(plain) : null;
    const waitingBranch = !!shot?.branch;
    const start = clock.now();
    let previous = null;
    let same = 0;
    let done = false;
    let lastTyped = false;              /* 循环内变量的落定快照，供失败诊断 */
    for (let guard = 0; guard < 4000 && !done; guard++) {
      await player.idle();
      await clock.advance(TICK_MS);
      await player.idle();
      /* 分支镜进镜就清空台词行（无 contentType），它的「内容」就是选项本身 */
      const typed = !pages || player.container.classList.contains('empty')
          || (waitingBranch && refs.avgChoices.children.length > 0)
          || (refs.avgLine.innerHTML !== lineBefore
              && pages.includes(refs.avgLine.textContent));
      const current = [
        refs.avgLine.innerHTML, refs.avgDialog.className, refs.avgChoices.className,
        refs.avgOverlay.className, charaSignature(refs), refs.avgBg.style.opacity,
        refs.avgLogBox.children.length,
      ].join('\u0000');
      lastTyped = typed;
      same = current === previous ? same + 1 : 0;
      previous = current;
      /* 分支镜的 shotEnd 要等人选项才落：选项挂出即视为落定。 */
      const settled = player.shotEnd
          || (waitingBranch && refs.avgChoices.children.length);
      done = typed && settled && same >= STABLE_TICKS && clock.nextDelay() > 400;
    }
    if (!done) problems.push(`第 ${label} 镜虚拟钟内没打完`
        + `（shotEnd=${player.shotEnd} choices=${refs.avgChoices.children.length}`
        + ` branch=${!!waitingBranch} typed=${lastTyped} same=${same}`
        + ` nextDelay=${clock.nextDelay()}）`);
    await clock.advance(TRAIL_MS);
    await player.idle();
    /* CSS transition 走真实文档时间线、不吃虚拟钟：立绘的 left/filter 过渡
       最长 1s，不真实等一手，快照会抓到过渡中间值。 */
    await new Promise((r) => setTimeout(r, 1150));
    return Math.round(clock.now() - start);
  };
}

export const TICK_MS = 60;
export const STABLE_TICKS = 6;
export const TRAIL_MS = 700;
