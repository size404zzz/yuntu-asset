import {h, clear} from './ui/dom.js';
import {normalizeScript, nextIndexOf, isTerminal, branchTargets, serializeScript}
    from './core/script.js';
import {shotSummary} from './core/schema.js';
import {Player} from './engine/player.js';
import {AudioEngine, defaultAudioResolve} from './engine/audio.js';

const FIXTURES = [
  {id: 'scene1', title: '临危受命 · 数组格式'},
  {id: 'scene2', title: '背水一战 · 对象 map 格式'},
  {id: 'scene3', title: '绝处逢生 · 数组格式'},
];

const state = {stories: new Map(), story: null, index: 0, playing: false};

/* 素材解析：引擎报的是 wiki 命名（Lpic_x_avg.png / Icon_face_x_1.png /
   Cpt00_e_cg002.png），本地 res/ 树的大小写与目录结构都不同，靠
   data/asset-index.json（tools/build-asset-index.mjs 生成）精确解析。
   索引缺失或未命中的条目先按规则猜本地落点，再退回 /images 代理
   （仅在 tools/ref/serve.py 宿主下有效）。M8 素材库落地后换 IndexedDB。 */
const assetIndex = await fetch('data/asset-index.json')
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);

const filePathOf = (name) => assetIndex?.[name.toLowerCase()]
    ?? (() => {
      const lower = name.toLowerCase();
      const lpic = /^lpic_(.+)\.png$/.exec(lower);
      if (lpic) {
        return `res/Assets/Res/Character/${lpic[1]}/lpic_${lpic[1]}.png`;
      }
      const face = /^icon_face_(.+)_(\d+)\.png$/.exec(lower);
      if (face) {
        const stem = face[1];
        return 'res/Assets/Res/Character/' + `${stem}_avg/Face/${stem}_avg_face_${face[2]}.png`;
      }
      return '/images/' + name[0].toUpperCase() + name.slice(1);
    })();

/* 预览 = 真引擎：分镜列表点谁就 seekShot 到谁（M5 传输条）。
   M7 音频：手势前静音（浏览器自动播放策略），首次 pointerdown 解锁并
   按已流逝时间续播手势前登记的 bgm。 */
const audio = new AudioEngine({
  resolve: defaultAudioResolve,
  log: (m) => console.warn('[audio]', m),
});
addEventListener('pointerdown', () => audio.unlock(), {once: true});

const player = new Player({
  mount: document.getElementById('preview'),
  mode: 'clamp',
  filePathOf,
  layoutOf: async (img) =>
      (await fetch(`data/layouts/${img.imgPath}.json`)).json(),
  getName: () => '教授',
  getGender: () => 'TA',
  characters: await (await fetch('data/Avg_character.json')).json(),
  nouns: await (await fetch('data/Noun_des.json')).json(),
  audio,
});

const btnSound = document.getElementById('btn-sound');
btnSound.addEventListener('click', () => {
  audio.setMuted(!audio.muted);
  btnSound.textContent = audio.muted ? '音效·关' : '音效·开';
});

/* 引擎键（数组剧本 = 下标；map 剧本 = 键名）与编辑器下标的换算。 */
function keyOf(story, index) {
  return story.format === 'array' ? index : story.indexToWire[index];
}

async function loadFixtures() {
  const report = document.getElementById('report');
  report.append('剧本归一化自检\n', '─'.repeat(38), '\n');
  for (const fixture of FIXTURES) {
    const response = await fetch(`data/fixtures/${fixture.id}.json`);
    const raw = await response.json();
    const story = normalizeScript(raw);
    story.title = fixture.title;
    state.stories.set(fixture.id, story);

    const contentShots = story.shots.filter((s) => s.content).length;
    const tweened = story.shots.filter((s) => s.imgTween?.length).length;
    const badRefs = story.shots.flatMap((shot, i) =>
        (shot.branch ?? [])
            .map((o) => branchTargets(story, i).find((t) => t.wire === o.jumpAct))
            .filter((t) => t && t.index === null)
            .map((t) => `#${i}→${t.wire}`));
    const lines = [
      `${fixture.id}  格式=${story.format}` +
          `  shots=${story.shots.length}  线性可达=${story.order.length}` +
          `  孤儿=${story.orphans.length}`,
      `      含对白=${contentShots}  含tween=${tweened}` +
          `  终点=${story.shots.findIndex((_, i) => isTerminal(story, i))}`,
    ];
    if (story.orphans.length) lines.push(`      孤儿下标: ${story.orphans.join(', ')}`);
    if (badRefs.length) lines.push(`      悬空分支: ${badRefs.join(', ')}`);
    report.append(h('div', {className: badRefs.length ? 'bad' : 'ok', text: lines.join('\n')}), '\n');
  }
  const select = document.getElementById('story-select');
  for (const fixture of FIXTURES) {
    select.append(h('option', {value: fixture.id, text: state.stories.get(fixture.id).title}));
  }
  select.addEventListener('change', () => useStory(select.value));
  useStory(FIXTURES[0].id);
}

