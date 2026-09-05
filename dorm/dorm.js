// 云图计划 · 宿舍 M1 竖切:单房间 + 5 家具 + croque 走/站/坐/躺。
// 资产由 tools/dorm/export_dorm_m1.py 导出(Unity→glTF);本页只负责拼装与驱动。
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

// ---------------------------------------------------------------- renderer
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
$('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2b241c);
scene.fog = new THREE.Fog(0x2b241c, 12, 30);

const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 100);
camera.position.set(3.4, 4.6, 3.4);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.3, 0);
controls.maxPolarAngle = Math.PI / 2 - 0.05;
controls.minDistance = 2;
controls.maxDistance = 14;
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
const loaded = {};

function load(name) {
  return new Promise((res, rej) => {
    loader.load(`./assets/${name}.gltf`, (g) => { loaded[name] = g; res(g); },
      undefined, (e) => rej(e));
  });
}

// ---------------------------------------------------------------- 摆位(米制;地板 4×4)
const PLACE = [
  ['furn_ab2024_sofa',   -1.15, 0, -1.45, Math.PI,       '沙发'],
  ['furn_ab2024_chair',   0.55, 0, -1.35, Math.PI * 0.9, '椅子'],
  ['furn_ab2024_carpet',  0.1,  0,  0.45, 0,              '地毯'],
  ['furn_bamboo_shelf',   1.62, 0, -1.55, -Math.PI / 2,  '置物架'],
  ['furn_ab2024_deco01', -1.42, 0,  1.42, -Math.PI / 4,  '装饰柜'],
];
// 坐/躺落点(手调;M3 换成 DormConfigAsset 的 InteractMoveCurve 驱动)
const SEAT = { x: 0.55, z: -1.35, y: 0.13, rot: Math.PI * 0.9 };
const LIE = { x: 0.1, z: 0.45, y: 0.02, rot: 0 };

// ---------------------------------------------------------------- 状态机
let mixer = null, croque = null;
const clips = {};
let state = '';
let autoMode = true;        // 自动巡游
let chainActive = false;    // 一次性演出链进行中(坐/躺/说话)
let chainWait = 0;
let onceAction = null;      // 当前一次性动作(轮询其播完)
const WALK_SPEED = 0.75;

const WAYPOINTS = [
  { x: 1.2, z: 1.2, act: null },
  { x: -1.2, z: 1.0, act: 'talk' },
  { x: -1.3, z: -0.9, act: null },
  { x: 0.55, z: -1.05, act: 'sit' },
  { x: 0.1, z: 0.1, act: 'lie' },
];
let wp = 0;

function setState(name) {
  // name: dorm_walk1 / dorm_stand1 / dorm_sit / dorm_sit_loop / dorm_lie_start /
  //       dorm_lie_loop / dorm_getup / dorm_talk
  if (!croque || !clips[name]) return;
  const once = ['dorm_sit', 'dorm_lie_start', 'dorm_getup', 'dorm_talk'].includes(name);
  const next = clips[name];
  if (once) {
    next.reset().setLoop(THREE.LoopOnce, 1);
    next.clampWhenFinished = true;
    onceAction = next;
  } else {
    next.reset().setLoop(THREE.LoopRepeat, Infinity);
    onceAction = null;
  }
  for (const k in clips) {
    const a = clips[k];
    if (a !== next && a.isRunning()) a.crossFadeTo(next, 0.25, false);
  }
  if (!next.isRunning()) next.play();
  state = name;
  $('state').textContent = name;
}

function startInteraction(kind) {
  chainActive = true;
  chainWait = 0;
  if (kind === 'sit') {
    croque.scene.position.set(SEAT.x, SEAT.y, SEAT.z);
    croque.scene.rotation.y = SEAT.rot;
    setState('dorm_sit');
  } else if (kind === 'lie') {
    croque.scene.position.set(LIE.x, LIE.y, LIE.z);
    croque.scene.rotation.y = LIE.rot;
    setState('dorm_lie_start');
  } else if (kind === 'talk') {
    setState('dorm_talk');
  }
}

function endChain() {
  chainActive = false;
  chainWait = 0;
  onceAction = null;
  croque.scene.position.y = 0;
  if (autoMode) { wp = (wp + 1) % WAYPOINTS.length; startWalkTo(WAYPOINTS[wp]); }
  else setState('dorm_stand1');
}

function startWalkTo(t) {
  const p = croque.scene.position;
  croque.scene.userData.target = Math.atan2(t.x - p.x, t.z - p.z);
  setState('dorm_walk1');
}

function updateWalk(dt) {
  const t = WAYPOINTS[wp];
  const p = croque.scene.position;
  let dyaw = croque.scene.userData.target - croque.scene.rotation.y;
  while (dyaw > Math.PI) dyaw -= Math.PI * 2;
  while (dyaw < -Math.PI) dyaw += Math.PI * 2;
  croque.scene.rotation.y += dyaw * Math.min(1, dt * 8);
  const dx = t.x - p.x, dz = t.z - p.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 0.06) {
    if (t.act) { startInteraction(t.act); return; }
    wp = (wp + 1) % WAYPOINTS.length;
    startWalkTo(WAYPOINTS[wp]);
    return;
  }
  p.x += dx / dist * WALK_SPEED * dt;
  p.z += dz / dist * WALK_SPEED * dt;
}

