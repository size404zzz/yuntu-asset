/* dyn-config-import.mjs —— 把 dyn-config-dump.py 的 JSONL 落成表文件。
 *
 * 行协议（schema yuntu-dyn-config/v1）：
 *   {kind:'meta', dynSlots:[...]}                     运行时环境
 *   {kind:'table', name, source, count}               表头（count = 顶层键数）
 *   {kind:'row', name, source, key, v}                一个顶层条目
 * 同一张表可能有两个 source：configdata（ConfigData.<name> 的运行时合并真值）
 * 和 dyncfg（LoadDynCfg 的返回值）。落盘规则：<name>.json 用 dyncfg 非空者，
 * 否则 configdata；两个原始源也各存一份 <name>.<source>.json 供比对。
 *
 * 用法：
 *   node tools/dyn-config-import.mjs <capture.jsonl> [--out data/index/dyn-config]
 */
import {readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {join, resolve} from 'node:path';

const SCHEMA = 'yuntu-dyn-config/v1';

const argv = process.argv.slice(2);
const input = argv.find((a) => !a.startsWith('--'));
if (!input) {
  console.error('用法：node tools/dyn-config-import.mjs <capture.jsonl> [--out 目录]');
  process.exit(1);
}
const outIdx = argv.indexOf('--out');
const outDir = resolve(outIdx >= 0 ? argv[outIdx + 1] : join('data', 'index', 'dyn-config'));

const lines = readFileSync(resolve(input), 'utf8').split('\n').filter(Boolean);
const meta = [];
const tables = new Map();          /* name -> {source -> Map(key -> v)} */
const handbookRows = new Map();    /* classId -> Map(actId -> content 行) */
for (const line of lines) {
  let row;
  try { row = JSON.parse(line); } catch { continue; }
  if (row.schema !== SCHEMA) continue;
  if (row.kind === 'meta') { meta.push(row); continue; }
  if (row.kind === 'handbook-row' && row.row) {
    const cid = String(row.classId);
    const bucket = handbookRows.get(cid) ?? new Map();
    bucket.set(String(row.id), row.row);
    handbookRows.set(cid, bucket);
    continue;
  }
  if (row.kind !== 'row') continue;
  const src = String(row.source ?? '');
  const name = String(row.name ?? '');
  if (!name) continue;
  const bySource = tables.get(name) ?? new Map();
  const bucket = bySource.get(src) ?? new Map();
  bucket.set(String(row.key), row.v);
  bySource.set(src, bucket);
  tables.set(name, bySource);
}

/* 键 1..n 连续 → 数组；其余 → 对象（键即 Lua 顶层键的字符串形式）。 */
function rebuild(bucket) {
  const keys = [...bucket.keys()];
  const numeric = keys.map((k) => (/^(0|[1-9]\d*)$/.test(k) ? Number(k) : null));
  const isArray = numeric.every((k) => k !== null)
      && (numeric.length === 0
          || (Math.min(...numeric) >= 0
              && Math.max(...numeric) === numeric.length - 1));
  const out = isArray ? [] : {};
  for (const k of keys) {
    if (isArray) out[Number(k)] = bucket.get(k);
    else out[k] = bucket.get(k);
  }
  return out;
}

mkdirSync(outDir, {recursive: true});
const summary = {meta, tables: {}};
for (const [name, bySource] of tables) {
  const sources = {};
  for (const [src, bucket] of bySource) {
    const data = rebuild(bucket);
    sources[src] = data;
    writeFileSync(join(outDir, `${name}.${src}.json`),
        JSON.stringify(data, null, 1) + '\n');
  }
  /* dyncfg 非空优先（它是 LoadDynCfg 的真值）；否则 configdata（合并态）。 */
  const preferred = sources.dyncfg && Object.keys(sources.dyncfg).length
      ? sources.dyncfg
      : (sources.configdata ?? sources.dyncfg ?? null);
  if (preferred) {
    writeFileSync(join(outDir, `${name}.json`), JSON.stringify(preferred, null, 1) + '\n');
  }
  summary.tables[name] = Object.fromEntries(
      Object.entries(sources).map(([s, d]) => [s, Array.isArray(d) ? d.length : Object.keys(d).length]));
}

writeFileSync(join(outDir, '_summary.json'), JSON.stringify(summary, null, 1) + '\n');
if (handbookRows.size) {
  /* 手册 content 直读行（handbook-row）：生成器消费的形态——
     [{classId, id, row}]，覆盖静态 content（含 class 3 整类） */
  const rowsOut = [];
  for (const [cid, bucket] of [...handbookRows].sort()) {
    for (const [id, row] of bucket) {
      rowsOut.push({classId: Number(cid), id: Number(id), row});
    }
  }
  rowsOut.sort((a, b) => a.classId - b.classId || a.id - b.id);
  writeFileSync(join(outDir, 'handbook_activity.rows.json'),
      JSON.stringify(rowsOut, null, 1) + '\n');
  summary.handbookRows = rowsOut.length;
}
for (const [name, sources] of Object.entries(summary.tables)) {
  console.log(`  ${name}: ` + Object.entries(sources)
      .map(([s, n]) => `${s}=${n}`).join(' '));
}
console.log(`${meta.length} 份 meta · ${tables.size} 张表 → ${outDir}`
    + (existsSync(join(outDir, '_summary.json')) ? '' : ' (空)'));
