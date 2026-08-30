import {h} from './ui/dom.js';
import {normalizeScript, isTerminal, branchTargets, serializeScript}
    from './core/script.js';
import {AssetRegistry} from './core/assets.js';
import {openDB} from './core/idb.js';
import {
  exportProject, exportZip, importProject, saveProject, touchProjectIndex,
} from './editor/io.js';
import {openPicker} from './editor/picker.js';
import {openStoryPicker, loadStory} from './editor/storylib.js';
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

/* 预览 = 真引擎；M7 音频手势前静音、首次 pointerdown 解锁续播。
   解析三级：上传件 > 仓库音频索引（sheet/cue）> 全局 cue 表（接住
   bgm 的 sheet=cue 与省略 sheet 的脚本），最后退 data/audio 约定。
   M15 CV：data/index/voices.json 把 {heroId, voiceId} 解到
   VO_<代号>/<代号>_<语音名>（skin.lua 的 src_id_pic + audio_voice 表）。 */
let voiceIndex = null;
try {
  voiceIndex = await (await fetch('data/index/voices.json')).json();
} catch { /* 无语音映射：CV 静默跳过 */ }
const audio = new AudioEngine({
  resolve: (sheet, cue) =>
      registry.resolveAudio(sheet, cue)?.url
      ?? defaultAudioResolve(sheet, cue),
  resolveVoice: voiceIndex ? ({heroId, voiceId}) => {
    const hero = voiceIndex.byHero[String(heroId)];
    const line = voiceIndex.byVoiceId[String(voiceId)];
    if (!hero || !line) return null;
    const sheet = `VO_${hero.codename}`;
    const cue = `${hero.codename}_${line}`;
    return registry.resolveAudio(sheet, cue)?.url
        ?? `data/audio/${sheet}/${cue}.ogg`;
  } : null,
  log: (m) => console.warn('[audio]', m),
});
addEventListener('pointerdown', () => audio.unlock(), {once: true});

const player = new Player({
  mount: document.getElementById('preview'),
  mode: 'clamp',
  logClickCloses: true,     // M15：log 面板任意点击收起（参考默认常驻）
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
const glossary = await (await fetch('data/Noun_des.json')).json();
let currentId = 'scene1';

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
  onDoc: (doc) => {
    doc.subscribe(debounceSave);
  },
});

/* 自动保存：编辑事件防抖 1.5s 落 IDB（localStorage 兜底在 io.saveProject 里）。 */
let saveTimer = null;
let lastSave = null;
function debounceSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => doSave(true), 1500);
}
async function buildProject() {
  return exportProject({
    doc: editor.doc, title: editor.doc.story.title ?? currentId,
    registry, characters: editor.characters, glossary,
  });
}
async function doSave(silent) {
  const project = await buildProject();
  lastSave = JSON.stringify(project);
  await saveProject(await openDB(), currentId, project);
  await touchProjectIndex(await openDB(), currentId);
  if (!silent) flashStatus('已保存');
}
function flashStatus(text) {
  const el = document.getElementById('storage');
  const old = el.textContent;
  el.textContent = text;
  setTimeout(() => { el.textContent = old; }, 1500);
}
function download(name, data, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], {type}));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

document.getElementById('btn-save').addEventListener('click', () => doSave(false));
document.getElementById('btn-export').addEventListener('click', async () => {
  download(`${currentId}.yuntu.json`,
      lastSave ?? JSON.stringify(await buildProject()), 'application/json');
});
document.getElementById('btn-export-zip').addEventListener('click', async () => {
  flashStatus('打包中…');
  const zip = await exportZip({project: await buildProject()});
  download(`${currentId}.yuntu.zip`, zip, 'application/zip');
});
const importFile = h('input', {type: 'file', accept: '.json,application/json',
  style: {display: 'none'}});
importFile.addEventListener('change', async () => {
  const file = importFile.files[0];
  importFile.value = '';
  if (!file) return;
  try {
    const project = JSON.parse(await file.text());
    const data = await importProject(project, {registry, applyTo: true});
    currentId = data.title || 'imported';
    editor.meta = {title: data.title, sector: '绿洲防线'};
    editor.useStory(data.story);
    flashStatus('导入成功');
  } catch (error) {
    flashStatus(`导入失败：${error.message}`);
  }
});
document.getElementById('btn-import').addEventListener('click',
    () => importFile.click());
