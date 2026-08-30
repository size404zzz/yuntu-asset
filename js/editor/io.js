/* io.js —— M10 导入导出三形态 + 自动保存。
   工程包（计划口径）：{format, version, meta, stories:[{title, scriptType,
   shots}], layouts, characters, glossary, assets[]}——shots 保留 wire 原字段
   名，归一化只发生在读取边界，raw 游戏脚本可直接导入且不做不可逆翻译。
   assets 三路：上传件 base64 内联（kind: image|audio，音频键
   audio:<sheet>/<cue>）；repo 件（图/音频）只记 repoPath，bundle 落真文件。

   导出三形态：
   A 工程 JSON：repo 资源只记 repoPath 不内联；上传件 base64 内联。
   B 独立 ZIP bundle：play.html + js/** + project.json + assets/<file> 真文件，
     解到任意静态目录离线可跑。
   C 目录落盘：File System Access API 写同一套布局。

   可复现纪律：包内不写时间戳（往返测试比字节全等）；zip 固定 DOS 日期。 */

import {writeZip} from '../ui/zip.js';
import {b64encode, b64decode} from '../ui/zip.js';
import {serializeScript, normalizeScript} from '../core/script.js';
import {get as idbGet, put as idbPut, del as idbDel, KV} from '../core/idb.js';

export const FORMAT = 'yuntu-avg-project';
export const VERSION = 1;

/* 引擎会报名的文件名集合（从镜头数据推）：背景=imgPath 基名、
   立绘=Lpic_<path>.png、表情=Icon_face_<去_avg尾>_<id>.png。 */
function engineNamesOf(shots) {
  const names = new Set();
  const imgPathOf = new Map();
  for (const shot of Object.values(shots)) {
    for (const im of shot.images ?? []) {
      imgPathOf.set(im.imgId, im.imgPath);
      if (im.imgType === 2) names.add(`${im.imgPath.split('/')[1]}.png`);
      if (im.imgType === 3) names.add(`Lpic_${im.imgPath}.png`);
    }
    for (const f of shot.heroFace ?? []) {
      const p = imgPathOf.get(f.imgId);
      if (p && f.faceId) {
        names.add(`Icon_face_${p.replace(/_avg$/, '')}_${f.faceId}.png`);
      }
    }
  }
  return [...names];
}

/* 镜头引用的音频（bgm/sfx），按键去重；stop 的 bgm 无 cue 自然跳过。
   键 = audio:<sheet>/<cue>，与 AssetRegistry 上传件/resolveAudio 同约定。 */
function audioRefsOf(shots) {
  const refs = new Map();
  for (const shot of Object.values(shots)) {
    for (const part of ['bgm', 'sfx']) {
      const {cue, sheet} = shot.audio?.[part] ?? {};
      if (cue) refs.set(`audio:${sheet}/${cue}`.toLowerCase(), {sheet, cue});
    }
  }
  return [...refs.values()];
}

/* audio:<sheet>/<cue> → bundle 里的落盘路径。 */
function audioFileOf(name) {
  const m = /^audio:(.*)\/(.*)$/.exec(name);
  return m ? `assets/audio/${m[1]}/${m[2]}.ogg` : `assets/${name}`;
}

/* —— A：工程 JSON —— */

export async function exportProject({doc, title, registry, characters, glossary}) {
  const shots = serializeScript(doc.story);
  const assets = [];
  const seen = new Set();
  /* 上传件优先（base64 内联），repo 件只记 repoPath。 */
  for (const up of registry.listUploads()) {
    const hit = registry.resolve(up.name);
    if (!hit || hit.source !== 'upload') continue;
    const buf = await (await fetch(hit.url)).arrayBuffer();
    assets.push({
      name: up.name, kind: up.kind ?? 'image', repoPath: null,
      data: b64encode(new Uint8Array(buf)),
    });
    seen.add(up.name.toLowerCase());
  }
  for (const name of engineNamesOf(shots)) {
    if (seen.has(name.toLowerCase())) continue;
    const hit = registry.resolve(name);
    if (hit?.source === 'repo') {
      assets.push({name, kind: 'image', repoPath: hit.url});
      seen.add(name.toLowerCase());
    }
  }
  /* 音频：引用到的 repo 件记 repoPath（转码索引路径），上传件已在上面内联。 */
  for (const {sheet, cue} of audioRefsOf(shots)) {
    const key = `audio:${sheet}/${cue}`;
    if (seen.has(key.toLowerCase())) continue;
    const hit = registry.resolveAudio(sheet, cue);
    if (hit?.source === 'repo') {
      assets.push({name: key, kind: 'audio', repoPath: hit.url});
      seen.add(key.toLowerCase());
    }
  }
  /* layouts：标定件 + 仓库已知（bundle 必须自带，离线页不再请求 data/layouts）。 */
  const layouts = {};
  for (const [id, layout] of registry.layouts) layouts[id] = layout;
  for (const c of registry.repo.characters) {
    if (!c.layout || c.id in layouts) continue;
    try {
      layouts[c.id] = await (await fetch(registry.layoutUrl(c.id))).json();
    } catch { /* 缺文件：留给 derive 兜底 */ }
  }
  return {
    format: FORMAT, version: VERSION,
    meta: {editor: 'yuntu-asset'},
    stories: [{
      title,
      scriptType: doc.story.format,
      shots,
    }],
    layouts,
    characters: characters ?? null,
    glossary: glossary ?? null,
    assets,
  };
}

