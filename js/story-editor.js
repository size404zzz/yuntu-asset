/* story-editor.js —— 独立剧情编辑页（story-editor.html）。
   两步流程（参考 gfStory 的 EditorStart → SceneSetup → 编辑）：
   - 第 1 页 场景设置：背景库 / 音乐库两栏（分组折叠 + 搜索 + 试听），所选
     「开场背景 / 开场 BGM」在开始编辑时写入第 1 镜——背景 = 本镜 imgType-2
     注册条目（条目 alpha=1 即台上可见，与 state.js 的注册语义一致），
     音乐 = 本镜 audio.bgm（引擎语义自本镜起延续）。装载已有剧本时沿
     story.order 带出它的开场场景；所选与现状一致就不写（不动原数据）。
   - 第 2 页 编辑：index.html 的右边两栏——左「检查器」就地编辑本镜台上
     状态，右「预览」+ 传输条。分镜列表按需求不保留（Editor.renderList
     仍要容器，给隐藏 div），跨镜导航走 ⏮/⏭/连播/检查器跳转。
   保存 / 导出 / 自动保存与 index.html 同一条 io 链；返回第 1 页改场景后
   再进来，差异以一次可撤销的 structure 落到现有 doc 上。 */

import {h} from './ui/dom.js';
import {normalizeScript} from './core/script.js';
import {createShot} from './core/schema.js';
import {openDB} from './core/idb.js';
import {
  exportProject, exportZip, importProject, saveProject, touchProjectIndex,
  loadProject, listProjects,
} from './editor/io.js';
import {openStoryPicker, loadStory} from './editor/storylib.js';
import {toggleAudioPreview} from './editor/picker.js';
import {Editor} from './editor/editor.js';
import {bootCorpusPlayer} from './host.js';

/* 模块级错误就地显示（第 1 页的错误条），装载/导入失败不打断页面。 */
const errBox = document.getElementById('ss-error');
const showErr = (msg) => { errBox.textContent = msg ?? ''; };
window.addEventListener('error', (e) => showErr(e.message));
window.addEventListener('unhandledrejection', (e) =>
    showErr(String(e.reason?.message ?? e.reason)));

/* 注册表/音频/解析三件套 = 编辑器与全屏播放页同一条 boot 链（js/host.js）。 */
const {registry, player, audio, avgEffects, characters, glossary} =
    await bootCorpusPlayer(document.getElementById('preview'),
        {logClickCloses: true});

/* —— 顶栏存储信息（两页各一份，同步写） —— */
const storageEls = [document.getElementById('storage'),
  document.getElementById('edit-storage')];
const setStorage = (text) => {
  for (const el of storageEls) el.textContent = text;
};
(async () => {
  const est = await registry.estimate();
  const fmtMB = (b) => `${(b / 1048576).toFixed(1)}MB`;
  const repo = registry.repoAvailable
      ? `仓库 ${registry.repo.backgrounds.length} 背景 / `
          + `${registry.repo.characters.filter((c) => c.avg).length} 立绘`
      : '未找到本地素材库（纯上传模式）';
  setStorage(`${repo} · 上传 ${registry.listUploads().length} · `
      + `已用 ${est ? fmtMB(est.usage) : '?'}${registry.persisted ? ' · 持久化✓' : ''}`);
})();

function flashStatus(text) {
  const el = document.body.dataset.step === 'edit'
      ? storageEls[1] : storageEls[0];
  const old = el.textContent;
  el.textContent = text;
  setTimeout(() => { el.textContent = old; }, 1500);
}

/* —— 场景设置状态 ——
   sourceKey 区分来源（new:<n> 每点一次新建都换新键，强制下轮重建）；
   story = 装载来的归一化剧本（新建为 null）；applied = 剧本当前已带的
   开场场景真值（{bg: imgPath|null, music: cue|null}），「所选 == 真值」
   就不写，保证装载→直接开始编辑不动原数据一个字节。 */
