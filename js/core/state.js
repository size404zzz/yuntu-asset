/* state.js —— 与动画无关的 settled 状态：纯数据、可重放。
   applyImages / applyShotTweens / applyFaces 是仅有的三个 reducer，
   player 增量调用它们，seek 时从 emptyState() 折叠 0..N 重放（代价 O(N)，
   200 镜约几十微秒；不缓存快照，编辑器改 shot i 不需要作废任何东西）。

   语义出处 = 游戏本体（契约于 2026-08-31 从 wiki 参考件换成游戏，见 plan
   「契约切换」节；对账链 tools/test-gameplay.mjs）：
   - 立绘在场以 imgTween lane 为依据（images[] 声明算不算入场是**已知分歧**，见下）；
   - 明暗是**赋值**：`AvgImgTweenUntil` L96-103 `if tweenCfg.isDark ~= nil then
     rgb = isDark and 0.5 or 1` —— 缺省不碰。参考件那套「缺省也翻转」已废；
   - bg overlay 同款（原版每条背景图各有一个 color.rgb，我们只有一个遮罩层）；
   - delete 没有豁免（参考的豁免分支恒 false，是死代码）。 */

/* 槽位仅 1..5 有效；语料里有入场不带 posId（或给 0/越界值）的轨迹，
   归一到 3（居中槽）——宁可站中间，也不产出无规则的 posundefined。
   player 的 DOM 侧必须同口径（_blockChara 入场分支）。 */
export const isValidPos = (p) => Number.isInteger(p) && p >= 1 && p <= 5;

/* pos/scale 向量守卫：长度 2 且两分量皆有限数才算（语料有 [0] 脏形态）。
   与 player 的行内定位同口径——折叠态与屏上定位必须一致。 */
export const isValidPosVec = (p) =>
    Array.isArray(p) && p.length === 2
    && Number.isFinite(p[0]) && Number.isFinite(p[1]);

export const isValidRotVec = (p) =>
    Array.isArray(p) && p.length >= 3
    && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]);

export function emptyState() {
  return {
    imgMap: new Map(),
    lanes: new Map(),
    laneOrder: [],
    /* 非立绘图层（DistantView / Background / Foreground / Movie）。
       `lanes` 保持只装角色，避免改变已有 fold/autoLightCast 的身份语义。 */
    layers: new Map(),
    layerOrder: [],
    bg: null,
    bgOverlayDark: false,
    faces: new Map(),
  };
}

/* loadImages 的数据层。返回 {touched, deletions}：
   touched —— 本批注册条目（DOM 据此取 layout、补规则；reenter = 本镜先回收过）；
   deletions —— 本批 delete 标记的 imgId（先回收，再注册）。 */
export function applyImages(state, images) {
  /* 两遍扫描（SYS f24 L517-527）：先把所有 delete 回收完，再逐条注册。
     所以同镜「delete + 又列出」不是撤销，而是**回收后重建一个全新 item**
     （换装：可见度/明暗都从新条目重算，不继承旧 item）。
     参考件那套「同批撤销」是它 loadImages 里恒 false 的死代码，已废。 */
  const deletions = [...new Set(images.filter((i) => i?.delete).map((i) => i.imgId))];
  const gone = new Set(deletions);
  for (const imgId of deletions) {
    state.imgMap.delete(imgId);
    state.lanes.delete(imgId);
    state.layers.delete(imgId);
    const slot = state.laneOrder.indexOf(imgId);
    if (slot >= 0) state.laneOrder.splice(slot, 1);
    const layerSlot = state.layerOrder.indexOf(imgId);
    if (layerSlot >= 0) state.layerOrder.splice(layerSlot, 1);
    if (state.bg?.imgId === imgId) state.bg = null;
  }
  const touched = [];
  for (const img of images) {
    if (!img || img.delete) continue;
    state.imgMap.set(img.imgId, img);
    if (img.imgType !== 3) {
      /* 游戏的 UINAvgImgItem.InitAvgImgParam 会在每次注册时把
         position/rotation/scale/color 写回节点；非角色层在这里保留一份
         可重放的落定态。alpha 缺省仍交给实际 tween/DOM 语义处理。 */
      state.layers.set(img.imgId, {
        imgId: img.imgId,
        imgType: img.imgType,
        alpha: img.alpha ?? 0,
        isDark: false,
        pos: isValidPosVec(img.pos) ? img.pos : null,
        scale: isValidPosVec(img.scale) ? img.scale : null,
        rot: isValidRotVec(img.rot) ? img.rot : null,
      });
      if (!state.layerOrder.includes(img.imgId)) state.layerOrder.push(img.imgId);
    }
    touched.push({img, reenter: gone.has(img.imgId)});
  }
  /* 「注册即定可见度/重置明暗」（InitAvgHeroPicParam 当场写 color）**暂未实现**：
     注册条目 7489 条全是 alpha=0，游戏里就是"摆位并先隐"，与现在「无 lane = 不可见」
     同观感；但若在此建 lane，lane 群体一变大会喂给 avgwire 的 autoLightCast
     （它按说话者路径匹配，会把同角色的多个换装件一起点亮 ⇒ 两个帕斯卡同屏）。
     等「autoLightCast 在游戏契约下是否保留」定了再一并做。见 plan 的 D 类。 */

  return {touched, deletions};
}

/* 一个镜头的 imgTween 折叠。返回 {events, lastEnding}：
   events 保持参考 miseEnScene 的遍历序（Map 插入序 = imgTween 首见序），
   DOM 层按事件调度动画；lastEnding = 最晚的 delay+duration（秒），
   就是 manageImg 的串行门（打字要等它跑完，R8）。 */