/* 导入只产数据，不碰全局注册表（测试可拿返回值直接起播放器）；
   applyTo=true 时才写进 registry。 */
export async function importProject(project, {registry, applyTo = false} = {}) {
  if (project.format !== FORMAT) throw new Error(`不是本工程的包（${project.format}）`);
  const story0 = project.stories[0];
  const story = normalizeScript(story0.shots);
  story.title = story0.title;
  const data = {
    story,
    title: story0.title,
    layouts: project.layouts ?? {},
    assets: project.assets ?? [],
    characters: project.characters ?? {},
    glossary: project.glossary ?? {},
  };
  if (applyTo && registry) {
    const urls = new Map();
    for (const a of data.assets) {
      if (!a.data) continue;
      await registry.upload(a.name, new Blob([b64decode(a.data)],
          {type: a.kind === 'audio' ? 'audio/ogg' : 'image/png'}),
          {kind: a.kind ?? 'image'});
      urls.set(a.name.toLowerCase(), true);
    }
    for (const [id, layout] of Object.entries(data.layouts)) {
      await registry.saveLayout(id, layout);
    }
  }
  return data;
}

/* 从导入数据直接造解析三件套（play.html 与往返测试共用——
   「导出→新页导入」与预览走的是同一份代码，不是测试特供近似）。 */
export function projectResolvers(project, {base = ''} = {}) {
  const byName = new Map();
  for (const a of project.assets ?? []) byName.set(a.name.toLowerCase(), a);
  const urls = new Map();
  const filePathOf = (name) => {
    const key = name.toLowerCase();
    if (urls.has(key)) return urls.get(key);
    const a = byName.get(key);
    if (a) {
      if (a.data) {
        const blob = new Blob([b64decode(a.data)], {type: 'image/png'});
        const url = URL.createObjectURL(blob);
        urls.set(key, url);
        return url;
      }
      return `${base}${a.repoPath ?? `assets/${name}`}`;
    }
    return `${base}assets/${name}`;
  };
  /* 音频解析（与 AssetRegistry.resolveAudio 同键约定）：内联 blob >
     repoPath > bundle 约定路径 assets/audio/<sheet>/<cue>.ogg。 */
  const audioUrlOf = (sheet, cue) => {
    const key = `audio:${sheet}/${cue}`.toLowerCase();
    const a = byName.get(key);
    if (a?.data) {
      if (!urls.has(key)) {
        urls.set(key, URL.createObjectURL(new Blob([b64decode(a.data)],
            {type: 'audio/ogg'})));
      }
      return urls.get(key);
    }
    if (a) return `${base}${a.repoPath ?? audioFileOf(a.name)}`;
    return `${base}assets/audio/${sheet}/${cue}.ogg`;
  };
  const layouts = project.layouts ?? {};
  const layoutOf = async (img) => {
    const hit = layouts[img.imgPath];
    if (hit) return hit;
    throw new Error(`layout 缺失: ${img.imgPath}`);
  };
  return {filePathOf, layoutOf, audioUrlOf};
}

/* —— B：独立 ZIP bundle —— */

const BUNDLE_JS = [
  'js/ui/dom.js', 'js/ui/zip.js',
  'js/core/scheduler.js', 'js/core/state.js', 'js/core/markup.js',
  'js/core/script.js', 'js/core/idb.js', 'js/core/assets.js',
  'js/engine/player.js', 'js/engine/sprite.js', 'js/engine/typewriter.js',
  'js/engine/nouns.js', 'js/engine/audio.js', 'js/play.js',
];

