/* state.js —— 与动画无关的 settled 状态：纯数据、可重放。
   applyImages / applyShotTweens / applyFaces 是仅有的三个 reducer，
   player 增量调用它们，seek 时从 emptyState() 折叠 0..N 重放（代价 O(N)，
   200 镜约几十微秒；不缓存快照，编辑器改 shot i 不需要作废任何东西）。

   语义全部来自参考冻结结论，不是常识：
   - 立绘在场以 imgTween lane 为依据（images[] 声明不算）；
   - 明暗是累积翻转：不带 isDark 的条目也会翻转（undefined != false 为真）；
   - bg overlay 的 dark 同款（contains != isDark 才 toggle）；
   - delete 没有豁免（参考的豁免分支恒 false，是死代码）。 */

export function emptyState() {
  return {
    imgMap: new Map(),
    lanes: new Map(),
    laneOrder: [],
    bg: null,
    bgOverlayDark: false,
    faces: new Map(),
  };
}

/* loadImages 的数据层。返回 {touched, deletions}：
   touched —— 本批注册/重注册的条目（DOM 层据此取 layout、补规则）；
   deletions —— 被本批 delete 标记且未撤销的 imgId。
   参考的「撤销」语义：同一批里先 delete 后又列出同一 imgId → 不删。 */
export function applyImages(state, images) {
  const deleteCache = new Set();
  const touched = [];
  for (const img of images) {
    if (img.delete) {
      deleteCache.add(img.imgId);
    } else if (deleteCache.has(img.imgId)) {
      deleteCache.delete(img.imgId);
      state.imgMap.set(img.imgId, img);
      touched.push({img, reenter: true});
    } else {
      state.imgMap.set(img.imgId, img);
      touched.push({img, reenter: false});
    }
  }
  const deletions = [...deleteCache];
  for (const imgId of deletions) {
    state.imgMap.delete(imgId);
    state.lanes.delete(imgId);
    const slot = state.laneOrder.indexOf(imgId);
    if (slot >= 0) state.laneOrder.splice(slot, 1);
  }
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
        state.bg = {imgId, alpha: entry.alpha, duration: entry.duration};
        if (state.bgOverlayDark != entry.isDark) {
          state.bgOverlayDark = !state.bgOverlayDark;
        }
      }
      events.push({imgId, imgType: 2, entries});
    } else if (img.imgType === 3) {
      let lane = state.lanes.get(imgId);
      const entering = !lane;
      if (!lane) {
        lane = {alpha: 0, posId: img.posId, isDark: false};
        state.lanes.set(imgId, lane);
        state.laneOrder.push(imgId);
      }
      let first = entering;
      for (const entry of entries) {
        lane.alpha = entry.alpha;
        if (first) {
          lane.posId = entry.posId !== undefined ? entry.posId : img.posId;
          first = false;
        } else if (entry.posId && lane.posId != entry.posId) {
          lane.posId = entry.posId;
        }
        if (entry.isDark != lane.isDark) lane.isDark = !lane.isDark;
      }
      events.push({imgId, imgType: 3, entering, entries});
    }
  }
  return {events, lastEnding};
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
