/* unpack-acb.mjs —— 把 res/Assets/media/audios/ 的 CRIWARE 音频（ACB/AWB，
   HCA 编码）经 vgmstream-cli 解码、ffmpeg 转 ogg vorbis，落到
   data/audio/<sheet>/<cue>.ogg，并生成 data/index/audio.json。

   依据（实测）：
   - 带内嵌波形的 ACB（AVG / AVG_gf / Ambience / Chara_* 等）vgmstream 可直接
     按 cue 名列子曲；一个 cue 名可能对应多条波形，只保留首条（wire 格式按名
     引用，重名本来就不可区分）。
   - 「瘦 ACB」（Mus_* / EV_* / GF_YT_PV 等，bgm 类）自身无子曲，波形在同名
     外部 AWB 里；改解 AWB，sheet 仍记 ACB 基名（游戏脚本里 bgm 的 sheet=cue=
     曲名，正好对上）。
   - 一律 `-i` 单次解码（不展开循环段）；循环由播放引擎 source.loop 承担。

   依赖：仓库根目录的 vgmstream-win64/vgmstream-cli.exe + PATH 里的 ffmpeg。
   用法：node tools/media/unpack-acb.mjs [--force] [--only <substr>]
     默认增量：已有 ogg 的 sheet 跳过；--force 全部重转。 */

import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const SRC = path.join(ROOT, 'res/Assets/media/audios');
const OUT = path.join(ROOT, 'data/audio');
const TMP = path.join(ROOT, 'tools/media/.tmp');
const VGM = path.join(ROOT, 'vgmstream-win64/vgmstream-cli.exe');
const INDEX_OUT = path.join(ROOT, 'data/index/audio.json');

/* 旧索引：增量跳过时继承时长 */
let prevIndex = {sheets: {}};
try { prevIndex = JSON.parse(fs.readFileSync(INDEX_OUT, 'utf8')); } catch { /* 首次运行 */ }

const args = process.argv.slice(2);
const force = args.includes('--force');
const voice = args.includes('--voice');   /* 附带 Voice/JA_JP 的剧情语音（约 441MB 源） */
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;

const sanitize = (name) => name.replace(/[\\/:*?"<>|\s]+/g, '_');

function run(cmd, argv, {timeout = 120_000} = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, argv, {stdio: ['ignore', 'pipe', 'pipe']});
    let out = '', err = '';
    const kill = setTimeout(() => p.kill(), timeout);
    p.stdout.on('data', (d) => out += d);
    p.stderr.on('data', (d) => err += d);
    p.on('close', (code) => { clearTimeout(kill); resolve({code, out, err}); });
    p.on('error', () => { clearTimeout(kill); resolve({code: -1, out, err}); });
  });
}

/* vgmstream -I：拿子曲总数（可能输出多条 JSON，取第一条）。 */
async function probe(file) {
  const {code, out} = await run(VGM, ['-I', file], {timeout: 30_000});
  if (code !== 0 || !out.trim()) return null;
  try { return JSON.parse(out.trim().split('\n')[0]); } catch { return null; }
}

/* 解码全部子曲到 dir，文件名 `<idx>_<name>.wav`。返回 [{idx, name, file}]。 */
async function decodeAll(file, dir) {
  fs.mkdirSync(dir, {recursive: true});
  const {code, err} = await run(VGM,
      ['-S', '0', '-i', '-o', path.join(dir, '?s_?n.wav'), file],
      {timeout: 600_000});
  if (code !== 0) throw new Error(`vgmstream exit ${code}: ${err.slice(0, 300)}`);
  return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.wav'))
      .map((f) => {
        const m = f.match(/^(\d+)_(.*)\.wav$/);
        return m ? {idx: +m[1], name: m[2], file: f}
                 : {idx: 0, name: path.basename(f, '.wav'), file: f};
      })
      .sort((a, b) => a.idx - b.idx);
}

