// 云图计划 · 宿舍 M3:角色巡游。
// 房间 -1_1 的实机家具布局(capture-dorm-scene.json)+ 5 个 dmodel 角色独立巡游。
// 每角色状态机:idle(dorm_stand1 循环)→ 随机目标 → walk(dorm_walk1)→ idle。
import * as THREE from './lib/three.module.js';
import { GLTFLoader } from './lib/GLTFLoader.js';
import { OrbitControls } from './lib/OrbitControls.js';

const $ = (id) => document.getElementById(id);
const check = (name, ok, detail) => {
  const li = document.createElement('li');
  li.innerHTML = `<span class="${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✗'} ${name}</span>` +
                 (detail ? ` <span class="dim">${detail}</span>` : '');
  $('check').appendChild(li);
};

// ---------------------------------------------------------------- 渲染基础
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

const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.1, 100);
camera.position.set(3.4, 2.2, 3.6);   // fov/俯角参考实机抓包(fov40, 俯角10°)
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.6, 0);
controls.maxPolarAngle = Math.PI / 2 - 0.04;
controls.update();

scene.add(new THREE.HemisphereLight(0xfff2dd, 0x7a6a55, 1.05));
const sun = new THREE.DirectionalLight(0xffe8c0, 1.5);
sun.position.set(3.5, 6, 2.5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -4; sun.shadow.camera.right = 4;
sun.shadow.camera.top = 4; sun.shadow.camera.bottom = -4;
sun.shadow.bias = -0.0004;
scene.add(sun);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const loader = new GLTFLoader();
const load = (name) => new Promise((res, rej) =>
  loader.load(`./assets/${name}.gltf`, (g) => res(g), undefined, rej));

// ---------------------------------------------------------------- 房间(-1_1)
// 游戏房间本地坐标 [0,4]m → 本页世界 [-2,2]
const toWorld = (p) => new THREE.Vector3(p[0] - 2, p[1] ?? 0, p[2] - 2);
const ROOM_N = ['room_ab2024_floor', 'room_ab2024_wall'];
const ROOM_ID = '-1_1';
let CAPTURE = null;

function furnishRoom(fixtureRoom, furnitureProtos) {
  let ok = 0;
  for (const f of fixtureRoom.furniture) {
    const proto = furnitureProtos[f.prefab];
    if (!proto) continue;
    const o = proto.scene.clone(true);
    const p = toWorld(f.pos);
    o.position.set(p.x, p.y, p.z);
    o.rotation.y = (f.rotY || 0) * Math.PI / 180;
    o.traverse((n) => { if (n.isMesh) { n.castShadow = true; n.receiveShadow = true; } });
    scene.add(o);
    ok++;
  }
  return ok;
}

// ---------------------------------------------------------------- 角色巡游
const ROAM_MIN = -1.45, ROAM_MAX = 1.45;
const CHARS = [
  { name: 'professor', home: [2.8, 0.1] },
  { name: 'sol', home: [2.54, 1.224], rotY: 185.4 },
  { name: 'simo', home: [0.76, 2.6], rotY: 146.7 },
  { name: 'taisch', home: [1.04, 2.87], rotY: 269.5 },
  { name: 'turing', home: [1.447, 0.492], rotY: 157.5 },
];

const agents = [];   // {name, root, mixer, clips, state, target, wait, speed}
let INTERACT_SPOTS = [];   // {kind:'sit'|'lie', seat:Vector3, stand:Vector3, yaw}
let CATALOG_ITEMS = null, DORM_INTERACT = null;

// 家具类别 → 交互方式(启发式;真实数据在 C# 配置侧,未随包下发)
function interactKindOf(prefab) {
  const n = prefab.toLowerCase();
  if (/bed|carpet|hammock/.test(n)) return 'lie';
  if (/chair|sofa|stool|bench/.test(n)) return 'sit';
  return null;
}

function buildInteractSpots(fixtureRoom, protoAABB) {
  INTERACT_SPOTS = [];
  for (const f of fixtureRoom.furniture) {
    const kind = interactKindOf(f.prefab);
    if (!kind) continue;
    const item = (CATALOG_ITEMS || []).find((c) => c.id === f.prefab);
    const col = item && item.colliders && item.colliders[0];
    if (!col) continue;
    // 碰撞盒中心(本地)→ 世界;家具 rotY 只绕 Y
    const rad = (f.rotY || 0) * Math.PI / 180;
    const cx = col.center[0], cz = col.center[2];
    const base = toWorld(f.pos);
    const wx = base.x + cx * Math.cos(rad) + cz * Math.sin(rad);
    const wz = base.z - cx * Math.sin(rad) + cz * Math.cos(rad);
    const topY = col.center[1] + col.size[1] / 2;
    const seat = new THREE.Vector3(wx, kind === 'sit' ? Math.max(0, topY - 0.57) : Math.max(0, topY - 0.05), wz);
    // 站位点:座位向房心一侧退半步
    const dir = new THREE.Vector3(wx, 0, wz);
    if (dir.length() > 0.01) dir.normalize(); else dir.set(0, 0, 1);
    const stand = new THREE.Vector3(wx - dir.x * 0.55, 0, wz - dir.z * 0.55);
    INTERACT_SPOTS.push({ kind, seat, stand, yaw: Math.atan2(base.x - wx, base.z - wz), prefab: f.prefab });
  }
}

// 曲线采样(Unity AnimationCurve 线性近似;keys=[[t,v],...])
function sampleCurve(keys, t) {
  if (!keys || !keys.length) return t;
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, v0] = keys[i - 1], [t1, v1] = keys[i];
      return v0 + (v1 - v0) * ((t - t0) / Math.max(1e-6, t1 - t0));
    }
  }
  return keys[keys.length - 1][1];
}

