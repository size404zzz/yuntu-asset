/* storylib.js —— M14 剧本库：1878 段 AvgCfg 的浏览/搜索/装载。
 *
 * 数据面（Node 可测）：
 * - groupOf/filterStories/storyGroups：无档案时分组名退回 ID 首段，子串搜索按 ID；
 * - archiveTree：把 data/index/story-archive.json（游戏「行动记录」的现成分类
 *   还原件，生成见 tools/build-story-archive.mjs）立成三层剧情树——
 *   分类（大型/常规/专属 + 主线 + 未归档）→ 年份/扇区/ID 首段 → 活动 → 剧情段；
 * - loadStory：fetch 字节码 → lundump/lvm 解码 → avgwire 映射，返回
 *   {wire, stats}——与 selftest-avg.html / tools/test-avg-e2e.mjs 同一条链。
 * UI 面：openStoryPicker 复用素材选择器的模态骨架。有档案时默认剧情树视图
 * （左轨 = 分类 + 年份，右栏 = 活动 → 剧情，照游戏「行动记录」的层级），
 * 搜索框一有输入就切回按 ID 的平铺结果；无档案时保持旧的平铺 + 分组下拉。
 */

import {h, clear} from '../ui/dom.js';
import {parseChunk} from '../core/lundump.js';
import {execChunk, toJS} from '../core/lvm.js';
import {storyToWire} from '../core/avgwire.js';
import {stripMarkup} from '../core/schema.js';

export const PAGE = 120;

/* 剧情组兜底名 = ID 首段：cpt00_e_01_01 → cpt00，23spring_hb_x → 23spring。 */
export const groupOf = (id) => String(id).split('_')[0];

export function filterStories(stories, {query = '', group = null} = {}) {
  const q = query.toLowerCase();
  return stories.filter((s) =>
      (!group || groupOf(s.id) === group)
      && (!q || s.id.toLowerCase().includes(q)));
}

