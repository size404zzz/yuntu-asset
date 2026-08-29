/* doc.js —— M9 文档层：归一化 story 的编辑入口 + 撤销栈 + 失效分级。
   计划口径：
   - 撤销用逐 story 全量快照栈（136 shot < 15KB，60 条上限，同字段 400ms
     内折叠成一步）；不做 diff-patch——快照永远正确，折叠解决粒度。
   - 失效三级：L3（文案/说话人/音量）定点补丁不重启 shot；
     L2（imgTween/heroFace/posId/bgColor）重新 seek（防抖 120ms）；
     L1（images/nextId/branch/contentType/layout/资源）重装载 + 重建规则表
     （防抖 60ms）。player 不订阅 doc——editor 订阅后调 player 方法，
     play.html 因此完全不携带失效逻辑。
   - doc 只认「编辑器下标 + 字段路径」，wire 键换算留在 editor。 */

export const L1 = 1;
export const L2 = 2;
export const L3 = 3;

/* 字段路径 → 失效级别。前缀匹配（audio.bgm.volume → L3）；
   未列出的字段按 L1 保守处理（重装载永远正确，只是贵一点）。 */
const FIELD_LEVEL = [
  [/^content$/, L3],
  [/^speakerName$/, L3],
  [/^speakerHeroId$/, L3],
  [/^audio/, L3],
  [/^imgTween/, L2],
  [/^heroFace/, L2],
  [/^speakerHeroPosId$/, L2],
  [/^bgColor$/, L2],
  [/^scrambleTypeWriter$/, L2],
];

export function levelOf(field) {
  for (const [re, lv] of FIELD_LEVEL) if (re.test(field)) return lv;
  return L1;
}

export function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  let node = obj;
  for (const k of keys) node = node[k] ??= {};
  if (value === undefined) delete node[last];
  else node[last] = value;
}

export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

const clone = (v) => structuredClone(v);

export class Doc {
  constructor(story) {
    this.story = story;          // normalizeScript 的产物（shots 可编辑）
    this.version = 0;
    this.listeners = new Set();
    this.undoStack = [];         // 每项 {shots, index, label}
    this.redoStack = [];
    this._batch = null;          // {at, index, field}：当前可折叠批的前态
  }

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  /* editor 调用的唯一写入口。index = 编辑器下标；field = 点路径。
     opts.label 进撤销栈提示；opts.forceLevel 覆盖分级（如整镜替换）。 */
  patch(index, field, value, {label, forceLevel} = {}) {
    const shot = this.story.shots[index];
    if (!shot) return false;
    if (getPath(shot, field) === value && !field.includes('.')) return false;
    const now = Date.now();
    const collapsible = this._batch
        && this._batch.index === index && this._batch.field === field
        && now - this._batch.at < 400;
    if (!collapsible) {
      this.undoStack.push({
        shots: clone(this.story.shots), index, label: label ?? field,
      });
      if (this.undoStack.length > 60) this.undoStack.shift();
      this.redoStack.length = 0;
      this._batch = {index, field, at: now};
    } else {
      this._batch.at = now;
    }
    setPath(shot, field, value);
    this.version++;
    const level = forceLevel ?? levelOf(field);
    for (const fn of this.listeners) fn({index, field, level, kind: 'patch'});
    return true;
  }

  /* 结构变更（插入/删除/移动）：永远 L1，且不可折叠。 */
  structure(mutate, {label = '结构调整'} = {}) {
    this.undoStack.push({
      shots: clone(this.story.shots), index: null, label,
    });
    if (this.undoStack.length > 60) this.undoStack.shift();
    this.redoStack.length = 0;
    this._batch = null;
    mutate(this.story);
    this.version++;
    for (const fn of this.listeners)
      fn({index: null, field: null, level: L1, kind: 'structure'});
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  undo() {
    if (!this.canUndo) return null;
    const redo = {shots: clone(this.story.shots)};
    const back = this.undoStack.pop();
    this.story.shots = back.shots;
    this.redoStack.push({...redo, index: back.index, label: back.label});
    this._batch = null;
    this.version++;
    for (const fn of this.listeners)
      fn({index: back.index, field: null, level: L1, kind: 'undo'});
    return back;
  }

  redo() {
    if (!this.canRedo) return null;
    const fwd = this.redoStack.pop();
    this.undoStack.push({shots: clone(this.story.shots), ...fwd});
    this.story.shots = fwd.shots;
    this._batch = null;
    this.version++;
    for (const fn of this.listeners)
      fn({index: fwd.index, field: null, level: L1, kind: 'redo'});
    return fwd;
  }
}
