/* picker.js —— M8 素材选择器：搜索仓库索引 / 上传本地文件 / 选一张回一个
   {name, url, kind}。模态浮层，纯 DOM（ui/dom.js），不依赖播放器。
   立绘条目回的是「角色 id」——选中后由调用方决定拿 lpic 还是进标定。 */

import {h, clear} from '../ui/dom.js';
import {searchBackgrounds, searchCharacters, searchAudio, audioSheets}
    from '../core/repo-index.js';

const PAGE = 120;

export function openPicker(registry, {title = '选择素材', kind = 'bg', onPick} = {}) {
  const overlay = h('div.picker-overlay');
  const box = h('div.picker-box');
  const search = h('input', {
    className: 'picker-search', placeholder: '搜索名字 / 分组…',
  });
  const grid = h('div.picker-grid');
  const bar = h('div.picker-bar');
  let query = '';
  let offset = 0;
  let items = [];

  const label = (it) => (kind === 'bg' ? it.name : it.id);
  const urlOf = (it) => (kind === 'bg'
      ? registry.resolve(it.name + '.png')?.url ?? it.path
      : registry.resolve(`Lpic_${it.id}.png`)?.url ?? it.lpic);

  function refill(reset = true) {
    if (reset) { offset = 0; clear(grid); }
    const more = kind === 'bg'
        ? searchBackgrounds(registry.repo, query)
        : searchCharacters(registry.repo, query, {avgOnly: false});
    items = more;
    for (const it of more.slice(offset, offset + PAGE)) {
      const thumb = h('img', {src: urlOf(it), loading: 'lazy', alt: label(it)});
      const badge = kind === 'chara' && !registry.layoutEntry(it.id)
          ? h('span.picker-warn', {text: '⚠'}) : null;
      grid.append(h('button.picker-cell', {onclick: () => onPick({
        name: label(it), url: urlOf(it), kind, item: it,
      })}, thumb, badge, h('span', {text: label(it)})));
    }
    offset += PAGE;
    if (offset < items.length) {
      grid.append(h('button.picker-more',
          {text: `加载更多（${items.length - offset}）`, onclick: () => refill(false)}));
    }
  }

  search.addEventListener('input', () => { query = search.value.trim(); refill(); });

  const kindBtn = h('button.tiny', {text: kind === 'bg' ? '切到立绘' : '切到背景'});
  kindBtn.addEventListener('click', () => {
    kind = kind === 'bg' ? 'chara' : 'bg';
    kindBtn.textContent = kind === 'bg' ? '切到立绘' : '切到背景';
    refill();
  });

  const file = h('input', {type: 'file', multiple: true, className: 'picker-file'});
  file.addEventListener('change', async () => {
    for (const f of file.files) {
      await registry.upload(f.name, f, {kind: 'image'});
    }
    file.value = '';
    if (kind === 'bg') {
      const added = [];
      for (const f of [...registry.listUploads({kind: 'image'})]) {
        if (!registry.repo.backgrounds.some((b) => f.name.toLowerCase() === b.name + '.png')) {
          added.push({name: f.name.replace(/\.png$/i, ''), group: '上传', path: f.key});
        }
      }
      registry.repo.backgrounds = added.concat(registry.repo.backgrounds);
    }
    refill();
  });

  bar.append(
      h('b', {text: title}), kindBtn,
      h('button.tiny', {text: '上传文件…', onclick: () => file.click()}),
      file,
      h('span.spacer'),
      h('button.tiny', {text: '关闭', onclick: () => overlay.remove()}));
  box.append(bar, search, grid);
  overlay.append(box);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.append(overlay);
  search.focus();
  refill();
  return overlay;
}

/* —— 音频选择器：列表式（无缩略图），行内 ▶ 试听，点行选中。
   数据来自 data/index/audio.json（转码件）；空库给转码指引。 */

const fmtDur = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
let previewAudio = null;      /* 试听单例：跨浮层/检查器只响一条 */
let previewBtn = null;

function stopPreview() {
  if (previewAudio) { previewAudio.pause(); previewAudio = null; }
  if (previewBtn) { previewBtn.textContent = '▶'; previewBtn = null; }
}

/* ▶/⏹ 切换试听（选择器与检查器音乐区共用同一单例）。 */
export function toggleAudioPreview(url, btn) {
  if (previewAudio && previewBtn === btn) { stopPreview(); return; }
  stopPreview();
  previewAudio = new Audio(url);
  previewAudio.play().catch(() => {});
  previewAudio.addEventListener('ended', stopPreview);
  previewBtn = btn;
  btn.textContent = '⏹';
}

export function openAudioPicker(registry, {title = '选择音频', onPick} = {}) {
  const overlay = h('div.picker-overlay');
  const box = h('div.picker-box');
  const search = h('input', {className: 'picker-search', placeholder: '搜索 cue / sheet…'});
  const sheetSel = h('select');
  const grid = h('div.picker-grid');
  const bar = h('div.picker-bar');
  let query = '';
  let sheet = null;
  let offset = 0;
  let items = [];

  function refill(reset = true) {
    if (reset) { offset = 0; clear(grid); }
    items = searchAudio(registry.repo, query, {sheet});
    if (!items.length && !offset) {
      grid.append(h('div.muted', {
        text: registry.repoAvailable && !audioSheets(registry.repo).length
            ? '音频库为空：先运行 node tools/media/unpack-acb.mjs 转码'
            : '没有匹配的音频',
      }));
      return;
    }
    for (const it of items.slice(offset, offset + PAGE)) {
      const play = h('button.tiny', {text: '▶', onclick: (e) => {
        e.stopPropagation();
        toggleAudioPreview(it.path, play);
      }});
      grid.append(h('button.picker-cell.picker-audio', {onclick: () => {
        stopPreview();
        onPick({sheet: it.sheet, cue: it.cue, url: it.path});
      }},
      play,
      h('span', {text: it.cue}),
      h('span.picker-sheet', {text: it.sheet}),
      h('span.picker-dur', {text: fmtDur(it.duration)})));
    }
    offset += PAGE;
    if (offset < items.length) {
      grid.append(h('button.picker-more',
          {text: `加载更多（${items.length - offset}）`, onclick: () => refill(false)}));
    }
  }

  search.addEventListener('input', () => { query = search.value.trim(); refill(); });
  sheetSel.append(h('option', {value: '', text: '全部 sheet'}),
      ...audioSheets(registry.repo).map((s) => h('option', {value: s, text: s})));
  sheetSel.addEventListener('change', () => { sheet = sheetSel.value || null; refill(); });

  bar.append(
      h('b', {text: title}), sheetSel,
      h('span.spacer'),
      h('button.tiny', {text: '关闭', onclick: () => { stopPreview(); overlay.remove(); }}));
  box.append(bar, h('div.row', {style: {display: 'flex', gap: '6px'}}, search), grid);
  overlay.append(box);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) { stopPreview(); overlay.remove(); }
  });
  document.body.append(overlay);
  search.focus();
  refill();
  return overlay;
}