document.body.append(importFile);

const state = {stories: new Map(), playing: false, playTimer: null};
const tpPlay = document.getElementById('tp-play');

async function useStory(id) {
  stopPlay();
  currentId = id;
  const story = state.stories.get(id);
  document.getElementById('story-label').textContent =
      id + (story.title && story.title !== id ? ` · ${story.title}` : '');
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

/* 预览状态开关（M9 计划项）：定格 / 播放本镜 / 连续播放。 */
document.getElementById('tp-mode').addEventListener('change', (e) => {
  editor.mode = e.target.value;
  if (editor.mode === 'chain') return startPlay();
  stopPlay();
  editor._seekInto(editor.mode === 'once' ? 'timed' : 'freeze');
});
document.getElementById('tp-next').addEventListener('click', () => {
  const n = editor.doc.story.shots.length - 1;
  editor.select(Math.min(n, editor.index + 1));
});
document.getElementById('tp-prev').addEventListener('click', () => {
  editor.select(Math.max(0, editor.index - 1));
});

/* —— M14 剧本库：1878 段 AvgCfg 的浏览与一键装载 ——
   索引缺席（R13）时按钮禁用并提示构建命令；装载 = loadStory（字节码解码
   + avgwire 映射）→ normalizeScript → 走与夹具完全相同的 useStory 管线。 */
let avgManifest = null;
let storyCatalog = null;
try {
  avgManifest = await (await fetch('data/index/avg-scripts.json')).json();
  storyCatalog = await (await fetch('data/index/story-catalog.json')).json();
} catch { /* 无索引：纯夹具模式 */ }
const btnStories = document.getElementById('btn-storylib');
if (!avgManifest) {
  btnStories.disabled = true;
  btnStories.title = '缺 data/index/avg-scripts.json（node tools/build-asset-index.mjs）';
} else {
  btnStories.addEventListener('click', () => {
    openStoryPicker(avgManifest, {catalog: storyCatalog, onPick: async ({id}) => {
      document.querySelector('.picker-overlay')?.remove();
      try {
        flashStatus(`装载 ${id}…`);
        const story = await loadCorpusStory(id);
        flashStatus(`已装载 ${id}（${story.shots.length} 镜）`);
      } catch (error) {
        flashStatus(`装载失败：${error.message}`);
      }
    }});
  });
}

async function loadCorpusStory(id) {
  if (!avgManifest) throw new Error('剧本库索引缺席');
  if (!state.stories.has(id)) {
    const meta = avgManifest.stories.find((s) => s.id === id);
    const {wire} = await loadStory(fetch, meta);
    const story = normalizeScript(wire);
    story.title = id;
    state.stories.set(id, story);
  }
  await useStory(id);
  return state.stories.get(id);
}

window.addEventListener('resize', () => player.fitToContainer());

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
  await useStory(FIXTURES[0].id);
}

loadFixtures().then(async () => {
  if (!new URLSearchParams(location.search).get('smoke')) return;
  await new Promise((r) => setTimeout(r, 500));
  const smoke = {
    done: true,
    pos: document.getElementById('tp-pos').textContent,
    storage: document.getElementById('storage').textContent,
    shots: document.querySelectorAll('.shot-row').length,
    charas: document.querySelectorAll('#avg-charas .avg-chara').length,
  };
  /* M14 冒烟追加：剧本库装载链在真实编辑器里跑一遍（夹具字段保持原口径）。 */
  if (avgManifest) {
    try {
      const story = await loadCorpusStory('cpt00_e_01_01');
      /* M15 偏离项冒烟：log 面板开 → 任意点击收起（logClickCloses）。 */
      const refs = player.refs;
      refs.avgControlLog.click();
      const logOpened = refs.avgOverlay.classList.contains('log');
      player.container.click();
      const logClosed = !refs.avgOverlay.classList.contains('log');
      smoke.storylib = {
        id: currentId,
        shots: story.shots.length,
        pos: document.getElementById('tp-pos').textContent,
        brief: player.refs.avgSceneBrief.textContent.slice(0, 20),
        logCloses: logOpened && logClosed ? true : `open=${logOpened} closed=${logClosed}`,
      };
    } catch (e) {
      smoke.storylib = {error: e.message};
    }
  }
  await fetch('/freeze?scene=editor_smoke', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(smoke, null, 1),
  });
});
