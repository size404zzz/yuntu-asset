/**
 * M13 语料端到端跑者：起同源宿主 → 无头 Chrome 打开 selftest-avg.html
 * （现场解码 res/ 的 AvgCfg/AvgLang → avgwire 映射 → Player 逐镜 seek）→
 * 读回报告，与 Node 侧同源解码的期望对拍。默认三段剧本覆盖
 * 纯文本主线（cpt00_e_01_01）与立绘+分支（23concert_undline_03、cpt_kimie）。
 *
 * 用法：node tools/test-avg-e2e.mjs [--id=ID1,ID2] [--timeout=240]
 */
import {existsSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {mkdirSync, writeFileSync} from 'node:fs';
import {parseChunk} from '../js/core/lundump.js';
import {execChunk, toJS} from '../js/core/lvm.js';
import {storyToWire, replayChain} from '../js/core/avgwire.js';
import {stripMarkup} from '../js/core/schema.js';
import {emptyState, applyImages, applyShotTweens} from '../js/core/state.js';
import {flag, findChrome, freshProfile, launchPage, startHost, waitForReport,
  FIXTURES} from './lib/run.mjs';

const IDS = flag('id',
    'cpt00_e_01_01,23concert_undline_03,cpt_kimie_03_04').split(',');
const OUT = join(FIXTURES, 'expected-avg_e2e_report.json');
const ROOT = resolve(process.cwd());

/* —— Node 侧同源期望：与页面同一套解码/映射/遍历规则 —— */

const manifest = JSON.parse(readFileSync(join(ROOT, 'data', 'index', 'avg-scripts.json'), 'utf8'));
const decodeLua = (path) =>
  toJS(execChunk(parseChunk(readFileSync(join(ROOT, path))))[0]);
function expectOf(id) {
  const meta = manifest.stories.find((s) => s.id === id);
  if (!meta) throw new Error(`剧本 ${id} 不在索引里`);
  /* 与页面同口径：带全局立绘表/说话者桥表的完整映射链。 */
  const {wire, stats} = storyToWire(decodeLua(meta.cfg), decodeLua(meta.lang),
      {imgIds: manifest.imgIds, heroSprites: manifest.heroSprites, pathOwner: manifest.pathOwner});
  /* 重放链上的可停留镜（branch[0] 优先、断档即终局），直通镜停不住。 */
  const seekable = replayChain(wire)
      .filter((id) => {
        const s = wire[id];
        return s.content || s.branch || !s.autoContinue;
      });
  /* 单页、非 type5 的 content 镜，settled 后 avgLine 应等于去标记文本。 */
  const lines = new Map();
  for (const id2 of seekable) {
    const shot = wire[id2];
    if (typeof shot.content !== 'string' || shot.contentType === 5) continue;
    if (shot.content.includes('<|>')) continue;
    lines.set(id2, stripMarkup(shot.content));
  }
  const brief = typeof wire['1']?.SkipScenario === 'string' ? wire['1'].SkipScenario : '';
  const spriteShots = seekable.filter((id2) =>
      (wire[id2].images ?? []).some((img) => img.imgType === 3));
  /* 沿重放链折叠状态（页面 seekShot 逐镜重放的同款路径），为每镜记录
     各立绘的期望行内绝对定位：有 pos → "left,bottom"（em），否则 null。 */
  const absPosAt = new Map();
  const foldState = emptyState();
  for (const id2 of replayChain(wire)) {
    const shot = wire[id2];
    if (shot.images?.length) applyImages(foldState, shot.images);
    applyShotTweens(foldState, shot);
    const per = new Map();
    for (const [imgId, lane] of foldState.lanes) {
      per.set(String(imgId), lane.pos
          ? `${lane.pos[0] / 32}em,${lane.pos[1] / 32}em` : null);
    }
    absPosAt.set(id2, per);
  }
  return {wire, stats, seekable, lines, brief, spriteShots, absPosAt};
}

/* —— 宿主（一次）与每段剧本一轮浏览器 —— */

const TIMEOUT = Number(flag('timeout', '240'));
const host = await startHost({probe: 'data/index/avg-scripts.json',
  port: Number(flag('port', '0'))});
const chromeBin = findChrome();

/* 渲染态 → 纯文本：reformat 产出的 DOM 里字面 > 被转义成 &gt;、换行成
   <br>，先还原实体再按 stripMarkup 拆标记，与期望侧（源文案 stripMarkup）
   同构（textContent 会把 <br> 压成空串，不能用）。 */
const plainOf = (html) => stripMarkup(
    html.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&'));

let code = 0;
const failures = [];
const summaries = [];
let lastReport = null;
try {
  for (const id of IDS) {
    const chrome = launchPage({chrome: chromeBin, port: host.port,
      page: `selftest-avg.html?id=${id}`,
      profile: freshProfile(`e2e-${id}`)});
    let report = null;
    try {
      report = await waitForReport({out: OUT, timeoutS: TIMEOUT, chrome,
        step: id});
    } catch (e) {
      failures.push(`${id}: ${e.message}`);
      code = 1;
      chrome.kill();
      continue;
    }
    chrome.kill();
    lastReport = report;
    const want = expectOf(id);
    if (report.brief !== want.brief) {
      failures.push(`${id}: 简介不符 ${JSON.stringify(report.brief)}`);
    }
    const gotIds = report.shots.map((s) => s.id);
    if (JSON.stringify(gotIds) !== JSON.stringify(want.seekable)) {
      failures.push(`${id}: 遍历序列不符 页面${gotIds.length} vs 期望${want.seekable.length}`);
    }
    let lineChecked = 0;
    for (const [sid, text] of want.lines) {
      const got = report.shots.find((s) => s.id === sid)?.line;
      if (got === undefined) continue;
      lineChecked++;
      if (plainOf(got) !== text) {
        failures.push(`${id} 镜 ${sid} 台词不符：${JSON.stringify(plainOf(got).slice(0, 30))}`
            + ` ≠ ${JSON.stringify(text.slice(0, 30))}`);
      }
    }
    const withCharas = report.shots.filter((s) => s.charas > 0).length;
    if (want.spriteShots.length && withCharas === 0) {
      failures.push(`${id}: 有立绘镜 ${want.spriteShots.length} 个但舞台没挂上立绘`);
    }
    /* 站位合法性：台上立绘必须都落在 1..5 槽（posundefined 零容忍）。 */
    for (const s of report.shots) {
      for (const p of s.posIds ?? []) {
        if (!['1', '2', '3', '4', '5'].includes(p)) {
          failures.push(`${id} 镜 ${s.id}: 立绘槽位非法 pos${p}`);
        }
      }
    }
    /* 绝对定位对拍：行内 [left,bottom] 与折叠态 lane.pos（÷32 成 em）一致。 */
    let absChecked = 0;
    for (const s of report.shots) {
      const wantPos = want.absPosAt.get(s.id) ?? new Map();
      for (const {imgId, pos} of s.absPos ?? []) {
        absChecked++;
        const exp = wantPos.get(String(imgId)) ?? null;
        const got = pos ? pos.join(',') : null;
        if (got !== exp) {
          failures.push(`${id} 镜 ${s.id}: 立绘 ${imgId} 绝对定位 ${got} ≠ 期望 ${exp}`);
        }
      }
    }
    if (report.stats?.resolved !== want.stats.resolved
        || report.stats?.unresolved?.length !== want.stats.unresolved.length) {
      failures.push(`${id}: 映射统计不符 页面 ${report.stats?.resolved} vs Node ${want.stats.resolved}`);
    }
    for (const m of report.problems ?? []) failures.push(`${id} 页面问题：${m}`);
    for (const m of report.pageErrors ?? []) failures.push(`${id} 页面错误：${m}`);
    summaries.push(`${id}: 镜 ${report.shots.length}/${want.seekable.length}`
        + ` · 台词核对 ${lineChecked} · 立绘镜 ${withCharas}/${want.spriteShots.length}`
        + ` · 绝对定位 ${absChecked}`
        + ` · 解引用 ${want.stats.resolved}+${want.stats.unresolved.length}`);
  }
} finally {
  host.kill();
}

for (const s of summaries) console.log('  ' + s);
for (const m of failures) console.log('  - ' + m);
if (failures.length && lastReport) {
  mkdirSync(join(ROOT, 'tools', 'media', '.tmp'), {recursive: true});
  writeFileSync(join(ROOT, 'tools', 'media', '.tmp', 'avg-e2e-report.json'),
      JSON.stringify(lastReport, null, 1));
}
console.log(failures.length ? '\nM13 语料端到端未通过' : '\nM13 语料端到端通过');
process.exit(failures.length || code ? 1 : 0);