// 取角色自己的交互配置(没有则退回通用曲线)
function interactCurvesFor(name) {
  const di = DORM_INTERACT;
  if (!di) return null;
  const arr = di.characters[name] || Object.values(di.characters)[0];
  if (!arr || !arr.length) return null;
  return di.dispositions[arr[0].dispositionType] || null;
}


function makeAgent(def, gltf) {
  const root = gltf.scene;
  root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  const home = toWorld([def.home[0], 0, def.home[1]]);
  root.position.copy(home);
  root.rotation.y = ((def.rotY ?? 0) * Math.PI) / 180;
  scene.add(root);
  const mixer = new THREE.AnimationMixer(root);
  const clips = {};
  for (const c of gltf.animations || []) {
    if (!clips[c.name]) clips[c.name] = mixer.clipAction(c);
  }
  const a = {
    name: def.name, root, mixer, clips,
    state: 'idle', wait: 1 + Math.random() * 3,
    target: null, speed: 0.55 + Math.random() * 0.25,
    yaw: root.rotation.y, once: null, spot: null, t0: 0,
    curves: interactCurvesFor(def.name),
  };
  playClip(a, 'dorm_stand1', true);
  agents.push(a);
  const row = document.createElement('div');
  row.className = 'c';
  row.innerHTML = `<b>${def.name}</b> · <span class="dim">巡游中</span>`;
  $('chars').appendChild(row);
  a.row = row;
  return a;
}

function playClip(a, name, loop) {
  const next = a.clips[name];
  if (!next) return;
  if (loop) next.reset().setLoop(THREE.LoopRepeat, Infinity);
  for (const k in a.clips) {
    const c = a.clips[k];
    if (c !== next && c.isRunning()) c.crossFadeTo(next, 0.3, false);
  }
  if (!next.isRunning()) next.play();
}

function setState(a, label) {
  a.state = label;
  if (a.row) a.row.innerHTML = `<b>${a.name}</b> · <span class="dim">${label}</span>`;
}

