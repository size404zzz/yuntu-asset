/* audit-effects.mjs —— 全语料 AVG 特效引用普查。
 *
 * 用法：
 *   node tools/audit-effects.mjs --schema     # 特效条目的字段形状与宿主键
 *   node tools/audit-effects.mjs              # 按 prefab 汇总：次数 / 段落 / 参数分布
 *   node tools/audit-effects.mjs --samples    # 每个 prefab 打一条原始条目样例
 *   node tools/audit-effects.mjs --prefab     # 只算 effect1..4[].prefabName：真粒子特效清单
 */
import {readFileSync} from 'node:fs';
import {resolve, join, basename} from 'node:path';
import {parseChunk} from '../js/core/lundump.js';
import {execChunk, toJS} from '../js/core/lvm.js';

const ROOT = resolve(process.cwd());
const manifest = JSON.parse(readFileSync(join(ROOT, 'data/index/avg-scripts.json'), 'utf8'));
const argv = process.argv.slice(2);
const MODE = argv.includes('--schema') ? 'schema'
    : argv.includes('--samples') ? 'samples'
    : argv.includes('--prefab') ? 'prefab' : 'summary';

const PATHLIKE = /^[A-Za-z0-9_\-./]+$/;
const count = (m, k, n = 1) => m.set(k, (m.get(k) ?? 0) + n);

/* 资源路径候选：含斜杠、非纯数字、且落在已知资源前缀或带特效特征。 */
function isResourcePath(v) {
  return typeof v === 'string' && v.includes('/') && PATHLIKE.test(v)
      && v.length > 3 && !/\.(lua|asset|controller)$/i.test(v);
}

const prefabHits = new Map();      // prefab → {count, stories:Set, entries:[], fields:Map}
const hostKeys = new Map();        // "宿主对象键集合 ⇒ 资源键" 形状
const unknownStrings = new Map();  // 疑似资源但没匹配到 prefab 的键

function walk(node, parents) {
  if (Array.isArray(node)) {
    for (const v of node) walk(v, parents);
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (isResourcePath(v)) {
      record(node, k, v, parents);
    } else if (v && typeof v === 'object') {
      walk(v, [...parents, k]);
    }
  }
}

function record(host, key, path, parents) {
  const isEffect = /^(avg|fx|effect|eff|vfx)/i.test(path) || /FXP|_eff|\beff-/i.test(path);
  if (!isEffect) return;
  const ownerKey = parents[parents.length - 1] ?? '(root)';
  const shape = Object.keys(host).sort().join('+');
  count(hostKeys, `${ownerKey} . ${key} :: {${shape}}`);
  const hit = prefabHits.get(path) ?? {count: 0, stories: new Set(), fields: new Map(),
    samples: [], keys: new Map(), owners: new Map(), layers: new Map(), pos: new Map()};
  hit.count++;
  hit.stories.add(CURRENT_STORY);
  count(hit.keys, key);
  count(hit.owners, ownerKey);
  if (host.layer !== undefined) count(hit.layers, JSON.stringify(host.layer));
  count(hit.pos, Array.isArray(host.pos) ? `pos[${host.pos.length}]` : (host.pos === undefined ? '(无)' : 'other'));
  for (const [k, v] of Object.entries(host)) {
    if (k === key) continue;
    count(hit.fields, typeof v === 'object' ? `${k}:obj` : `${k}=${JSON.stringify(v)}`);
  }
  if (hit.samples.length < 2) hit.samples.push({story: CURRENT_STORY, key, host});
  prefabHits.set(path, hit);
}

let CURRENT_STORY = null;
for (const story of manifest.stories) {
  if (!story.cfg) continue;
  CURRENT_STORY = story.id;
  let js;
  try {
    js = toJS(execChunk(parseChunk(readFileSync(join(ROOT, story.cfg))))[0]);
  } catch (e) {
    count(unknownStrings, `DECODE-FAIL ${story.id}: ${e.message}`);
    continue;
  }
  walk(js, []);
}

const sorted = [...prefabHits.entries()].sort((a, b) => b[1].count - a[1].count);
if (MODE === 'prefab') {
  const real = sorted.filter(([, h]) => h.keys.has('prefabName'));
  const others = sorted.filter(([, h]) => !h.keys.has('prefabName'));
  let refs = 0;
  console.log(`真粒子特效（effect1..4[].prefabName）：${real.length} 种`);
  for (const [path, hit] of real) {
    const n = hit.keys.get('prefabName');
    refs += n;
    const slots = [...hit.owners.keys()].sort().join('/');
    const layers = [...hit.layers.entries()].map(([k, v]) => `${k}×${v}`).join(' ') || '(缺省)';
    const pos = [...hit.pos.keys()].join(' ');
    console.log(`  ${String(n).padStart(4)} 条 ${String(hit.stories.size).padStart(4)}段`
        + `  ${path.padEnd(46)} 槽:${slots.padEnd(12)} layer:${layers.padEnd(18)} pos:${pos}`);
  }
  console.log(`合计 ${refs} 条特效引用`);
  console.log(`\n被同前缀捞到但不是粒子特效（注册图像 imgPath / 视频 vedioPath）：`
      + `${others.length} 种 / ${others.reduce((a, [, h]) => a + h.count, 0)} 条`);
  for (const [path, hit] of others) {
    console.log(`  ${String(hit.count).padStart(4)}  ${path.padEnd(46)} 键:${[...hit.keys].join(',')} 宿主:${[...hit.owners].join(',')}`);
  }
} else if (MODE === 'schema') {
  console.log(`特效宿主键形状（${prefabHits.size} 个 prefab / ${sorted.reduce((a, h) => a + h[1].count, 0)} 条引用）：`);
  for (const [shape, n] of [...hostKeys.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(6)}  ${shape}`);
  }
} else if (MODE === 'samples') {
  for (const [path, hit] of sorted) {
    console.log(`\n### ${path}  ×${hit.count} / ${hit.stories.size} 段`);
    console.log('  fields:', [...hit.fields.entries()].sort((a, b) => b[1] - a[1])
        .slice(0, 12).map(([k, v]) => `${k}(${v})`).join(', '));
    for (const s of hit.samples) {
      console.log(`  sample@${s.story} key=${s.key}: ${JSON.stringify(s.host).slice(0, 400)}`);
    }
  }
} else {
  console.log(`共 ${prefabHits.size} 种特效资源路径，${sorted.reduce((a, h) => a + h[1].count, 0)} 条引用`);
  for (const [path, hit] of sorted) {
    console.log(`  ${String(hit.count).padStart(6)} × ${hit.stories.size.toString().padStart(4)}段  ${path}`);
  }
  const names = sorted.map(([p]) => basename(p.toLowerCase()));
  console.log('\n资源名（比对 bundle 侧用）:', names.join(', '));
}
if (unknownStrings.size) {
  console.log('\n解码失败/其他:', [...unknownStrings.entries()].slice(0, 5));
}
