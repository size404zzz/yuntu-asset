/* assets.js —— M8 素材注册表（AssetRegistry）：仓库索引 + IndexedDB 上传
   两路来源的统一视图，ObjectURL 生命周期的唯一持有者。
   规则（计划 R 条目）：
   - Blob 存 IDB，ObjectURL 只在内存现造，永不落盘；
   - 上传按「小写文件名」覆盖仓库同名条目（用户意图优先）；
   - layout 是一种 kind：标定件（kv layout:<id>）> 仓库已知（data/layouts）
     > 无（调用方用 sprite.deriveLayout 出起点并打 ⚠，本模块不 import
     sprite——依赖方向是 sprite 与 assets 同层）；
   - 音频 kind 走 audio:<sheet>/<cue> 键，M7 的解析器接这里；
   - 缺素材不致命：resolve 返回 null，上层画「资源缺失」占位。 */

import {openDB, entries, get, put, del, BLOBS, KV,
  requestPersist, storageEstimate} from './idb.js';
import {loadRepoIndex, flatLookup} from './repo-index.js';

export class AssetRegistry {
  constructor({fetchImpl, log = () => {}} = {}) {
    this.log = log;
    this.fetchImpl = fetchImpl;
    this.db = null;
    this.repo = {available: false, flat: {}, backgrounds: [], characters: []};
    this.urls = new Map();        /* 小写文件名 → ObjectURL（图片/音频） */
    this.uploads = new Map();     /* 小写文件名 → meta */
    this.layouts = new Map();     /* charaId → 标定 layout */
    this.persisted = false;
  }

  async boot() {
    [this.repo, this.db] = await Promise.all([
      loadRepoIndex({fetchImpl: this.fetchImpl}),
      openDB(),
    ]);
    this.persisted = await requestPersist().catch(() => false);
    for (const {key, value} of await entries(this.db, BLOBS)) {
      this.urls.set(key, URL.createObjectURL(value.blob));
      this.uploads.set(key, {...value.meta, key});
    }
    for (const {key, value} of await entries(this.db, KV)) {
      if (key.startsWith('layout:')) this.layouts.set(key.slice(7), value);
    }
    return this;
  }

  get repoAvailable() { return this.repo.available; }

  /* 图片/音频解析：上传覆盖仓库。返回 {url, source} 或 null。 */
  resolve(name) {
    const key = name.toLowerCase();
    if (this.urls.has(key)) return {url: this.urls.get(key), source: 'upload'};
    const path = flatLookup(this.repo, name);
    return path ? {url: path, source: 'repo'} : null;
  }

  /* 音频解析三级：上传件（键 audio:<sheet>/<cue>）> 仓库索引精确
     sheet/cue > byCue 全局兜底——游戏脚本里 bgm 的 sheet=cue（曲名自成一
     张瘦 sheet），也有省略 sheet 的，都靠全局表接住。缺失返回 null，
     上层静默跳过（剧情不因缺音频卡死）。 */
  resolveAudio(sheet, cue) {
    if (!cue) return null;
    const key = `audio:${sheet}/${cue}`.toLowerCase();
    if (this.urls.has(key)) return {url: this.urls.get(key), source: 'upload'};
    const audio = this.repo.audio;
    const hit = sheet ? audio?.sheets?.[sheet]?.cues?.[cue] : null;
    if (hit) return {url: hit.path, source: 'repo'};
    const global = audio?.byCue?.[cue];
    return global ? {url: global.path, source: 'repo'} : null;
  }

  /* layout 解析：标定 > 仓库已知 > null（调用方 derive）。返回带 source。 */
  layoutEntry(charaId) {
    if (this.layouts.has(charaId)) {
      return {layout: this.layouts.get(charaId), source: 'calibrated'};
    }
    if (this.repo.characters.some((c) => c.id === charaId && c.layout)) {
      return {layout: null, source: 'repo'};   // 路径由 layoutUrl 给
    }
    return null;
  }

  layoutUrl(charaId) { return `data/layouts/${charaId}.json`; }

  async saveLayout(charaId, layout) {
    await put(this.db, KV, layout, `layout:${charaId}`);
    this.layouts.set(charaId, layout);
  }

  async removeLayout(charaId) {
    await del(this.db, KV, `layout:${charaId}`);
    this.layouts.delete(charaId);
  }

  /* 上传：file → Blob 仓 + 即时可用的 ObjectURL。
     kind: 'image' | 'audio'；audio 的 name 传 `audio:<sheet>/<cue>`。 */
  async upload(name, file, {kind = 'image'} = {}) {
    const key = name.toLowerCase();
    const blob = file instanceof Blob ? file : new Blob([await file.arrayBuffer()],
        {type: file.type});
    await put(this.db, BLOBS, {
      blob,
      meta: {name, kind, size: blob.size, type: blob.type, at: Date.now()},
    }, key);
    const old = this.urls.get(key);
    if (old) URL.revokeObjectURL(old);
    this.urls.set(key, URL.createObjectURL(blob));
    this.uploads.set(key, {name, kind, size: blob.size, type: blob.type, key});
    return this.uploads.get(key);
  }

  async remove(key) {
    await del(this.db, BLOBS, key);
    const url = this.urls.get(key);
    if (url) URL.revokeObjectURL(url);
    this.urls.delete(key);
    this.uploads.delete(key);
  }

  listUploads({kind = null} = {}) {
    return [...this.uploads.values()].filter((m) => !kind || m.kind === kind);
  }

  async estimate() {
    return storageEstimate();
  }
}
