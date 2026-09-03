/* audit-decode-completeness.mjs —— 语料解码完整性核对。
 *
 * 对每支 AvgCfg/AvgLang：把字节码常量表里的字符串与 lvm 解码结果比对，
 * 统计「常量里有、解码后找不到」的漏项。这些漏项意味着 VM 少执行了某些
 * 赋值（或某些数据在 VM 根本没跑到的原型里），即语料静默丢数据。
 *
 * 用法：
 *   node tools/audit-decode-completeness.mjs            # 全语料 Cfg
 *   node tools/audit-decode-completeness.mjs --lang     # 台词侧
 *   node tools/audit-decode-completeness.mjs --limit=50 # 只查前 50 段
 *   node tools/audit-decode-completeness.mjs --show=10  # 详列前 10 个漏项文件
 */
import {readFileSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {parseChunk} from '../js/core/lundump.js';
import {execChunk, toJS} from '../js/core/lvm.js';

const ROOT = resolve(process.cwd());
const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.slice(name.length + 3)) : dflt;
};
const KIND = argv.includes('--lang') ? 'lang' : 'cfg';
const LIMIT = flag('limit', 0);
const SHOW = flag('show', 0);

const manifest = JSON.parse(readFileSync(join(ROOT, 'data/index/avg-scripts.json'), 'utf8'));
const stories = LIMIT ? manifest.stories.slice(0, LIMIT) : manifest.stories;

function collectStrings(proto, into) {
  for (const k of proto.constants ?? []) {
    if (k.type === 'str' && typeof k.value === 'string') into.add(k.value);
  }
  for (const sub of proto.protos ?? []) collectStrings(sub, into);
  return into;
}

const perFile = [];
let totalMissing = 0;
const byValue = new Map();
let decodeFail = 0;

for (const story of stories) {
  const path = story[KIND];
  if (!path) continue;
  let proto;
  try {
    proto = parseChunk(readFileSync(join(ROOT, path)));
  } catch (e) {
    decodeFail++;
    continue;
  }
  let js;
  try {
    js = toJS(execChunk(proto)[0]);
  } catch (e) {
    decodeFail++;
    perFile.push({id: story.id, error: `exec: ${e.message}`, missing: []});
    continue;
  }
  const out = JSON.stringify(js);
  const strings = collectStrings(proto, new Set());
  /* ≥4 字符才核：短串（"a"、"id"）几乎必然作为其他键的子串出现，比不出信息。 */
  const missing = [...strings].filter((s) => s.length >= 4 && !out.includes(JSON.stringify(s)));
  if (!missing.length) continue;
  totalMissing += missing.length;
  perFile.push({id: story.id, missing});
  for (const m of missing) byValue.set(m, (byValue.get(m) ?? 0) + 1);
}

const affected = perFile.filter((p) => p.missing?.length);
console.log(`${KIND} 侧：${stories.length} 段 · 解码失败 ${decodeFail}`
    + ` · 有漏项的文件 ${affected.length} · 漏项总数 ${totalMissing}`);
if (affected.length) {
  const avg = (totalMissing / affected.length).toFixed(1);
  const worst = [...affected].sort((a, b) => b.missing.length - a.missing.length).slice(0, 8);
  console.log(`平均每文件漏项 ${avg}；最多：`);
  for (const w of worst) {
    console.log(`  ${String(w.missing.length).padStart(4)}  ${w.id}`
        + `  ${w.missing.slice(0, 4).map((s) => JSON.stringify(s)).join(' ')}`);
  }
  console.log('\n按值汇总（前 30，出现文件数）：');
  for (const [v, n] of [...byValue.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
    console.log(`  ${String(n).padStart(5)}  ${JSON.stringify(v)}`);
  }
}
if (SHOW && affected.length) {
  for (const p of affected.slice(0, SHOW)) {
    console.log(`\n### ${p.id}  漏 ${p.missing.length}`);
    console.log(p.missing.map((s) => '  · ' + JSON.stringify(s)).join('\n'));
  }
}
