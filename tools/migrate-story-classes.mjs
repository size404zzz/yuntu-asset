/* 未归档 → 宿舍剧情 / 其他剧情 两个分类（一次性结构调整，也用于重新播种后复原）。
 *
 * 规则：`宿舍剧情·XX` 组成为「宿舍剧情」分类下的活动 XX（前缀删掉），
 * 其余未归档组原样进「其他剧情」；未归档只留编辑器的「待分类」暂存池。
 * 产物是手动覆盖层 data/index/story-archive-manual.json（main.js 优先读它，
 * 生成档案重跑不冲掉）。
 *
 * 用法：node tools/migrate-story-classes.mjs [--force]
 *      --force 覆盖已有手动档案（默认拒绝：那里面是人工调整）。
 */
import {existsSync} from 'node:fs';
import {readFile, writeFile} from 'node:fs/promises';

const DORM = '宿舍剧情·';
const TARGET = 'data/index/story-archive-manual.json';

if (existsSync(TARGET) && !process.argv.includes('--force')) {
  console.error(`${TARGET} 已存在（里面是人工调整）——确认要按生成档案重算请加 --force`);
  process.exit(1);
}

const archive = JSON.parse(await readFile('data/index/story-archive.json', 'utf8'));

const byGroup = new Map();
for (const e of archive.unarchived) {
  const id = typeof e === 'string' ? e : e.id;
  const group = typeof e === 'string' ? '' : (e.group ?? '');
  (byGroup.get(group) ?? byGroup.set(group, []).get(group)).push(id);
}

const build = (prefix, pick) => [...byGroup].map(([g, ids]) => pick(g, ids))
    .filter(Boolean)
    .sort((x, y) => y.ids.length - x.ids.length || x.name.localeCompare(y.name))
    .map(({name, ids}, i) => ({
      id: `${prefix}-${i + 1}`, name, year: null, type: null,
      stories: ids.map((id) => ({id})),
    }));

const dorm = build('dorm', (g, ids) =>
    g.startsWith(DORM) && {name: g.slice(DORM.length), ids});
const other = build('other', (g, ids) =>
    !g.startsWith(DORM) && {name: g, ids});

archive.classes.push(
    {classId: 4, name: '宿舍剧情', activities: dorm},
    {classId: 5, name: '其他剧情', activities: other});
archive.unarchived = [];
archive.manual = true;
archive.savedAt = new Date().toISOString();

const count = (list) => list.reduce((n, x) => n + x.stories.length, 0);
const total = count(archive.classes.flatMap((c) => c.activities))
    + archive.mainline.reduce((n, m) => n + m.stories.length, 0);
console.log(`宿舍 ${dorm.length} 组 ${count(dorm)} 段｜其他 ${other.length} 组 `
    + `${count(other)} 段｜总计 ${total}`);
await writeFile(TARGET, JSON.stringify(archive));
console.log(`-> ${TARGET}`);
