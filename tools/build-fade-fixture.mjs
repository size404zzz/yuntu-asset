/* build-fade-fixture.mjs —— 重建 data/fixtures/wiki-fades-23carnival.json，
 * fadeadvice（M23 退场建议）的**外源金标准**。
 *
 * 用法：node tools/build-fade-fixture.mjs        （需要 wiki.42lab.cloud 可达）
 *
 * 链路：
 *   1. api.php?action=parse&page=行动记录/无律背反&prop=wikitext → 页面 wikitext
 *      里 {{#invoke:AvgNav|main|1=<目录 JSON>}}，取出全部 script_id；
 *   2. 逐 id 查 File:Avg_<id>.json 的 imageinfo，拿 md5 目录真实地址；
 *   3. 抓 JSON，抽「该（镜键, imgId）上有 α0/d>0 淡出 tween 或 images[].delete」
 *      作为真值标签。
 *
 * 为什么它是金标准：wiki 行动记录的转写件比游戏 dump 多出整套隐式调度
 * （23carnival 39 段：+2887 / −1 条立绘条目，台词逐镜对位 100% 命中），
 * 即「演出实际发生过的调度」的显式化。它不参与播放器冻结对拍，只做
 * fadeadvice 分档命中率的回归锚点——改 NEAR_WINDOW/MID_WINDOW 或触发器
 * 口径后重跑 tools/test-fadeadvice.mjs 就能看出梯度有没有被改坏。
 */
import {writeFileSync, readFileSync} from 'node:fs';
import {resolve, join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = 'http://wiki.42lab.cloud';
const PAGE = '行动记录/无律背反';
const OUT = join(ROOT, 'data/fixtures/wiki-fades-23carnival.json');

const get = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
};

const wikitext = await get(`${HOST}/api.php?action=parse&format=json&prop=wikitext`
    + `&page=${encodeURIComponent(PAGE)}`);
const navJson = /AvgNav\|main\|1=(\{[\s\S]*\})\s*\}\}/
    .exec(wikitext.parse.wikitext['*'])?.[1];
if (!navJson) throw new Error('页面里没找到 AvgNav 目录 JSON');
const nav = JSON.parse(navJson);

const ids = [];
for (const part of nav.avg) {
  for (const story of part) {
    if (story.script_id) ids.push(story.script_id);
    for (const sid of story.script_ids ?? []) ids.push(sid);
  }
}
const uniq = [...new Set(ids)];

/* imageinfo 批量解析 md5 目录 */
const urls = new Map();
for (let i = 0; i < uniq.length; i += 20) {
  const titles = uniq.slice(i, i + 20)
      .map((id) => `File:Avg ${id.replace(/_/g, ' ')}.json`).join('|');
  const q = await get(`${HOST}/api.php?action=query&format=json&prop=imageinfo`
      + `&iiprop=url&titles=${encodeURIComponent(titles)}`);
  for (const p of Object.values(q.query.pages)) {
    if (!p.imageinfo) { console.warn('缺文件:', p.title); continue; }
    /* 中文站命名空间是「文件:」（File: 只是规范化输入名） */
    const name = p.title.split(':').slice(1).join(':')
        .replace(/^Avg /, '').replace(/\.json$/, '').replace(/ /g, '_');
    urls.set(name, p.imageinfo[0].url);
  }
}

const stories = {};
for (const id of uniq) {
  const url = urls.get(id);
  if (!url) continue;
  const res = await fetch(url);
  if (!res.ok) { console.warn(`抓不到 ${id}: ${res.status}`); continue; }
  const json = await res.json();
  const fades = [];
  for (const [k, shot] of Object.entries(json)) {
    for (const t of shot.imgTween ?? []) {
      if (t && (t.alpha ?? 1) === 0 && (t.duration ?? 0) > 0) fades.push([Number(k), t.imgId]);
    }
    for (const im of shot.images ?? []) {
      if (im?.delete) fades.push([Number(k), im.imgId]);
    }
  }
  fades.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  stories[id] = {shots: Object.keys(json).length, fades};
}

const out = {
  _source: `GFWiki ${PAGE} = ${nav.name_en}（${nav.id}）${uniq.length} 段转写件`,
  _collected: new Date().toISOString().slice(0, 10),
  _how: 'api.php parse 取 AvgNav 目录 → File:Avg_<script_id>.json（imageinfo 解 md5 目录）→ 抽淡出标签',
  _truth: '真值 = 该（镜键, imgId）上 wiki 有 α0/d>0 淡出 tween 或 images[].delete',
  _caveat: '只做 fadeadvice 的回归锚点；不参与播放器冻结对拍。转写件是游戏 dump 的超集，缺的镜（分支孤儿）不计入。',
  stories,
};
writeFileSync(OUT, JSON.stringify(out) + '\n');
const total = Object.values(stories).reduce((n, s) => n + s.fades.length, 0);
console.log(`${Object.keys(stories).length} 段 · ${total} 条淡出标签 · ${OUT}`);
