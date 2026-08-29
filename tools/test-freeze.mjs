/**
 * 冻结表自检：data/fixtures/expected-scene1.json 是 M3/M4/M5 的断言基线，
 * 先证明这份基线自身可信 —— 每条判据都能用「参考的公式 + 仓库里的 layout」重算出来，
 * 算不平时说明要么抓取漂了、要么常量化错了，两者都必须在写引擎之前抓住。
 *
 * 用法：node tools/test-freeze.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const FIXTURE = 'scene1';
const freeze = JSON.parse(
    readFileSync(join(ROOT, 'data', 'fixtures', `expected-${FIXTURE}.json`), 'utf8'));
const scene = JSON.parse(
    readFileSync(join(ROOT, 'data', 'fixtures', `${FIXTURE}.json`), 'utf8'));
const layouts = new Map();
for (const name of ['persicaria_avg', 'sol_avg', 'croque_avg']) {
  layouts.set(name, JSON.parse(
      readFileSync(join(ROOT, 'data', 'layouts', `${name}.json`), 'utf8')));
}

let failures = 0;
const fail = (m) => { failures++; console.log('  FAIL ' + m); };
const ok = (m) => console.log('  ok   ' + m);

const PLAIN = /<[^>]*>/g;
const plain = (html) => html.replace(PLAIN, '');

/* --- 1. 抓取本身完整 --- */
const {summary, problems, pageErrors, meta} = freeze;
const shots = freeze.shots.filter((s) => !s.endOfScene);
if (shots.length !== freeze.summary.observed) {
  fail(`shots 里有 ${freeze.shots.length - shots.length} 个非镜条目混进来了`);
}
if (!summary.done) fail('这是 live 模式的中间产物（summary.done=false），不能用');
if (!summary.endOfScene) fail('没播到 playEnd（末尾缺 endOfScene），冻结表可能不完整');
if (summary.observed !== summary.contentShots) {
  fail(`只抓到 ${summary.observed}/${summary.contentShots} 镜`);
}
if (problems.length) fail(`problems: ${problems.join(' | ')}`);
if (pageErrors.length) fail(`pageErrors: ${pageErrors.join(' | ')}`);
if (meta.stage.width !== 1200 || meta.stage.height !== 540
    || meta.stage.fontSize !== '16px') {
  fail(`舞台不是 1200×540@16px，而是 ${meta.stage.width}×${meta.stage.height}`
      + `@${meta.stage.fontSize} —— em 推导全部失真，重跑时给足 --win`);
} else {
  ok(`完整 ${summary.observed} 镜 · 舞台 1200×540@16px · 无 problem 无 pageError`);
}

/* --- 2. settled 文案 == 回廊该条全文（参考打完字时二者同源） --- */
const textMismatch = [];
for (const [i, shot] of shots.entries()) {
  const logged = freeze.log[i]?.lines?.[0];
  if (logged === undefined) { textMismatch.push(`${shot.shot}: 回廊缺条目`); continue; }
  if (shot.lineHTML !== logged) {
    /* 浏览器回读 innerHTML 会把属性补引号，纯文本必须一致。 */
    if (plain(shot.lineHTML) !== plain(logged)) {
      textMismatch.push(`${shot.shot}: ${JSON.stringify(plain(shot.lineHTML))}`
          + ` != ${JSON.stringify(plain(logged))}`);
    }
  }
}
if (textMismatch.length) fail('定格文案与回廊不符:\n         ' + textMismatch.join('\n         '));
else ok(`${shots.length} 镜定格全文与回廊一致（含 ${shots.filter((s) => /<span|<a /.test(s.lineHTML)).length} 镜带标签）`);

/* --- 3. R8 串行门：打字起点必须不早于本镜全部 tween 结束 ---
   scene1 的 0/6/19/21 是无内容镜，点击永远不会停在它们身上：playShot 一进来就
   `shotId++` 落到下一镜，所以「它们的 avgLine.replaceChildren() 清空 + 它们的
   imgTween」全部落在后继内容镜那一次点击的时间线里。后果有两条，都必须显式建模：
   1) 内容镜的 phase.lineAt 记到的是前镜那次清空（≈0ms），不是本镜首字；
   2) 本镜 manageContentType 真正的门 = 前镜 horizon + 本镜 horizon。 */
const horizonOf = (index) => (scene[index]?.imgTween || []).reduce(
    (max, t) => Math.max(max, (t.delay || 0) + (t.duration || 0)), 0) * 1000;
