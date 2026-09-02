/* test-gamefold.mjs —— 游戏折叠模型（js/test/gamefold.js）的语义回归。
 *
   两半：
   A. 模型不变量（手工条目序列，不依赖素材）——把反汇编读出的分支形状钉成断言；
   B. 字节码锚点（读 res/Assets/Res/LuaScripts/_logic/，那是本地保留不入库的
      第三方字节码；缺件时跳过并报 note，与 test-style.mjs 处理 %TEMP%/avgref 同法）。
   用法：node tools/test-gamefold.mjs [--corpus]   末项再跑一遍全语料计数打印（不断言）
 */
import assert from 'node:assert/strict';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {emptyFold, foldShot, applyGameTween, applyGameImages, CHAR, visible}
    from '../js/test/gamefold.js';
import {emptyState, applyImages, applyShotTweens} from '../js/core/state.js';
import {parseChunk} from '../js/core/lundump.js';
import {execChunk, makeStdEnv, LuaTable} from '../js/core/lvm.js';

const ROOT = resolve(process.cwd());
let passed = 0;
const ok = (m) => { passed++; console.log('  ok   ' + m); };
const L = (x) => ({lanes: new Map([[7, {alpha: 1, isDark: false, posId: null, pos: null, scale: null}]]),
    imgType: new Map([[7, CHAR]]), ...x});

/* —— A1：isDark 是赋值不是翻转（TU L96-103）；state.js 必须与 oracle 同形 —— */
{
  const seq = [{imgId: 7, isDark: true}, {imgId: 7}, {imgId: 7, isDark: false}, {imgId: 7}];
  const f = L();
  const s = emptyState();
  applyImages(s, [{imgId: 7, imgType: CHAR, alpha: 1}]);
  const ours = [];
  for (const e of seq) {
    foldShot(f, {imgTween: [e]}, () => null);
    applyShotTweens(s, {imgTween: [e]});
    ours.push([f.lanes.get(7).isDark, !!s.lanes.get(7).isDark]);
  }
  /* 缺省两条都不许动；显式值直接落 */
  assert.deepEqual(ours.map(([g]) => g), [true, true, false, false], 'oracle：赋值语义');
  assert.deepEqual(ours.map(([, o]) => o), [true, true, false, false],
      'state.js 与 oracle 同形（翻转语义已废）');
  ok('isDark 赋值语义：oracle 与 state.js 一致');
}

/* —— A2：显式 alpha 覆盖槽位 α；无 alpha 时槽位 α 说话 —— */
{
  const slot = (id, posId) => ({pos: [-345, -450], scale: [1, 1], alpha: posId === 1 ? 0 : 1});
  const a = foldShot(L(), {imgTween: [{imgId: 7, posId: 1, alpha: 1}]}, slot);
  assert.equal(a.lanes.get(7).alpha, 1, 'TU L90-94 是独立 if ⇒ 显式 alpha 赢');
  const b = foldShot(L(), {imgTween: [{imgId: 7, posId: 1}]}, slot);
  assert.equal(b.lanes.get(7).alpha, 0, '无 alpha 时槽 1 的官方 α=0 把人已收场');
  ok('posId 回槽：α 优先级 = 显式 alpha > 槽位 α');
}

/* —— A3：pos/scale 是真 elseif，posId 吞掉条目自带值 —— */
{
  const slot = () => ({pos: [-345, -450], scale: [1.7, 1.7], alpha: 1});
  const f = foldShot(L(), {imgTween: [{imgId: 7, posId: 3, pos: [9, 9, 9], scale: [2, 2, 2]}]}, slot);
  assert.deepEqual(f.lanes.get(7).pos, [-345, -450], 'posId 在时条目 pos 被无视');
  assert.deepEqual(f.lanes.get(7).scale, [1.7, 1.7], '同理 scale 用槽位');
  const g = foldShot(L(), {imgTween: [{imgId: 7, pos: [9, 9, 9]}]}, slot);
  assert.deepEqual(g.lanes.get(7).pos, [9, 9, 9], '无 posId 才用条目 pos');
  ok('pos/scale：posId 优先（elseif 语义）');
}

