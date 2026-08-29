/**
 * M3 规则表对拍：sprite.buildCharaRules 生成的 CSS 必须与冻结表 charaRules 的
 * 去重规则集逐条相等（几何与画布分辨率无关，纯 Node 即可验证，不需要浏览器）。
 * 冻结表里每条重复 2 份（setScene 预取 + playShot 再载，见 B10），这里先去重再比。
 *
 * 用法：node tools/test-sprite-rules.mjs
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {buildCharaRules} from '../js/engine/sprite.js';

const ROOT = process.cwd();
const freeze = JSON.parse(
    readFileSync(join(ROOT, 'data', 'fixtures', 'expected-scene1.json'), 'utf8'));
const layouts = {};
for (const name of ['persicaria_avg', 'sol_avg', 'croque_avg']) {
  layouts[name] = JSON.parse(
      readFileSync(join(ROOT, 'data', 'layouts', `${name}.json`), 'utf8'));
}
/* 冻结表观测时的舞台。 */
const stage = {
  width: freeze.meta.stage.width,
  height: freeze.meta.stage.height,
  fontSize: parseFloat(freeze.meta.stage.fontSize),
};

const norm = (s) => s.replace(/\s+/g, '');
const parseRules = (text) => {
  const map = new Map();
  for (const m of text.matchAll(/\.avg-chara[^{]*\{[^}]*\}/g)) {
    const [sel, body] = m[0].split('{');
    map.set(norm(sel + '{'), norm(body.replace(/\}$/, '')));
  }
  return map;
};

/* 参考的冻结表：42 条 = 21 选择器 × 2。去重后应当 = 我的单轮输出。 */
const frozen = parseRules(freeze.charaRules);
const entries = [
  {imgId: 101, config: layouts.persicaria_avg},
  {imgId: 103, config: layouts.sol_avg},
  {imgId: 105, config: layouts.croque_avg},
];
const mine = parseRules(buildCharaRules(entries, stage));

let failures = 0;
const fail = (m) => { failures++; console.log('  FAIL ' + m); };
const ok = (m) => console.log('  ok   ' + m);

if (frozen.size !== 21) fail(`冻结表去重后 ${frozen.size} 条，不是 21`);
if (mine.size !== frozen.size) fail(`生成 ${mine.size} 条 != 冻结 ${frozen.size} 条`);
let matched = 0;
for (const [sel, body] of frozen) {
  if (!mine.has(sel)) { fail(`缺选择器 ${sel}`); continue; }
  if (mine.get(sel) !== body) {
    fail(`${sel}\n         冻结: ${body}\n         生成: ${mine.get(sel)}`);
  } else matched++;
}
for (const sel of mine.keys()) if (!frozen.has(sel)) fail(`多出选择器 ${sel}`);

if (!failures) ok(`${matched} 条规则与冻结表逐条相等`
    + `（舞台 ${stage.width}×${stage.height}@${stage.fontSize}px）`);
console.log(failures ? `\n存在 ${failures} 类失败` : '\nM3 规则表通过');
process.exit(failures ? 1 : 0);
