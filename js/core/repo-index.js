/* repo-index.js —— M8 本地素材库（res/ 生成件）的读取与搜索。
   三份数据：
   - data/asset-index.json：引擎报的文件名 → 仓库路径（播放器解析用）；
   - data/index/backgrounds.json：{name, group, path}（人来搜的背景/CG）；
   - data/index/characters.json：{id, lpic, faces, layout, avg}（立绘）。
   R13：应用不假设 res/ 一定存在——任何一份取不到都退化为「纯上传模式」，
   available=false 由顶栏提示，搜索函数对空库返回 []，整块 UI 不炸。
   本模块是纯数据层（fetch 注入），Node 里可以直接单测。 */

export async function loadRepoIndex({
  fetchImpl = (...a) => fetch(...a),
  base = 'data',
} = {}) {
  const json = async (path) => {
    const r = await fetchImpl(`${base}/${path}`);
    if (!r.ok) throw new Error(`${path} → ${r.status}`);
    return r.json();
  };
  try {
    const [flat, backgrounds, characters] = await Promise.all([
      json('asset-index.json'),
      json('index/backgrounds.json'),
      json('index/characters.json'),
    ]);
    return {available: true, flat, backgrounds, characters};
  } catch {
    return {available: false, flat: {}, backgrounds: [], characters: []};
  }
}

const contains = (hay, needle) =>
    needle === '' || String(hay).toLowerCase().includes(needle.toLowerCase());

/* 背景搜索：query 命中 name 或 group；group 过滤；limit/offset 分页。 */
export function searchBackgrounds(repo, query = '', {group = null, limit = 0, offset = 0} = {}) {
  const hits = repo.backgrounds.filter((b) =>
      (!group || b.group === group)
      && (contains(b.name, query) || contains(b.group, query)));
  return limit ? hits.slice(offset, offset + limit) : hits;
}

export function backgroundGroups(repo) {
  const seen = [];
  for (const b of repo.backgrounds) if (!seen.includes(b.group)) seen.push(b.group);
  return seen.sort();
}

/* 立绘搜索：query 命中 id；avgOnly 只看 _avg；layoutState 按标定态过滤。 */
export function searchCharacters(repo, query = '',
    {avgOnly = false, layoutState = 'all', limit = 0, offset = 0} = {}) {
  const hits = repo.characters.filter((c) =>
      (!avgOnly || c.avg)
      && (layoutState === 'all'
          || (layoutState === 'calibrated') === !!c.layout)
      && contains(c.id, query));
  return limit ? hits.slice(offset, offset + limit) : hits;
}

/* 引擎文件名的精确解析（Lpic_x.png / Icon_face_s_4.png / Cpt00_e_bg008.png）。 */
export function flatLookup(repo, name) {
  return repo.flat[name.toLowerCase()] ?? null;
}
