/**
 * M6 UI 行为冻结驱动器：同样跑未改动的 AvgPlayer.js + NounDes.js，
 * 但驱动的是「交互脚本路径」——面板开关、回廊词典、自动播放、跳过、
 * hide-ui、分支选择（scene2）——每一步抓一份 uiState 落盘成
 * expected-ui_sceneN.json（slug 走下划线：serve.py 白名单不放连字符）。
 * 播放主线的逐镜冻结在 driver.mjs，互不影响。
 *
 * 确定性设计（第一版踩过的坑）：
 * - uiState 只读类名/文本/条数/面板可见性，不读计算几何与内联样式——
 *   那些已被 M4 逐镜冻结覆盖，这里对拍的是交互因果，不是渲染；
 * - 「稳定」必须叠加「文案打全」判据（行文本 ∈ 全部页文本 ∪ ''）：
 *   纯签名稳定会在 manageImg 串行门的安静窗里提前收工，抓到半打字态；
 * - 只翻转 class/文本的同步动作（开关面板、点词条、hide-ui…）用
 *   mode='now' 立即抓拍，不等空闲——自动播放的 1s/2s 定时器与真实钟
 *   赛跑，任何「等空闲再抓」都会把下一步的推进吞进本步。
 */
import {setScene, handleStageClick} from './AvgPlayer.js';
import {initialize, nounDes} from './NounDes.js';

console.log = () => {};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const params = new URLSearchParams(location.search);
const pageErrors = [];
addEventListener('error', (e) => pageErrors.push(`${e.message} @ ${e.filename}:${e.lineno}`));
addEventListener('unhandledrejection', (e) => pageErrors.push(
    `rejection: ${e.reason?.message || e.reason}\n${e.reason?.stack || ''}`));

const SCENE = params.get('scene') || 'scene1';
const TITLES = {scene1: '临危受命', scene2: '背水一战', scene3: '绝处逢生'};
const TICK_MS = 60;
const STABLE_TICKS = 6;

function dashToCamel(dash) {
  return dash.replace(/-(\w)/g, (_, c) => c.toUpperCase());
}

window.getName = () => '教授';
window.getGender = () => 'TA';
window.getFilePath = (fileName) =>
    '/images/' + fileName[0].toUpperCase() + fileName.slice(1);
window.charaImgStyles = document.getElementById('chara-img-styles');
window.avgContainer = document.getElementById('avg-container');
for (const elem of avgContainer.querySelectorAll('[id]')) {
  window[dashToCamel(elem.id)] = elem;
}
window.avgCharacters = await (await fetch('/images/Avg_character.json')).json();
initialize();
for (let guard = 600; guard-- && !Object.keys(nounDes).length; ) await sleep(20);

avgContainer.addEventListener('click', handleStageClick);

const scene = await (await fetch(`/data/fixtures/${SCENE}.json`)).json();
setScene(scene, TITLES[SCENE] || SCENE, '1', '绿洲防线', '');
/* setScene 把 content 原地格式化成分页数组——判据表在这之后取。 */
const allPages = new Set(['']);
for (const shot of Object.values(scene)) {
  for (const page of [...(shot.content || [])]) {
    allPages.add(new DOMParser().parseFromString(page, 'text/html').body.textContent);
  }
}

const PLAIN = (html) => new DOMParser().parseFromString(html, 'text/html').body.textContent;
const sig = () => [
  avgLine.innerHTML, avgDialog.className, avgOverlay.className,
  avgChoices.className, avgLogBox.children.length, avgContainer.className,
  avgPandect.className, avgDes.className, avgDesDt.textContent,
  avgControlAuto.className,
].join('\u0000');

/* 两段式落点（夹具实测：串行门 ≤1.8s、无多页、自动重挂 2000ms）：
   第一段等新镜首字（越过 manageImg 串行门的「旧文案完全安静」假稳窗），
   第二段等「签名稳 6 tick 且行文本 ∈ 页文案」（清空态也认）。
   打完字后 ~550ms 即抓拍，和 2000ms 自动重挂之间留 1.45s 安全边距。 */
const typedNow = () => {
  const html = avgLine.innerHTML;
  return html === '' || allPages.has(PLAIN(html));
};

async function waitIdle() {
  const entry = avgLine.innerHTML;
  for (let guard = 50; guard--; ) {
    await sleep(TICK_MS);
    if (avgLine.innerHTML !== entry) break;
  }
  let previous = null;
  let same = 0;
  for (let guard = 500; guard--; ) {
    await sleep(TICK_MS);
    const current = sig();
    same = current === previous ? same + 1 : 0;
    previous = current;
    if (same >= STABLE_TICKS && typedNow()) break;
  }
  await sleep(150);
}

async function waitLineChange(before) {
  for (let guard = 500; guard--; ) {
    await sleep(TICK_MS);
    if (avgLine.innerHTML !== before) break;
  }
  await waitIdle();
}

