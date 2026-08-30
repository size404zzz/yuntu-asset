/**
 * M8 仓库索引层单测（纯 Node）：验证生成件口径、搜索语义与 R13 退化路径。
 * 用法：node tools/test-repo-index.mjs
 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {loadRepoIndex, searchBackgrounds, searchCharacters, searchAudio,
  audioSheets, backgroundGroups, flatLookup} from '../js/core/repo-index.js';
import {AssetRegistry} from '../js/core/assets.js';

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

/* M12 音频索引：口径、搜索、sheet 过滤。 */
const sheetCount = audioSheets(repo).length;
const totalCues = searchAudio(repo, '').length;
assert.ok(sheetCount >= 288, `sheet 数 ≥288（实际 ${sheetCount}）`);
assert.ok(totalCues >= 2000, `cue 总数 ≥2000（实际 ${totalCues}）`);
ok(`音频口径：${sheetCount} sheet / ${totalCues} cue`);

/* bgm 的 sheet=cue（瘦表），duration 随条目。 */
const bgm = searchAudio(repo, 'Mus_Story_Dangerous');
assert.ok(bgm.some((x) => x.sheet === 'Mus_Story_Dangerous'
    && x.cue === 'Mus_Story_Dangerous' && x.duration > 0));
assert.ok(searchAudio(repo, 'MUS_STORY_DANGEROUS').length >= 1, '大小写不敏感');
assert.ok(searchAudio(repo, 'Nope_Missing_Cue_xyz').length === 0);
ok('音频搜索：bgm 命中 / 大小写 / 缺失空');

/* sfx 挂在 AVG_gf 等 sheet 下；sheet 精确过滤不混入别家同名 cue。 */
assert.ok(searchAudio(repo, 'AVG_Explode')
    .some((x) => x.sheet === 'AVG_gf' && x.cue === 'AVG_Explode'));
const onlyGf = searchAudio(repo, '', {sheet: 'AVG_gf'});
assert.ok(onlyGf.length > 0 && onlyGf.every((x) => x.sheet === 'AVG_gf'));
assert.equal(searchAudio(repo, 'AVG_Explode', {sheet: 'Chara_Persicaria'}).length, 0);
ok('音频搜索：sfx 命中 / sheet 过滤');

/* resolveAudio 三级：上传 > sheet/cue 精确 > byCue 兜底 > null。
   AssetRegistry 不 boot（不碰 IDB），只喂 repo 与上传键。 */
const reg = new AssetRegistry();
reg.repo = repo;
assert.equal(reg.resolveAudio('Mus_Story_Dangerous', 'Mus_Story_Dangerous')?.source,
    'repo');
assert.equal(reg.resolveAudio(null, 'Mus_Story_Dangerous')?.source, 'repo',
    '省略 sheet 走 byCue 兜底');
assert.equal(reg.resolveAudio('AVG_gf', 'Nope_Missing'), null);
assert.equal(reg.resolveAudio('AVG_gf', null), null, '无 cue 直接 null');
reg.urls.set('audio:avg_gf/avg_explode', 'blob:fake');
assert.equal(reg.resolveAudio('AVG_gf', 'AVG_Explode')?.url, 'blob:fake',
    '上传件覆盖仓库');
ok('resolveAudio 三级：上传 > sheet/cue > byCue，缺失 null');

/* R13 退化：索引缺失 = 纯上传模式，不炸。 */
const missing = await loadRepoIndex({
  fetchImpl: async () => ({ok: false, status: 404}),
});
assert.equal(missing.available, false);
assert.equal(searchBackgrounds(missing, 'cpt').length, 0);
assert.equal(searchCharacters(missing, '').length, 0);
assert.equal(flatLookup(missing, 'anything.png'), null);
assert.equal(searchAudio(missing, 'Mus_').length, 0);
assert.deepEqual(audioSheets(missing), []);
assert.equal(new AssetRegistry().resolveAudio('a', 'b'), null,
    '未 boot 的 registry 音频解析安全 null');
ok('R13 退化：无 res/ 时 available=false，全部搜索安全空转');

console.log(`\n${passed} 项通过`);