function useStory(id) {
  stopPlay();
  state.story = state.stories.get(id);
  state.index = 0;
  player.setScene(serializeScript(state.story), state.story.title, '1', '绿洲防线', '');
  renderShotList();
  seekToIndex(0);
}

function renderShotList() {
  const list = clear(document.getElementById('shot-list'));
  const story = state.story;
  story.shots.forEach((shot, index) => {
    const {text} = shotSummary(shot);
    const badges = [
      shot.images?.length ? '●' : '',
      shot.imgTween?.length ? '◐' : '',
      shot.audio ? '♪' : '',
      shot.effect ? '✳' : '',
      shot.branch ? '★' : '',
      isTerminal(story, index) ? '⏤' : '',
      story.orphans.includes(index) ? '⚠' : '',
    ].filter(Boolean).join(' ');
    const speaker = shot.speakerName === 'bravo' ? '教授' :
        shot.speakerName || (shot.speakerHeroId != null ? `#${shot.speakerHeroId}` : '');
    const row = h('div.shot-row', {
      className: index === state.index ? 'shot-row selected' : 'shot-row',
      dataset: {index},
    },
        h('span.num', {text: String(index)}),
        h('span.speaker', {text: `${shot.contentType ?? '-'} ${speaker}`}),
        h('span.text', {text: text || '（无文案）'}),
        h('span.badges', {text: badges}));
    row.addEventListener('click', () => seekToIndex(index));
    list.append(row);
  });
}

/* —— 传输条（M5）—— */

const tpPos = document.getElementById('tp-pos');
const tpPlay = document.getElementById('tp-play');
let playTimer = null;

const setStatus = (message) => {
  tpPos.dataset.status = message || '';
  updatePos();
};

function updatePos() {
  const story = state.story;
  const status = tpPos.dataset.status || '';
  tpPos.textContent = status
      || `#${state.index} / ${story.shots.length - 1} · key=${player.shotId}`;
}

/* 点了直通镜/孤儿镜时，就近找可停靠镜（优先向后，同距取靠后）。 */
function nearestPausableIndex(from) {
  const candidates = state.story.order
      .filter((i) => player.isPausableKey(keyOf(state.story, i)));
  if (!candidates.length) return null;
  let best = candidates[0];
  for (const i of candidates) {
    if (Math.abs(i - from) < Math.abs(best - from)
        || (Math.abs(i - from) === Math.abs(best - from) && i > best)) {
      best = i;
    }
  }
  return best;
}

async function seekToIndex(index) {
  stopPlay();
  let key = keyOf(state.story, index);
  if (!player.isPausableKey(key)) {
    const alt = nearestPausableIndex(index);
    if (alt === null) {
      state.index = index;
      renderShotList();
      setStatus(`#${index} 无法预览（场景没有可停靠镜）`);
      return;
    }
    index = alt;
    key = keyOf(state.story, alt);
  }
  state.index = index;
  renderShotList();
  try {
    await player.seekShot(key);
    updatePos();
  } catch (error) {
    setStatus(`seek 失败：${error.message}`);
  }
}

function syncIndexFromPlayer() {
  const story = state.story;
  const key = player.shotId;
  const index = story.format === 'array'
      ? key : story.indexToWire.indexOf(Number(key));
  if (index >= 0 && index !== state.index) {
    state.index = index;
    renderShotList();
  }
  updatePos();
}

function stopPlay() {
  if (!state.playing) return;
  state.playing = false;
  clearInterval(playTimer);
  playTimer = null;
  tpPlay.textContent = '▶ 连播';
}

function startPlay() {
  state.playing = true;
  tpPlay.textContent = '⏸ 暂停';
  const tick = () => {
    if (!state.playing) return;
    if (player.playEnd) {
      stopPlay();
      setStatus('播完一场——点任意分镜重看');
      return;
    }
    if (player.refs.avgChoices.className) {
      stopPlay();
      setStatus('停在分支——选一个选项后继续');
      return;
    }
    if (player.shotEnd) {
      player.playShot();
      syncIndexFromPlayer();
    }
  };
  playTimer = setInterval(tick, 250);
  tick();
}

tpPlay.addEventListener('click', () => {
  if (state.playing) return stopPlay();
  startPlay();
});

document.getElementById('tp-next').addEventListener('click', () => {
  const order = state.story.order;
  const pos = order.indexOf(state.index);
  const next = order.slice(pos + 1)
      .find((i) => player.isPausableKey(keyOf(state.story, i)));
  if (next === undefined) return setStatus('后面没有可停靠的镜了');
  seekToIndex(next);
});

document.getElementById('tp-prev').addEventListener('click', () => {
  const order = state.story.order;
  const pos = order.indexOf(state.index);
  const prev = order.slice(0, Math.max(0, pos)).reverse()
      .find((i) => player.isPausableKey(keyOf(state.story, i)));
  if (prev === undefined) return setStatus('前面没有可停靠的镜了');
  seekToIndex(prev);
});

window.addEventListener('resize', () => player.fitToContainer());
document.getElementById('btn-1to1').addEventListener('click', () => {
  player.setScale(1);
});

loadFixtures();
