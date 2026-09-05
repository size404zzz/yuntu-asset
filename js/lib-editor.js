/* lib-editor.js —— 剧本库分类编辑页（lib-editor.html）。
 *
 * 编辑的是手动覆盖层 data/index/story-archive-manual.json（结构与生成档案
 * story-archive.json 同形：classes / mainline / unarchived）。编辑页以生成
 * 档案播种，保存后 main.js 优先加载手动档案，重跑生成器不冲掉人工调整。
 * 保存端点：tools/ref/serve.py 的 /archive-save；其它静态服务器退化为
 * 导出 JSON 手动放置。
 */
import {h, clear} from './ui/dom.js';

const SAVE_URL = '/archive-save';
const MANUAL_URL = 'data/index/story-archive-manual.json';
const DERIVED_URL = 'data/index/story-archive.json';
const POOL = '待分类';
const PAGE = 60;

let data = null;            /* {classes, mainline, unarchived} */
let source = 'derived';     /* derived | manual */
let manifest = null;        /* avg-scripts.json：id → {name, brief, steps} */
let sel = null;             /* 选中组 {key, kind, ci, id, name, group} */
let undoStack = [];
let dirty = false;
let savedMark = null;       /* 落盘/载入时的档案指纹：dirty 由它比对出来 */
let manualIssue = null;   /* 手动档案被跳过时给个可见说明，别让人以为调整丢了 */
let drag = null;          /* 在途拖动 {kind:'entry'|'group', id?, from?, key?} */

const $ = (id) => document.getElementById(id);
const treeEl = $('tree');
const panelEl = $('panel');

/* —— 组寻址：act = class 内活动；main = 主线组；una = 未归档组 —— */
const groupKey = (kind, tag) => `${kind}:${tag}`;
const activitiesOf = (ci) => data.classes[ci]?.activities ?? [];
const actById = (ci, id) => activitiesOf(ci).find((a) => a.id === id);
const mainByName = (name) => data.mainline.find((m) => m.name === name);
const unaByGroup = (group) => data.unarchived.filter((e) => e.group === group);
const storyName = (id) => manifest?.stories.find((s) => s.id === id)?.name ?? null;
const groupByKey = (key) => allGroups().find((g) => g.key === key);
/* 手动档案必须自成一体：缺任一个容器键都会让后续渲染/搬运读到 undefined */
const isArchive = (v) => !!v?.classes?.length
    && Array.isArray(v.mainline) && Array.isArray(v.unarchived);

function syncDirty() {
  dirty = JSON.stringify(data) !== savedMark;
  $('btn-undo').disabled = !undoStack.length;
}

function pushUndo(state) {
  undoStack.push(state);
  if (undoStack.length > 50) undoStack.shift();
  syncDirty();
}

function snapshot() {
  pushUndo(JSON.stringify(data));
}

/* 拖动落点专用：mutate() 自报有没有真改，原地拖回原位的落点不留撤销点 */
function applyDrop(mutate) {
  const mark = JSON.stringify(data);
  if (!mutate()) return false;
  pushUndo(mark);
  return true;
}

function markSource() {
  const el = $('src');
  el.textContent = source === 'manual'
      ? '数据源：手动档案（story-archive-manual.json）'
      : '数据源：生成档案（未保存过，保存后生成 story-archive-manual.json）';
  if (manualIssue) el.textContent += `｜${manualIssue}`;
  el.className = 'libed-src' + (source === 'manual' ? ' manual'
      : manualIssue ? ' warn' : '');
}