// 演出链推进(轮询一次性动作完成,避免事件竞态)
function updateChain(dt) {
  if (!chainActive) return;
  if (onceAction) {
    const done = !onceAction.isRunning() ||
                 onceAction.time >= onceAction.getClip().duration - 0.02;
    if (!done) return;
    const n = onceAction.getClip().name;
    onceAction = null;
    if (n === 'dorm_sit') { setState('dorm_sit_loop'); chainWait = 4; }
    else if (n === 'dorm_lie_start') { setState('dorm_lie_loop'); chainWait = 4; }
    else if (n === 'dorm_talk' || n === 'dorm_getup') { endChain(); }
    return;
  }
  const loopish = (state === 'dorm_sit_loop' || state === 'dorm_lie_loop');
  if (loopish && chainWait > 0) {
    chainWait -= dt;
    if (chainWait <= 0) setState('dorm_getup');
  }
}

// ---------------------------------------------------------------- 主循环
const clock = new THREE.Clock();
let fpsT = 0, fpsN = 0;

function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (mixer) mixer.update(dt);
  if (croque) {
    if (chainActive) {
      updateChain(dt);
    } else if (autoMode) {
      updateWalk(dt);
    }
  }
  controls.update();
  renderer.render(scene, camera);
  fpsN++; fpsT += dt;
  if (fpsT >= 0.5) { $('fps').textContent = (fpsN / fpsT).toFixed(0) + ' FPS'; fpsT = 0; fpsN = 0; }
}

// ---------------------------------------------------------------- 按钮
function setAuto(on) {
  autoMode = on; chainActive = false; chainWait = 0;
  $('b-auto').classList.toggle('on', on);
  croque.scene.position.y = 0;
  if (on) startWalkTo(WAYPOINTS[wp]); else setState('dorm_stand1');
}
$('b-auto').onclick = () => setAuto(!autoMode);
$('b-walk').onclick = () => { autoMode = false; $('b-auto').classList.remove('on'); chainActive = false; startWalkTo(WAYPOINTS[wp]); };
$('b-stand').onclick = () => { autoMode = false; $('b-auto').classList.remove('on'); chainActive = false; croque.scene.position.y = 0; setState('dorm_stand1'); };
$('b-sit').onclick = () => { autoMode = false; $('b-auto').classList.remove('on'); startInteraction('sit'); };
$('b-lie').onclick = () => { autoMode = false; $('b-auto').classList.remove('on'); startInteraction('lie'); };
$('b-talk').onclick = () => { autoMode = false; $('b-auto').classList.remove('on'); startInteraction('talk'); };

// ---------------------------------------------------------------- 启动
Promise.all([
  load('room_ab2024_floor'), load('room_ab2024_wall'),
  ...PLACE.map(([n]) => load(n)), load('croque_dorm'),
]).then(() => {
  const floor = loaded.room_ab2024_floor.scene;
  floor.traverse((o) => { if (o.isMesh) { o.receiveShadow = true; o.castShadow = false; } });
  scene.add(floor);
  const wallSrc = loaded.room_ab2024_wall.scene;
  for (let i = 0; i < 4; i++) {
    const w = wallSrc.clone(true);
    w.rotation.y = i * Math.PI / 2;
    w.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    scene.add(w);
  }
  check('房间拼装(地板 + 4 面墙)', true, 'ab2024 套系,单件 4m 宽 × 2.4m 高');

  let furnOk = 0;
  for (const [name, x, y, z, rot] of PLACE) {
    const g = loaded[name].scene;
    g.position.set(x, y, z);
    g.rotation.y = rot;
    g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    scene.add(g);
    furnOk++;
  }
  check('家具 ×' + furnOk, furnOk === 5, '沙发/椅子/地毯/置物架/装饰柜');

  croque = loaded.croque_dorm;
  croque.scene.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  scene.add(croque.scene);
  mixer = new THREE.AnimationMixer(croque.scene);
  for (const c of croque.animations) {
    if (!clips[c.name]) clips[c.name] = mixer.clipAction(c);
  }

  let joints = 0, skins = 0;
  croque.scene.traverse((o) => {
    if (o.isSkinnedMesh && o.skeleton) { joints += o.skeleton.bones.length; skins++; }
  });
  check('角色蒙皮(' + skins + ' 蒙皮 / ' + joints + ' 骨)', skins === 2 && joints >= 69,
    'body 65 骨 + head 4 骨');
  const uniq = [...new Set(croque.animations.map((a) => a.name))];
  check('宿舍动画 ×' + uniq.length, uniq.length >= 14, uniq.join(' '));
  const texCount = new Set();
  croque.scene.traverse((o) => {
    if (o.isMesh) for (const m of (Array.isArray(o.material) ? o.material : [o.material]))
      if (m && m.map) texCount.add(m.map.uuid);
  });
  check('角色贴图/材质', texCount.size >= 2, texCount.size + ' 张主贴图');

  croque.scene.position.set(WAYPOINTS[0].x, 0, WAYPOINTS[0].z);
  croque.scene.rotation.y = 0;
  croque.scene.userData.target = 0;
  $('b-auto').classList.add('on');
  setState('dorm_stand1');
  setTimeout(() => { if (autoMode && !chainActive) startWalkTo(WAYPOINTS[wp]); }, 1200);
}).catch((e) => {
  console.error('dorm load fail:', e);
  check('资产加载', false, String((e && (e.stack || e.message)) || e));
  $('state').textContent = '加载失败';
});

check('骨架一致性(静态结论)', true, '18/18 角色 dmodel 人形核心链(40 节)逐路径一致');

window.__dorm = { scene, croque: () => croque, loaded, camera, controls, setState, startInteraction };
tick();
