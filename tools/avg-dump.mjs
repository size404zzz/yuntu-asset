/* avg-dump.mjs —— AvgCfg/AvgLang 字节码的解码 CLI。
 *
 * 用法：
 *   node tools/avg-dump.mjs <剧本ID> [更多ID...]   # 解码并打印 JSON（--lang 出台词侧）
 *   node tools/avg-dump.mjs --scan                 # 全语料跑通 + 结构/opcode 普查
 *
 * 剧本 ID 经 data/index/avg-scripts.json（build-asset-index 生成件）解析到
 * res/Assets/Res/LuaScripts 下的字节码文件。
 */
import {readFileSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {parseChunk} from '../js/core/lundump.js';
import {execChunk, toJS} from '../js/core/lvm.js';

const ROOT = resolve(process.cwd());
const manifest = JSON.parse(readFileSync(join(ROOT, 'data', 'index', 'avg-scripts.json'), 'utf8'));
const byId = new Map(manifest.stories.map((s) => [s.id, s]));
const OPS = ['MOVE', 'LOADK', 'LOADKX', 'LOADBOOL', 'LOADNIL', 'GETUPVAL', 'GETTABUP',
  'GETTABLE', 'SETTABUP', 'SETUPVAL', 'SETTABLE', 'NEWTABLE', 'SELF', 'ADD', 'SUB', 'MUL',
  'MOD', 'POW', 'DIV', 'IDIV', 'BAND', 'BOR', 'BXOR', 'SHL', 'SHR', 'UNM', 'BNOT', 'NOT',
  'LEN', 'CONCAT', 'JMP', 'EQ', 'LT', 'LE', 'TEST', 'TESTSET', 'CALL', 'TAILCALL', 'RETURN',
  'FORLOOP', 'FORPREP', 'TFORCALL', 'TFORLOOP', 'SETLIST', 'CLOSURE', 'VARARG'];

function decode(kind, id) {
  const story = byId.get(id);
  if (!story) throw new Error(`剧本 ID 不在索引里：${id}`);
  const path = kind === 'lang' ? story.lang : story.cfg;
  if (!path) throw new Error(`${kind === 'lang' ? 'AvgLang' : 'AvgCfg'} 缺文件：${id}`);
  const proto = parseChunk(readFileSync(join(ROOT, path)));
  return toJS(execChunk(proto)[0]);
}

const argv = process.argv.slice(2);
const wantLang = argv.includes('--lang');
const ids = argv.filter((a) => !a.startsWith('--'));

if (ids.length) {
  for (const id of ids) {
    console.log(JSON.stringify(decode(wantLang ? 'lang' : 'cfg', id), null, 1));
  }
} else if (argv.includes('--scan')) {
  /* —— 全语料：跑通 + opcode/字段普查 —— */
  const t0 = performance.now();
  const opFreq = new Map();
  const cfgFields = new Map();
  const langFields = new Map();
  let failures = 0, cfgSteps = 0, langSteps = 0;
  const failureList = [];

  const count = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
  const walk = (node, m, depth) => {
    if (Array.isArray(node)) {
      for (const v of node) walk(v, m, depth + 1);
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      count(m, k);
      walk(v, m, depth + 1);
    }
  };

  const failuresById = [];
  for (const story of manifest.stories) {
    for (const kind of ['cfg', 'lang']) {
      try {
        const proto = parseChunk(readFileSync(join(ROOT, kind === 'lang' ? story.lang : story.cfg)));
        for (const ins of proto.code) count(opFreq, OPS[ins & 0x3F] ?? `op${ins & 0x3F}`);
        const js = toJS(execChunk(proto)[0]);
        /* 步骤键 = 整数 ID（台词侧 -999 是合法哨兵）；Cfg 顶层还允许字符串
           共享段键（heroFace/audio 模板块，22white_florence 等 6 个文件）。 */
        for (const [k, step] of Object.entries(js)) {
          if (/^-?\d+$/.test(k)) {
            if (kind === 'cfg') { cfgSteps++; walk(step, cfgFields, 0); }
            else { langSteps++; walk(step, langFields, 0); }
          } else if (typeof step === 'object' && step) {
            walk(step, kind === 'cfg' ? cfgFields : langFields, 0);
          }
        }
      } catch (e) {
        failures++;
        if (failuresById.length < 8) failuresById.push(`${story.id}(${kind}): ${e.message}`);
      }
    }
  }
  const dt = (performance.now() - t0) / 1000;
  console.log(`全语料：${manifest.stories.length} 段 × (Cfg+Lang)，失败 ${failures}`
      + ` · 步骤 ${cfgSteps} · 台词条 ${langSteps} · 耗时 ${dt.toFixed(1)}s`);
  if (failuresById.length) console.log(failuresById.map((s) => '  FAIL ' + s).join('\n'));
  const top = (m, n = 14) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
      .map(([k, v]) => `${k}:${v}`).join('  ');
  console.log('opcode 普查：' + top(opFreq, 46));
  console.log('Cfg 字段普查：' + top(cfgFields));
  console.log('Lang 字段普查：' + top(langFields));
} else {
  console.error('用法：node tools/avg-dump.mjs <剧本ID>… [--lang] | --scan');
  process.exit(1);
}