const setup = {
  sourceKey: 'new:0',
  id: null,
  title: '',
  story: null,
  bg: null,          // {name, group} 背景库条目
  music: null,       // {sheet, cue}
  applied: {bg: null, music: null},
};
let activeKey = null;   // 已进入编辑态的来源键
let currentId = null;   // 保存 / 导出键
let newCounter = 0;

/* —— 背景库 —— */
function backgroundItems() {
  const repo = registry.repo.backgrounds.map((b) =>
      ({name: b.name, group: b.group}));
  const seen = new Set(repo.map((b) => b.name.toLowerCase()));
  const ups = registry.listUploads({kind: 'image'})
      .filter((u) => u.name.toLowerCase().endsWith('.png'))
      .filter((u) => !seen.has(u.name.toLowerCase()))
      .map((u) => ({name: u.name.replace(/\.png$/i, ''), group: '上传'}));
  return [...ups, ...repo];
}
const bgUrl = (it) =>
    registry.resolve(`${it.name}.png`)?.url ?? it.path ?? null;
const bgKeyOf = (it) => (it ? `${it.group ?? ''}/${it.name}` : null);

const bgOpen = new Set();
let bgTotal = 0;
let musTotal = 0;
function renderBgPane() {
  const list = document.getElementById('ss-bg-list');
  const search = document.getElementById('ss-bg-search');
  const q = search.value.trim().toLowerCase();
  const all = backgroundItems();
  const items = all.filter((it) => !q
      || it.name.toLowerCase().includes(q)
      || String(it.group).toLowerCase().includes(q));
  const groups = new Map();
  for (const it of items) {
    const g = String(it.group ?? '其他');
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(it);
  }
  /* 初次渲染默认展开第一组（之后尊重用户的折叠选择）。 */
  if (!bgOpen.size && !q && groups.size) bgOpen.add(groups.keys().next().value);
  list.replaceChildren();
  for (const [g, its] of groups) {
    const hasSel = its.some((it) => bgKeyOf(it) === bgKeyOf(setup.bg));
    const open = q || hasSel || bgOpen.has(g);
    const grid = h('div.se-bg-grid');
    for (const it of its) {
      const cell = h('button.se-bg-cell',
          {title: `${it.group} / ${it.name}`, onclick: () => {
            const wasSel = cell.classList.contains('selected');
            setup.bg = wasSel ? null : it;
            for (const c of list.querySelectorAll('.se-bg-cell')) {
              c.classList.remove('selected');
            }
            if (!wasSel) cell.classList.add('selected');
            renderStage();
            renderCounts();
          }},
          h('img', {src: bgUrl(it), loading: 'lazy', alt: it.name}),
          h('span', {text: it.name}));
      if (bgKeyOf(it) === bgKeyOf(setup.bg)) cell.classList.add('selected');
      grid.append(cell);
    }
    const det = h('details.se-group', {open: !!open},
        h('summary', {},
            h('span.se-group-name', {text: g}),
            h('span.se-group-count', {text: String(its.length)})),
        grid);
    det.addEventListener('toggle', () => {
      if (det.open) bgOpen.add(g); else bgOpen.delete(g);
    });
    list.append(det);
  }
  if (!items.length) list.append(h('div.se-empty', {text: '没有匹配的背景'}));
  bgTotal = all.length;
}
document.getElementById('ss-bg-search').addEventListener('input',
    () => renderBgPane());