/* —— 组枚举：统一形态 {key, kind, label, count, ci, id, name, group} —— */
function allGroups() {
  const out = [];
  data.classes.forEach((cls, ci) => {
    const byYear = new Map();
    for (const a of activitiesOf(ci)) {
      const y = String(a.year ?? '年份未定');
      (byYear.get(y) ?? byYear.set(y, []).get(y)).push(a);
    }
    /* 整分类都没有年份（宿舍剧情/其他剧情这类手工分类）就不标年份 */
    const dated = activitiesOf(ci).some((a) => a.year != null);
    const years = [...byYear.keys()].sort((x, y) =>
        x === '年份未定' ? 1 : y === '年份未定' ? -1 : Number(y) - Number(x));
    for (const y of years) {
      for (const a of byYear.get(y)) {
        out.push({key: groupKey('act', `${ci}:${a.id}`), kind: 'act', ci, id: a.id,
                  year: a.year ?? null,
                  label: a.name ?? String(a.id), count: a.stories.length,
                  extra: dated ? `${cls.name}·${y}` : cls.name});
      }
    }
  });
  for (const m of data.mainline) {
    out.push({key: groupKey('main', m.name), kind: 'main', name: m.name,
              label: m.name ?? '(未命名)', count: m.stories.length, extra: '主线'});
  }
  const unaGroups = new Map();
  for (const e of data.unarchived) {
    const list = unaGroups.get(e.group) ?? [];
    list.push(e);
    unaGroups.set(e.group, list);
  }
  for (const [group, list] of [...unaGroups].sort((x, y) => y[1].length - x[1].length)) {
    out.push({key: groupKey('una', group), kind: 'una', group,
              label: group, count: list.length, extra: '未归档'});
  }
  /* 「待分类」常驻：未归档组由条目派生，全搬空后就没有靶子可以拖出/移出了 */
  if (!unaGroups.has(POOL)) {
    out.push({key: groupKey('una', POOL), kind: 'una', group: POOL,
              label: POOL, count: 0, extra: '未归档'});
  }
  return out;
}

/* —— 变更操作 —— */
function entriesOf(g) {
  if (g.kind === 'act') return actById(g.ci, g.id)?.stories;
  if (g.kind === 'main') return mainByName(g.name)?.stories;
  return null;
}

function removeFromSource(id, exceptKey = null) {
  for (const [ci, cls] of data.classes.entries()) {
    for (const a of cls.activities) {
      const i = a.stories.findIndex((s) => s.id === id);
      if (i >= 0 && groupKey('act', `${ci}:${a.id}`) !== exceptKey) {
        return [a.stories.splice(i, 1)[0], `act:${ci}:${a.id}`];
      }
    }
  }
  for (const m of data.mainline) {
    const i = m.stories.findIndex((s) => s.id === id);
    if (i >= 0 && groupKey('main', m.name) !== exceptKey) {
      return [m.stories.splice(i, 1)[0], `main:${m.name}`];
    }
  }
  const i = data.unarchived.findIndex((e) => e.id === id);
  if (i >= 0 && groupKey('una', data.unarchived[i].group) !== exceptKey) {
    /* 组名必须在 splice 前取：splice 后同下标已是邻居（末条则直接 undefined） */
    const from = `una:${data.unarchived[i].group}`;
    return [data.unarchived.splice(i, 1)[0], from];
  }
  return [null, null];
}

function toPool(id) {
  const [removed] = removeFromSource(id);
  if (removed) data.unarchived.push({id: removed.id, group: POOL});
}

/* 目标容器决定条目的规范形态：活动/主线组只留 id（+ 手改的 name），
 * 未归档只留 {id, group}——搬运转手时不把上家的 group 漏进下家。 */
function storyOfEntry(src, id) {
  return src?.name ? {id: src.id, name: src.name} : {id: src.id ?? id};
}

function place(id, g) {
  const [removed] = removeFromSource(id);
  if (g.kind === 'act') {
    actById(g.ci, g.id)?.stories.push(storyOfEntry(removed, id));
  } else if (g.kind === 'main') {
    mainByName(g.name)?.stories.push(storyOfEntry(removed, id));
  } else {
    data.unarchived.push({id: removed?.id ?? id, group: g.group});
  }
}

/* 整支并进另一支：条目全搬走，空掉的活动/主线组自己不会消失，这里连壳删掉
 * （未归档组由条目派生，搬空即自动消失）。 */
