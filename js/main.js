import {h, clear} from './ui/dom.js';
import {normalizeScript, nextIndexOf, isTerminal, branchTargets, serializeScript}
    from './core/script.js';
import {shotSummary} from './core/schema.js';
import {AssetRegistry} from './core/assets.js';
import {openPicker} from './editor/picker.js';
import {Player} from './engine/player.js';
import {AudioEngine, defaultAudioResolve} from './engine/audio.js';
import {deriveLayout} from './engine/sprite.js';

const FIXTURES = [
  {id: 'scene1', title: '临危受命 · 数组格式'},
  {id: 'scene2', title: '背水一战 · 对象 map 格式'},
  {id: 'scene3', title: '绝处逢生 · 数组格式'},
];

const state = {stories: new Map(), story: null, index: 0, playing: false};

/* M8 素材库：仓库索引（res/ 生成件）+ IndexedDB 上传的统一注册表。
   解析优先级：上传覆盖仓库；layout 是标定 > 仓库已知 > deriveLayout 起点
   （⚠ 徽标与一键标定在 M9 检查器里做）。R13：res/ 缺失退化为纯上传模式。 */
const registry = await new AssetRegistry().boot();

const loadBitmap = (url) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error(`lpic 加载失败: ${url}`));
  img.src = url;
});

const filePathOf = (name) => {
  const hit = registry.resolve(name);
  if (hit) return hit.url;
  const lower = name.toLowerCase();
  const lpic = /^lpic_(.+)\.png$/.exec(lower);
  if (lpic) return `res/Assets/Res/Character/${lpic[1]}/lpic_${lpic[1]}.png`;
  const face = /^icon_face_(.+)_(\d+)\.png$/.exec(lower);
  if (face) {
    return 'res/Assets/Res/Character/'
        + `${face[1]}_avg/Face/${face[1]}_avg_face_${face[2]}.png`;
  }
  return '/images/' + name[0].toUpperCase() + name.slice(1);
};

const layoutOf = async (img) => {
  const entry = registry.layoutEntry(img.imgPath);
  if (entry?.source === 'calibrated') return entry.layout;
  if (entry) {
    return (await fetch(registry.layoutUrl(img.imgPath))).json();
  }
  const bmp = await loadBitmap(filePathOf(`Lpic_${img.imgPath}.png`));
  return deriveLayout(bmp);
};

/* 预览 = 真引擎：分镜列表点谁就 seekShot 到谁（M5 传输条）。
   M7 音频：手势前静音（浏览器自动播放策略），首次 pointerdown 解锁并
   按已流逝时间续播手势前登记的 bgm；上传音频（M8）覆盖 data/audio 约定。 */
const audio = new AudioEngine({
  resolve: (sheet, cue) =>
      registry.resolve(`audio:${sheet}/${cue}`)?.url
      ?? defaultAudioResolve(sheet, cue),
  log: (m) => console.warn('[audio]', m),
});
addEventListener('pointerdown', () => audio.unlock(), {once: true});

const player = new Player({
  mount: document.getElementById('preview'),
  mode: 'clamp',
  filePathOf,
  layoutOf,
  getName: () => '教授',
  getGender: () => 'TA',
  characters: await (await fetch('data/Avg_character.json')).json(),
  nouns: await (await fetch('data/Noun_des.json')).json(),
  audio,
});

const fmtMB = (b) => `${(b / 1048576).toFixed(1)}MB`;
(async () => {
  const el = document.getElementById('storage');
  const est = await registry.estimate();
  const repo = registry.repoAvailable
      ? `仓库 ${registry.repo.backgrounds.length} 背景 / `
          + `${registry.repo.characters.filter((c) => c.avg).length} 立绘`
      : '未找到本地素材库（纯上传模式）';
  el.textContent = `${repo} · 上传 ${registry.listUploads().length} · `
      + `已用 ${est ? fmtMB(est.usage) : '?'}${registry.persisted ? ' · 持久化✓' : ''}`;
})();

const btnSound = document.getElementById('btn-sound');
btnSound.addEventListener('click', () => {
  audio.setMuted(!audio.muted);
  btnSound.textContent = audio.muted ? '音效·关' : '音效·开';
});

document.getElementById('btn-assets').addEventListener('click', () => {
  openPicker(registry, {
    title: '素材库',
    kind: 'bg',
    onPick: (sel) => {
      if (sel.kind === 'chara') {
        location.href = `cal.html?id=${encodeURIComponent(sel.name)}`;
        return;
      }
      const report = document.getElementById('report');
      report.append(h('div', {
        className: 'ok',
        text: `已选背景 ${sel.name}（M9 检查器接字段）`,
      }), '\n');
      document.querySelector('.picker-overlay')?.remove();
    },
  });
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

loadFixtures().then(async () => {
  if (!new URLSearchParams(location.search).get('smoke')) return;
  await new Promise((r) => setTimeout(r, 500));
  await fetch('/freeze?scene=editor_smoke', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      done: true,
      pos: document.getElementById('tp-pos').textContent,
      storage: document.getElementById('storage').textContent,
      shots: document.querySelectorAll('.shot-row').length,
      charas: document.querySelectorAll('#avg-charas .avg-chara').length,
    }, null, 1),
  });
});
