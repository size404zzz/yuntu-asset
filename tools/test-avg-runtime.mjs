/* Regression test for the Frida JSONL capture importer. */
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'yuntu-avg-runtime-'));
try {
  const input = join(dir, 'capture.jsonl');
  const output = join(dir, 'scenes.json');
  const rows = [
    {schema: 'yuntu-avg-runtime/v1', kind: 'ready'},
    {schema: 'yuntu-avg-runtime/v1', seq: 1, kind: 'act', story: 'demo',
      actId: 1, actCfg: {content: '一', imgTween: [{imgId: 101, alpha: 1}],
        comm: true}},
    {schema: 'yuntu-avg-runtime/v1', seq: 2, kind: 'tween', story: 'demo',
      actId: 1, imgId: 101, ops: [{op: 'localMove', to: {x: 1, y: 2, z: 0}}]},
    {schema: 'yuntu-avg-runtime/v1', seq: 2.5, kind: 'frame', native: true,
      mono: 10, frame: 1, story: 'demo', actId: 1,
      objects: [{key: 'root', imgId: 101, pos: {x: 1, y: 2, z: 0}}]},
    /* Controller/UI wrappers can report the same act twice; it must remain
       one run and the event must stay attached to that act. */
    {schema: 'yuntu-avg-runtime/v1', seq: 3, kind: 'act', story: 'demo',
      actId: 1, actCfg: {content: '一', imgTween: [{imgId: 101, alpha: 1}],
        comm: true}},
    {schema: 'yuntu-avg-runtime/v1', seq: 4, kind: 'act', story: 'demo',
      actId: 2, actCfg: {content: '二'}},
  ];
  writeFileSync(input, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const run = spawnSync(process.execPath,
    [resolve('tools/avg-runtime-import.mjs'), input, '--out', output],
    {encoding: 'utf8'});
  assert.equal(run.status, 0, run.stderr);
  const got = JSON.parse(readFileSync(output, 'utf8'));
  assert.deepEqual(Object.keys(got.scenes), ['demo']);
  assert.equal(got.scenes.demo['1'].content, '一');
  assert.equal(got.scenes.demo['1'].runtime.events.length, 1);
  assert.equal(got.scenes.demo['1'].runtime.frames.length, 1);
  assert.equal(got.scenes.demo['1'].runtime.frames[0].t, 0);
  assert.equal(got.scenes.demo['2'].content, '二');
  assert.equal(got.stats.acts, 2);
  console.log('AVG runtime importer 通过');
} finally {
  rmSync(dir, {recursive: true, force: true});
}