function mergeGroups(from, to) {
  const ids = (from.kind === 'una' ? unaByGroup(from.group) : entriesOf(from) ?? [])
      .map((s) => s.id);
  if (!ids.length) return false;
  for (const id of ids) place(id, to);
  if (from.kind === 'act' && !actById(from.ci, from.id)?.stories.length) {
    data.classes[from.ci].activities
        = data.classes[from.ci].activities.filter((a) => a.id !== from.id);
  } else if (from.kind === 'main' && !mainByName(from.name)?.stories.length) {
    data.mainline = data.mainline.filter((m) => m.name !== from.name);
  }
  if (sel?.key === from.key) sel = to;
  return true;
}

/* 组内拖到某个位置：act/main 直接原地重排，未归档组在全局数组里是散段，
 * 重排后收成连续段（组序仍按大小排，不影响别的组）。 */
function reorderGroup(g, id, index) {
  const list = g.kind === 'una' ? unaByGroup(g.group) : entriesOf(g);
  if (!Array.isArray(list)) return false;
  const from = list.findIndex((s) => s.id === id);
  if (from < 0) return false;
  const to = Math.max(0, Math.min(index, list.length - 1));
  if (to === from) return false;
  const [entry] = list.splice(from, 1);
  list.splice(to, 0, entry);
  if (g.kind === 'una') {
    data.unarchived = [...data.unarchived.filter((e) => e.group !== g.group), ...list];
  }
  return true;
}

function renameGroup(g, value) {
  const name = value.trim();
  if (!name) return;
  if (g.kind === 'act') {
    const a = actById(g.ci, g.id);
    if (a) a.name = name;
  } else if (g.kind === 'main') {
    const m = mainByName(g.name);
    if (m) { m.name = name; g.name = name; g.key = groupKey('main', name); }
  } else {
    for (const e of data.unarchived) {
      if (e.group === g.group) e.group = name;
    }
    g.group = name; g.key = groupKey('una', name);
  }
  sel = g;
}

function deleteGroup(g) {
  const entries = (g.kind === 'una'
      ? unaByGroup(g.group).map((e) => ({...e, group: POOL}))
      : (entriesOf(g) ?? []).map((s) => ({id: s.id, group: POOL})));
  if (g.kind === 'act') {
    const cls = data.classes[g.ci];
    cls.activities = cls.activities.filter((a) => a.id !== g.id);
  } else if (g.kind === 'main') {
    data.mainline = data.mainline.filter((m) => m.name !== g.name);
  }
  data.unarchived.push(...entries);
  sel = null;
}

function addActivity(ci, name, year) {
  const cls = data.classes[ci];
  const n = 1 + Math.max(0, ...data.classes.flatMap((c) =>
      c.activities.map((a) => Number(String(a.id).replace(/\D/g, '')) || 0)));
  const id = `manual-${n}`;
  cls.activities.push({id, name, year, type: null, stories: []});
  return id;
}

/* —— 拖动 ——
 * 条目拖到左列分组＝搬入（候选区拖过去＝加入）；分组拖到另一分组＝整支并入（减少分支）；
 * 组内拖到某行位置＝排序。载荷存模块变量：同页拖放用不着序列化，
 * setData 只为满足「不给 dataTransfer 就不许拖」的浏览器规矩。 */
function clearDropMarks() {
  for (const el of document.querySelectorAll('.drop-in,.drop-line')) {
    el.classList.remove('drop-in', 'drop-line');
  }
}

function startDrag(e, payload) {
  drag = payload;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', payload.id ?? payload.key ?? '');
  const el = e.currentTarget;
  el.classList.add('dragging');
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    drag = null;
    clearDropMarks();
  }, {once: true});
}