function chain(index) {
  let ms = horizonOf(index);
  let clears = 0;
  for (let i = index - 1; i >= 0 && !scene[i].content; i--) {
    ms += horizonOf(i);
    /* clearStage 之后 avgLine 本来就是空的，replaceChildren 不产生 mutation。 */
    if (i > 0 && !scene[i].contentType) clears++;
  }
  return {ms, cleared: clears > 0};
}
const gate = [];
for (const shot of shots) {
  const {lineAt, dialogClassAt, lineEndAt} = shot.phase;
  if (lineAt === null) { gate.push(`${shot.shot}: 从未写入 #avg-line`); continue; }
  const {ms: chainMs, cleared} = chain(shot.shot);
  if (dialogClassAt === null) { gate.push(`${shot.shot}: 从未改过 #avg-dialog class`); continue; }
  if (dialogClassAt < chainMs - 25) {
    gate.push(`${shot.shot}: manageContentType(${dialogClassAt}) 早于链式 `
        + `horizon=${chainMs.toFixed(1)}`);
  }
  if (dialogClassAt > chainMs + 120) {
    gate.push(`${shot.shot}: manageContentType(${dialogClassAt}) 比链式 horizon=`
        + `${chainMs.toFixed(1)} 晚超过 120ms`);
  }
  if (cleared) {
    /* 判据推导出「本镜时间线以前镜清空开头」，就得看到清空的样子，否则推导错了。 */
    if (lineAt > 50) {
      gate.push(`${shot.shot}: 前镜无内容，lineAt=${lineAt} 却不是清空时刻`);
    }
    if (!(lineEndAt > dialogClassAt)) {
      gate.push(`${shot.shot}: 首字没等在前镜清空之后`
          + ` lineEnd=${lineEndAt} class=${dialogClassAt}`);
    }
  } else if (Math.abs(dialogClassAt - lineAt) > 25) {
    gate.push(`${shot.shot}: manageContentType(${dialogClassAt}) 与 speak(${lineAt})`
        + ` 不同 tick（且前镜有内容，无清空可解释）`);
  }
}
if (gate.length) fail('phase 时序不符 R8:\n         ' + gate.join('\n         '));
else ok(`R8 串行门成立（${shots.filter((s) => s.phase.tweenHorizonMs > 0).length} 镜有过渡门，`
    + `${shots.filter((s) => chain(s.shot).cleared).length} 镜被无内容前镜抢掉首字时刻，`
    + `其余 ${shots.length - shots.filter((s) => chain(s.shot).cleared).length} 镜`
    + ` #avg-dialog class 与首字同 tick）`);

/* --- 4. 立绘几何：layout + ÷2 + /32 能重算出记录值 --- */
const imgMap = new Map();
for (const s of scene) for (const img of s.images || []) imgMap.set(img.imgId, img);
const EM = 16;
const geometry = [];
const seenLanes = new Set();
/* blockChara 写的是 if (img.isDark != classList.contains('dark')) toggle() ——
   带 isDark 就赋值，不带（undefined）时 `undefined != false` 为真，照样翻转。
   所以明暗是逐条累积的，必须按 lane 顺序重放，不能只看本镜。 */