/* WAV 头：取时长与声道数（vgmstream 输出 PCM16 RIFF）。 */
function wavInfo(file) {
  const buf = Buffer.alloc(256);
  const fd = fs.openSync(file, 'r');
  fs.readSync(fd, buf, 0, 256, 0);
  fs.closeSync(fd);
  if (buf.toString('latin1', 0, 4) !== 'RIFF') return {duration: 0, channels: 1};
  let channels = 1, byteRate = 1, dataSize = 0;
  for (let p = 12; p + 8 <= buf.length;) {
    const id = buf.toString('latin1', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (id === 'fmt ') { channels = buf.readUInt16LE(p + 10); byteRate = buf.readUInt32LE(p + 16); }
    if (id === 'data') dataSize = size;
    p += 8 + size + (size & 1);
  }
  return {duration: dataSize / byteRate, channels};
}

const sheets = {};   /* sheet → {cues: {cue → {path, duration}}} */
const skipped = [];

/* 队列：根目录 ACB；--voice 时附带 Voice/JA_JP（sheet 名 = basename，无碰撞）。 */
const acbEntries = fs.readdirSync(SRC)
    .filter((f) => f.toLowerCase().endsWith('.acb')).sort()
    .map((f) => ({name: f, dir: SRC}));
if (voice) {
  const vdir = path.join(SRC, 'Voice', 'JA_JP');
  acbEntries.push(...fs.readdirSync(vdir)
      .filter((f) => f.toLowerCase().endsWith('.acb')).sort()
      .map((f) => ({name: f, dir: vdir, voice: true})));
}
const queue = acbEntries
    .filter(({name}) => !only || name.toLowerCase().includes(only.toLowerCase()));
console.log(`${queue.length} ACB 待处理（force=${force}${only ? `, only=${only}` : ''}${voice ? ', +Voice' : ''}）`);

/* 并发池：n 个任务同时跑。 */
async function pool(items, n, worker) {
  let i = 0;
  const runners = Array.from({length: Math.min(n, items.length)}, async () => {
    while (i < items.length) {
      const item = items[i++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

await pool(queue, 5, async (entry) => {
  const acbName = entry.name;
  const sheet = path.basename(acbName, '.acb');
  const acbPath = path.join(entry.dir, acbName);
  const sheetOut = path.join(OUT, sanitize(sheet));

  /* 增量：已有产物则跳过（--force 覆盖重转） */
  if (!force && fs.existsSync(sheetOut) && fs.readdirSync(sheetOut).some((f) => f.endsWith('.ogg'))) {
    const prev = prevIndex.sheets?.[sheet]?.cues ?? {};
    const cues = {};
    for (const f of fs.readdirSync(sheetOut).filter((f) => f.endsWith('.ogg'))) {
      const cue = path.basename(f, '.ogg');
      cues[cue] = {path: `data/audio/${sanitize(sheet)}/${f}`, duration: prev[cue]?.duration ?? 0};
    }
    sheets[sheet] = {cues, rebuilt: false};
    return;
  }

  /* 瘦 ACB → 同名 AWB；都没有则放弃。
     Voice 表强制 AWB 优先：其 ACB 只内嵌首条 cue（BATTLE），完整波形全在 AWB。 */
  let src = acbPath, kind = 'acb';
  const awb = path.join(entry.dir, `${sheet}.awb`);
  if (entry.voice && fs.existsSync(awb)) {
    src = awb; kind = 'awb';
  } else {
    const info = await probe(acbPath);
    if (!info || !(info.streamInfo?.total >= 1)) {
      if (fs.existsSync(awb)) { src = awb; kind = 'awb'; }
      else { skipped.push(sheet); console.warn(`  跳过 ${sheet}：无子曲且无同名 AWB`); return; }
    }
  }

  const tmpDir = path.join(TMP, sanitize(sheet));
  fs.rmSync(tmpDir, {recursive: true, force: true});
  let waves;
  try {
    waves = await decodeAll(src, tmpDir);
  } catch (e) {
    skipped.push(sheet);
    console.warn(`  解码失败 ${sheet}（${kind}）：${e.message}`);
    return;
  }
  if (!waves.length) { skipped.push(sheet); console.warn(`  跳过 ${sheet}：解出 0 条`); return; }

  /* 重名保留首条 */
  const seen = new Set();
  const cues = {};
  fs.mkdirSync(sheetOut, {recursive: true});
  for (const {name, file} of waves) {
    const cue = sanitize(name);
    if (seen.has(cue)) continue;
    seen.add(cue);
    const wavPath = path.join(tmpDir, file);
    const {duration, channels} = wavInfo(wavPath);
    const oggName = `${cue}.ogg`;
    const q = channels >= 2 ? '5' : '3';
    const enc = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-i', wavPath, '-c:a', 'libvorbis', '-q:a', q, path.join(sheetOut, oggName)]);
    if (enc.code !== 0) { console.warn(`  转码失败 ${sheet}/${cue}`); continue; }
    cues[cue] = {path: `data/audio/${sanitize(sheet)}/${oggName}`, duration: +duration.toFixed(2)};
  }
  fs.rmSync(tmpDir, {recursive: true, force: true});
  sheets[sheet] = {cues, rebuilt: true};
  console.log(`  ✓ ${sheet}（${kind}）：${Object.keys(cues).length} 条`);
});

/* 真孤儿 AWB（连 ACB 都没有）；瘦 ACB 已在上面按同名规则处理或跳过。 */
for (const awbName of fs.readdirSync(SRC).filter((f) => f.toLowerCase().endsWith('.awb'))) {
  const sheet = path.basename(awbName, '.awb');
  if (sheets[sheet] || skipped.includes(sheet)
      || fs.existsSync(path.join(SRC, `${sheet}.acb`))) continue;
  const tmpDir = path.join(TMP, sanitize(sheet));
  fs.rmSync(tmpDir, {recursive: true, force: true});
  let waves;
  try { waves = await decodeAll(path.join(SRC, awbName), tmpDir); } catch { continue; }
  const sheetOut = path.join(OUT, sanitize(sheet));
  fs.mkdirSync(sheetOut, {recursive: true});
  const seen = new Set();
  const cues = {};
  for (const {name, file} of waves) {
    const cue = sanitize(name);
    if (seen.has(cue)) continue;
    seen.add(cue);
    const wavPath = path.join(tmpDir, file);
    const {duration, channels} = wavInfo(wavPath);
    const enc = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-i', wavPath, '-c:a', 'libvorbis', '-q:a', channels >= 2 ? '5' : '3',
      path.join(sheetOut, `${cue}.ogg`)]);
    if (enc.code !== 0) continue;
    cues[cue] = {path: `data/audio/${sanitize(sheet)}/${cue}.ogg`, duration: +duration.toFixed(2)};
  }
  fs.rmSync(tmpDir, {recursive: true, force: true});
  if (Object.keys(cues).length) { sheets[sheet] = {cues, rebuilt: true}; console.log(`  ✓ ${sheet}（孤儿 awb）`); }
}

/* 全局 cue 表：bgm 的 sheet=cue，或脚本省略 sheet 时兜底。
   同名冲突时「sheet 名 = cue 名」的条目优先（bgm 语义），否则先到优先。 */
const byCue = {};
for (const [sheet, {cues}] of Object.entries(sheets)) {
  for (const [cue, meta] of Object.entries(cues)) {
    const exact = sheet === cue;
    if (!byCue[cue] || (exact && !byCue[cue].exact)) {
      byCue[cue] = {sheet, path: meta.path, duration: meta.duration, exact};
    }
  }
}
for (const v of Object.values(byCue)) delete v.exact;

const index = {
  format: 'audio-index',
  version: 1,
  generatedAt: new Date().toISOString(),
  source: 'res/Assets/media/audios（vgmstream + ffmpeg 转码，tools/media/unpack-acb.mjs）',
  sheets,
  byCue,
};
fs.mkdirSync(path.dirname(INDEX_OUT), {recursive: true});
fs.writeFileSync(INDEX_OUT, JSON.stringify(index));

const cueCount = Object.values(sheets).reduce((n, s) => n + Object.keys(s.cues).length, 0);
console.log(`\n完成：${Object.keys(sheets).length} sheet / ${cueCount} cue → ${path.relative(ROOT, OUT)}`);
if (skipped.length) console.log('跳过：', skipped.join(', '));
