/* gamefold.js —— 游戏本体的 AVG 落定态折叠模型（换契约后的 oracle）。
 *
 * 为什么要单独一份：契约从 wiki AvgPlayer 换成游戏本体之后，改 `state.js`/
 * `player.js` 再没有外部播放器可当参照，必须有第二份独立实现来对拍。这份模型
 * 只按游戏 Lua 逻辑反汇编出来的规则折叠，**不 import state.js**，两码不相干。
 *
 * 语义出处（`node tools/lua-disasm.mjs <文件> --key=N` 可复跑）：
 *   · SYS = Game.Avg.UI.UIAVGSystem
 *       f24 L517-519 先扫一遍 `if cfg.delete then RecycleImgItem(imgId)`
 *       f24 L525-527 再扫一遍 `if not cfg.delete then NewImgItem(cfg)`
 *       f26 L609-628 回收＝从 dic 摘掉（背景/前景/远景进池，立绘 Delete()），
 *                未命中只 warn 且**不减 imgCount**
 *       f25 L541-575 imgType 决定容器：2→background 3→heroItem 4→foreground
 *                1 与 5 共用 distantView
 *   · IT  = Game.Avg.UI.UINAvgImgItem / HP = UINAvgHeroPic
 *       IT f2 L44-76、HP f4 L105-137 注册即写 pos/rot/scale/color.a：
 *            `alpha = imgCfg.alpha; if alpha == nil then alpha = rawImg.color.a end`
 *            `color = isDark and Color.gray or Color.white`
 *       HP f1 L45-79 资源未到达时 `loadResComplete=false`，tween 先排队
 *       HP f4 L116-121 rot 是**无条件写**：`transform.localEulerAngles =
 *              imgCfg.rot and Vector3(rot[1..3]) or Vector3.zero`
 *              ⇒ 注册不带 rot 会把立绘转回正面，不是"保持现状"。
 *              ⚠ 未决：`commonPicCtrl:SetPosType(posType)`（HP L52，C# 侧读不出方法体）
 *                在本函数之后跑，是否覆盖 localEulerAngles 未知 —— 实机 chelsea 的注册
 *                条目带 `rot=(0,180,0)`，而它的 `HeroItem` 实测 euler=(0,0,0)，
 *                「注册写了又被 SetPosType 抹掉」与「采到的不是同一镜」两种解释都成立。
 *                ⇒ 本模型按 Lua 侧字面语义折 rot，不预判 C# 侧的覆盖。
 *   · TU  = Game.Avg.AvgImgTweenUntil `Tween(imgItem, tweenCfg)`
 *       L32-45 pos：`if posId then (立绘→picPosData.pos｜否则 eAvgImgPosType[posId])
 *                    elseif pos then ... end`（then 尾有 JMP ⇒ 真 elseif）
 *       L60-70 scale：同构 elseif
 *       L53-56 rot：`if tweenCfg.rot ~= nil then sequence:Insert(delay,
 *                    transform:DOLocalRotate(Vector3(rot[1..3]), duration,
 *                    RotateMode.FastBeyond360)) end`
 *                    —— **独立 if，不受 posId 门控**，与 pos/scale 的 elseif 不同
 *       L79-86 color.a = picPosData.alpha（posId 且立绘）
 *       L90-94 color.a = tweenCfg.alpha   —— 与上一段之间**没有 JMP** ⇒ 独立 if
 *                     ⇒ 显式 alpha 覆盖槽位 α
 *       L96-103 `if isDark ~= nil then rgb = isDark and 0.5 or 1`（赋值，缺省不碰）
 *   · 枚举（直接 execChunk 可得）：eAvgImgType = DistantView1/Background2/
 *     Character3/Foreground4/Movie5；eAvgImgPosType = (-500,0,0)/(0,0,0)/(500,0,0)
 *
 * 与 state.js 的已知分歧（正是要拿去对拍的那几条）：
 *   isDark 缺省：游戏不碰，state.js 累积翻转；images[] 注册：游戏直接定可见度，
 *   state.js 只摆槽位；posId 回槽：游戏连带复位 α/scale；
 *   rot：游戏是独立 if、不受 posId 门控（TU L53-56），state.js:152 却在 posId 回槽时
 *        把 lane.rot 清成 null —— 游戏侧没有这条清除分支。
 */

