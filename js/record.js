/* record.js —— 全屏播放页入口：整段语料的回看 + 录制（?id=<段ID>）。
 *
 * 页面本身就是录制靶（视口 = 舞台，1200×540 设计稿等比缩放充满窗口），
 * 所以录制会话不需要舞台出画钩子；工具栏在录制期间整体隐藏
 * （openRecorder 的 onPhase → body.record-active），平时 2.5s 无操作自动
 * 隐没——任何常驻 UI 都会被录进视频。舞台内点击走引擎原生推进
 * （对白点击、选项点选），录制中由会话的 capture 截停吞掉。
 */

import {h} from './ui/dom.js';
import {normalizeScript, serializeScript} from './core/script.js';
import {loadStory, openStoryPicker} from './editor/storylib.js';
import {openRecorder} from './editor/recorder.js';
import {bootCorpusPlayer} from './host.js';
import {STAGE_WIDTH, STAGE_HEIGHT} from './engine/player.js';

let currentId = new URLSearchParams(location.search).get('id')
    || 'cpt00_e_01_01';

const {player} = await bootCorpusPlayer(document.getElementById('stage-host'));
document.title = `${currentId} · 云图计划 · 全屏播放`;

/* 舞台等比缩放充满视口（允许放大：全屏回看要的就是铺满）。 */
const fit = () => {
  const k = Math.min(globalThis.innerWidth / STAGE_WIDTH,
      globalThis.innerHeight / STAGE_HEIGHT);
  Object.assign(player.container.style, {
    width: `${STAGE_WIDTH}px`, maxWidth: 'none',
    transform: `scale(${k})`, transformOrigin: 'center center',
  });
};
fit();
addEventListener('resize', fit);

/* —— 工具栏（自动隐没；录制期间 display:none） —— */
const elTitle = document.getElementById('rt-title');
const elPos = document.getElementById('rt-pos');
const btnPlay = document.getElementById('rt-play');
const btnRecord = document.getElementById('rt-record');
const btnLib = document.getElementById('rt-lib');

const updatePos = () => { elPos.textContent = `#${player.shotId}`; };

/* —— 连播（与 main.js 同一口径：shotEnd 推进、选项/播完停） —— */
const play = {playing: false, timer: null};
const PLAY_POLL = 250;

function tick() {
  if (!play.playing) return;
  if (player.playEnd) { stopPlayback(); return; }
  if (player.refs.avgChoices.className) { stopPlayback(); return; }
  if (player.shotEnd) player.playShot();
  updatePos();
}

function schedulePoll() {
  clearInterval(play.timer);
  play.timer = setInterval(tick, PLAY_POLL / player.rate);
}

function stopPlayback() {
  if (!play.playing) return;
  play.playing = false;
  clearInterval(play.timer);
  btnPlay.textContent = '▶ 连播';
}

async function startPlayback() {
  if (player.playEnd) await replay();     // 播完再点 = 从头再来
  play.playing = true;
  btnPlay.textContent = '⏸ 暂停';
  schedulePoll();
  tick();
}

btnPlay.addEventListener('click',
    () => void (play.playing ? stopPlayback() : startPlayback()));

document.getElementById('rt-rate').addEventListener('change', (e) => {
  player.setRate(Number(e.target.value) || 1);
  if (play.playing) schedulePoll();
});

/* —— 语料装载（剧本库同一条解码链） —— */
let manifest = null;
let archive = null;
try {
  manifest = await (await fetch('data/index/avg-scripts.json')).json();
  archive = await (await fetch('data/index/story-archive.json')).json();
} catch { /* 无索引：纯夹具部署包 */ }

const state = {story: null};

/* 落到首个可停留镜：开场常是 autoContinue 直通镜，seekShot 停不住首镜
   （fastForward 会顺着链自动推进）——与编辑器 _pausable 落点同一语义。 */
async function landFirst() {
  const first = player.sceneTimeline().find((e) => e.pausable);
  if (first) await player.seekShot(first.key);
  updatePos();
}

async function useStory(id) {
  if (!manifest) {
    throw new Error('缺 data/index/avg-scripts.json'
        + '（node tools/build-asset-index.mjs）');
  }
  const meta = manifest.stories.find((s) => s.id === id);
  if (!meta) throw new Error(`语料里没有 ${id}`);
  stopPlayback();
  const {wire} = await loadStory(fetch, meta,
      {heroSprites: manifest.heroSprites, pathOwner: manifest.pathOwner});
  state.story = normalizeScript(wire);
  state.story.title = id;
  currentId = id;
  history.replaceState(null, '', `?id=${encodeURIComponent(id)}`);
  document.title = `${id} · 云图计划 · 全屏播放`;
  elTitle.textContent = id;
  player.setScene(serializeScript(state.story), id, '1', '', '');
  await landFirst();
}

async function replay() {
  player.setScene(serializeScript(state.story), currentId, '1', '', '');
  await landFirst();
}

if (manifest) {
  btnLib.addEventListener('click', () => {
    openStoryPicker(manifest, {archive, onPick: async ({id}) => {
      document.querySelector('.picker-overlay')?.remove();
      try {
        elTitle.textContent = `装载 ${id}…`;
        await useStory(id);
      } catch (e) {
        elTitle.textContent = `装载失败：${e.message}`;
      }
    }});
  });
} else {
  btnLib.disabled = true;
  btnLib.title = '缺 data/index/avg-scripts.json';
}

/* —— 录制：页面即舞台，静态会话（无出画钩子） —— */
btnRecord.addEventListener('click', () => {
  document.querySelector('.picker-overlay')?.remove();
  openRecorder({
    player,
    storyId: () => currentId,
    getStory: () => ({story: state.story, title: currentId, sector: ''}),
    stopPreviewPlay: stopPlayback,
    onPhase: (p) => document.body.classList.toggle('record-active',
        ['requesting', 'countdown', 'recording', 'stopping'].includes(p)),
  });
});

/* —— 工具栏自动隐没：2.5s 无操作隐去，动一下就回来 —— */
let idleTimer = null;
const wake = () => {
  document.body.classList.remove('record-idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(
      () => document.body.classList.add('record-idle'), 2500);
};
addEventListener('pointermove', wake);
addEventListener('pointerdown', wake);
wake();

try {
  await useStory(currentId);
} catch (e) {
  elTitle.textContent = '装载失败';
  document.getElementById('stage-host').append(
      h('div.record-error', {text: e.message}));
}