/* —— 音乐库：Mus_* sheet = 一曲一 sheet（cue 与 sheet 同名） —— */
function musicTracks() {
  const sheets = registry.repo.audio?.sheets ?? {};
  const out = [];
  for (const [sheet, entry] of Object.entries(sheets)) {
    if (!/^mus_/i.test(sheet)) continue;
    for (const [cue, meta] of Object.entries(entry?.cues ?? {})) {
      out.push({sheet, cue, url: registry.resolveAudio(sheet, cue)?.url
          ?? meta?.path ?? null, duration: meta?.duration ?? 0});
    }
  }
  return out.sort((a, b) => a.cue.localeCompare(b.cue));
}
const musicGroupOf = (cue) => cue.replace(/^Mus_/i, '').split('_')[0] || '其他';
const fmtDur = (s) =>
    `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

const musOpen = new Set();
function renderMusicPane() {
  const list = document.getElementById('ss-mus-list');
  const q = document.getElementById('ss-mus-search').value.trim().toLowerCase();
  const all = musicTracks();
  const items = all.filter((t) =>
      !q || t.cue.toLowerCase().includes(q) || t.sheet.toLowerCase().includes(q));
  const groups = new Map();
  for (const t of items) {
    const g = musicGroupOf(t.cue);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(t);
  }
  if (!musOpen.size && !q && groups.size) musOpen.add(groups.keys().next().value);
  list.replaceChildren();
  for (const [g, its] of groups) {
    const hasSel = its.some((t) => setup.music?.cue === t.cue);
    const open = q || hasSel || musOpen.has(g);
    const rows = h('div.se-mus-rows');
    for (const t of its) {
      const play = h('button.tiny', {text: '▶', title: t.url ? '试听' : '解析不到音频',
        disabled: !t.url, onclick: (e) => {
          e.stopPropagation();
          toggleAudioPreview(t.url, play);
        }});
      const row = h('button.se-mus-row',
          {title: t.cue, onclick: () => {
            const wasSel = row.classList.contains('selected');
            setup.music = wasSel ? null : {sheet: t.sheet, cue: t.cue};
            for (const r of list.querySelectorAll('.se-mus-row')) {
              r.classList.remove('selected');
            }
            if (!wasSel) row.classList.add('selected');
            renderStage();
            renderCounts();
          }},
          play,
          h('span.se-mus-name', {text: t.cue}),
          h('span.se-mus-dur',
              {text: t.duration ? fmtDur(t.duration) : ''}));
      if (setup.music?.cue === t.cue) row.classList.add('selected');
      rows.append(row);
    }
    const det = h('details.se-group', {open: !!open},
        h('summary', {},
            h('span.se-group-name', {text: g}),
            h('span.se-group-count', {text: String(its.length)})),
        rows);
    det.addEventListener('toggle', () => {
      if (det.open) musOpen.add(g); else musOpen.delete(g);
    });
    list.append(det);
  }
  if (!items.length) {
    list.append(h('div.se-empty', {text: registry.repoAvailable
        ? '没有匹配的曲目' : '音频库为空：先运行 node tools/media/unpack-acb.mjs'}));
  }
  musTotal = all.length;
}
document.getElementById('ss-mus-search').addEventListener('input',
    () => renderMusicPane());

function renderCounts() {
  document.getElementById('ss-bg-count').textContent = `共 ${bgTotal}`
      + (setup.bg ? ` · 已选 ${setup.bg.name}` : '');
  document.getElementById('ss-mus-count').textContent = `共 ${musTotal}`
      + (setup.music ? ` · 已选 ${setup.music.cue}` : '');
}

/* —— 场景预览（第 1 页底部的 16:9 静态框） —— */
function renderStage() {
  const stage = document.getElementById('ss-stage');
  const hint = document.getElementById('ss-stage-hint');
  const url = setup.bg ? bgUrl(setup.bg) : null;
  stage.style.backgroundImage = url ? `url("${url}")` : '';
  hint.style.display = url ? 'none' : '';
  let badge = stage.querySelector('.se-stage-music');
  if (setup.music) {
    badge ??= h('div.se-stage-music');
    badge.textContent = `♪ ${setup.music.cue}`;
    if (!badge.isConnected) stage.append(badge);
  } else {
    badge?.remove();
  }
  const note = document.getElementById('ss-stage-note');
  /* 注记的真值：刚装载的 story 优先；「新建 + 已有编辑会话」才看 doc 现值。 */
  const src = setup.story ?? editor?.doc?.story ?? null;
  const truth = src ? currentSceneTruth(src) : null;
  note.textContent = truth
      ? `剧本开场：背景 ${truth.bg ?? '（无）'}${truth.bgAt != null ? `（第 ${truth.bgAt} 镜注册）` : ''}`
          + ` · BGM ${truth.music ?? '（无）'}`
          + (setup.bg || setup.music ? ' → 所选将以「开始编辑」为准' : '')
      : '新建剧本：不选就是空舞台开场';
}

/* —— 开场场景的读 / 写（全部只落 shots[0]，沿引擎语义向后延续） —— */
function currentSceneTruth(story) {
  let bg = null;
  let bgAt = null;
  for (const i of story.order) {
    const im = (story.shots[i].images ?? []).find((x) =>
        x && !x.delete && x.imgType === 2 && x.imgPath);
    if (im) {
      bg = im.imgPath;
      bgAt = i;
      break;
    }
  }
  let music = null;
  for (const i of story.order) {
    const bgm = story.shots[i].audio?.bgm;
    if (bgm?.cue) {
      music = bgm.cue;
      break;
    }
  }
  return {bg, bgAt, music};
}

/* 已有 imgType-2 注册就改写首条的 imgPath（保持 imgId 与既有 tween 引用），
   没有就补一条 alpha=1 的 fullScreen 条目 + 0 号揭示帧（播放器只在 tween
   帧到来时才把背景画上 DOM，语料侧同款补帧见 avgwire.materializeFirstBg）。 */
function writeOpeningBg(story, item) {
  const shot = story.shots[0];
  const images = shot.images ?? [];
  const imgPath = `${item.group ?? ''}/${item.name}`;
  const at = images.findIndex((im) => im && !im.delete && im.imgType === 2);
  let imgId;
  if (at >= 0) {
    imgId = images[at].imgId;
    story.shots[0] = {...shot, images: images.map((im, n) =>
        n === at ? {...im, imgPath, alpha: 1} : im)};
  } else {
    const used = new Set(images.map((im) => im?.imgId));
    imgId = 1;
    while (used.has(imgId)) imgId += 1;
    story.shots[0] = {...shot, images: [...images,
        {imgId, imgType: 2, imgPath, alpha: 1, fullScreen: true}]};
  }
  /* 0 号揭示帧只在该元素没有 0 号帧时补：已有的揭示/淡入节奏不动。 */
  const tween = shot.imgTween ?? [];
  if (tween.some((t) => t && t.imgId === imgId && (t.delay ?? 0) === 0)) return;
  story.shots[0].imgTween =
      [{imgId, delay: 0, duration: 0, alpha: 1, isDark: false}, ...tween];
}

/* 清空开场背景：只摘第 1 镜自有的 imgType-2 条目与它们的帧（后续镜的
   注册数据不动，引擎语义下它们到点照样出现）。 */
function clearOpeningBg(story) {
  const shot = story.shots[0];
  const images = shot.images ?? [];
  const ids = new Set(images
      .filter((im) => im && !im.delete && im.imgType === 2)
      .map((im) => im.imgId));
  if (!ids.size) return;
  const rest = images.filter((im) => !(im && ids.has(im.imgId)));
  if (rest.length) shot.images = rest; else delete shot.images;
  const tween = (shot.imgTween ?? []).filter((t) => !(t && ids.has(t.imgId)));
  if (tween.length) shot.imgTween = tween; else delete shot.imgTween;
}

function writeOpeningMusic(story, music) {
  const shot = story.shots[0];
  const next = {...(shot.audio ?? {})};
  if (music) {
    next.bgm = {cue: music.cue, sheet: music.sheet,
        fadeIn: shot.audio?.bgm?.fadeIn ?? 1, fadeOut: shot.audio?.bgm?.fadeOut ?? 1};
  } else {
    delete next.bgm;
  }
  if (Object.keys(next).length) shot.audio = next; else delete shot.audio;
}

/* 所选与真值的差异写入：bg 按 imgPath 键比，music 按 cue 比。 */
function applySceneMutate(story, scene, applied) {
  const bgKey = bgKeyOf(scene.bg);
  if (bgKey !== (applied?.bg ?? null)) {
    if (scene.bg) writeOpeningBg(story, scene.bg);
    else clearOpeningBg(story);
  }
  const cue = scene.music?.cue ?? null;
  if (cue !== (applied?.music ?? null)) writeOpeningMusic(story, scene.music);
}

/* —— 剧本来源 —— */
function setSource({key, id, label, story, autoTitle}) {
  setup.sourceKey = key;
  setup.id = id ?? null;
  setup.story = story ?? null;
  if (autoTitle !== undefined) {
    setup.title = autoTitle ?? '';
    document.getElementById('ss-title').value = setup.title;
  }
  document.getElementById('ss-source-info').textContent = label;
  const truth = story ? currentSceneTruth(story) : {bg: null, music: null};
  setup.applied = {bg: truth.bg, music: truth.music};
  /* 带出开场场景：背景按 imgPath 基名匹配库内条目（匹配不上保持未选，
     真值在预览注记里可见）；音乐直接记 cue。 */
  setup.bg = truth.bg
      ? backgroundItems().find((it) => bgKeyOf(it) === truth.bg) ?? null
      : null;
  setup.music = truth.music
      ? musicTracks().find((t) => t.cue === truth.music) ?? null : null;
  document.getElementById('ss-story-info').textContent =
      label + (story ? ` · ${story.shots.length} 镜` : '');
  renderBgPane();
  renderMusicPane();
  renderCounts();
  renderStage();
}

document.getElementById('ss-new').addEventListener('click', () => {
  newCounter += 1;
  setSource({key: `new:${newCounter}`, id: null,
      label: '新建空白剧本（1 镜）', story: null, autoTitle: ''});
});

/* —— M14 剧本库：与 index.html 同一条装载链（字节码解码 + avgwire 映射） —— */
let avgManifest = null;
let storyArchive = null;
try {
  avgManifest = await (await fetch('data/index/avg-scripts.json')).json();
  const manual = await fetch('data/index/story-archive-manual.json');
  if (manual.ok) {
    const parsed = await manual.json();
    if (parsed?.classes?.length && Array.isArray(parsed.mainline)
        && Array.isArray(parsed.unarchived)) storyArchive = parsed;
  }
} catch { /* 无索引：剧本库按钮置灰 */ }
if (avgManifest && !storyArchive) {
  try {
    storyArchive = await (await fetch('data/index/story-archive.json')).json();
  } catch { /* 生成档案也缺席：平铺视图 */ }
}
const btnLib = document.getElementById('ss-lib');
if (!avgManifest) {
  btnLib.disabled = true;
  btnLib.title = '缺 data/index/avg-scripts.json（node tools/build-asset-index.mjs）';
} else {
  btnLib.addEventListener('click', () => {
    openStoryPicker(avgManifest, {archive: storyArchive, onPick: async ({id}) => {
      document.querySelector('.picker-overlay')?.remove();
      try {
        flashStatus(`装载 ${id}…`);
        const meta = avgManifest.stories.find((s) => s.id === id);
        const {wire} = await loadStory(fetch, meta,
            {heroSprites: avgManifest.heroSprites, pathOwner: avgManifest.pathOwner});
        const story = normalizeScript(wire);
        story.title = id;
        setSource({key: `corpus:${id}`, id,
            label: `剧本库：${id}`, story, autoTitle: id});
        flashStatus(`已装载 ${id}（${story.shots.length} 镜）`);
      } catch (e) {
        showErr(`装载失败：${e.message}`);
      }
    }});
  });
}

/* —— 导入工程 JSON（与 index.html 同一条 importProject 链） —— */
const importFile = h('input', {type: 'file', accept: '.json,application/json',
  style: {display: 'none'}});
importFile.addEventListener('change', async () => {
  const file = importFile.files[0];
  importFile.value = '';
  if (!file) return;
  try {
    const project = JSON.parse(await file.text());
    const data = await importProject(project, {registry, applyTo: true});
    setSource({key: `import:${data.title}:${data.story.shots.length}`,
        id: data.title || 'imported',
        label: `导入：${data.title}（${data.story.shots.length} 镜）`,
        story: data.story, autoTitle: data.title ?? ''});
    flashStatus('导入成功');
  } catch (e) {
    showErr(`导入失败：${e.message}`);
  }
});
document.getElementById('ss-import').addEventListener('click',
    () => importFile.click());
document.body.append(importFile);

/* —— 已保存工程（IDB 自动保存件） —— */
document.getElementById('ss-idb').addEventListener('click', async () => {
  const db = await openDB();
  const list = await listProjects(db);
  if (!list.length) {
    flashStatus('还没有已保存的工程（编辑页点「保存」后出现在这里）');
    return;
  }
  const overlay = h('div.picker-overlay');
  const box = h('div.picker-box.picker-story-box');
  const listEl = h('div.picker-story-list');
  for (const p of list) {
    listEl.append(h('button.picker-cell.picker-story', {onclick: async () => {
      overlay.remove();
      try {
        const project = await loadProject(db, p.id);
        const s0 = project?.stories?.[0];
        if (!s0) throw new Error('工程数据缺失');
        const story = normalizeScript(s0.shots);
        story.title = s0.title ?? p.id;
        setSource({key: `idb:${p.id}`, id: p.id,
            label: `已保存工程：${s0.title ?? p.id}（${story.shots.length} 镜）`,
            story, autoTitle: s0.title ?? p.id});
      } catch (e) {
        showErr(`载入失败：${e.message}`);
      }
    }},
        h('span.picker-id', {text: p.id}),
        h('span.picker-brief', {text: p.title ?? ''})));
  }
  box.append(h('div.picker-bar', {}, h('b', {text: '已保存的工程'}),
      h('span.spacer'),
      h('button.tiny', {text: '关闭', onclick: () => overlay.remove()})), listEl);
  overlay.append(box);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  document.body.append(overlay);
});

/* —— 开始编辑：新建/装载 → 场景写入首镜 → 进入第 2 页；
   同来源返回改场景 → 差异以一次可撤销 structure 落到现有 doc。 —— */
const currentTitle = () => document.getElementById('ss-title').value.trim()
    || setup.title || setup.id || '未命名剧情';

function ensureStory() {
  if (editor.doc && activeKey === setup.sourceKey) return null;
  if (setup.sourceKey.startsWith('new:')) {
    return {story: normalizeScript([createShot()]),
        applied: {bg: null, music: null}};
  }
  if (!setup.story) throw new Error('还没有装载剧本');
  return {story: setup.story, applied: currentSceneTruth(setup.story)};
}

document.getElementById('ss-continue').addEventListener('click', () => {
  try {
    showErr('');
    const entry = ensureStory();
    const scene = {bg: setup.bg, music: setup.music};
    document.body.dataset.step = 'edit';
    if (entry) {
      applySceneMutate(entry.story, scene, entry.applied);
      setup.applied = currentSceneTruth(entry.story);
      currentId = setup.id ?? currentTitle();
      editor.meta = {title: currentTitle(), sector: '绿洲防线'};
      activeKey = setup.sourceKey;
      editor.useStory(entry.story);
    } else {
      editor.doc.structure((s) => applySceneMutate(s, scene, setup.applied),
          {label: '开场场景'});
      setup.applied = currentSceneTruth(editor.doc.story);
      editor.meta = {title: currentTitle(), sector: '绿洲防线'};
    }
    document.getElementById('story-label').textContent =
        `${currentId ?? currentTitle()} · ${editor.doc.story.shots.length} 镜`;
    renderStage();
  } catch (e) {
    document.body.dataset.step = 'setup';
    showErr(e.message);
  }
});

/* ==================== 第 2 页：检查器（编辑）+ 预览 ==================== */

/* 分镜列表按需求不保留；Editor.renderList 仍要容器，给隐藏 div 承接。 */
const hiddenShots = h('div', {style: {display: 'none'}});
document.body.append(hiddenShots);

const editor = new Editor({
  player, registry, characters,
  dom: {
    shotList: hiddenShots,
    inspector: document.getElementById('inspector'),
    pos: document.getElementById('tp-pos'),
    undo: document.getElementById('btn-undo'),
    redo: document.getElementById('btn-redo'),
  },
  meta: {},
  onDoc: (doc) => doc.subscribe(debounceSave),
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
    registry, characters: editor.characters, glossary, effects: avgEffects,
  });
}
async function doSave(silent) {
  if (!editor.doc) return;
  const project = await buildProject();
  lastSave = JSON.stringify(project);
  await saveProject(await openDB(), currentId, project);
  await touchProjectIndex(await openDB(), currentId);
  if (!silent) flashStatus('已保存');
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
  download(`${currentId ?? 'story'}.yuntu.json`,
      lastSave ?? JSON.stringify(await buildProject()), 'application/json');
});
document.getElementById('btn-export-zip').addEventListener('click', async () => {
  flashStatus('打包中…');
  const zip = await exportZip({project: await buildProject()});
  download(`${currentId ?? 'story'}.yuntu.zip`, zip, 'application/zip');
});

/* —— 音效开关 —— */
const btnSound = document.getElementById('btn-sound');
btnSound.addEventListener('click', () => {
  audio.setMuted(!audio.muted);
  btnSound.textContent = audio.muted ? '音效·关' : '音效·开';
});

/* —— 返回第 1 页（连播停掉，doc 与撤销栈原样保留） —— */
document.getElementById('btn-back').addEventListener('click', () => {
  stopPlay();
  document.body.dataset.step = 'setup';
  renderBgPane();
  renderMusicPane();
  renderCounts();
  renderStage();
});

/* —— 预览传输（与 index.html 同一套推进/连播/倍速逻辑） —— */
const playState = {playing: false, timer: null};
const tpPlay = document.getElementById('tp-play');
const tpRate = document.getElementById('tp-rate');

function stopPlay() {
  if (!playState.playing) return;
  playState.playing = false;
  clearInterval(playState.timer);
  tpPlay.textContent = '▶ 连播';
}

/* 引擎只在 shotEnd 处可推进，轮询间隔就是额外的节拍门。 */
const PLAY_POLL = 250;
function tick() {
  if (!playState.playing) return;
  if (player.playEnd) { stopPlay(); return; }
  if (player.refs.avgChoices.className) { stopPlay(); return; }
  if (player.shotEnd) {
    player.playShot();
    syncIndex();
  }
}
function schedulePoll() {
  clearInterval(playState.timer);
  playState.timer = setInterval(tick, PLAY_POLL / player.rate);
}
function startPlay() {
  playState.playing = true;
  tpPlay.textContent = '⏸ 暂停';
  schedulePoll();
  tick();
}
function syncIndex() {
  const story = editor.doc?.story;
  if (!story) return;
  const wire = Number(player.shotId);
  const index = story.format === 'array' ? wire : story.indexToWire.indexOf(wire);
  if (index >= 0 && index !== editor.index) {
    editor.index = index;
    editor.renderList();
    editor.renderInspector();
  }
}
tpPlay.addEventListener('click', () =>
    (playState.playing ? stopPlay() : startPlay()));

/* 预览倍速：10× 通读整段剧情（引擎侧 JS 定时全压，见 Player.setRate）。 */
const FAST_RATE = 10;
tpRate.addEventListener('click', () => {
  const fast = player.rate === 1;
  player.setRate(fast ? FAST_RATE : 1);
  tpRate.textContent = fast ? `${FAST_RATE}×` : '1×';
  if (playState.playing) schedulePoll();
});

/* 预览状态开关：定格 / 播放本镜 / 连续播放。 */
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

/* —— 首屏：默认「新建空白剧本」 —— */
setSource({key: 'new:0', id: null, label: '新建空白剧本（1 镜）',
    story: null, autoTitle: ''});
