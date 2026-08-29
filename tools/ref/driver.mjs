/**
 * 参考行为冻结驱动器：跑未改动的 AvgPlayer.js，逐镜抓 settled state + phase 时序。
 *
 * scene1 是线性数组、无 branch/nextId、每镜至多一页、4 个无台词镜正好是 4 个
 * autoContinue 镜（播完立刻 0ms 续下一镜）—— 所以观测点用「回廊条数」定位，
 * 天然跳过那些来不及看的中间镜。pointer 由驱动器按参考 playShot 的算术自算，
 * 不引用本仓库任何模块，避免 oracle 和被测实现互相污染。
 */
import {setScene, handleStageClick, clearStage} from './AvgPlayer.js';
import {initialize, nounDes} from './NounDes.js';

/* 参考引擎自带 console.log(avgScene)，53 个对象会刷满日志。
   只掐日志，不碰任何行为。 */
console.log = () => {};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const params = new URLSearchParams(location.search);
/* 参考引擎内部抛异常会让整轮静默卡住，必须把错误捞进结果里。 */
const pageErrors = [];
addEventListener('error', (event) => pageErrors.push(
    `${event.message} @ ${event.filename}:${event.lineno}`));
addEventListener('unhandledrejection', (event) => pageErrors.push(
    `rejection: ${event.reason?.message || event.reason}`));
const SCENE = params.get('scene') || 'scene1';
/* slug 覆盖：max 截停跑（像素比对用）不许踩全量冻结件。 */
const SLUG = params.get('slug') || SCENE;
const STABLE_TICKS = 6;
const TICK_MS = 60;
/* 打完字再等 700ms：type5 的 fade-out 在 500ms 才挂上，不等就会抖。 */
const TRAIL_MS = 700;
const TRACE = params.get('trace') === '1';
/* live=1：每镜落盘一次，用于定位「跑到第 N 镜就再没动静」这类停滞。 */
const LIVE = params.get('live') === '1';

function dashToCamel(dash) {
  return dash.replace(/-(\w)/g, (_, char) => char.toUpperCase());
}

/* --- blk04.script 的引导部分（移动端/全屏/resize 与本题无关，不搬） --- */
window.getName = () => '教授';
window.getGender = () => 'TA';
window.getFilePath = (fileName) =>
    '/images/' + fileName[0].toUpperCase() + fileName.slice(1);
window.charaImgStyles = document.getElementById('chara-img-styles');
window.avgContainer = document.getElementById('avg-container');
const avgContainer = window.avgContainer;
avgContainer.classList.add('empty');
for (const elem of avgContainer.querySelectorAll('[id]')) {
  window[dashToCamel(elem.id)] = elem;
}
window.avgCharacters =
    await (await fetch('/images/Avg_character.json')).json();
initialize();
for (let guard = 600; guard-- && !Object.keys(nounDes).length; ) await sleep(20);

/* --- 变更时间线：只观察，不改引擎 --- */
const WATCH = new Set([
  'height-tester', 'avg-bg', 'avg-bg-overlay', 'avg-charas', 'avg-dialog',
  'avg-speaker', 'avg-line', 'avg-choices', 'avg-log-box', 'avg-overlay',
]);
const events = [];
let timelineFrom = 0;
const observer = new MutationObserver((list) => {
  const at = performance.now();
  for (const record of list) {
    let node = record.target.nodeType === 1
        ? record.target : record.target.parentElement;
    while (node && !WATCH.has(node.id)) node = node.parentElement;
    events.push({
      at,
      where: node ? node.id : 'other',
      kind: record.type,
      attr: record.attributeName || null,
      target: (record.target.id || record.target.className
          || record.target.nodeName),
    });
  }
});
observer.observe(avgContainer, {
  childList: true, attributes: true, characterData: true, subtree: true,
});