const uiState = () => ({
  container: avgContainer.className,
  stage: avgStage.className,
  overlay: avgOverlay.className,
  pandect: avgPandect.className,
  dialog: avgDialog.className,
  speaker: avgSpeaker.innerHTML,
  lineHTML: avgLine.innerHTML,
  choicesClass: avgChoices.className,
  choices: [...avgChoices.children].map((el) =>
      ({text: el.textContent, jumpAct: el.dataset.jumpAct})),
  autoClass: avgControlAuto.className,
  logCount: avgLogBox.children.length,
  logTail: avgLogBox.lastElementChild?.innerHTML ?? null,
  desClass: avgDes.className,
  desId: avgDes.dataset.id ?? null,
  desDt: avgDesDt.textContent,
  desDd: avgDesDd.textContent.slice(0, 40),
  expandText: avgDesExpand.textContent,
  desTypes: [...avgDesType.children].map(
      (li) => li.textContent + (li.className ? '*' : '')),
  entriesCount: avgDesEntries.children.length,
  entriesHead: [...avgDesEntries.children].slice(0, 5).map(
      (li) => li.textContent + (li.className ? '*' : '')),
  entriesScrollTop: Math.round(avgDesEntries.scrollTop),
  logVisible: getComputedStyle(avgLog).display,
  pandectVisible: getComputedStyle(avgPandect).display,
  skipVisible: getComputedStyle(avgSkip).display,
});

const problems = [];
const steps = [];
async function step(name, action, mode = 'idle') {
  if (action) await action();
  if (mode === 'idle') await waitIdle();
  steps.push({name, state: uiState()});
}
async function clickUntil(name, cond, cap = 80) {
  for (let guard = cap; guard--; ) {
    if (cond()) return void steps.push({name, state: uiState()});
    avgContainer.click();
    await waitIdle();
  }
  problems.push(`${name}: ${cap} 次点击内条件没成立`);
  steps.push({name, state: uiState()});
}
const lineHasRef = () => !!avgLine.querySelector('[data-ref]');
const choicesShown = (n) => () => avgChoices.children.length === n;

async function dictRoundTrip(refStep) {
  await step('ref-show', () => avgLine.querySelector('[data-ref]').click(), 'now');
  await step('des-return', () => avgDesReturn.click(), 'now');
  await step('backdrop-close', () => avgPandect.click(), 'now');
}

async function scene1Script() {
  await step('boot', null, 'now');
  await step('shot1', () => avgContainer.click());
  await step('log-open', () => avgControlLog.click(), 'now');
  await step('play-through-log', () => avgContainer.click());
  await step('dict-open', () => avgControlDict.click(), 'now');
  await step('type-hero', () => avgDesType.children[3].click(), 'now');
  await step('entry-click', () => avgDesEntries.children[2].click(), 'now');
  await step('backdrop-close', () => avgPandect.click(), 'now');
  await clickUntil('at-ref', lineHasRef);
  await dictRoundTrip();
  await step('expand-toggle', () => avgDesExpand.click(), 'now');
  await step('backdrop-close-2', () => avgPandect.click(), 'now');
  await step('hide-on', () => avgControlHideUi.click(), 'now');
  await step('hide-restore', () => avgContainer.click(), 'now');
  await step('auto-enable', () => avgControlAuto.click(), 'now');
  /* waitLineChange 自带落定，这里必须 'now'，否则第二次 waitIdle 会
     干等过 2000ms 重挂、把抓拍推到下一镜打完（+2 跳镜的根因）。 */
  await step('auto-tick1', () => waitLineChange(avgLine.innerHTML), 'now');
  await step('auto-tick2', () => waitLineChange(avgLine.innerHTML), 'now');
  /* 'now' 抓拍会撞上两条 compose 链微任务跳数的差异（参考 .then 链 vs
     我们的 async 函数），统一落 idle：点进的镜打全即抓，距下次自动
     重挂还有 ~1.5s 安全边距。 */
  await step('auto-click-cancel', () => avgContainer.click());
  await step('auto-tick3', () => waitLineChange(avgLine.innerHTML), 'now');
  await step('auto-off', () => avgControlAuto.click(), 'now');
  await step('auto-quiet', () => sleep(3200), 'now');
  await step('skip-open', () => avgControlSkip.click(), 'now');
  await step('skip-confirm', () => avgSkipConfirm.click());
  await step('skip-cancel', () => avgSkipCancel.click());
}

async function scene2Script() {
  await step('boot', null, 'now');
  await clickUntil('branch-8', choicesShown(2));
  await step('choose-2', () => avgChoices.children[1].click());
  await clickUntil('at-ref', lineHasRef);
  await dictRoundTrip();
  await clickUntil('branch-37', choicesShown(3));
  await step('choose-3', () => avgChoices.children[2].click());
  await clickUntil('is-end', () => avgContainer.classList.contains('empty'));
}

if (SCENE === 'scene2') await scene2Script();
else await scene1Script();

const payload = {
  meta: {
    scene: SCENE,
    oracle: 'wiki.42lab.cloud AvgPlayer.js + NounDes.js（逐字节）交互路径',
    stage: {
      width: avgContainer.clientWidth,
      height: avgContainer.clientHeight,
      fontSize: getComputedStyle(avgContainer).fontSize,
    },
  },
  steps,
  problems,
  pageErrors,
  done: true,
};
await fetch(`/freeze?scene=ui_${SCENE}`, {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify(payload, null, 1),
});
document.title = 'ui-freeze-done';