function pickTarget() {
  return new THREE.Vector3(
    ROAM_MIN + Math.random() * (ROAM_MAX - ROAM_MIN), 0,
    ROAM_MIN + Math.random() * (ROAM_MAX - ROAM_MIN));
}

// 选一个空闲交互点(25% 概率触发交互)
function pickSpot(a) {
  if (!INTERACT_SPOTS.length || Math.random() > 0.45) return null;
  const free = INTERACT_SPOTS.filter((s) => !s.busyBy);
  if (!free.length) return null;
  free.sort((p, q) =>
    p.seat.distanceToSquared(a.root.position) - q.seat.distanceToSquared(a.root.position));
  const s = free[Math.random() < 0.7 ? 0 : Math.floor(Math.random() * free.length)];
  s.busyBy = a.name;
  return s;
}

function faceToward(a, target, dt, rate = 6) {
  const d = new THREE.Vector3().subVectors(target, a.root.position);
  const yaw = Math.atan2(d.x, d.z);
  let dy = yaw - a.root.rotation.y;
  while (dy > Math.PI) dy -= Math.PI * 2;
  while (dy < -Math.PI) dy += Math.PI * 2;
  a.root.rotation.y += dy * Math.min(1, dt * rate);
}

function walkStep(a, dt, target, arriveDist, onArrive) {
  const d = new THREE.Vector3().subVectors(target, a.root.position);
  const dist = Math.hypot(d.x, d.z);
  faceToward(a, target, dt);
  if (dist < arriveDist) { onArrive(); return; }
  const step = Math.min(dist, a.speed * dt);
  a.root.position.x += (d.x / dist) * step;
  a.root.position.z += (d.z / dist) * step;
}

// 交互链主更新
function updateAgent(a, dt) {
  a.mixer.update(dt);
  switch (a.state) {
    case 'idle': {
      a.wait -= dt;
      if (a.wait <= 0) {
        const spot = pickSpot(a);
        if (spot) {
          a.spot = spot;
          a.target = spot.stand.clone();
          playClip(a, 'dorm_walk1', true);
          setState(a, 'walk→' + spot.kind);
        } else {
          a.target = pickTarget();
          a.yaw = Math.atan2(a.target.x - a.root.position.x, a.target.z - a.root.position.z);
          playClip(a, 'dorm_walk1', true);
          setState(a, 'walk');
        }
      }
      return;
    }
    case 'walk': {
      walkStep(a, dt, a.target, 0.08, () => {
        a.wait = 1.5 + Math.random() * 4;
        playClip(a, 'dorm_stand1', true);
        setState(a, 'idle');
      });
      return;
    }
    case 'walk→sit':
    case 'walk→lie': {
      walkStep(a, dt, a.target, 0.1, () => {
        // 到站立点:按 moveCurve 滑向座位,播 sit/lie 入座动画
        a.kind = a.state.endsWith('sit') ? 'sit' : 'lie';
        const mc = a.curves && a.curves.moveCurves && a.curves.moveCurves[0];
        a.once = {
          t: 0,
          dur: (mc && mc.moveTime) || 0.8,
          from: a.root.position.clone(),
          to: a.spot.seat.clone(),
          cx: mc ? mc.moveX.keys : null,
          cy: mc ? mc.moveY.keys : null,
          clipName: a.kind === 'sit' ? 'dorm_sit' : 'dorm_lie_start',
        };
        playClip(a, a.once.clipName, false);
        setState(a, a.kind === 'sit' ? 'sitting' : 'lying');
      });
      return;
    }
    case 'sitting':
    case 'lying': {
      const o = a.once;
      o.t += dt;
      const u = Math.min(1, o.t / o.dur);
      const px = sampleCurve(o.cx, u);
      const py = sampleCurve(o.cy, u);
      a.root.position.x = o.from.x + (o.to.x - o.from.x) * px;
      a.root.position.z = o.from.z + (o.to.z - o.from.z) * px;
      a.root.position.y = Math.max(0, o.to.y) * py;
      let dy = a.spot.yaw - a.root.rotation.y;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      a.root.rotation.y += dy * Math.min(1, dt * 5);
      if (u >= 1) {
        a.root.position.copy(o.to);
        if (a.kind === 'sit') {
          playClip(a, 'dorm_sit_loop', true);
          a.wait = 5 + Math.random() * 4;
          setState(a, 'sit(休憩)');
        } else {
          playClip(a, 'dorm_lie_loop', true);
          a.wait = 5 + Math.random() * 4;
          setState(a, 'lie(休憩)');
        }
      }
      return;
    }
    case 'sit(休憩)':
    case 'lie(休憩)': {
      a.wait -= dt;
      if (a.wait <= 0) {
        playClip(a, 'dorm_getup', false);
        setState(a, 'getup');
      }
      return;
    }
    case 'getup': {
      const act = a.clips.dorm_getup;
      if (!act || act.time >= act.getClip().duration - 0.03) {
        if (a.spot) { a.spot.busyBy = null; a.spot = null; }
        a.root.position.y = 0;
        a.wait = 1 + Math.random() * 3;
        playClip(a, 'dorm_stand1', true);
        setState(a, 'idle');
      }
      return;
    }
  }
}