const list = (x) => (Array.isArray(x) ? x : Object.values(x ?? {}));
export const CHAR = 3;                            /* eAvgImgType.Character */

export function emptyFold() {
  return {lanes: new Map(), imgType: new Map(), warnings: []};
}

/* slotOf(imgId, posId) → {pos,scale,alpha} | null：官方槽位数据。
   由调用方注入（data/layouts/<角色>.json），模型不碰素材索引。 */
export function applyGameImages(f, images, slotOf) {
  const ims = list(images);
  for (const e of ims) {                      /* 第一遍：只收 delete */
    if (e?.delete && e.imgId != null) f.lanes.delete(e.imgId);
  }
  for (const e of ims) {                      /* 第二遍：注册/换参 */
    if (!e || e.imgId == null || e.delete) continue;
    if (e.imgType != null) f.imgType.set(e.imgId, e.imgType);
    const prev = f.lanes.get(e.imgId) ?? {alpha: 0, isDark: false};
    const isChar = e.imgType === CHAR || (e.imgType == null && f.imgType.get(e.imgId) === CHAR);
    const slot = isChar && e.posId != null ? slotOf?.(e.imgId, e.posId) : null;
    let alpha = e.alpha;
    if (alpha === undefined) alpha = slot && slot.alpha !== undefined
        ? slot.alpha : prev.alpha;            /* 缺省 = 继承 rawImg.color.a */
    f.lanes.set(e.imgId, {
      alpha,
      /* InitAvgHeroPicParam L133 `color = imgCfg.isDark and Color.gray or Color.white`
         是**无条件赋值** ⇒ 注册不带 isDark 就是把明暗重置成亮，不继承。 */
      isDark: e.isDark === true,
      posId: e.posId ?? prev.posId ?? null,
      pos: e.pos ?? (slot ? slot.pos : null),
      scale: e.scale ?? (slot ? slot.scale : null),
      /* HP L116-121：注册无条件写 localEulerAngles ⇒ 不带 rot 就是归零，不继承。 */
      rot: e.rot ?? null,
    });
  }
  return f;
}

export function applyGameTween(f, entries, slotOf) {
  for (const e of list(entries)) {
    if (!e || e.imgId == null) continue;
    const lane = f.lanes.get(e.imgId);
    if (!lane) {                              /* SYS f27 L646：拿不到 item 就静默丢 */
      f.warnings.push(`Can't find avg img item, imgId = ${e.imgId}`);
      continue;
    }
    const isChar = f.imgType.get(e.imgId) === CHAR;
    const slot = e.posId != null && isChar ? slotOf?.(e.imgId, e.posId) : null;
    /* pos/scale：posId 优先（真 elseif），否则条目自带 */
    if (slot) {
      if (slot.pos) lane.pos = slot.pos;
      if (slot.scale) lane.scale = slot.scale;
      if (slot.alpha !== undefined) lane.alpha = slot.alpha;   /* L79-86 */
    } else if (e.pos !== undefined) lane.pos = e.pos;
    if (e.posId == null && e.scale !== undefined) lane.scale = e.scale;
    /* rot：TU L53-56 是独立 if 且**不受 posId 门控** ⇒ 带就写、不带就不碰。
       不要照 pos/scale 加 posId 清除分支，游戏侧没有那条。 */
    if (e.rot !== undefined) lane.rot = e.rot;
    if (e.alpha !== undefined) lane.alpha = e.alpha;            /* L90-94 独立 if */
    if (e.isDark !== undefined) lane.isDark = e.isDark === true;/* L96-103 赋值 */
    if (e.posId != null) lane.posId = e.posId;
  }
  return f;
}

/* 一镜落定：先 images 后 imgTween（原版 RefreshAvgImg 在 PlayAvgOrder 之前）。 */
export function foldShot(f, shot, slotOf) {
  applyGameImages(f, shot?.images, slotOf);
  applyGameTween(f, shot?.imgTween, slotOf);
  return f;
}

export const visible = (lane) => (lane?.alpha ?? 0) > 0;
