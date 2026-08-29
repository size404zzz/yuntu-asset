import {h} from './ui/dom.js';
import {normalizeScript, isTerminal, branchTargets, serializeScript}
    from './core/script.js';
import {AssetRegistry} from './core/assets.js';
import {openPicker} from './editor/picker.js';
import {Editor} from './editor/editor.js';
import {Player} from './engine/player.js';
import {AudioEngine, defaultAudioResolve} from './engine/audio.js';
import {deriveLayout} from './engine/sprite.js';

const FIXTURES = [
  {id: 'scene1', title: '临危受命 · 数组格式'},
  {id: 'scene2', title: '背水一战 · 对象 map 格式'},
  {id: 'scene3', title: '绝处逢生 · 数组格式'},
];

/* M8 素材库：仓库索引 + IndexedDB 上传的统一注册表（R13：无 res/ 退化）。 */
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
  if (entry) return (await fetch(registry.layoutUrl(img.imgPath))).json();
  const bmp = await loadBitmap(filePathOf(`Lpic_${img.imgPath}.png`));
  return deriveLayout(bmp);
};

/* 预览 = 真引擎；M7 音频手势前静音、首次 pointerdown 解锁续播。 */
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
    title: '素材库', kind: 'bg',
    onPick: (sel) => {
      if (sel.kind === 'chara') {
        location.href = `cal.html?id=${encodeURIComponent(sel.name)}`;
        return;
      }
      document.getElementById('report').append(
          h('div', {className: 'ok', text: `已选背景 ${sel.name}`}));
      document.querySelector('.picker-overlay')?.remove();
    },
  });
});

/* —— M9 编辑器 —— */
const editor = new Editor({
  player, registry,
  characters: await (await fetch('data/Avg_character.json')).json(),
  dom: {
    shotList: document.getElementById('shot-list'),
    inspector: document.getElementById('inspector'),
    pos: document.getElementById('tp-pos'),
    undo: document.getElementById('btn-undo'),
    redo: document.getElementById('btn-redo'),
  },
  meta: {sector: '绿洲防线'},
});

const state = {stories: new Map(), playing: false, playTimer: null};
const tpPlay = document.getElementById('tp-play');

async function useStory(id) {
  stopPlay();
  const story = state.stories.get(id);
  editor.meta = {title: story.title, sector: '绿洲防线'};
  editor.useStory(story);
}

function stopPlay() {
  if (!state.playing) return;
  state.playing = false;
  clearInterval(state.playTimer);
  tpPlay.textContent = '▶ 连播';
}

function startPlay() {
  state.playing = true;
  tpPlay.textContent = '⏸ 暂停';
  const tick = () => {
    if (!state.playing) return;
    if (player.playEnd) { stopPlay(); return; }
    if (player.refs.avgChoices.className) { stopPlay(); return; }
    if (player.shotEnd) {
      player.playShot();
      syncIndex();
    }
  };
  state.playTimer = setInterval(tick, 250);
  tick();
}

function syncIndex() {
  const story = editor.doc.story;
  const wire = Number(player.shotId);
  const index = story.format === 'array' ? wire : story.indexToWire.indexOf(wire);
  if (index >= 0 && index !== editor.index) {
    editor.index = index;
    editor.renderList();
    editor.renderInspector();
  }
}

tpPlay.addEventListener('click', () => (state.playing ? stopPlay() : startPlay()));
document.getElementById('tp-next').addEventListener('click', () => {
  const n = editor.doc.story.shots.length - 1;
  editor.select(Math.min(n, editor.index + 1));
});
document.getElementById('tp-prev').addEventListener('click', () => {
  editor.select(Math.max(0, editor.index - 1));
});

window.addEventListener('resize', () => player.fitToContainer());
document.getElementById('btn-1to1').addEventListener('click', () => {
  player.setScale(1);
});

/* —— 夹具装载（归一化自检报告保留）—— */
async function loadFixtures() {
  const report = document.getElementById('report');
  report.append('剧本归一化自检\n', '─'.repeat(38), '\n');
  for (const fixture of FIXTURES) {
    const raw = await (await fetch(`data/fixtures/${fixture.id}.json`)).json();
    const story = normalizeScript(raw);
    story.title = fixture.title;
    state.stories.set(fixture.id, story);
    const contentShots = story.shots.filter((s) => s.content).length;
    const badRefs = story.shots.flatMap((shot, i) =>
        (shot.branch ?? [])
            .map((o) => branchTargets(story, i).find((t) => t.wire === o.jumpAct))
            .filter((t) => t && t.index === null)
            .map((t) => `#${i}→${t.wire}`));
    report.append(h('div', {
      className: badRefs.length ? 'bad' : 'ok',
      text: `${fixture.id}  格式=${story.format}  shots=${story.shots.length}`
          + `  线性可达=${story.order.length}  含对白=${contentShots}`
          + `  终点=${story.shots.findIndex((_, i) => isTerminal(story, i))}`
          + (badRefs.length ? `  悬空分支: ${badRefs.join(', ')}` : ''),
    }), '\n');
  }
  const select = document.getElementById('story-select');
  for (const fixture of FIXTURES) {
    select.append(h('option', {value: fixture.id, text: fixture.title}));
  }
  select.addEventListener('change', () => useStory(select.value));
  await useStory(FIXTURES[0].id);
}

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
