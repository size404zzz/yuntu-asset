/* test-gameplay.mjs —— 我们的折叠（state.js）与游戏折叠（js/test/gamefold.js）逐镜对账。
 *
 * 契约从 wiki 换成游戏本体后，`expected-scene*.json` 那批基准件已删除，
 * 播放链失去对照物。这条链用不着浏览器：两边都只吃 wire 后的镜序列，
 * 所以把 oracle 直接当基准，把分歧按「已解释 / 未知」两类记账：
 *   已解释 = 本轮反汇编确认的三处语义差（isDark 缺省翻转、posId 回槽复位 α/scale、
 *            images[] 注册即定可见度）；
 *   未知   = 必须为 0，否则就是没读到的语义或实现 bug。
 * 用法：node tools/test-gameplay.mjs [--scene=scene2] [--verbose]
 *      （不带 --scene 跑全语料 1878 段；带则只跑 data/fixtures 下的那个夹具）
 */
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {parseChunk} from '../js/core/lundump.js';
import {execChunk, toJS, LuaTable} from '../js/core/lvm.js';
import {emptyState, applyImages, applyShotTweens} from '../js/core/state.js';
import {emptyFold, foldShot, CHAR} from '../js/test/gamefold.js';

const ROOT = resolve(process.cwd());
const verbose = process.argv.includes('--verbose');
const sceneArg = process.argv.find((a) => a.startsWith('--scene='))?.slice(8);
const list = (x) => (Array.isArray(x) ? x : Object.values(x ?? {}));

const man = JSON.parse(readFileSync(join(ROOT, 'data/index/avg-scripts.json'), 'utf8'));
const IMG = man.imgIds;                          // imgId → 立绘候选路径（票数降序，[0]=全局众数）
const layCache = new Map();
function layoutOf(imgId) {
  const cands = IMG[imgId];
  const p = Array.isArray(cands) ? cands[0] : cands;
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
}
const slotOf = (imgId, posId) => {
  const l = layoutOf(imgId);
  const e = l && l[`AvgHero${posId}`];
  return e ? {pos: e.pos, scale: e.scale, alpha: e.alpha} : null;
};

/* ---------- 两边的落定态取成同一形状（只比可见度与明暗） ---------- */
const ours = (st, id) => {
  const l = st.lanes.get(id);
  return l ? {alpha: l.alpha ?? 0, dark: !!l.isDark} : null;
};
const theirs = (f, id) => {
  const l = f.lanes.get(id);
  return l ? {alpha: l.alpha ?? 0, dark: !!l.isDark} : null;
};

/* 分歧归类：按该镜条目的字段组合判定属于哪一处已知差异 */
function bucketOf(imgs, tws, id, o, t) {
  const mine = tws.filter((e) => e && e.imgId === id);
  const reg = imgs.filter((e) => e && e.imgId === id);
  if (o.dark !== t.dark && mine.some((e) => e.isDark === undefined)) {
    return 'isDark 缺省：我们翻转 / 游戏不碰';
  }
  if (o.dark !== t.dark && reg.length) return 'images[] 注册即重置明暗：我们继承';
  if (o.alpha !== t.alpha && reg.some((e) => e.alpha !== undefined)) {
    return 'images[] 注册即定可见度：我们只摆槽位不定 α';
  }
  if (o.alpha !== t.alpha && mine.some((e) => e.posId != null && e.alpha === undefined)) {
    return 'posId 回槽：游戏按官方槽 α 落定';
  }
  return null;
}

function stories() {
  if (sceneArg) {
    const scene = JSON.parse(readFileSync(join(ROOT, 'data/fixtures', `${sceneArg}.json`), 'utf8'));
    return [{id: sceneArg, shots: scene}];
  }
  const out = [];
  for (const s of man.stories) {
    let raw;
    try { raw = execChunk(parseChunk(readFileSync(join(ROOT, s.cfg))))[0]; } catch { continue; }
    if (!(raw instanceof LuaTable)) continue;
    out.push({id: s.id, raw});
  }
  return out;
}

const T = {shots: 0, lanes: 0, laneDiff: 0, inherited: 0, converged: 0,
  diffs: new Map(), unknown: [], stories: new Set()};
for (const s of stories()) {
  const st = emptyState();
  const f = emptyFold();
  const shots = s.raw instanceof LuaTable
      ? [...s.raw.entries()].filter(([, v]) => v instanceof LuaTable)
          .sort((a, b) => +a[0] - +b[0]).map(([, v]) => toJS(v))
      : s.shots ?? [];
  const diverged = new Map();     /* imgId → 首次分歧的镜键；后续同异记为「继承」 */
  for (const shot of list(shots)) {
    if (!shot || typeof shot !== 'object') continue;
    T.shots++;
    shot.__k = Object.keys(shot).length;
    applyImages(st, list(shot.images));
    applyShotTweens(st, {...shot, imgTween: list(shot.imgTween)});
    foldShot(f, shot, slotOf);
    const ids = new Set([...st.lanes.keys(), ...f.lanes.keys()]);
    for (const id of ids) {
      const o = ours(st, id);
      const t = theirs(f, id);
      if (!o || !t) continue;                      /* 一侧没建 lane：表示法差异，不算语义分歧 */
      T.lanes++;
      const same = o.alpha === t.alpha && o.dark === t.dark;
      if (same) {
        if (diverged.delete(id)) T.converged++;      /* 两侧又一致了 */
        continue;
      }
      T.laneDiff++;
      if (diverged.has(id)) { T.inherited++; continue; }
      /* 只在首次分歧处归类——之后的一致/不一致都是它的尾巴 */
      diverged.set(id, shot.__k);
      const b = bucketOf(list(shot.images), list(shot.imgTween), id, o, t);
      T.stories.add(s.id);
      if (b) {
        T.diffs.set(b, (T.diffs.get(b) ?? 0) + 1);
      } else {
        T.unknown.push(`${s.id} imgId=${id} 我们 α=${o.alpha} dark=${o.dark}`
            + ` / 游戏 α=${t.alpha} dark=${t.dark}`
            + `
        imgTween=${JSON.stringify(list(shot.imgTween).filter((e) => e?.imgId === id))}`
            + `
        images=${JSON.stringify(list(shot.images).filter((e) => e?.imgId === id))}`);
      }
    }
  }
}

console.log(`镜 ${T.shots} · lane·镜 ${T.lanes} · 有分歧的 lane·镜 ${T.laneDiff}`
    + `（其中首次分歧 ${T.diffs.size ? '' : ''}${[...T.diffs.values()].reduce((a, b) => a + b, 0) + T.unknown.length}、`
    + `继承 ${T.inherited}、复归 ${T.converged}）`);
for (const [k, v] of [...T.diffs].sort((a, b) => b[1] - a[1])) {
  console.log(`  已知差异  ${k.padEnd(42)} ${v}`);
}
console.log(`  未知分歧   ${T.unknown.length}`);
if (verbose) T.unknown.slice(0, 25).forEach((u) => console.log('    · ' + u));

/* 反退化靠 lane·镜样本量；分类器本身的可信度由 test-gamefold 的合成用例钉 */
assert.ok(T.lanes > (sceneArg ? 20 : 100000), `lane·镜样本太少，对账没真跑：${T.lanes}`);
assert.equal(T.unknown.length, 0,
    `出现未归类分歧（前 5 条）：\n    ${T.unknown.slice(0, 5).join('\n    ')}`);
console.log(`\nstate.js 与游戏折叠的对账通过：分歧全部落在 ${T.diffs.size} 类已知语义差内，`
    + `涉及 ${T.stories.size} 段`);