export function storyGroups(manifest) {
  const counts = new Map();
  for (const s of manifest.stories) {
    const g = groupOf(s.id);
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => ({label, count}))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/* 档案 → 三层剧情树。顶层 = 分类（档案 classes 顺序）+ 主线 + 未归档；
 * 中层组 = 年份（有年份的分类）/ 活动本身（无年份的手工分类，如宿舍剧情·
 * 其他剧情）/ 扇区（主线）/ ID 首段或 group（未归档）；叶子 = 剧情段
 * （镜数从 manifest 补，档案只管归属）。主线扇区、未归档分组与无年份分类
 * 没有真「活动」层，各包一个同名虚拟活动，UI 对单同名活动组直通到剧情。
 * 年份降序、年份未定的活动垫底；未归档按组大小排；空节点不进树。 */
export function archiveTree(archive, manifest) {
  const steps = new Map(manifest.stories.map((s) => [s.id, s.steps]));
  const storyOf = (s) => ({id: s.id, steps: steps.get(s.id), brief: s.brief ?? s.name});
  const push = (map, key, val) => {
    const list = map.get(key) ?? [];
    list.push(val);
    map.set(key, list);
  };

  const nodes = archive.classes.map((c) => {
    /* 无年份的分类（宿舍剧情/其他剧情这类手工分类）不硬造年份层：
     * 活动本身即中层组，与主线/未归档同形。 */
    if (!c.activities.some((a) => a.year != null)) {
      return {
        name: c.name,
        kind: 'class',
        groups: c.activities.map((a) => ({
          label: a.name ?? `活动${a.id}`,
          activities: [{id: a.id, name: a.name ?? `活动${a.id}`,
                        stories: a.stories.map(storyOf)}],
        })),
      };
    }
    const byYear = new Map();
    for (const a of c.activities) {
      push(byYear, a.year != null ? String(a.year) : '年份未定',
          {id: a.id, name: a.name ?? `活动${a.id}`, stories: a.stories.map(storyOf)});
    }
    const labels = [...byYear.keys()].sort((x, y) =>
        x === '年份未定' ? 1 : y === '年份未定' ? -1 : Number(y) - Number(x));
    return {
      name: c.name,
      kind: 'class',
      groups: labels.map((label) => ({label, activities: byYear.get(label)})),
    };
  });

  nodes.push({
    name: '主线',
    kind: 'bin',
    groups: archive.mainline.map((m) => {
      const label = m.name ?? (m.sectorId != null ? `扇区 ${m.sectorId}` : '未分扇区');
      return {label, activities: [{name: label, stories: m.stories.map(storyOf)}]};
    }),
  });

  const byPrefix = new Map();
  /* unarchived 条目：{id, group}（生成器按游戏数据命名）；旧版为纯 id 字符串，
   * 退回 ID 首段分组。 */
  for (const entry of archive.unarchived) {
    const id = typeof entry === 'string' ? entry : entry.id;
    const group = typeof entry === 'string' ? groupOf(id) : (entry.group ?? groupOf(id));
    push(byPrefix, group, {id, steps: steps.get(id)});
  }
  nodes.push({
    name: '未归档',
    kind: 'bin',
    groups: [...byPrefix.entries()]
        .sort((x, y) => y[1].length - x[1].length || x[0].localeCompare(y[0]))
        .map(([label, stories]) => ({label, activities: [{name: label, stories}]})),
  });
  /* 空节点不进树：picker 的 renderMain 直接取 groups[group]，空层会踩空。
   * 未归档被手工分类抽空后就是这样（「待分类」再使用时它自己会回来）。 */
  return nodes.filter((n) => n.groups.length);
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
  const overlay = h('div.picker-overlay');
  const box = h('div.picker-box.picker-story-box');
  const search = h('input', {
    className: 'picker-search', placeholder: '搜索剧情 ID…',
  });
  const rail = h('div.picker-tree-rail');
  const main = h('div.picker-tree-main');
  const tree = archive ? archiveTree(archive, manifest) : null;
  const treeEl = tree ? h('div.picker-tree', rail, main) : null;
  const groupSel = h('select');
  const list = h('div.picker-grid.picker-story-list');
  const bar = h('div.picker-bar');
  let query = '';
  let pickGroup = null;              /* 平铺视图的 ID 首段筛选（仅无档案下拉） */
  let offset = 0;
  let items = [];
  let cat = 0;                       /* 树游标：顶层分类 */
  let group = 0;                     /* 中层组（年份/扇区/首段） */
  let act = null;                    /* 活动下钻序号；null = 活动列表层 */

  const row = (it) => h('button.picker-cell.picker-story', {onclick: () => onPick({id: it.id})},
      h('span.picker-id', {text: it.id}),
      h('span.picker-steps', {text: it.steps != null ? `${it.steps} 镜` : ''}),
      h('span.picker-brief', {text: it.brief ? stripMarkup(it.brief) : ''}));

  /* —— 剧情树视图：左轨 = 分类 + 选中分类的年份组，右栏 = 活动 → 剧情 —— */
  const groupCount = (g) => g.activities.reduce((n, a) => n + a.stories.length, 0);

  function renderMain() {
    clear(main);
    const node = tree[cat];
    const g = node.groups[group];
    /* 组里只有一个同名活动壳（主线/未归档/无年份分类）：直通剧情，
     * 不渲染多余的卡片层。 */
    const direct = g.activities.length === 1 && g.activities[0].name === g.label;
    if (act == null && !direct) {
      main.append(h('div.picker-crumb', {text: `${node.name} · ${g.label} · ${groupCount(g)} 段`}));
      g.activities.forEach((a, i) => main.append(h('button.picker-act',
          {onclick: () => { act = i; renderMain(); }},
          h('b', {text: a.name}),
          h('span.picker-act-n', {text: `${a.stories.length} 段`}),
          h('span.picker-act-view', {text: '查看 ▶'}))));
    } else {
      const a = g.activities[direct ? 0 : act];
      if (!direct) {
        main.append(h('button.picker-back',
            {text: '‹ 返回活动列表', onclick: () => { act = null; renderMain(); }}));
      }
      main.append(h('div.picker-crumb',
          {text: direct ? `${node.name} · ${g.label}` : `${node.name} · ${g.label} · ${a.name}`}));
      if (a.stories.length) for (const s of a.stories) main.append(row(s));
      else main.append(h('div.muted.picker-empty', {text: '该活动在语料里没有可装载的剧情段'}));
    }
    main.scrollTop = 0;
  }

  function renderRail() {
    clear(rail);
    tree.forEach((node, i) => rail.append(h(
        `button.picker-tree-cat${i === cat ? '.selected' : ''}`,
        {onclick: () => { cat = i; group = 0; act = null; renderRail(); renderMain(); }},
        h('span', {text: node.name}),
        h('span.picker-tree-n',
            {text: String(node.groups.reduce((n, g) => n + groupCount(g), 0))}))));
    const cur = tree[cat];
    rail.append(h('div.picker-tree-sub'));
    cur.groups.forEach((g, i) => rail.append(h(
        `button.picker-tree-year${i === group ? '.selected' : ''}`,
        {onclick: () => { group = i; act = null; renderRail(); renderMain(); }},
        h('span', {text: g.label}),
        h('span.picker-tree-n', {text: String(groupCount(g))}))));
  }

  /* —— 平铺视图：搜索结果（或有档案前的旧路径）——
   * 查询同时命中两类：活动/分组名（整组带组头列出）与剧情 ID（平铺，
   * 去掉已在活动命中里出现过的段）。 */
  function refill(reset = true) {
    if (reset) { offset = 0; clear(list); }
    const q = query.toLowerCase();
    let rows;
    if (q && tree) {
      rows = [];
      const listed = new Set();
      for (const node of tree) {
        for (const g of node.groups) {
          for (const a of g.activities) {
            if ((a.name ?? '').toLowerCase().includes(q)) {
              /* 无年份分类/主线/未归档的组名就是活动名，路径里重复的段丢掉 */
              const trail = [node.name, g.label]
                  .filter((x, i, arr) => x !== a.name && arr.indexOf(x) === i)
                  .join('｜');
              rows.push({header: trail ? `${a.name}（${trail}）` : a.name});
              for (const s of a.stories) {
                if (!listed.has(s.id)) { listed.add(s.id); rows.push(s); }
              }
            }
          }
        }
      }
      for (const s of filterStories(manifest.stories, {query, group: pickGroup})) {
        if (!listed.has(s.id)) rows.push(s);
      }
    } else {
      rows = filterStories(manifest.stories, {query, group: pickGroup});
    }
    if (!rows.length) {
      list.append(h('div.muted', {text: '没有匹配的剧本'}));
      return;
    }
    items = rows;
    const view = rows.slice(offset, offset + PAGE);
    for (const it of view) {
      if (it.header) list.append(h('div.picker-group', {text: it.header}));
      else list.append(row(it));
    }
    offset += view.length;
    if (offset < rows.length) {
      list.append(h('button.picker-more',
          {text: `加载更多（${rows.length - offset}）`, onclick: () => refill(false)}));
    }
  }

  const syncView = () => {
    const browsing = tree !== null && !query;
    treeEl.style.display = browsing ? '' : 'none';
    list.style.display = browsing ? 'none' : '';
    if (browsing) { renderRail(); renderMain(); } else refill();
  };

  search.addEventListener('input', () => { query = search.value.trim(); syncView(); });
  groupSel.append(h('option', {value: '', text: '全部分组'}),
      ...storyGroups(manifest).map(({label, count}) =>
          h('option', {value: label, text: `${label}（${count}）`})));
  groupSel.addEventListener('change', () => { pickGroup = groupSel.value || null; refill(); });

  bar.append(
      h('b', {text: title}),
      ...(tree ? [] : [groupSel]),
      h('span.spacer'),
      h('span.muted', {text: `${manifest.stories.length} 段 · 数据源 res/Assets/Res/LuaScripts`}),
      h('button.tiny', {text: '关闭', onclick: () => overlay.remove()}));
  box.append(bar, search, ...(tree ? [treeEl] : []), list);
  overlay.append(box);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.append(overlay);
  search.focus();
  syncView();
  return overlay;
}