export function applyShotTweens(state, shot) {
  const events = [];
  if (!shot?.imgTween) return {events, lastEnding: 0};
  const mise = new Map();
  let lastEnding = 0;
  for (const entry of shot.imgTween) {
    if (!mise.has(entry.imgId)) mise.set(entry.imgId, []);
    mise.get(entry.imgId).push(entry);
    lastEnding = Math.max(lastEnding, (entry.delay || 0) + (entry.duration || 0));
  }
  for (const [imgId, entries] of mise) {
    const img = state.imgMap.get(imgId);
    if (!img) continue;
    if (img.imgType === 2) {
      for (const entry of entries) {
        /* alpha 缺省 = 保持（语料的抖动/效果拍不带 alpha）：继承 settled 态，
           与 DOM 侧「不写 opacity」同口径。 */
        state.bg = {imgId, alpha: entry.alpha ?? state.bg?.alpha ?? 0,
          duration: entry.duration};
        if (entry.isDark !== undefined) state.bgOverlayDark = entry.isDark === true;
        const layer = state.layers.get(imgId);
        if (layer) {
          if (entry.alpha !== undefined) layer.alpha = entry.alpha;
          if (isValidPosVec(entry.pos)) layer.pos = entry.pos;
          if (isValidPosVec(entry.scale)) layer.scale = entry.scale;
          if (isValidRotVec(entry.rot)) layer.rot = entry.rot;
          if (entry.isDark !== undefined) layer.isDark = entry.isDark === true;
        }
      }
      events.push({imgId, imgType: 2, entries});
    } else if (img.imgType === 3) {
      /* 注册可以先建 lane（见 applyImages），所以「入场」另用 entered 记：
         首次 tween 事件才建/挂 DOM 元素，与旧行为逐字一致。 */
      let lane = state.lanes.get(imgId);
      const entering = !lane?.entered;
      if (!lane) {
        lane = {alpha: 0, posId: img.posId, isDark: false, pos: null, scale: null};
        state.lanes.set(imgId, lane);
        state.laneOrder.push(imgId);
      }
      lane.entered = true;
      let first = entering;
      for (const entry of entries) {
        /* alpha 缺省 = 保持：抖动/灯光拍只动 isDark/pos，不改可见度。
           旧行为记 undefined（判不可见）而 DOM 侧 opacity 不变（仍可见），
           态屏分裂；现两侧统一为继承。 */
        if (entry.alpha !== undefined) lane.alpha = entry.alpha;
        /* pos/scale 同款继承：条目缺省 = 保持当前绝对定位/缩放；
           带有效 posId 的回槽条目消费绝对定位（与 DOM 行内清除同口径）。 */
        if (isValidPosVec(entry.pos)) lane.pos = entry.pos;
        else if (isValidPos(entry.posId)) lane.pos = null;
        if (isValidPosVec(entry.scale)) lane.scale = entry.scale;
        else if (isValidPos(entry.posId)) lane.scale = null;
        if (isValidRotVec(entry.rot)) lane.rot = entry.rot;
        else if (isValidPos(entry.posId)) lane.rot = null;
        if (first) {
          lane.posId = entry.posId !== undefined ? entry.posId : img.posId;
          if (!isValidPos(lane.posId)) lane.posId = 3;
          first = false;
        } else if (isValidPos(entry.posId) && lane.posId != entry.posId) {
          lane.posId = entry.posId;
        }
        /* 赋值而不是翻转：缺省 = 不碰这条的明暗（原版只在该条目带 isDark 时
           才写 color.rgb）。 */
        if (entry.isDark !== undefined) lane.isDark = entry.isDark === true;
      }
      events.push({imgId, imgType: 3, entering, entries});
    } else if (img.imgType === 1 || img.imgType === 4 || img.imgType === 5) {
      const layer = state.layers.get(imgId);
      if (!layer) continue;
      for (const entry of entries) {
        if (entry.alpha !== undefined) layer.alpha = entry.alpha;
        if (isValidPosVec(entry.pos)) layer.pos = entry.pos;
        if (isValidPosVec(entry.scale)) layer.scale = entry.scale;
        if (isValidRotVec(entry.rot)) layer.rot = entry.rot;
        if (entry.isDark !== undefined) layer.isDark = entry.isDark === true;
      }
      events.push({imgId, imgType: img.imgType, entries});
    }
  }
  return {events, lastEnding};
}

/* 立绘层 z 序。游戏侧：NewImgItem 里 ChangeAvgImgOrder(imgCfg.order) 并置
   imgNeedSort[imgType]，UIAVGSystem f28 再把该层字典摊成数组、按
   `GetAvgImgOrder()`（= imgCfg.order or 0）**升序** table.sort，逐个
   SetAsLastSibling ⇒ order 大的后面上面。
   同 order 时游戏是 pairs 序 + 不稳定 sort，结果本身不保证；这里钉成
   lane 建立序，保证回放可复现。 */
export function laneZOrder(state) {
  return state.laneOrder
      .map((imgId, seq) => ({imgId, seq, order: state.imgMap.get(imgId)?.order ?? 0}))
      .sort((a, b) => (a.order - b.order) || (a.seq - b.seq))
      .map((e) => e.imgId);
}

/* heroFace 折叠。faceId 为 0/缺省 = 还原默认脸（参考 drawFace 的 if(faceId)）。 */
export function applyFaces(state, shot) {
  const changed = [];
  for (const face of shot?.heroFace || []) {
    state.faces.set(face.imgId, face.faceId || 0);
    changed.push(face);
  }
  return changed;
}