function dropOnGroup(e, g) {
  if (!drag || (drag.kind === 'group' && drag.key === g.key)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  clearDropMarks();
  e.currentTarget.classList.add('drop-in');
}

function droppedOnGroup(e, g) {
  e.preventDefault();
  const from = drag;
  drag = null;
  clearDropMarks();
  if (!from || (from.kind === 'group' && from.key === g.key)) return;
  const changed = applyDrop(() => {
    if (from.kind !== 'group') { place(from.id, g); return true; }
    const src = groupByKey(from.key);
    return src ? mergeGroups(src, g) : false;
  });
  if (changed) renderAll();
}

/* 指针落在哪两行之间：行上半＝插到该行前，行下半＝插到该行后 */
function insertIndex(listWrap, y) {
  const rows = [...listWrap.querySelectorAll('.libed-entry')];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i].getBoundingClientRect();
    if (y < r.top + r.height / 2) return i;
  }
  return rows.length;
}

function markLine(listWrap, index) {
  for (const el of document.querySelectorAll('.drop-line')) el.classList.remove('drop-line');
  const rows = [...listWrap.querySelectorAll('.libed-entry')];
  (rows[index] ?? listWrap).classList.add('drop-line');
}

/* —— 渲染 —— */
function renderTree() {
  clear(treeEl);
  const groups = allGroups();
  const node = (title, frag) => {
    const wrap = h('div.libed-node');
    wrap.append(h('header', {text: title}));
    wrap.append(frag);
    treeEl.append(wrap);
  };
  const groupEl = (g) => h('div.libed-group' + (sel?.key === g.key ? '.selected' : '')
      + (g.kind === 'una' && g.group === POOL ? '.libed-pool' : ''),
      {dataset: {key: g.key}, draggable: true,
        onclick: () => { sel = g; renderAll(); },
        ondragstart: (e) => startDrag(e, {kind: 'group', key: g.key}),
        ondragover: (e) => dropOnGroup(e, g),
        ondrop: (e) => droppedOnGroup(e, g)},
      h('span', {text: g.label}), h('span.n', {text: String(g.count)}));

  data.classes.forEach((cls, ci) => {
    const frag = document.createDocumentFragment();
    for (const g of groups.filter((x) => x.kind === 'act' && x.ci === ci)) {
      frag.append(groupEl(g));
    }
    node(cls.name, frag);
  });
  const mainFrag = document.createDocumentFragment();
  for (const g of groups.filter((x) => x.kind === 'main')) mainFrag.append(groupEl(g));
  node('主线', mainFrag);
  const unaFrag = document.createDocumentFragment();
  for (const g of groups.filter((x) => x.kind === 'una')) unaFrag.append(groupEl(g));
  node('未归档', unaFrag);
}

