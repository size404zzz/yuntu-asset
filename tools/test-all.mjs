/**
 * 全量回归单入口：注册表驱动 + 分池并行 + 汇总。
 *
 * 用法：node tools/test-all.mjs [--only=seek,play] [--skip=io] [--list]
 *        [--node-jobs=4] [--browser-jobs=2] [--timeout=S]
 *  - node 链（纯 Node，无浏览器）一池默认 4 并发；browser 链（各自起
 *    serve.py 临时端口宿主 + 无头 Chrome）一池默认 2 并发。两池互不抢端口。
 *  - 每条链的输出在结束时原子打印（并行不交错）；失败链的完整输出原样
 *    保留，成功链只留最后一行结论。总退出码 = 有任一失败即 1。
 *  - --list 按注册表打印链清单（INTRO.md 回归矩阵与它对口）。
 */
import {spawn} from 'node:child_process';
import {join, resolve} from 'node:path';

const flag = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const ROOT = resolve(process.cwd());

/* —— 链注册表：新增回归在这里挂一行，--list 与全量跑自动跟上 —— */
const REGISTRY = [
  // —— 纯 Node ——
  {name: 'script', kind: 'node', desc: '剧本双格式归一化'},
  {name: 'markup', kind: 'browser', desc: '分词/分页/打字机三态（真 DOM reformat）'},
  {name: 'skeleton', kind: 'node', desc: '舞台骨架逐 id 结构保真'},
  {name: 'style', kind: 'node', desc: 'avg/pandect.css 逐声明移植'},
  {name: 'sprite', kind: 'browser', desc: '画布合成/换脸/推导（像素判据）'},
  {name: 'play', kind: 'browser', desc: '播放器逐镜对拍（冻结表）'},
  {name: 'seek', kind: 'browser', desc: 'seek ≡ 连播暂停（A/B 两路快照对字节）'},
  {name: 'gamefold', kind: 'node', desc: '镜像/抖动/z 序等折叠语义锚点'},
  {name: 'gameplay', kind: 'node', desc: 'state.js 与游戏折叠对账'},
  {name: 'avgcfg', kind: 'node', desc: 'AvgCfg/AvgLang 字节码解释器 + wire 映射'},
  {name: 'avg-e2e', kind: 'browser', desc: '语料端到端：解码→映射→逐镜 seek 对拍'},
  {name: 'editor', kind: 'browser', desc: '编辑器失效三级 + prev 起值 + 并发 seek'},
  {name: 'assets', kind: 'browser', desc: 'IDB/注册表/标定 + 编辑器冒烟'},
  {name: 'io', kind: 'browser', desc: '导出→导入→连播快照全等 + bundle 完整性'},
  {name: 'audio', kind: 'node', desc: '音频编排（FakeCtx，含 CV 语音通道）'},
  {name: 'doc', kind: 'node', desc: '撤销栈/失效分级'},
  {name: 'zip', kind: 'node', desc: 'STORE 打包可复现'},
  {name: 'repo-index', kind: 'node', desc: '素材索引/搜索/三级解析'},
  {name: 'storylib', kind: 'node', desc: '剧本库：分组/搜索/loadStory/语音映射'},
  {name: 'fadeadvice', kind: 'node', desc: '退场建议：触发/排除/分档/幂等'},
  {name: 'recorder', kind: 'node', desc: '录制视频：mime/参数/自动驱动/监测/转码（纯函数）'},
  {name: 'avg-runtime', kind: 'node', desc: 'Frida 运行时 JSONL → 可重放导入链'},
  {name: 'layers', kind: 'node', desc: '五层舞台折叠模型断言'},
  {name: 'layers-browser', kind: 'browser', desc: '五层舞台浏览器冒烟（effect/ppv/占位）'},
  {name: 'sg', kind: 'browser', desc: '23sg 专属演出：SG 窗/手机聊天/世界线/终端镜'},
];

const only = flag('only', '');
const skip = new Set(flag('skip', '').split(',').filter(Boolean));
let entries = REGISTRY.filter((e) => !skip.has(e.name));
if (only) entries = entries.filter((e) => only.split(',').includes(e.name));

if (flag('list', '')) {
  for (const e of entries) {
    console.log(`| \`node tools/test-${e.name}.mjs\` | ${e.desc} | ${e.kind} |`);
  }
  process.exit(0);
}

const TIMEOUT_S = Number(flag('timeout', '0')) || null;
const JOBS = {node: Number(flag('node-jobs', '4')), browser: Number(flag('browser-jobs', '2'))};

/* 跑一条链：缓冲输出，结束时原样交给回调。 */
function runOne(entry) {
  return new Promise((done) => {
    const t0 = Date.now();
    const child = spawn(process.execPath,
        [join(ROOT, 'tools', `test-${entry.name}.mjs`)],
        {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']});
    let out = '';
    const collect = (chunk) => {
      out += String(chunk);
      if (TIMEOUT_S && Date.now() - t0 > TIMEOUT_S * 1000) child.kill();
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('close', (exitCode) => done({
      ...entry,
      out,
      ms: Date.now() - t0,
      ok: exitCode === 0,
    }));
  });
}

/* 分池 worker：同一池内按并发上限消费队列。 */
async function drain(queue, jobs, results) {
  const workers = Array.from({length: Math.max(1, jobs)}, async () => {
    for (;;) {
      const entry = queue.shift();
      if (!entry) return;
      console.log(`▶ ${entry.name}（${entry.kind}）…`);
      const result = await runOne(entry);
      results.push(result);
      console.log(`${result.ok ? '✓' : '✗'} ${entry.name} · ${(result.ms / 1000).toFixed(1)}s`);
    }
  });
  await Promise.all(workers);
}

const t0 = Date.now();
const results = [];
const nodeQueue = entries.filter((e) => e.kind === 'node');
const browserQueue = entries.filter((e) => e.kind === 'browser');
await Promise.all([
  drain(nodeQueue, JOBS.node, results),
  drain(browserQueue, JOBS.browser, results),
]);

/* —— 汇总 —— */
console.log('\n' + '═'.repeat(46));
let failed = 0;
for (const entry of entries) {
  const result = results.find((r) => r.name === entry.name);
  if (!result) { console.log(`✗ ${entry.name} · 没跑完`); failed++; continue; }
  const mark = result.ok ? '✓' : '✗';
  console.log(`${mark} ${entry.name.padEnd(15)} ${(result.ms / 1000).toFixed(1)}s`
      + `  ${entry.desc}`);
  if (!result.ok) {
    failed++;
    console.log('  ' + '─'.repeat(42));
    for (const line of result.out.trimEnd().split('\n')) console.log('  ' + line);
  }
}
const total = (Date.now() - t0) / 1000;
console.log('═'.repeat(46));
console.log(`${results.length - failed}/${results.length} 通过 · 全程 ${total.toFixed(1)}s`
    + (failed ? ` · ${failed} 条链失败` : ' · 全绿'));
process.exit(failed ? 1 : 0);
