/**
 * 五层舞台浏览器冒烟：验证 Player 的动态 parent、缺视频占位、
 * 多背景、effect、ppv、bgColor 和对白仍在同一条 compose 链落地。
 */
import {existsSync, readFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {browserTest} from './lib/run.mjs';

const OUT = join(process.cwd(), 'data', 'fixtures', 'expected-layers_report.json');
rmSync(OUT, {force: true});

const {code} = await browserTest({
  label: '五层舞台浏览器冒烟',
  scene: 'layers_report',
  page: 'selftest-layers.html',
  timeout: 60,
  windowSize: '1600,800',
});
process.exit(code);