const sinceTimeline = () => events.filter((event) => event.at >= timelineFrom);
const at = (name, last = false) => {
  const hits = sinceTimeline().filter((event) => event.where === name);
  if (!hits.length) return null;
  return Math.round(((last ? hits[hits.length - 1] : hits[0]).at - timelineFrom) * 10) / 10;
};
const atAttr = (name, attr) => {
  const hits = sinceTimeline()
      .filter((event) => event.where === name && event.attr === attr);
  return hits.length
      ? Math.round((hits[hits.length - 1].at - timelineFrom) * 10) / 10 : null;
};
const ticks = (name) =>
    sinceTimeline().filter((event) => event.where === name).length;

function charaSignature() {
  return [...avgCharas.children]
      .map((el) => `${el.dataset.imgId}:${el.className}:${el.style.opacity}`).join('|');
}

const PLAINER = document.createElement('div');
const plain = (html) => {
  PLAINER.innerHTML = html;
  return PLAINER.textContent;
};

/**
 * 等到「本镜文案已打全 + DOM 静止」。
 *
 * 光看静止会出错：composeAsync 让 speak 等完本镜所有 tween，那段空档里 DOM
 * 本来就纹丝不动，实测在第 7 镜提前返回（快照只剩 9 个字），下一次点击被
 * readLine 的 interrupt 分支吃掉，整轮就此卡死。所以内容镜必须以
 * 「#avg-line 的纯文本 == 某一页全文」为硬条件。
 */
async function settle(shot, lineBefore) {
  const pages = Array.isArray(shot?.content) && shot.content.length
      ? shot.content.map(plain) : null;
  const horizon = shot?.imgTween?.length
      ? Math.max(0, ...shot.imgTween.map((t) => t.delay + t.duration)) : 0;
  const floor = performance.now() + horizon * 1000 + STABLE_TICKS * TICK_MS;
  const start = performance.now();
  let previous = null;
  let same = 0;
  for (let guard = 0; guard < 150; guard++) {
    await sleep(TICK_MS);
    const typed = !pages || avgContainer.classList.contains('empty')
        || (avgLine.innerHTML !== lineBefore && pages.includes(avgLine.textContent));
    const current = [
      avgLine.innerHTML, avgDialog.className, avgChoices.className,
      avgOverlay.className, charaSignature(), avgBg.style.opacity,
      avgLogBox.children.length,
    ].join('\u0000');
    same = current === previous ? same + 1 : 0;
    previous = current;
    if (typed && same >= STABLE_TICKS && performance.now() > floor) {
      await sleep(TRAIL_MS);
      return {settled: true, waitedMs: Math.round(performance.now() - start)};
    }
  }
  return {settled: false, waitedMs: Math.round(performance.now() - start)};
}

function readCanvas(canvas) {
  const context = canvas.getContext('2d');
  const samples = {};
  const spots = {face: [.5, .27], chest: [.5, .5], hem: [.5, .78]};
  for (const [key, [fx, fy]] of Object.entries(spots)) {
    try {
      const size = 48;
      const data = context.getImageData(
          Math.round(canvas.width * fx - size / 2),
          Math.round(canvas.height * fy - size / 2), size, size).data;
      let ink = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 8) ink++;
      samples[key] = ink;
    } catch (error) {
      samples[key] = 'TAINTED';
    }
  }
  return {size: canvas.width, samples};
}

