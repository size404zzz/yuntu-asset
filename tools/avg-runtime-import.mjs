/* avg-runtime-import.mjs - JSONL runtime capture -> replay scenes.
 *
 * The output keeps the raw event stream beside each act and also exposes a
 * `scenes` map whose values are ordinary AvgCfg-like shots.  Unknown fields
 * are intentionally preserved, so the current Player can load the file while
 * later runtime-aware renderers can consume `runtime.events`.
 *
 * Usage:
 *   node tools/avg-runtime-import.mjs capture.jsonl --out runtime-scenes.json
 */
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';

const args = process.argv.slice(2);
const input = args.find((x) => !x.startsWith('--'));
const outArg = args.find((x) => x.startsWith('--out='))?.slice(6)
  ?? (args.includes('--out') ? args[args.indexOf('--out') + 1] : null);
if (!input || !existsSync(resolve(input))) {
  console.error('用法：node tools/avg-runtime-import.mjs <capture.jsonl> [--out file.json]');
  process.exit(2);
}

const rows = readFileSync(resolve(input), 'utf8').split(/\r?\n/)
  .filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch (_) { return []; }
  });
const result = {
  format: 'yuntu-avg-runtime',
  version: 1,
  source: {input: resolve(input), schema: 'yuntu-avg-runtime/v1'},
  stories: {},
  scenes: {},
  stats: {rows: rows.length, acts: 0, events: 0, frames: 0, unknown: 0},
};

const storyOf = (row) => String(row.story ?? 'unknown');
const actOf = (row) => row.actId == null ? 'unknown' : String(row.actId);
const story = (id) => result.stories[id] ??= {runs: [], acts: {}};
const ensureAct = (row) => {
  const sid = storyOf(row);
  const aid = actOf(row);
  const s = story(sid);
  if (!s._active || (row.kind === 'act' && s._active.actId !== aid)) {
    if (row.kind === 'act') {
      s._active = {story: sid, actId: aid, cfg: null, events: [],
        firstSeq: row.seq ?? null, lastSeq: row.seq ?? null};
      s.runs.push(s._active);
      result.stats.acts++;
    }
  }
  if (!s._active) {
    s._active = {story: sid, actId: aid, cfg: null, events: [],
      firstSeq: row.seq ?? null, lastSeq: row.seq ?? null};
    s.runs.push(s._active);
    result.stats.acts++;
  }
  s._active.lastSeq = row.seq ?? s._active.lastSeq;
  return {sid, aid, s, run: s._active};
};

for (const row of rows) {
  if (!row || row.schema !== 'yuntu-avg-runtime/v1') continue;
  if (row.kind === 'ready' || row.kind === 'recorder') continue;
  if (row.story == null && row.kind !== 'agent-error') {
    result.stats.unknown++;
    continue;
  }
  const {sid, aid, s, run} = ensureAct(row);
  if (row.kind === 'act') {
    run.cfg = row.actCfg ?? row.cfg ?? null;
    const entry = s.acts[aid] ??= {actId: row.actId, cfg: null, runs: []};
    entry.cfg = run.cfg ?? entry.cfg;
    entry.runs.push(run);
  } else {
    run.events.push(row);
    result.stats.events++;
  }
}

for (const [sid, s] of Object.entries(result.stories)) {
  delete s._active;
  const scenes = {};
  for (const [aid, entry] of Object.entries(s.acts)) {
    const run = [...entry.runs].reverse().find((x) => x.cfg) ?? entry.runs.at(-1);
    if (!run?.cfg || typeof run.cfg !== 'object') continue;
    const nativeFrames = run.events.filter((event) =>
      event.native === true && event.kind === 'frame');
    const firstMono = nativeFrames.find((event) => Number.isFinite(event.mono))?.mono
      ?? 0;
    const frames = nativeFrames.map((event, index) => ({
      frame: event.frame ?? index + 1,
      /* mono is recorder-relative; t is Act-relative and is the only clock
         consumed by the browser player. */
      t: Math.max(0, (Number(event.mono) || 0) - firstMono),
      objects: event.objects ?? [],
      materials: event.materials ?? [],
      particles: event.particles ?? [],
    }));
    const bindings = run.events.filter((event) => event.kind === 'binding')
      .map((event) => ({imgId: event.imgId, root: event.root,
        name: event.name, path: event.path}));
    /* Native frame payloads are kept in their indexed form instead of being
       duplicated inside events.  This matters for a 60 Hz capture: a ten
       minute scene can otherwise be copied twice in the JSON export. */
    const events = run.events.filter((event) =>
      !(event.native === true && event.kind === 'frame'));
    scenes[aid] = {...run.cfg, runtime: {
      source: 'frida', story: sid, actId: run.actId,
      seq: [run.firstSeq, run.lastSeq], events, frames, bindings,
      native: {frameCount: frames.length,
        duration: frames.at(-1)?.t ?? 0,
        samplingHz: frames.length > 1
          ? (frames.length - 1) / Math.max(0.001, frames.at(-1).t) : 0},
    }};
    result.stats.frames += frames.length;
  }
  result.scenes[sid] = scenes;
  for (const run of s.runs) delete run._active;
}

const output = outArg ? resolve(outArg) : resolve(input.replace(/\.jsonl$/i, '.scenes.json'));
writeFileSync(output, JSON.stringify(result, null, 2) + '\n', 'utf8');
console.log(`写出 ${output}`);
console.log(`剧情 ${Object.keys(result.scenes).length} · act ${result.stats.acts}`
  + ` · 事件 ${result.stats.events} · 未归属 ${result.stats.unknown}`);