// ---------------------------------------------------------------- 启动
(async () => {
  CAPTURE = await (await fetch('../data/dorm/capture-dorm-scene.json')).json();
  CATALOG_ITEMS = (await (await fetch('../data/dorm/furniture-catalog.json')).json()).items;
  DORM_INTERACT = await (await fetch('../data/dorm/dorm-interact.json')).json();
  const fixtureRoom = CAPTURE.rooms.find((r) => r.id === ROOM_ID);
  const prefabIds = [...new Set(fixtureRoom.furniture.map((f) => f.prefab))];
  const names = [...ROOM_N, ...prefabIds.map((p) => 'furn_' + p),
                 ...CHARS.map((c) => 'char_' + c.name)];
  const scenes = await Promise.all(names.map(load));
  const byName = {};
  names.forEach((n, i) => { byName[n] = scenes[i]; });
  const furnitureProtos = {};
  for (const p of prefabIds) furnitureProtos[p] = byName['furn_' + p];

  const floor = byName['room_ab2024_floor'].scene;
  floor.traverse((o) => { if (o.isMesh) o.receiveShadow = true; });
  scene.add(floor);
  for (let i = 0; i < 4; i++) {
    const w = byName['room_ab2024_wall'].scene.clone(true);
    w.rotation.y = i * Math.PI / 2;
    w.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    scene.add(w);
  }
  check('房间拼装(实机房间 ' + ROOM_ID + ')', true, 'ab2024 房壳 + 实机家具布局');

  const n = furnishRoom(fixtureRoom, furnitureProtos);
  check('实机家具 ×' + n, n === fixtureRoom.furniture.length,
    fixtureRoom.furniture.map((f) => f.prefab).join(' '));

  buildInteractSpots(fixtureRoom, null);
  check('交互点 ×' + INTERACT_SPOTS.length, INTERACT_SPOTS.length > 0,
    INTERACT_SPOTS.map((s) => `${s.prefab}(${s.kind})`).join(' '));

  for (const def of CHARS) {
    makeAgent(def, byName['char_' + def.name]);
  }
  check('角色巡游 ×' + agents.length, agents.length === 5,
    'professor/sol/simo/taisch/turing,各自独立状态机');

  const clock = new THREE.Clock();
  window.__patrol = { controls, camera, agents: () => agents };
  (function tick() {
    requestAnimationFrame(tick);
    const dt = Math.min(clock.getDelta(), 0.05);
    for (const a of agents) updateAgent(a, dt);
    controls.update();
    renderer.render(scene, camera);
  })();
})().catch((e) => {
  console.error(e);
  check('加载', false, String((e && e.message) || e));
});
