/* shotstate.js —— 「截至本镜」的舞台连续性折叠（编辑器检查器用）。
   state.js 是播放器契约（有对拍保护，见 test-gameplay），只产落定值；
   本模块在它的 reducer 之上补「出处」：每个在场元素记调用发生的镜号
   （images 注册 / bgm 起 / effect 起 / bgColor 起 / 表情变），检查器据此把
   「延续下来的状态」与「本镜新触发」分开呈现——BGM 从第 1 镜起响，第 5 镜
   的状态里就带「于第 1 镜起」，而不是只在第 1 镜可见。
   折叠路径 = story.order（真实推进链，分支走 branch[0]）；孤儿镜（不在链上）
   退化为数组前缀 0..index。每镜应用次序照 playShot：images → heroFace →
   imgTween → aux（audio/bgm、bgColor、ppv、effect）。 */

import {emptyState, applyImages, applyShotTweens, applyFaces} from './state.js';

export const LAYER_NAMES = {1: '远景', 2: '背景', 4: '前景', 5: 'Movie'};
export const BG_COLORS = {1: '清除', 2: '黑', 3: '白'};

/* 选中镜在推进链上的前缀（含自身）；孤儿镜按数组下标前缀折叠。 */
export function foldPath(story, index) {
  const at = story.order ? story.order.indexOf(index) : -1;
  if (at >= 0) return story.order.slice(0, at + 1);
  return Array.from({length: index + 1}, (_, i) => i);
}

export function foldShotState(story, index) {
  const path = foldPath(story, index);
  const state = emptyState();
  const regShot = new Map();    /* imgId → 当前注册条目所在镜（delete 后重注册会换） */
  const laneShot = new Map();   /* imgId → 首次进 lane（揭示）的镜 */
  const faceSince = new Map();  /* imgId → {faceId, since} */
  const effects = new Map();    /* effect id → {id, prefab, pos, layer, since} */
  let stopNow = [];             /* 本镜 stopList 停掉的 id */
  let bgm = null;               /* {cue, sheet, fadeIn, fadeOut, since} */
  let bgmStop = null;           /* {since}：最近一次 bgm.stop 的镜 */
  let bgColor = null;           /* {value, since}（引擎只认 1/2/3，其余忽略） */
  let ppv = null;               /* {since} */
  let touched = new Set();      /* 末镜 imgTween 提到的 imgId（「本镜有动」） */

  for (const i of path) {
    const shot = story.shots[i] ?? {};
    if (shot.images?.length) {
      applyImages(state, shot.images);
      /* 出处簿记同 applyImages 的两遍扫描：先回收（delete 摘出处），
         再注册（同镜 delete+列出 = 全新条目，出处记本镜）。 */
      for (const im of shot.images) {
        if (im?.delete && Number.isInteger(im.imgId)) {
          regShot.delete(im.imgId);
          laneShot.delete(im.imgId);
        }
      }
      for (const im of shot.images) {
        if (im && !im.delete && Number.isInteger(im.imgId)) {
          regShot.set(im.imgId, i);
        }
      }
    }
    if (shot.heroFace?.length) {
      applyFaces(state, shot);
      for (const f of shot.heroFace) {
        if (f) faceSince.set(f.imgId, {faceId: f.faceId || 0, since: i});
      }
    }
    touched = new Set();
    stopNow = [];
    if (shot.imgTween?.length) {
      for (const t of shot.imgTween) if (t) touched.add(t.imgId);
    }
    const lanesBefore = new Set(state.lanes.keys());
    applyShotTweens(state, shot);
    for (const imgId of state.lanes.keys()) {
      if (!lanesBefore.has(imgId)) laneShot.set(imgId, i);
    }
    /* bgm 语义照 audio.bgmCue：stop → 停；无 stop 无 cue → 不动现状；
       有 cue → 换轨/续响（同曲不重启，但对检查器而言「最近一次调用」就是出处）。 */
    const cue = shot.audio?.bgm;
    if (cue) {
      if (cue.stop) {
        bgm = null;
        bgmStop = {since: i};
      } else if (cue.cue) {
        bgm = {...cue, since: i};
        bgmStop = null;
      }
    }
    const color = BG_COLORS[shot.bgColor];
    if (color !== undefined) bgColor = {value: shot.bgColor, since: i};
    if (shot.ppv && typeof shot.ppv === 'object') ppv = {since: i};
    if (shot.effect && typeof shot.effect === 'object') {
      for (const [id, cfg] of Object.entries(shot.effect)) {
        if (id === 'stopList') continue;
        /* 非 object 条目引擎整个跳过（连旧元素都不摘），这里同口径。 */
        if (cfg && typeof cfg === 'object') {
          effects.set(String(id), {
            id: String(id), prefab: String(cfg.prefabName || id),
            pos: cfg.pos, layer: cfg.layer, since: i,
          });
        }
      }
      const stop = Array.isArray(shot.effect.stopList) ? shot.effect.stopList : [];
      for (const id of stop) {
        effects.delete(String(id));
        stopNow.push(String(id));
      }
    }
  }

  const sprites = [];
  const layers = [];
  for (const [imgId, img] of state.imgMap) {
    const since = regShot.get(imgId) ?? null;
    if (img.imgType === 3) {
      const lane = state.lanes.get(imgId) ?? null;
      sprites.push({
        imgId, imgPath: img.imgPath, comm: !!img.comm,
        posId: lane?.posId ?? img.posId,
        alpha: lane?.alpha ?? 0,
        isDark: lane?.isDark ?? false,
        pos: lane?.pos ?? null, scale: lane?.scale ?? null, rot: lane?.rot ?? null,
        entered: !!lane?.entered,
        faceId: state.faces.get(imgId),
        since, litSince: laneShot.get(imgId) ?? null,
        touched: touched.has(imgId),
      });
    } else {
      const layer = state.layers.get(imgId);
      layers.push({
        imgId, imgType: img.imgType, imgPath: img.imgPath,
        alpha: layer?.alpha ?? img.alpha ?? 0,
        isDark: layer?.isDark ?? false,
        pos: layer?.pos ?? null, scale: layer?.scale ?? null, rot: layer?.rot ?? null,
        since, touched: touched.has(imgId),
      });
    }
  }

  const shot = story.shots[index] ?? {};
  return {
    path,
    sprites, layers,
    bgm, bgmStop, bgColor, ppv,
    effects: [...effects.values()],
    stopNow,
    /* 本镜一次性触发（不延续）：sfx / CV / 视频 / 文案抖动。 */
    sfx: shot.audio?.sfx ?? null,
    voice: shot.voice ?? null,
    vedioPath: shot.vedioPath,
    contentShake: shot.contentShake,
  };
}