function snapshot(shot, index) {
  const bgStyle = getComputedStyle(avgBg);
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
      container: avgContainer.className,
      stage: avgStage.className,
      dialog: avgDialog.className,
      overlay: avgOverlay.className,
      choices: avgChoices.className,
      bgOverlay: avgBgOverlay.className,
    },
    dialogMinHeight: avgDialog.style.minHeight || null,
    lineMinHeight: avgLine.style.minHeight || null,
    speaker: avgSpeaker.innerHTML,
    lineHTML: avgLine.innerHTML,
    lineText: avgLine.textContent,
    bg: {
      image: bgStyle.backgroundImage,
      size: bgStyle.backgroundSize,
      position: bgStyle.backgroundPosition,
      opacity: avgBg.style.opacity || null,
      transition: avgBg.style.transition || null,
      overlayTransition: avgBgOverlay.style.transition || null,
    },
    charas: [...avgCharas.children].map((el) => {
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
    choices: [...avgChoices.children].map((el) =>
        ({text: el.textContent, jumpAct: el.dataset.jumpAct})),
    logEntries: avgLogBox.children.length,
    trace: TRACE ? sinceTimeline().slice(0, 60).map((event) => ({
      t: Math.round((event.at - timelineFrom) * 10) / 10,
      w: event.where, k: event.kind, a: event.attr, n: event.target,
    })) : undefined,
    phase: {
      dialogAt: at('avg-dialog'),
      dialogClassAt: atAttr('avg-dialog', 'class'),
      bgAt: at('avg-bg'),
      bgOverlayAt: at('avg-bg-overlay'),
      charaAt: at('avg-charas'),
      lineAt: at('avg-line'),
      lineEndAt: at('avg-line', true),
      lineTicks: ticks('avg-line'),
      heightTesterTicks: ticks('height-tester'),
      tweenHorizonMs: (shot?.imgTween?.length
          ? Math.max(...shot.imgTween.map((t) => t.delay + t.duration)) : 0) * 1000,
    },
  };
}

/* --- 开跑 --- */
const scene = await (await fetch(`/data/fixtures/${SCENE}.json`)).json();
const contentOrder = scene.map((shot, i) => (shot.content ? i : -1)).filter(i => i >= 0);
clearStage();
setScene(scene, params.get('title') || '临危受命',
    params.get('number') || '1', params.get('sector') || '绿洲防线', '');
avgContainer.addEventListener('click', handleStageClick);

const header = {
  skipTitle: avgSkipTitle.textContent,
  sectorLocation: avgSectorLocation.textContent,
  sectorEn: avgSectorEn.textContent,
  sceneBrief: avgSceneBrief.textContent,
};

const shots = [];
const problems = [];
let DONE = false;
let logNow = null;
let rulesNow = null;
const readLog = () => [...avgLogBox.children].map((div) => ({
  speaker: div.children[0].innerHTML,
  lines: [...div.children[1].children].map((p) => p.innerHTML),
}));
let seen = 0;
let lastLanded = null;
/* 落点指针：照参考 playShot 的推进算术自算（nextId 优先、+1 兜底、
   无内容 autoContinue 镜链式穿过）。contentOrder[before] 的线性模型
   遇到 nextId 跳转就会错位（scene4 实测踩中）。 */
