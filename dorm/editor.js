// 云图计划 · 宿舍 M2:摆放编辑器。
// 房间 + 20 件家具目录 + 0.5m 网格吸附 + 旋转/删除 + IndexedDB 存档。
// 打开 editor.html 即编辑模式;「预览」进入 M1 巡游视角。
import * as THREE from './lib/three.module.js';
import { GLTFLoader } from './lib/GLTFLoader.js';
import { OrbitControls } from './lib/OrbitControls.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- 基础场景
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
$('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2b241c);
scene.fog = new THREE.Fog(0x2b241c, 14, 34);

const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 100);
camera.position.set(3.2, 4.2, 3.6);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.3, 0);
controls.minDistance = 0.25;
controls.maxPolarAngle = Math.PI / 2 - 0.04;
controls.update();

scene.add(new THREE.HemisphereLight(0xfff2dd, 0x7a6a55, 1.0));
const sun = new THREE.DirectionalLight(0xffe8c0, 1.6);
sun.position.set(3.5, 6, 2.5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -5; sun.shadow.camera.right = 5;
sun.shadow.camera.top = 5; sun.shadow.camera.bottom = -5;
sun.shadow.bias = -0.0004;
scene.add(sun);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- 加载
const loader = new GLTFLoader();
const protos = {};           // 家具 id → Object3D(模板)

function loadGltf(name) {
  return new Promise((res, rej) => {
    loader.load(`./assets/${name}.gltf`, (g) => res(g.scene), undefined, rej);
  });
}

// ---------------------------------------------------------------- 房间
const FLOOR = 4.0, CELL = 0.5, GRID_N = FLOOR / CELL;   // 8×8 格
const gridHelper = new THREE.GridHelper(FLOOR, GRID_N, 0x6b5a3e, 0x4a3f30);
gridHelper.position.y = 0.005;
scene.add(gridHelper);

// ---------------------------------------------------------------- 编辑数据
// items: [{uid, id, gx, gz, rot}]  gx/gz ∈ [0,8) 格坐标(格中心)
let items = [];
let uidSeq = 1;
const placed = new Map();   // uid → Object3D

function itemFootprint(id) {
  const it = CATALOG.find((c) => c.id === id);
  if (!it || !it.colliders || !it.colliders.length) return { w: 1, d: 1 };
  const c = it.colliders[0];
  return { w: Math.max(1, Math.round(c.size[0] / CELL)), d: Math.max(1, Math.round(c.size[2] / CELL)) };
}

function cellsOf(it) {
  const f = itemFootprint(it.id);
  const rot = ((it.rot % 4) + 4) % 4;
  const sw = rot % 2 === 0 ? f.w : f.d;
  const sd = rot % 2 === 0 ? f.d : f.w;
  const x0 = it.gx - Math.floor(sw / 2), z0 = it.gz - Math.floor(sd / 2);
  const cells = [];
  for (let x = x0; x < x0 + sw; x++)
    for (let z = z0; z < z0 + sd; z++) cells.push(x + ',' + z);
  return { cells, sw, sd };
}

function collides(it, ignoreUid) {
  const occ = new Set();
  for (const other of items) {
    if (other.uid === ignoreUid) continue;
    for (const c of cellsOf(other).cells) occ.add(c);
  }
  return cellsOf(it).cells.some((c) => occ.has(c));
}

function spawnObject(id) {
  const src = protos[id];
  const o = src.clone(true);
  o.traverse((n) => { if (n.isMesh) { n.castShadow = true; n.receiveShadow = true; } });
  scene.add(o);
  return o;
}

function refreshObject(it) {
  let o = placed.get(it.uid);
  if (!o) { o = spawnObject(it.id); placed.set(it.uid, o); o.userData.uid = it.uid; }
  o.position.set((it.gx - GRID_N / 2 + 0.5) * CELL, 0, (it.gz - GRID_N / 2 + 0.5) * CELL);
  o.rotation.y = it.rot * Math.PI / 2;
}

function removeItem(uid) {
  const o = placed.get(uid);
  if (o) { scene.remove(o); placed.delete(uid); }
  items = items.filter((it) => it.uid !== uid);
}

// ---------------------------------------------------------------- 目录 UI
let CATALOG = [];
function buildCatalogUI() {
  const themes = {};
  for (const c of CATALOG) (themes[c.theme] = themes[c.theme] || []).push(c);
  const el = $('catalog');
  el.innerHTML = '';
  for (const th of Object.keys(themes).sort()) {
    const h = document.createElement('div');
    h.className = 'theme';
    h.textContent = th;
    el.appendChild(h);
    for (const c of themes[th]) {
      const b = document.createElement('button');
      b.textContent = c.id.replace(/^[a-z0-9]+_/, '');
      b.dataset.id = c.id;
      b.onclick = () => startGhost(c.id);
      el.appendChild(b);
    }
  }
}

// ---------------------------------------------------------------- 摆放交互
let ghost = null, ghostId = null, ghostRot = 0;
const ray = new THREE.Raycaster();
const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const pointer = new THREE.Vector2();
let dragUid = null;

function startGhost(id) {
  cancelGhost();
  ghostId = id; ghostRot = 0;
  ghost = spawnObject(id);
  ghost.traverse((n) => {
    if (n.isMesh) {
      n.material = n.material.clone();
      n.material.transparent = true;
      n.material.opacity = 0.55;
      n.castShadow = false;
    }
  });
  $('hint').textContent = '左键放置 · R 旋转 · Esc 取消';
}

function cancelGhost() {
  if (ghost) { scene.remove(ghost); ghost = null; ghostId = null; }
  $('hint').textContent = '';
}

function pointerHit(e) {
  const r = renderer.domElement.getBoundingClientRect();
  pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  ray.setFromCamera(pointer, camera);
  const p = new THREE.Vector3();
  return ray.ray.intersectPlane(floorPlane, p) ? p : null;
}

function snap(v) {
  return Math.max(0, Math.min(GRID_N - 1,
    Math.floor((v / CELL) + GRID_N / 2)));
}

renderer.domElement.addEventListener('pointermove', (e) => {
  const p = pointerHit(e);
  if (!p) return;
  if (ghost) {
    const gx = snap(p.x), gz = snap(p.z);
    ghost.position.set((gx - GRID_N / 2 + 0.5) * CELL, 0, (gz - GRID_N / 2 + 0.5) * CELL);
    ghost.rotation.y = ghostRot * Math.PI / 2;
    const probe = { uid: -1, id: ghostId, gx, gz, rot: ghostRot };
    ghost.traverse((n) => {
      if (n.isMesh) n.material.color?.setHex(collides(probe) ? 0xff5544 : 0xffffff);
    });
  } else if (dragUid) {
    const it = items.find((i) => i.uid === dragUid);
    if (it) {
      it.gx = snap(p.x); it.gz = snap(p.z);
      if (!collides(it, it.uid)) refreshObject(it);
    }
  }
});

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const p = pointerHit(e);
  if (!p) return;
  if (ghost) {
    const gx = snap(p.x), gz = snap(p.z);
    const it = { uid: uidSeq++, id: ghostId, gx, gz, rot: ghostRot };
    if (collides(it)) return;
    items.push(it);
    refreshObject(it);
    save();
    return;
  }
  // 选中已有家具
  ray.setFromCamera(pointer, camera);
  const hits = ray.intersectObjects([...placed.values()], true);
  if (hits.length) {
    let o = hits[0].object;
    while (o && o.userData.uid === undefined) o = o.parent;
    if (o && o.userData.uid) { dragUid = o.userData.uid; select(o.userData.uid); }
  }
});

