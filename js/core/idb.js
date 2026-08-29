/* idb.js —— IndexedDB 薄封装（M8）：素材 Blob 与标定件的唯一落盘点。
   为什么不用 localStorage（计划 R 条目实测）：一张 2.2MB 背景 base64 后
   3.0MB，吃掉 60% 配额；IDB 原生存 Blob、异步不卡 UI。
   两个对象仓：blobs（key → {blob, meta}）与 kv（key → 任意 JSON，
   放标定 layout、文档兜底等小件）。
   Chrome 存储压力下会静默驱逐 IDB —— boot 时必须 requestPersist()，
   并把 estimate() 用量亮给用户。 */

export const DB_NAME = 'yuntu-avg';
export const DB_VERSION = 1;
export const BLOBS = 'blobs';
export const KV = 'kv';

export function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS);
      if (!db.objectStoreNames.contains(KV)) db.createObjectStore(KV);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB 被其他标签页占用'));
  });
}

function simple(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    let result;
    fn(tx.objectStore(store), (v) => { result = v; });
  });
}

export const put = (db, store, value, key) =>
    simple(db, store, 'readwrite', (os, done) => {
      os.put(value, key);
      done(undefined);
    });

export const get = (db, store, key) =>
    simple(db, store, 'readonly', (os, done) => {
      const req = os.get(key);
      req.onsuccess = () => done(req.result ?? null);
    });

export const del = (db, store, key) =>
    simple(db, store, 'readwrite', (os, done) => {
      os.delete(key);
      done(undefined);
    });

export const keys = (db, store) =>
    simple(db, store, 'readonly', (os, done) => {
      const req = os.getAllKeys();
      req.onsuccess = () => done(req.result);
    });

/* 全仓读取（blobs 条目不多，一次进内存建 URL 表）。 */
export function entries(db, store) {
  return new Promise((resolve, reject) => {
    const out = [];
    const tx = db.transaction(store, 'readonly');
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
    tx.objectStore(store).openCursor().onsuccess = (e) => {
      const cur = e.target.result;
      if (!cur) return;
      out.push({key: cur.key, value: cur.value});
      cur.continue();
    };
  });
}

export async function requestPersist() {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted?.()) return true;
  return navigator.storage.persist();
}

export async function storageEstimate() {
  if (!navigator.storage?.estimate) return null;
  const {quota = 0, usage = 0} = await navigator.storage.estimate();
  return {quota, usage};
}