const ST = Array.isArray(scene) ? -1 : 0;
let pointer = ST;
/* 窥探式：只算不提交——翻页点击不该推进指针，回廊确认增长后才落定。 */
function nextFrom(p) {
  for (let guard = 400; guard--; ) {
    const shot = scene[p];
    p = shot?.nextId != null ? Number(shot.nextId) + ST : p + 1;
    const nxt = scene[p];
    if (!nxt || nxt.content || nxt.branch || !nxt.autoContinue) break;
  }
  return p;
}
const MAX = Number(params.get('max') || 0);
for (let click = 0; click < 120; click++) {
  observer.takeRecords();
  events.length = 0;
  timelineFrom = performance.now();
  const before = avgLogBox.children.length;
  const lineBefore = avgLine.innerHTML;
  const guess = nextFrom(pointer);
  avgContainer.click();
  /* settle 判据 = 「行文本离开点击值 且 ∈ 下一内容镜∪上一落点的页」——
     纯并集会在 manageImg 串行门里被旧文案误判，纯点后立即看日志会被
     无内容镜的 1s 串行门链骗过（两个坑都实测踩过）；分类放到 settle 后。 */
  const status = await settle({
    content: [...(scene[guess]?.content ?? []),
      ...(lastLanded == null ? [] : scene[lastLanded]?.content ?? [])],
  }, lineBefore);
  /* clearStage 会同时掏空 #avg-log-box（L400）与 charaImgStyles.innerText（L438），
     而「本镜打完 + 已 playEnd」的判定要等下一次点击才成立 ——
     回廊与立绘规则表都必须趁还完整时各留一份，且不能被清空后的那一轮覆盖。 */
  if (!avgContainer.classList.contains('empty')) {
    if (avgLogBox.children.length) logNow = readLog();
    rulesNow = charaImgStyles.innerText || rulesNow;
  }
  if (!status.settled) {
    problems.push(`第 ${landed} 镜 ${status.waitedMs}ms 内没打完`
        + ` dialog=${JSON.stringify(avgDialog.className)}`
        + ` line=${JSON.stringify(avgLine.textContent.slice(-24))}`
        + ` ticks=${ticks('avg-line')}`);
  }
  if (avgContainer.classList.contains('empty')) {
    shots.push({shot: null, endOfScene: true, click, phase: {}});
    break;
  }
  const after = avgLogBox.children.length;
  let landed;
  if (after > before) { landed = guess; pointer = guess; }
  else if (avgLine.innerHTML !== lineBefore) landed = lastLanded;   // 翻页：指针不动
  else landed = null;
  if (landed == null) {
    problems.push(`第 ${click} 次点击既没涨回廊也没翻页（before=${before} after=${after}）`
        + ` dialog=${JSON.stringify(avgDialog.className)}`
        + ` line=${JSON.stringify(avgLine.innerHTML.slice(-24))}`
        + ` charas=${avgCharas.children.length} choices=${JSON.stringify(avgChoices.className)}`
        + ` container=${JSON.stringify(avgContainer.className)}`);
    break;
  }
  shots.push(Object.assign(snapshot(scene[landed], landed),
      {settleMs: status.waitedMs}));
  seen++;
  lastLanded = landed;
  if (LIVE) {
    console.info(`live ${seen}/${contentOrder.length} shot=${contentOrder[after - 1]}`
        + ` settle=${status.waitedMs}ms settled=${status.settled}`);
    await post();
  }
  if (after > before + 1) {
    problems.push(`第 ${click} 次点击一次推进了 ${after - before} 镜`);
  }
  if (MAX && seen >= MAX) break;
}

function buildPayload() {
  return {
    meta: {
      scene: SCENE,
      oracle: 'wiki.42lab.cloud MediaWiki:Gadget-AvgPlayer.js（逐字节，仅 import 路径本地化）',
      ua: navigator.userAgent,
      viewport: {
        screen: [screen.width, screen.height],
        inner: [innerWidth, innerHeight],
        client: [document.documentElement.clientWidth,
                 document.documentElement.clientHeight],
        offset: [document.documentElement.offsetWidth,
                 document.documentElement.offsetHeight],
        dpr: devicePixelRatio,
        body: getComputedStyle(document.body).width,
        containerInline: avgContainer.style.width || null,
      },
      stage: {
        width: avgContainer.clientWidth,
        height: avgContainer.clientHeight,
        fontSize: getComputedStyle(avgContainer).fontSize,
      },
      dialogWidthPx: getComputedStyle(avgDialog).width,
      charaStageWidthPx: avgCharas.clientWidth,
      capturedAt: new Date().toISOString(),
    },
    header,
    shots,
    log: logNow || readLog(),
    charaRules: rulesNow ?? charaImgStyles.innerText,
    problems,
    pageErrors,
    summary: {
      contentShots: contentOrder.length,
      observed: seen,
      done: DONE,
      endOfScene: shots.some((s) => s.endOfScene),
      typeStartDelays: shots.filter((s) => !s.endOfScene)
          .map((s) => s.phase.lineAt),
    },
  };
}

async function post() {
  await fetch(`/freeze?scene=${SLUG}`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(buildPayload(), null, 1),
  });
}

DONE = true;
await post();
document.title = 'freeze-done';
console.info('freeze posted', seen, 'shots', problems);
