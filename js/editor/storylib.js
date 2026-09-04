/* storylib.js —— M14 剧本库：1878 段 AvgCfg 的浏览/搜索/装载。
 *
 * 数据面（Node 可测）：
 * - storyLabels/filterStories/storyGroups：分组名优先取档案归属（活动名、有名的
 *   主线扇区名），档案挂不上名的（无扇区主线、未归档）退回 ID 首段（groupOf）；
 *   子串搜索按 ID；
 * - archiveRows：把 data/index/story-archive.json（游戏「行动记录」的现成分类
 *   还原件，生成见 tools/build-story-archive.mjs）摊平成浏览行；
 * - loadStory：fetch 字节码 → lundump/lvm 解码 → avgwire 映射，返回
 *   {wire, stats}——与 selftest-avg.html / tools/test-avg-e2e.mjs 同一条链。
 * UI 面：openStoryPicker 复用素材选择器的模态骨架（列表式，无缩略图），
 * 行 = ID + 镜数 + 简介（stripMarkup 截断），点行回 {id} 由宿主装载。
 * 两种视图：全部 = 按 ID 平铺（分组下拉＝档案归属名，档案无名者退回 ID 首段）；
 * 行动记录 = 档案分类分段。
 */

import {h, clear} from '../ui/dom.js';
import {parseChunk} from '../core/lundump.js';
import {execChunk, toJS} from '../core/lvm.js';
import {storyToWire} from '../core/avgwire.js';
import {stripMarkup} from '../core/schema.js';

export const PAGE = 120;

/* 剧情组兜底名 = ID 首段：cpt00_e_01_01 → cpt00，23spring_hb_x → 23spring。 */
export const groupOf = (id) => String(id).split('_')[0];

/* 档案 → 段 ID 的分组名：活动名优先，其次有名的主线扇区名，其余（无扇区主线、
   未归档那一大坨）退回 ID 首段——挂不上档的段并成一组没有筛选价值。
   与 archiveRows 同一条归属规则：同一段只认第一次出现的分区。 */
export function storyLabels(archive) {
  if (!archive) return null;
  const labels = new Map();
  const claim = (id, label) => { if (!labels.has(id)) labels.set(id, label); };
  for (const c of archive.classes) {
    for (const a of c.activities) {
      for (const s of a.stories) claim(s.id, a.name ?? `活动${a.id}`);
    }
  }
  for (const m of archive.mainline) {
    if (m.name) for (const s of m.stories) claim(s.id, m.name);
  }
  return labels;
}

const labelOf = (labels, id) => (labels && labels.get(id)) || groupOf(id);

export function filterStories(stories, {query = '', group = null, labels = null} = {}) {
  const q = query.toLowerCase();
  return stories.filter((s) =>
      (!group || labelOf(labels, s.id) === group)
      && (!q || s.id.toLowerCase().includes(q)));
}

export function storyGroups(manifest, labels = null) {
  const counts = new Map();
  for (const s of manifest.stories) {
    const g = labelOf(labels, s.id);
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => ({label, count}))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/* 档案 → 浏览行。归属由档案定，镜数只有 manifest 有（生成侧已保证档案只指向语料
   里有的段）。同一段只归第一次出现的分区：复刻活动与原作共用段时归原作。 */
export function archiveRows(archive, manifest) {
  const steps = new Map(manifest.stories.map((s) => [s.id, s.steps]));
  const listed = new Set();
  const rows = [];
  const emit = (section, stories) => {
    let headered = false;
    for (const s of stories) {
      if (listed.has(s.id)) continue;
      listed.add(s.id);
      if (!headered) { rows.push({section}); headered = true; }
      rows.push({id: s.id, steps: steps.get(s.id), brief: s.brief ?? s.name});
    }
  };
  for (const c of archive.classes) {
    for (const a of c.activities) {
      emit(`${c.name}｜${a.name ?? a.id}${a.year ? ` · ${a.year}` : ''}`, a.stories);
    }
  }
  for (const m of archive.mainline) emit(`主线｜${m.name ?? m.sectorId}`, m.stories);
  emit('未归档', archive.unarchived.map((id) => ({id})));
  return rows;
}

/* 解码 + 映射一条龙；meta = avg-scripts.json 的条目 {id, cfg, lang}。
   两张构建期估出的表（build-asset-index 生成，随 manifest 一起取）：
   heroSprites 角色 → 她的立绘集、pathOwner 立绘 → 精确归属角色。映射层用
   它们给说话者补揭示；缺席时该步跳过（纯夹具/旧索引模式）。
   （旧第三张 imgIds 槽位表只留给编辑器查归属——落名层已于 2026-09-03 退役，
   见 avgwire 头注与 tools/audit-decode-completeness.mjs。） */
export async function loadStory(fetchImpl, meta, {heroSprites, pathOwner} = {}) {
  const decode = async (path) => {
    const res = await fetchImpl('/' + path);
    if (!res.ok) throw new Error(`${path} → ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    return toJS(execChunk(parseChunk(bytes))[0]);
  };
  const cfg = await decode(meta.cfg);
  const lang = await decode(meta.lang);
  return storyToWire(cfg, lang, {heroSprites, pathOwner});
}

export function openStoryPicker(manifest, {title = '剧本库', archive = null, onPick} = {}) {
  const labels = storyLabels(archive);
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
  let mode = 'all';                 /* all=按 ID 平铺 | archive=行动记录分类 */
  let offset = 0;
  let items = [];

  const row = (it) => h('button.picker-cell.picker-story', {onclick: () => onPick({id: it.id})},
      h('span.picker-id', {text: it.id}),
      h('span.picker-steps', {text: it.steps != null ? `${it.steps} 镜` : ''}),
      h('span.picker-brief', {text: it.brief ? stripMarkup(it.brief) : ''}));

  /* 分区标题只在它下面还有行时留（分区内行连续，看下一格即可）。 */
  const dropEmptySections = (rows) => {
    const q = query.toLowerCase();
    const kept = rows.filter((r) => r.section || !q || r.id.toLowerCase().includes(q));
    return kept.filter((r, i) => !r.section || (kept[i + 1] && !kept[i + 1].section));
  };

  function refill(reset = true) {
    if (reset) { offset = 0; clear(list); }
    items = mode === 'archive' && archive
        ? dropEmptySections(archiveRows(archive, manifest))
        : filterStories(manifest.stories, {query, group, labels});
    if (!items.length) {
      list.append(h('div.muted', {text: '没有匹配的剧本'}));
      return;
    }
    for (const it of items.slice(offset, offset + PAGE)) {
      if (it.section) list.append(h('div.picker-group', {text: it.section}));
      else list.append(row(it));
    }
    offset += PAGE;
    if (offset < items.length) {
      list.append(h('button.picker-more',
          {text: `加载更多（${items.length - offset}）`, onclick: () => refill(false)}));
    }
  }

  search.addEventListener('input', () => { query = search.value.trim(); refill(); });
  groupSel.append(h('option', {value: '', text: '全部分组'}),
      ...storyGroups(manifest, labels).map(({label, count}) =>
          h('option', {value: label, text: `${label}（${count}）`})));
  groupSel.addEventListener('change', () => { group = groupSel.value || null; refill(); });

  const modeBtn = archive
      ? h('button.tiny', {text: '行动记录', onclick: () => {
          mode = mode === 'all' ? 'archive' : 'all';
          modeBtn.textContent = mode === 'all' ? '行动记录' : '全部';
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