function renderPanel() {
  clear(panelEl);
  if (!sel) {
    panelEl.append(h('div.libed-hint', {text: '← 左侧选一个分组。条目从右侧拖到左列分组＝改归属；'
        + `分组拖到另一分组＝整支并入（减少分支）；组内上下拖＝排序。`
        + `「待分类」是暂存池，没有落点时先拖进它。`}));
    return;
  }
  const g = groupByKey(sel.key);
  if (!g) { sel = null; renderPanel(); return; }
  const entries = g.kind === 'una'
      ? unaByGroup(g.group).map((e) => ({id: e.id, name: storyName(e.id)}))
      : (entriesOf(g) ?? []).map((s) => ({id: s.id, name: s.name ?? storyName(s.id)}));

  panelEl.append(h('h2', {text: `${g.label}（${g.extra} · ${entries.length} 段）`}));

  const nameInput = h('input', {value: g.kind === 'act' ? (actById(g.ci, g.id)?.name ?? '')
      : g.kind === 'main' ? g.name : g.group});
  nameInput.addEventListener('change', () => {
    snapshot(); renameGroup(g, nameInput.value); renderAll();
  });
  panelEl.append(h('div.libed-row', h('label', {text: '名称'}), nameInput));

  if (g.kind === 'act') {
    const yearInput = h('input', {value: g.year ?? '', type: 'number'});
    yearInput.addEventListener('change', () => {
      const a = actById(g.ci, g.id);
      if (a) { snapshot(); a.year = yearInput.value === '' ? null : Number(yearInput.value); renderAll(); }
    });
    panelEl.append(h('div.libed-row', h('label', {text: '年份'}), yearInput,
        h('button.tiny', {text: '删除此活动', onclick: () => {
          if (!confirm(`删除「${g.label}」？${entries.length} 段将移入「${POOL}」`)) return;
          snapshot(); deleteGroup(g); renderAll();
        }}),
        h('button.tiny', {text: '新增活动', onclick: () => {
          const name = prompt('新活动名称：');
          if (!name?.trim()) return;
          /* 整分类无年份（宿舍剧情/其他剧情）时留空：给一个新年份会在
           * 这个分类里凭空劈出一个年份层 */
          const dated = activitiesOf(g.ci).some((a) => a.year != null);
          const year = prompt('年份：', String(g.year ?? (dated
              ? new Date().getFullYear() : '')));
          if (year === null) return;
          snapshot();
          const id = addActivity(g.ci, name.trim(), year === '' ? null : Number(year));
          sel = {key: groupKey('act', `${g.ci}:${id}`)};
          renderAll();
        }})));
  } else {
    panelEl.append(h('div.libed-row', h('label', {text: ' '}),
        h('button.tiny', {text: '删除此组', onclick: () => {
          if (!confirm(`删除「${g.label}」？${entries.length} 段将移入「${POOL}」`)) return;
          snapshot(); deleteGroup(g); renderAll();
        }}),
        h('button.tiny', {text: g.kind === 'main' ? '新增主线组' : '新增未归档组',
          onclick: () => {
            const name = prompt(g.kind === 'main' ? '新主线组名：' : '新未归档组名：');
            if (!name?.trim()) return;
            snapshot();
            if (g.kind === 'main') data.mainline.push({name: name.trim(), stories: []});
            else {
              for (const e of data.unarchived) {
                if (e.group === POOL && !e.id.startsWith('dorm_')) e.group = name.trim();
              }
            }
            sel = {key: groupKey(g.kind, name.trim())};
            renderAll();
          }})));
  }

  const listWrap = h('div.libed-stories', {
      ondragover: (ev) => {
        if (drag?.kind !== 'entry') return;
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'move';
        clearDropMarks();
        if (drag.fromKey === g.key) markLine(listWrap, insertIndex(listWrap, ev.clientY));
        else listWrap.classList.add('drop-in');
      },
      ondragleave: (ev) => {
        if (!listWrap.contains(ev.relatedTarget)) clearDropMarks();
      },
      ondrop: (ev) => {
        if (drag?.kind !== 'entry') return;
        ev.preventDefault();
        const {id, fromKey} = drag;
        const idx = insertIndex(listWrap, ev.clientY);
        drag = null;
        clearDropMarks();
        if (applyDrop(() => {
          if (fromKey === g.key) return reorderGroup(g, id, idx);
          place(id, g);
          reorderGroup(g, id, idx);   /* 跨组拖进来也落在指针位置 */
          return true;
        })) renderAll();
      },
  });
  for (const e of entries) {
    listWrap.append(h('div.libed-entry', {
        draggable: true,
        ondragstart: (ev) => startDrag(ev, {kind: 'entry', id: e.id, fromKey: g.key}),
      },
        h('span.id', {text: e.id}),
        h('span.name', {text: e.name ?? ''}),
        h('button.tiny', {text: '移出', onclick: () => {
          snapshot(); toPool(e.id); renderAll();
        }})));
  }
  panelEl.append(listWrap);

  const addBox = h('div.libed-add');
  const filter = h('input', {placeholder: '过滤语料段（ID 或名称含关键字）…', style: {width: '340px'}});
  const cands = h('div.cands');
  const inGroup = new Set(entries.map((e) => e.id));
  const renderCands = () => {
    clear(cands);
    const q = filter.value.trim().toLowerCase();
    const hits = (manifest?.stories ?? [])
        .filter((s) => !q || s.id.toLowerCase().includes(q)
            || (s.brief ?? '').toLowerCase().includes(q))
        .slice(0, PAGE);
    for (const s of hits) {
      const here = inGroup.has(s.id);
      cands.append(h('div.libed-entry', {
          draggable: true,
          ondragstart: (ev) => startDrag(ev, {kind: 'entry', id: s.id, fromKey: null}),
        },
          h('span.id', {text: s.id}),
          h('span.name', {text: s.brief ?? ''}),
          h('button.tiny', {text: here ? '✓ 在本组' : '+ 加入', disabled: here,
            onclick: () => { snapshot(); place(s.id, g); renderAll(); }})));
    }
    if (!hits.length) cands.append(h('div.libed-hint', {text: '无匹配'}));
  };
  filter.addEventListener('input', renderCands);
  renderCands();
  addBox.append(h('div.libed-row', h('label', {text: '添加条目'}), filter), cands);
  panelEl.append(addBox);
}

