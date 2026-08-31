/* fadeadvice.js —— M23 退场建议：**只给建议，不自动改**。
 *
 * 由来（M22 收场判据研究 + GFWiki「行动记录/无律背反」= 23carnival 39 段
 * 外源对拍，真值落在 data/fixtures/wiki-fades-23carnival.json）：
 *   1. 自动收掉「作者点亮却从不写退场」的立绘，三种判据（重排 / 换背景 /
 *      两者都）按「作者后面还提到它」严判的误清率都在 23% 上下。压不下去
 *      的原因不是判据不够细，而是严判基准本身错了：wiki 的淡出里有 50%
 *      （860/1734）在 ≤3 镜后就重新点亮——「淡出 + 再亮」是正常语法对，
 *      「后面还提」根本不是「必须留台」的信号。
 *   2. 淡出的落点有规律：68%（1186/1734）落在无说话人镜（ct2 底栏 + ct4
 *      大字），换背景镜只占 6%——所以触发器取「无说话人镜」。但落点规律
 *      **不能反着用**：把无说话人镜上当滞留者全列出来（39 段 1133 条），
 *      本镜命中 wiki 淡出只有 8%。这是典型的基率倒置——P(无说话人 | 淡出)
 *      高不等于 P(淡出 | 无说话人 + 滞留) 高。本模块因此不做「该收」的判定，
 *      只把候选按「语法上收得回来吗」排序交给人。
 *   3. 实测梯度（39 段 / 1133 条候选，命中 = 同一（镜, imgId）上 wiki 也收了；
 *      ±1 容一条转写者把淡出写在相邻镜）：
 *        下次提及距离  1 镜：31.6% / ±1 75.4%   （n=57）
 *                    2-3  ：15.7% / ±1 60.6%   （n=127）
 *                    4-10 ：15.5% / ±1 43.3%   （n=187）
 *                     >10 ： 5.2% / ±1 21.6%   （n=232）
 *                    之后再不提： 1.7% / ±1  7.4% （n=530）
 *      分档就按这条实测梯度切（imminent 20.7%/±1 65.2%，distant 43%，
 *      far 22%，silent 7%），不按想当然的「风险」。
 *   4. 「之后再不提」这一档（= 用户原本最想自动清的那类）命中率垫底，
 *      与 M22 的换景测量（wiki 留 19/21）同向：wiki 转写者遇到「作者点亮
 *      之后就再没条目」时一律不收——她就是静静站在台上到段落结束，没有
 *      后续条目不等于她退场了。这一档默认不列，UI 里可勾选显示并标注。
 *
 * 预检查的是「收掉之后她还会不会回来、以什么形态回来」，不是「该不该收」：
 *   relight  —— α1 条目：她自己会回来
 *   reentry  —— images[] 注册/delete：换装或清场
 *   fade     —— α0/d>0：作者本来就要她退场，我们只是提前到本镜
 *   preentry —— α0/d0 预站位：人回来但揭示半拍作者没写（needReveal）
 *   keep     —— 只动明暗/位置的条目，不改可见度
 *
 * 折叠口径：沿 story.order（重放链）折叠，孤儿镜不看——观众停不到的镜里
 * 淡出没有意义。可见性判据与 state.js 同款（lane.alpha > 0）。
 * 落笔参数与 autoLightCast 的收场条目、wiki 转写件两处口径一致
 * （delay 0 / duration 0.2 / alpha 0 / isDark false）。
 */

import {emptyState, applyImages, applyShotTweens} from './state.js';
import {stripMarkup} from './schema.js';

/* 分档阈值 = 上面的实测梯度：≤3 镜是「还在密集调度她」，>10 与「之后再不提」
   是「作者已经把她忘了/留着」。改这两个数要重跑 tools/test-fadeadvice.mjs
   的外源锚点（命中率断言跟着夹具走）。 */
export const NEAR_WINDOW = 3;
export const MID_WINDOW = 10;

/* 落笔条目的固定参数。 */
export const FADE_TWEEN = {delay: 0, duration: 0.2, alpha: 0, isDark: false};

/* 分档：label 给 UI，hit 是 39 段外源实测的 ±1 命中率（进头注，别口头传播） */
export const TIERS = {
  imminent: {label: '下 1-3 镜就有调度', hit: '±1 命中 65%', rank: 0},
  distant: {label: '4-10 镜后有调度', hit: '±1 命中 43%', rank: 1},
  far: {label: '10 镜后才再有调度', hit: '±1 命中 22%', rank: 2},
  silent: {label: '之后再不提（wiki 口径：转写者一律不收）',
    hit: '±1 命中 7%', rank: 3},
};