/* —— A4：非立绘的 posId 走 eAvgImgPosType，且不改可见度 —— */
{
  const f = L({imgType: new Map([[7, 2]])});
  foldShot(f, {imgTween: [{imgId: 7, posId: 3}]}, () => { throw new Error('非立绘不该查槽位表'); });
  assert.equal(f.lanes.get(7).alpha, 1, '背景 posId 不碰 α');
  ok('非立绘 posId：不查立绘槽位、不改 α');
}

/* —— A5：tween 打在未注册 imgId 上 = 静默丢（SYS f27 L646） —— */
{
  const f = emptyFold();
  applyGameTween(f, [{imgId: 99, alpha: 1}], () => null);
  assert.equal(f.lanes.size, 0);
  assert.match(f.warnings[0], /Can't find avg img item, imgId = 99/);
  ok('未注册 imgId 的 tween 被静默丢并记 warn');
}

/* —— A6：delete 先于注册（SYS f24 两遍扫描） —— */
{
  const f = applyGameImages(emptyFold(), [{imgId: 7, delete: true}, {imgId: 7, imgType: CHAR, alpha: 1}],
      () => null);
  assert.ok(visible(f.lanes.get(7)), '同镜先删后注册 ⇒ 人在台上');
  const g = applyGameImages(L(), [{imgId: 7, delete: true}], () => null);
  assert.equal(g.lanes.size, 0, 'delete 是零补间硬回收');
  ok('images[]：delete 先执行、注册后执行');
}

/* —— B：字节码锚点（_logic 不入库，缺件跳过） —— */
const LOGIC = join(ROOT, 'res/Assets/Res/LuaScripts/_logic');
if (existsSync(LOGIC)) {
  const read = (n) => {
    let b = readFileSync(join(LOGIC, n), null);
    let i = 0;
    while (!(b[i] === 0x1b && b[i + 1] === 0x4c && b[i + 2] === 0x75 && b[i + 3] === 0x61)) i++;
    /* 入库副本已剥过 TextAsset Raw 头（i=0）；AssetStudio 直出的要按 i-4 的长度切。 */
    return parseChunk(b.subarray(i, i + (i >= 4 ? b.readUInt32LE(i - 4) : b.length - i)));
  };
  const env = makeStdEnv();
  const v3 = new LuaTable();
  v3.set('New', (x, y, z) => ({x, y, z}));
  env.set('Vector3', v3);
  const val = (n) => execChunk(read(n), {env})[0];

  const t = val('Game.Avg.Enum.eAvgImgType.lua');
  assert.equal(t.get('Character'), CHAR, 'eAvgImgType.Character = 3');
  assert.equal(t.get('Movie'), 5);
  assert.equal(t.get('DistantView'), 1);
  const c = val('Game.Avg.Enum.eAvgContentType.lua');
  assert.deepEqual(['Chapter', 'Narratage', 'HeroDialog', 'NarratageWithSpeaker', 'Tips']
      .map((k) => c.get(k)), [1, 2, 3, 4, 5]);
  const px = val('Game.Avg.Enum.eAvgDialogPosX.lua');
  assert.deepEqual([1, 2, 3].map((i) => px.get(i)), [-300, 0, 300]);
  const ps = val('Game.Avg.Enum.eAvgImgPosType.lua');
  assert.equal(ps.get(1).x, -500);
  assert.equal(ps.get(2).x, 0);
  assert.equal(ps.get(3).x, 500);
  assert.equal(ps.get(4), null, '只有 3 格 ⇒ posId 4/5 对背景是空操作');
  ok('枚举锚点：eAvgImgType / eAvgContentType / eAvgDialogPosX / eAvgImgPosType(3 格 ±500)');

  const strs = [];
  const walk = (p) => { p.constants.forEach((k) => k.type === 'str' && strs.push(k.value)); p.protos.forEach(walk); };
  walk(read('Game.Avg.AvgImgTweenUntil.lua'));
  for (const need of ['DOColor', 'DOLocalMove', 'DOScale', 'DOLocalRotate', 'FastBeyond360',
    'DOShakePosition', 'shakeIntensity', 'dissolve', 'alpha', 'isDark', 'posId']) {
    assert.ok(strs.includes(need), `Tween 常量表应含 ${need}`);
  }
  ok('Tween 锚点：淡出/位移/缩放/旋转/震屏/溶解的 API 全在常量表里');
} else {
  console.log('  --   字节码锚点跳过：_logic/ 不入库（重导见 .gitignore 注释）');
}

/* —— 可选：全语料跑一遍，打印量级（不钉数，素材表在长） —— */
if (process.argv.includes('--corpus')) {
  const man = JSON.parse(readFileSync(join(ROOT, 'data/index/avg-scripts.json'), 'utf8'));
  const IMG = man.imgIds;
  const layCache = new Map();
  const layoutOf = (imgId) => {
    const p = IMG[imgId];
    if (!p) return null;
    if (layCache.has(p)) return layCache.get(p);
    const k = String(p).replace(/^.*\//, '').replace(/^lpic_/, '').replace(/\.png$/, '');
    let v = null;
    for (const name of [k, `${k}_avg`]) {
      const f = join(ROOT, 'data/layouts', `${name}.json`);
      if (existsSync(f)) { v = JSON.parse(readFileSync(f, 'utf-8')); break; }
    }
    layCache.set(p, v);
    return v;
  };
  const slotOf = (imgId, posId) => {
    const l = layoutOf(imgId);
    return l && l[`AvgHero${posId}`] ? {pos: l[`AvgHero${posId}`].pos,
      scale: l[`AvgHero${posId}`].scale, alpha: l[`AvgHero${posId}`].alpha} : null;
  };
  let hide = 0, show = 0, posIdChar = 0, darkAbs = 0;
  for (const s of man.stories) {
    let raw;
    try { raw = execChunk(parseChunk(readFileSync(join(ROOT, s.cfg))))[0]; }
    catch { continue; }
    const shotsT = raw instanceof LuaTable ? raw : null;
    if (!shotsT) continue;
    const keys = [...shotsT.entries()].filter(([, v]) => v instanceof LuaTable).map(([k]) => k);
    const f = emptyFold();
    for (const idx of keys.sort((a, b) => +a - +b)) {
      const shot = jsShot(shotsT.get(idx) instanceof LuaTable ? shotsT.get(idx) : null)
          ?? js(shotsT.get(idx));
      const tws = shot?.imgTween ?? [];
      const wasVisible = new Map();
      for (const e of tws) if (e?.imgId != null) wasVisible.set(e.imgId, f.lanes.get(e.imgId)?.alpha ?? 0);
      foldShot(f, shot, slotOf);
      for (const e of tws) {
        if (!e || e.posId == null || f.imgType.get(e.imgId) !== CHAR) continue;
        posIdChar++;
        if (e.isDark === undefined) darkAbs++;
        if (e.alpha !== undefined) continue;
        if (e.posId >= 2 && e.posId <= 4 && !wasVisible.get(e.imgId)) show++;
        if ((e.posId === 1 || e.posId === 5) && wasVisible.get(e.imgId)) hide++;
      }
    }
  }
  console.log(`\n  全语料：立绘 posId 条目 ${posIdChar} · 槽位 α 致隐 ${hide} · 致显 ${show}`
      + ` · 缺 isDark ${darkAbs}`);
}

function jsTween(shot) {
  const t = shot.get('imgTween');
  if (!t) return [];
  if (t instanceof LuaTable) {
    const n = Number(t.length());
    if (n > 0) return [...Array(n).keys()].map((i) => js(t.get(i + 1))).filter(Boolean);
  }
  return [...t.entries()].map(([, v]) => js(v)).filter(Boolean);
}
function js(o) {
  if (!(o instanceof LuaTable)) return o;
  const out = {};
  for (const [k, v] of o.entries()) out[typeof k === 'number' ? k : k] =
      v instanceof LuaTable ? js(v) : v;
  return out;
}
function jsShot(shot) {
  const o = js(shot);
  return {...o, imgTween: jsTween(shot), images: jsList(shot, 'images')};
}
function jsList(shot, key) {
  const t = shot.get(key);
  if (!t) return [];
  if (t instanceof LuaTable) {
    const n = Number(t.length());
    if (n > 0) return [...Array(n).keys()].map((i) => js(t.get(i + 1))).filter(Boolean);
  }
  return [...t.entries()].map(([, v]) => js(v)).filter(Boolean);
}

console.log(`\n${passed} 项通过`);