addEventListener('pointerup', () => { if (dragUid) { dragUid = null; save(); } });
addEventListener('keydown', (e) => {
  if (e.key === 'r' || e.key === 'R') {
    if (ghost) { ghostRot = (ghostRot + 1) % 4; }
    else if (selected) {
      const it = items.find((i) => i.uid === selected);
      if (it) { it.rot = (it.rot + 1) % 4; if (!collides(it, it.uid)) { refreshObject(it); save(); } }
    }
  }
  if (e.key === 'Escape') cancelGhost();
  if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
    removeItem(selected); select(null); save();
  }
});

// ---------------------------------------------------------------- 选中/属性
let selected = null;
function select(uid) {
  selected = uid;
  $('props').style.display = uid ? '' : 'none';
  if (!uid) return;
  const it = items.find((i) => i.uid === uid);
  $('pname').textContent = it.id;
  $('prot').textContent = it.rot * 90 + '°';
  $('ppos').textContent = `格(${it.gx},${it.gz})`;
}
$('b-rot').onclick = () => {
  const it = items.find((i) => i.uid === selected);
  if (it) { it.rot = (it.rot + 1) % 4; if (!collides(it, it.uid)) { refreshObject(it); save(); } select(selected); }
};
$('b-del').onclick = () => { removeItem(selected); select(null); save(); };