export const NEXT_LABEL = {
  relight: '复亮', reentry: '重注册', fade: '作者自己淡出',
  preentry: '预站位', keep: '只动明暗/位置',
};

/* 无说话人镜：wiki 淡出 68% 的落点。按「有没有说话人」判而不是按
   contentType 判，免得漏掉无说话人的对白镜。 */
export const hasSpeaker = (shot) =>
    (shot?.speakerHeroId !== undefined && shot?.speakerHeroId !== null)
    || !!shot?.speakerName;

/* 给一镜追加一条退场 tween（不改动原数组，供 doc.patch 整体替换）。 */
export function applyFadeOut(shot, imgId) {
  return [...(shot?.imgTween ?? []), {imgId, ...FADE_TWEEN}];
}

/* 预检：沿重放链往后找该 imgId 的下一次提及，判它是「回来」还是「消失」。
   tween 优先于 images[]——state.js 里可见性只由 tween 改，images[] 注册
   本身不改 lane.alpha（那是「摆到槽位上」，不是可见性事件）。 */
function lookAhead(story, order, fromPos, imgId) {
  for (let p = fromPos + 1; p < order.length; p++) {
    const j = order[p];
    const shot = story.shots[j];
    if (!shot) continue;
    const tw = (shot.imgTween ?? []).find((t) => t && t.imgId === imgId);
    if (tw) {
      const alpha = tw.alpha ?? null;
      const dur = tw.duration ?? 0;
      return {
        index: j, wire: wireOf(story, j), distance: p - fromPos,
        kind: alpha === null ? 'keep'
            : alpha > 0 ? 'relight'
            : dur > 0 ? 'fade' : 'preentry',
      };
    }
    if ((shot.images ?? []).some((m) => m && m.imgId === imgId)) {
      return {index: j, wire: wireOf(story, j), distance: p - fromPos,
        kind: 'reentry'};
    }
  }
  return null;
}

const wireOf = (story, index) => story.indexToWire?.[index] ?? index + 1;

const tierOf = (next) => {
  if (!next) return 'silent';
  if (next.distance <= NEAR_WINDOW) return 'imminent';
  if (next.distance <= MID_WINDOW) return 'distant';
  return 'far';
};

export function analyzeFadeAdvice(story) {
  const order = story?.order?.length
      ? story.order : (story?.shots ?? []).map((_, i) => i);
  const state = emptyState();
  const items = [];
  const stats = {shots: order.length, narration: 0, lingering: 0, byTier: {}};

  order.forEach((index, pos) => {
    const shot = story.shots[index] ?? {};
    /* 进镜前已在台上（作者点亮后一直留着）的立绘 */
    const lit = [];
    for (const [imgId, lane] of state.lanes) {
      if ((lane.alpha ?? 0) > 0) lit.push(imgId);
    }
    if (lit.length && !hasSpeaker(shot)) {
      stats.narration++;
      /* 本镜作者亲自动过它就不插嘴：那是原稿的调度，不是滞留 */
      const touched = new Set();
      for (const t of (shot.imgTween ?? [])) if (t) touched.add(t.imgId);
      for (const im of (shot.images ?? [])) if (im) touched.add(im.imgId);
      for (const imgId of lit) {
        if (touched.has(imgId)) continue;
        stats.lingering++;
        const next = lookAhead(story, order, pos, imgId);
        const tier = tierOf(next);
        stats.byTier[tier] = (stats.byTier[tier] ?? 0) + 1;
        items.push({
          index, wire: wireOf(story, index), imgId,
          imgPath: state.imgMap.get(imgId)?.imgPath ?? null,
          dark: !!state.lanes.get(imgId)?.isDark,
          contentType: shot.contentType ?? null,
          text: stripMarkup(String(shot.content ?? '')).slice(0, 32),
          next, tier,
          /* 回来路径是预站位 = 揭示半拍作者没写；收掉后要补揭示，
             或交给 autoLightCast 的说话镜补齐 */
          needReveal: next?.kind === 'preentry',
        });
      }
    }
    applyImages(state, shot.images ?? []);
    applyShotTweens(state, shot);
  });

  items.sort((a, b) => (TIERS[a.tier].rank - TIERS[b.tier].rank)
      || (a.index - b.index) || (a.imgId - b.imgId));
  return {items, stats};
}
