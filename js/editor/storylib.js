/* storylib.js —— M14 剧本库：1878 段 AvgCfg 的浏览/搜索/装载。
 *
 * 数据面（Node 可测）：
 * - groupOf/filterStories：按 ID 首段分组（cpt00/23spring/dorm/…）、子串搜索；
 * - loadStory：fetch 字节码 → lundump/lvm 解码 → avgwire 映射，返回
 *   {wire, stats}——与 selftest-avg.html / tools/test-avg-e2e.mjs 同一条链。
 * UI 面：openStoryPicker 复用素材选择器的模态骨架（列表式，无缩略图），
 * 行 = ID + 镜数 + 简介（stripMarkup 截断），点行回 {id} 由宿主装载。
 */

import {h, clear} from '../ui/dom.js';
import {parseChunk} from '../core/lundump.js';
import {execChunk, toJS} from '../core/lvm.js';
import {storyToWire} from '../core/avgwire.js';
import {stripMarkup} from '../core/schema.js';

export const PAGE = 120;

/* 剧情组 = ID 首段：cpt00_e_01_01 → cpt00，23spring_hb_x → 23spring。 */
export const groupOf = (id) => String(id).split('_')[0];

export function filterStories(stories, {query = '', group = null} = {}) {
  const q = query.toLowerCase();
  return stories.filter((s) =>
      (!group || groupOf(s.id) === group)
      && (!q || s.id.toLowerCase().includes(q)));
}

export function storyGroups(manifest) {
  const seen = new Set();
  for (const s of manifest.stories) seen.add(groupOf(s.id));
  return [...seen].sort();
}

/* 解码 + 映射一条龙；meta = avg-scripts.json 的条目 {id, cfg, lang}。
   imgIds / heroSprites 是全局立绘表与说话者立绘桥表（build-asset-index
   生成，随 manifest 一起取），供映射层给悬空 tween 落名、给说话者复亮；
   缺席时该两步跳过（纯夹具/旧索引模式）。 */
export async function loadStory(fetchImpl, meta, {imgIds, heroSprites} = {}) {
  const decode = async (path) => {
    const res = await fetchImpl('/' + path);
    if (!res.ok) throw new Error(`${path} → ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    return toJS(execChunk(parseChunk(bytes))[0]);
  };
  const cfg = await decode(meta.cfg);
  const lang = await decode(meta.lang);
  return storyToWire(cfg, lang, {imgIds, heroSprites});
}

export function openStoryPicker(manifest, {title = '剧本库', catalog = null, onPick} = {}) {
  const overlay = h('div.picker-overlay');
  const box = h('div.picker-box.picker-story-box');
  const search = h('input', {
    className: 'picker-search', placeholder: '搜索剧情 ID…',
  });
  const groupSel = h('select');
  const list = h('div.picker-grid.picker-story-list');
  const bar = h('div.picker-bar');
  let query = '';
  let group = null;
  let mode = 'all';                 /* all=按 ID 平铺 | line=剧情目录分组 */
  let offset = 0;
  let items = [];

  const row = (it) => h('button.picker-cell.picker-story', {onclick: () => onPick({id: it.id})},
      h('span.picker-id', {text: it.id}),
      h('span.picker-steps', {text: it.steps != null ? `${it.steps} 镜` : ''}),
      h('span.picker-brief', {text: it.brief ? stripMarkup(it.brief) : ''}));

  function refill(reset = true) {
    if (reset) { offset = 0; clear(list); }
    let flat;
    if (mode === 'line' && catalog) {
      flat = [];
      for (const g of catalog.groups) {
        for (const s of g.stories) {
          if (query && !s.id.toLowerCase().includes(query)) continue;
          flat.push({...s, group: g.groupId});
        }
      }
    } else {
      flat = filterStories(manifest.stories, {query, group});
    }
    items = flat;
    if (!items.length) {
      list.append(h('div.muted', {text: '没有匹配的剧本'}));
      return;
    }
    let lastGroup = null;
    for (const it of items.slice(offset, offset + PAGE)) {
      if (mode === 'line' && it.group !== lastGroup) {
        lastGroup = it.group;
        list.append(h('div.picker-group',
            {text: `剧情组 ${it.group}（${catalog.groups.find((g) => g.groupId === it.group)?.stories.length ?? ''}）`}));
      }
      list.append(row(it));
    }
    offset += PAGE;
    if (offset < items.length) {
      list.append(h('button.picker-more',
          {text: `加载更多（${items.length - offset}）`, onclick: () => refill(false)}));
    }
  }

  search.addEventListener('input', () => { query = search.value.trim(); refill(); });
  groupSel.append(h('option', {value: '', text: '全部分组'}),
      ...storyGroups(manifest).map((g) => h('option', {value: g, text: g})));
  groupSel.addEventListener('change', () => { group = groupSel.value || null; refill(); });

  const modeBtn = catalog
      ? h('button.tiny', {text: '剧情线', onclick: () => {
          mode = mode === 'all' ? 'line' : 'all';
          modeBtn.textContent = mode === 'all' ? '剧情线' : '全部';
          groupSel.style.display = mode === 'all' ? '' : 'none';
          refill();
        }})
      : null;

  bar.append(
      h('b', {text: title}), modeBtn, groupSel,
      h('span.spacer'),
      h('span.muted', {text: `${manifest.stories.length} 段 · 数据源 res/Assets/Res/LuaScripts`}),
      h('button.tiny', {text: '关闭', onclick: () => overlay.remove()}));
  box.append(bar, search, list);
  overlay.append(box);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.append(overlay);
  search.focus();
  refill();
  return overlay;
}