// ---------------------------------------------------------------- 存档(IndexedDB)
const DB_NAME = 'yuntu-dorm', STORE = 'layouts';
function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'name' });
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
async function save() {
  $('hint').textContent = '已保存';
  const db = await openDB();
  await new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ name: 'room1', items });
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
  renderList();
}
async function loadLayout() {
  const db = await openDB();
  const got = await new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readonly');
    const rq = tx.objectStore(STORE).get('room1');
    rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
  });
  if (got) {
    items = got.items;
    uidSeq = Math.max(0, ...items.map((i) => i.uid)) + 1;
    for (const it of items) refreshObject(it);
    renderList();
  }
}
function renderList() {
  $('list').innerHTML = items.map((it) =>
    `<div class="it" data-uid="${it.uid}">${it.id.replace(/^[a-z0-9]+_/, '')} <span>(${it.gx},${it.gz})</span></div>`).join('')
    || '<div class="dim">空房间 —— 从目录选择家具</div>';
  for (const el of $('list').querySelectorAll('.it')) {
    el.onclick = () => select(+el.dataset.uid);
  }
}
$('b-clear').onclick = async () => {
  for (const it of [...items]) removeItem(it.uid);
  save();
};

// ---------------------------------------------------------------- 导入实机房间
let CAPTURE = null;
$('b-import').onclick = async () => {
  if (!CAPTURE) {
    CAPTURE = await (await fetch('../data/dorm/capture-dorm-scene.json')).json();
    const sel = $('import-room');
    sel.innerHTML = '';
    for (const r of CAPTURE.rooms) {
      const o = document.createElement('option');
      o.value = r.id;
      o.textContent = `${r.id} (${r.furniture.length}件)`;
      sel.appendChild(o);
    }
  }
  $('import-box').style.display = '';
};
$('import-room').onchange = () => {
  if (!CAPTURE) return;
  const r = CAPTURE.rooms.find((x) => x.id === $('import-room').value);
  if (!r) return;
  for (const it of [...items]) removeItem(it.uid);
  for (const f of r.furniture) {
    if (!protos[f.prefab]) continue;
    // 游戏房间本地坐标 [0,4]m → 编辑格 [0,8)
    const gx = Math.max(0, Math.min(GRID_N - 1, Math.round(f.pos[0] / CELL)));
    const gz = Math.max(0, Math.min(GRID_N - 1, Math.round(f.pos[2] / CELL)));
    const it = { uid: uidSeq++, id: f.prefab, gx, gz, rot: Math.round((f.rotY || 0) / 90) % 4 };
    if (collides(it)) continue;
    items.push(it);
    refreshObject(it);
  }
  save();
  $('import-box').style.display = 'none';
};
$('import-cancel').onclick = () => { $('import-box').style.display = 'none'; };

// ---------------------------------------------------------------- 主循环
function tick() {
  requestAnimationFrame(tick);
  controls.update();
  renderer.render(scene, camera);
}

// ---------------------------------------------------------------- 启动
window.__edb = { stage: 'start' };
(async () => {
  const cat = await (await fetch('../data/dorm/furniture-catalog.json')).json();
  CATALOG = cat.items;
  window.__edb = { stage: 'catalog' };
  const names = ['room_ab2024_floor', 'room_ab2024_wall', ...CATALOG.map((c) => c.file.replace('.gltf', ''))];
  const gltfs = await Promise.all(names.map((n) => loadGltf(n)));
  window.__edb = { stage: 'gltfs', n: gltfs.length };
  const floor = gltfs[0];
  floor.traverse((o) => { if (o.isMesh) o.receiveShadow = true; });
  scene.add(floor);
  for (let i = 0; i < 4; i++) {
    const w = gltfs[1].clone(true);
    w.rotation.y = i * Math.PI / 2;
    w.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    scene.add(w);
  }
  CATALOG.forEach((c, i) => { protos[c.id] = gltfs[i + 2]; });
  buildCatalogUI();
  window.__edb = { stage: 'ui' };
  await loadLayout();
  window.__edb = { stage: 'done', items: items.length };
  tick();
})().catch((e) => {
  window.__edb = { stage: 'error', err: String((e && (e.stack || e.message)) || e) };
  $('hint').textContent = '加载失败: ' + (e && e.message || e);
});