const PLAY_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>AVG 剧情</title>
<link rel="stylesheet" href="css/avg.css">
<link rel="stylesheet" href="css/pandect.css">
<link rel="stylesheet" href="css/ux.css">
<style>html,body{margin:0;background:#000}html{overflow:hidden}</style>
</head>
<body>
<div id="stage"></div>
<script type="module">
import {bootProject} from './js/play.js';
const project = await (await fetch('project.json')).json();
const player = await bootProject(project, document.getElementById('stage'));
if (new URLSearchParams(location.search).get('probe')) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 2; i++) {
    player.container.click();
    await sleep(4000);
  }
  await fetch('/freeze?scene=bundle_probe', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      done: true,
      shotId: player.shotId,
      line: document.getElementById('avg-line').textContent,
      charas: document.querySelectorAll('.avg-chara').length,
    }, null, 1),
  });
}
</script>
</body>
</html>
`;

export async function exportZip({project, fetchImpl = fetch, assetBytes}) {
  const entries = [
    {name: 'play.html', data: PLAY_HTML},
    {name: 'project.json', data: JSON.stringify(project)},
  ];
  for (const path of BUNDLE_JS) {
    const r = await fetchImpl(`/${path}`);
    if (!r.ok) throw new Error(`打包缺文件 ${path}`);
    entries.push({name: path, data: new Uint8Array(await r.arrayBuffer())});
  }
  for (const css of ['css/avg.css', 'css/pandect.css', 'css/ux.css']) {
    const r = await fetchImpl(`/${css}`);
    entries.push({name: css, data: new Uint8Array(await r.arrayBuffer())});
  }
  for (const a of project.assets) {
    if (a.data) continue;                       // base64 件已在 project.json
    const bytes = assetBytes ? await assetBytes(a)
        : await (await fetchImpl(`/${a.repoPath}`)).arrayBuffer();
    entries.push({
      name: a.kind === 'audio' ? audioFileOf(a.name) : `assets/${a.name}`,
      data: new Uint8Array(bytes),
    });
  }
  return writeZip(entries);
}

/* —— C：目录落盘（File System Access API）—— */

export async function exportDir({project, zipEntries}) {
  if (!self.showDirectoryPicker) throw new Error('浏览器不支持目录写入（用 ZIP 形态）');
  const root = await self.showDirectoryPicker({mode: 'readwrite'});
  const write = async (path, data) => {
    const parts = path.split('/');
    let dir = root;
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, {create: true});
    const fh = await dir.getFileHandle(parts.at(-1), {create: true});
    const w = await fh.createWritable();
    await w.write(data);
    await w.close();
  };
  await write('project.json', JSON.stringify(project));
  for (const e of zipEntries) await write(e.name, e.data);
}

/* —— 自动保存：IDB 全量 + localStorage 瘦身兜底 —— */

export async function saveProject(db, id, project) {
  await idbPut(db, KV, project, `project:${id}`);
  try {
    const slim = {...project, assets: project.assets.filter((a) => a.data)};
    localStorage.setItem(`yuntu-project:${id}`, JSON.stringify(slim));
  } catch { /* 配额满：IDB 已是主存储 */ }
}

export async function loadProject(db, id) {
  const full = await idbGet(db, KV, `project:${id}`);
  if (full) return full;
  try {
    const text = localStorage.getItem(`yuntu-project:${id}`);
    return text ? JSON.parse(text) : null;
  } catch { return null; }
}

export async function listProjects(db) {
  const out = [];
  for (const key of await idbGet(db, KV, 'project-index') ?? []) {
    out.push({id: key, title: (await loadProject(db, key))?.stories?.[0]?.title ?? key});
  }
  return out;
}

export async function forgetProject(db, id) {
  await idbDel(db, KV, `project:${id}`);
  localStorage.removeItem(`yuntu-project:${id}`);
  const idx = ((await idbGet(db, KV, 'project-index')) ?? []).filter((k) => k !== id);
  await idbPut(db, KV, idx, 'project-index');
}

export async function touchProjectIndex(db, id) {
  const idx = (await idbGet(db, KV, 'project-index')) ?? [];
  if (!idx.includes(id)) await idbPut(db, KV, [...idx, id], 'project-index');
}