function renderAll() {
  renderTree();
  renderPanel();
}

/* —— 持久化 —— */
async function save() {
  const body = JSON.stringify({...data, manual: true, savedAt: new Date().toISOString()});
  try {
    const res = await fetch(SAVE_URL, {method: 'POST', body});
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    source = 'manual';
    savedMark = JSON.stringify(data);
    syncDirty(); markSource();
    alert('已保存 data/index/story-archive-manual.json —— 回编辑器刷新，剧本库即按这份走');
  } catch (error) {
    exportJson();
    alert(`保存端点不可用（${error.message}），已导出 JSON——请放置到\n`
        + 'data/index/story-archive-manual.json 后刷新编辑器。');
  }
}

function exportJson() {
  const blob = new Blob([JSON.stringify({...data, manual: true}, null, 1)],
      {type: 'application/json'});
  const a = h('a', {href: URL.createObjectURL(blob), download: 'story-archive-manual.json'});
  a.click();
  URL.revokeObjectURL(a.href);
}

async function reseed() {
  if (!confirm('从生成档案重新播种？当前手动调整将被覆盖（先保存/导出留底）。')) return;
  const res = await fetch(`${DERIVED_URL}?t=${Date.now()}`);
  if (!res.ok) { alert('生成档案加载失败'); return; }
  snapshot();
  data = await res.json();
  source = 'derived';
  sel = null;
  syncDirty();
  renderAll(); markSource();
}

async function boot() {
  try {
    manifest = await (await fetch('data/index/avg-scripts.json')).json();
  } catch { manifest = null; }
  let manual = null;
  try {
    const res = await fetch(`${MANUAL_URL}?t=${Date.now()}`);
    if (res.ok) {
      const parsed = await res.json();
      if (isArchive(parsed)) manual = parsed;
      else manualIssue = '手动档案不合形态（缺 classes/mainline/unarchived），已忽略';
    }
  } catch {
    manualIssue = '手动档案读不出（半截件？），已忽略';
  }
  if (manual) {
    data = manual;
    source = 'manual';
  } else {
    data = await (await fetch(`${DERIVED_URL}?t=${Date.now()}`)).json();
    source = 'derived';
  }
  savedMark = JSON.stringify(data);
  markSource();
  renderAll();

  $('btn-save').addEventListener('click', save);
  $('btn-export').addEventListener('click', exportJson);
  $('btn-undo').addEventListener('click', () => {
    const snap = undoStack.pop();
    if (!snap) return;
    data = JSON.parse(snap);
    sel = null;
    syncDirty();
    renderAll();
  });
  $('btn-reseed').addEventListener('click', reseed);
  $('file-import').addEventListener('change', (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    file.text().then((textBody) => {
      snapshot();
      data = JSON.parse(textBody);
      source = 'manual';
      sel = null;
      syncDirty();
      renderAll(); markSource();
    });
  });
  window.addEventListener('beforeunload', (e) => {
    if (dirty) e.preventDefault();
  });
}

boot();
/* 调试钩子：控制台可用 __libed() 查看编辑态（data/sel/未归档无 group 条目） */
window.__libed = () => ({
  source,
  dirty,
  sel,
  badUna: data.unarchived.filter((e) => e.group === undefined).map((e) => e.id),
  unaLen: data.unarchived.length,
  mainLen: data.mainline.length,
});
