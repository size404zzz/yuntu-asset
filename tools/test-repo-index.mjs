/**
 * M8 仓库索引层单测（纯 Node）：验证生成件口径、搜索语义与 R13 退化路径。
 * 用法：node tools/test-repo-index.mjs
 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {loadRepoIndex, searchBackgrounds, searchCharacters,
  backgroundGroups, flatLookup} from '../js/core/repo-index.js';

let passed = 0;
const ok = (m) => { passed++; console.log('  ok   ' + m); };
const ROOT = resolve(process.cwd());

const repo = await loadRepoIndex({
  fetchImpl: async (url) => {
    const file = join(ROOT, url);
    return {ok: true, json: () => JSON.parse(readFileSync(file, 'utf8'))};
  },
});

assert.equal(repo.available, true);
assert.equal(repo.backgrounds.length, 639, '背景 639（M8 验收）');
assert.ok(repo.characters.filter((c) => c.avg).length >= 496, '_avg 立绘 ≥496（M8 验收）');
ok(`口径：背景 ${repo.backgrounds.length} · _avg 立绘 ${repo.characters.filter((c) => c.avg).length}`);

/* 引擎报名的精确解析（大小写不敏感）。 */
assert.ok(flatLookup(repo, 'Lpic_persicaria_avg.png').endsWith('lpic_persicaria_avg.png'));
assert.ok(flatLookup(repo, 'Cpt00_e_cg002.png').includes('cpt00_e_cg002.png'));
assert.ok(flatLookup(repo, 'Icon_face_sol_10.png').includes('face'));
assert.equal(flatLookup(repo, 'Nope_missing.png'), null);
ok('flat 解析：wiki 命名 → 本地路径，缺失返回 null');

/* 背景搜索：子串、组过滤、分页、空 query。 */
assert.ok(searchBackgrounds(repo, 'cpt00_e_bg008').some((b) => b.name === 'cpt00_e_bg008'));
assert.ok(searchBackgrounds(repo, 'CPT00_E_BG008').length >= 1, '大小写不敏感');
const winter = searchBackgrounds(repo, '', {group: '21winter'});
assert.ok(winter.length > 0 && winter.every((b) => b.group === '21winter'));
assert.ok(searchBackgrounds(repo, '不存在的名字xyz').length === 0);
const page = searchBackgrounds(repo, '', {limit: 10, offset: 5});
assert.equal(page.length, 10);
assert.equal(page[0].path, searchBackgrounds(repo, '')[5].path);
assert.ok(backgroundGroups(repo).includes('cpt00'));
ok('背景搜索：子串/分组/分页/组清单');

/* 立绘搜索：avgOnly、标定态过滤。 */
assert.ok(searchCharacters(repo, 'persicaria', {avgOnly: true})
    .some((c) => c.id === 'persicaria_avg'));
assert.ok(searchCharacters(repo, '', {avgOnly: true}).length >= 496);
const calibrated = searchCharacters(repo, '', {layoutState: 'calibrated'});
assert.equal(calibrated.length, 3, '已知 layout 三件套');
assert.ok(calibrated.every((c) => c.layout));
const uncal = searchCharacters(repo, '', {layoutState: 'uncalibrated', avgOnly: true});
assert.equal(uncal.length, searchCharacters(repo, '', {avgOnly: true}).length - 3);
assert.ok(searchCharacters(repo, '', {avgOnly: true}).some((c) => c.faces.length > 5));
ok('立绘搜索：_avg 过滤 / 标定态过滤 / 脸表');

/* R13 退化：索引缺失 = 纯上传模式，不炸。 */
const missing = await loadRepoIndex({
  fetchImpl: async () => ({ok: false, status: 404}),
});
assert.equal(missing.available, false);
assert.equal(searchBackgrounds(missing, 'cpt').length, 0);
assert.equal(searchCharacters(missing, '').length, 0);
assert.equal(flatLookup(missing, 'anything.png'), null);
ok('R13 退化：无 res/ 时 available=false，全部搜索安全空转');

console.log(`\n${passed} 项通过`);