const darkState = new Map();
for (const shot of shots) {
  for (const t of scene[shot.shot]?.imgTween || []) {
    if (imgMap.get(t.imgId)?.imgType !== 3) continue;
    seenLanes.add(t.imgId);
    const before = darkState.get(t.imgId) || false;
    darkState.set(t.imgId, t.isDark === undefined ? !before : !!t.isDark);
  }
  const ids = shot.charas.map((c) => Number(c.imgId));
  const absent = [...seenLanes].filter((id) => !ids.includes(id));
  const extra = ids.filter((id) => !seenLanes.has(id));
  if (absent.length || extra.length) {
    geometry.push(`${shot.shot}: 在场 ${ids} != 已出现过的 imgType3 lane `
        + `[${seenLanes}]（缺 ${absent} 多 ${extra}）`);
  }
  for (const c of shot.charas) {
    const config = layouts.get(imgMap.get(Number(c.imgId))?.imgPath);
    if (!config) { geometry.push(`${shot.shot}: imgId ${c.imgId} 无 layout`); continue; }
    let sizeDelta = config.sizeDelta;
    if (Array.isArray(sizeDelta)) sizeDelta = sizeDelta[1];
    const imgSize = sizeDelta * Math.abs(config.m_LocalScale) / 2;
    const stageW = meta.stage.width, stageH = meta.stage.height;
    const transX = stageW / (2 * EM) - imgSize / 32;
    const transY = imgSize / 32 - stageH / (2 * EM);
    const scale = config['AvgHero' + c.posId]?.scale || [1, 1];
    const [mx, , , my, e, f] = c.transform === 'none'
        ? [1, 0, 0, 1, 0, 0] : c.transform.match(/-[\d.]+|[\d.]+/g).map(Number);
    const near = (a, b) => Math.abs(a - b) < 0.6;
    if (!near(parseFloat(c.width), imgSize) || !near(parseFloat(c.height), imgSize)) {
      geometry.push(`${shot.shot}/${c.imgId}: 宽高 ${c.width} != ${imgSize}`);
    }
    if (mx !== scale[0] || my !== scale[1]) {
      geometry.push(`${shot.shot}/${c.imgId}: scale ${mx},${my} != layout ${scale}`);
    }
    if (!near(e, transX * EM) || !near(f, transY * EM)) {
      geometry.push(`${shot.shot}/${c.imgId}: translate ${e},${f} != `
          + `${(transX * EM).toFixed(1)},${(transY * EM).toFixed(1)}`);
    }
    const pos = config['AvgHero' + c.posId]?.pos;
    if (!near(parseFloat(c.left), pos[0] / 2) || !near(parseFloat(c.bottom), pos[1] / 2)) {
      geometry.push(`${shot.shot}/${c.imgId}: left/bottom ${c.left}/${c.bottom} != `
          + `${pos[0] / 2}px/${pos[1] / 2}px`);
    }
    if (c.cls.includes('dark') !== !!darkState.get(Number(c.imgId))) {
      geometry.push(`${shot.shot}/${c.imgId}: dark=${c.cls.includes('dark')} `
          + `!= 重放 ${darkState.get(Number(c.imgId))}`);
    }
    const alpha = (scene[shot.shot].imgTween || []).filter(
        (t) => t.imgId === Number(c.imgId)).pop()?.alpha;
    if (alpha !== undefined && parseFloat(c.opacity || '1') !== alpha) {
      geometry.push(`${shot.shot}/${c.imgId}: opacity ${c.opacity} != 末条 alpha ${alpha}`);
    }
    const filter = c.cls.includes('dark') ? 'brightness(0.5)' : 'none';
    if (c.filter !== filter) {
      geometry.push(`${shot.shot}/${c.imgId}: filter ${c.filter} != ${filter}`);
    }
  }
}
const spriteShots = shots.filter((s) => s.charas.length).length;
if (geometry.length) fail('立绘几何重算不平:\n         ' + geometry.slice(0, 12).join('\n         '));
else if (!spriteShots) fail('冻结表里一个立绘都没有，几何判据没被跑到');
else ok(`${spriteShots} 镜共 ${shots.reduce((n, s) => n + s.charas.length, 0)} 个立绘：`
    + '宽高/translate/left/bottom/scale/dark 全部由 layout + ÷2 + /32 重算命中');

/* --- 5. 画布没被跨源污染（换脸依赖 getImageData） --- */
const tainted = [];
for (const shot of shots) {
  for (const c of shot.charas) {
    if (Object.values(c.canvas.samples).some((v) => v === 'TAINTED')) {
      tainted.push(`${shot.shot}/${c.imgId}`);
    }
  }
}
if (tainted.length) fail(`canvas 被污染，参考的换脸路径读不到像素: ${tainted.join(', ')}`);
else ok('所有立绘 canvas getImageData 可读（同源代理生效，R4 的降级路径没被触发）');

/* --- 6. B10：规则表整表重复 2 份（setScene 预取 + playShot 再载） ---
   只数选择器、不比文本顺序：posSizeMap.set 发生在 fetch(layout).then() 里
   （AvgPlayer.js:126/188），presetCharaImgStyles 遍历它的 keys 就是「响应到达次序」，
   同一份 scene1 连跑两次 101/103/105 的先后就会换（实测两轮内容全等、次序不同）。
   ⇒ 移植后按 imgId 排序输出规则，否则编辑器里的 diff 天天抖。 */
const selectors = (freeze.charaRules.match(/\.avg-chara[^{]*\{/g) || [])
    .map((s) => s.trim());
const counts = new Map();
for (const s of selectors) counts.set(s, (counts.get(s) || 0) + 1);
const dupes = [...counts.values()].filter((n) => n !== 2).length;
if (!selectors.length) fail('charaRules 是空的');
else if (dupes) fail(`${dupes} 个选择器的重复份数不是 2（参考应当恰好重复两轮 loadImages）`);
else ok(`charaRules ${selectors.length} 条 = ${counts.size} 个选择器 × 2，`
    + '印证 setScene 预取与 playShot 再载各写一遍（移植后整表重建，不留这个冗余）');

console.log(failures ? `\n存在 ${failures} 类失败` : '\n冻结表可信');
process.exit(failures ? 1 : 0);
