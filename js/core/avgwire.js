/* avgwire.js —— AvgCfg/AvgLang 解码件 → 引擎 wire（map 格式）的唯一映射入口。
 *
 * 引擎的 normalizeScript 原生吃「原始游戏导出」的 map 格式（键 = 步骤 ID，
 * nextId = 键名，scene2 夹具自带断档键），字段词汇与游戏脚本同名同形
 * （wiki 格式本就是游戏脚本的转写），所以映射做六类事：
 *
 * 1. Lang 解引用（全语料值型普查 M13，口径进 test-avgcfg）：
 *    - content / speakerName / SkipScenario / branch[].content：数字 = 本剧本
 *      AvgLang 的键，解析成文本；未命中的键保持数字原样可见（content
 *      125、speakerName 2、SkipScenario 1 处，属跨剧本引用/缺词条）；
 *    - storyAvgId：0/383 命中本剧本 Lang（值如 1800101，全局标题命名空间），
 *      原样透传，等剧情库接入全局标题表再解。
 * 2. branch 双形态归一：数组原样；对象形态（数字键 = 选项 +
 *    disableSelected/finalAct 旗标）展平为引擎要的数组，旗标挪到 shot 根
 *    （引擎忽略未知字段，无损）。
 * 3. 首张 bg 的隐现物化（materializeFirstBg）：游戏引擎里 images 声明的
 *    第一张 imgType-2 直接可见；wiki 玩家只认 imgTween，语料里四成剧本
 *    从不 tween 它——不物化就是几十镜黑屏。
 * 4. 悬空立绘 tween 的落名（materializeDanglingCast）：tween 的 imgId 走
 *    游戏侧的全局角色槽位表（147 在 31 段剧本里都是薇洛儿），images[]
 *    只在换装/换人时覆盖——94% 的剧本都有 tween 引用从未声明的 id，
 *    wiki 玩家对未注册 tween 一律跳过，角色整段隐身。imgIds 表由
 *    build-asset-index 对全语料声明直方图取众数估出（候选分歧的 id
 *    少数派剧本本就该用 images[] 覆盖，不影响默认值估计）。
 * 5. 永不可见立绘的揭示重建（revealNeverVisibleCast）：613 段剧本里
 *    有的角色只有 alpha 0 条目、alpha 1 的揭示半拍在数据里缺失
 *    （22child_01_03 的安吉拉：台词连连却整段隐身），按完好剧本的
 *    成对模式补齐。
 * 6. 说话者复亮（autoLightCast）：完好数据里明暗跟随说话节拍
 *    （说话=亮、聆听=暗），但部分剧本丢了「复亮」半拍（1year_prologue
 *    的帕斯卡：键 3 听教授切暗后，键 6/8/10/11 自己说话却一直压暗）。
 *    依 heroSprites 桥表（heroId → 立绘，构建器对全语料「说话×亮」
 *    投票估出，暗占优的阴影说话者天然落选）在说话镜补复亮条目。
 *    只修亮面：聆听面本就有数据，且隐身说话（电台台词）是合法演出。
 *
 * voice={heroId,voiceId} 是 CV 引用（468 处），引擎 M7 尚无 voice 通道，
 * 原样透传；images/imgTween/heroFace/effect/audio/ppv 等与 wire 同形直接过。
 */
import {emptyState, applyImages, applyShotTweens} from './state.js';

/* 0 起始平移：引擎 map 格式的 shotId 从 scriptType=0 起步、键 0 是
 * 「开局之前」，永远渲染不到（语料 1555 段 0 起始：21 段纯视频 + 1534 段
 * 首镜在 0）。凡键 '0' 存在的剧本，全部键与 nextId/jumpAct 统一 +1；
 * 1 起始的 323 段原样不动。 */
export function storyToWire(cfg, lang, {imgIds, heroSprites} = {}) {
  const stats = {resolved: 0, unresolved: [], shifted: false, bgReveal: null,
    danglingCast: [], autoLit: 0};
  const shift = '0' in cfg ? 1 : 0;
  stats.shifted = shift === 1;
  const wire = {};
  for (const [id, step] of Object.entries(cfg)) {
    wire[String(Number(id) + shift)] =
        resolveStep(step ?? {}, lang, id, stats, shift);
  }
  materializeDanglingCast(wire, imgIds, stats);
  revealNeverVisibleCast(wire, stats);
  materializeFirstBg(wire, stats);
  autoLightCast(wire, heroSprites, stats);
  return {wire, stats};
}

/* 说话者复亮：fold 引擎同款状态（state.js 的纯 reducer），在每个
 * speakerHeroId 命中桥表的镜检查其立绘 lane——可见但压暗就是丢了
 * 复亮半拍，补 {alpha 1, 亮} 并同步进模拟状态（后续镜的判定基于
 * 修正后的世界线）。隐身说话（电台台词）与聆听压暗都不碰。 */
function autoLightCast(wire, heroSprites, stats) {
  if (!heroSprites) return;
  const state = emptyState();
  const pathOf = new Map();
  let fixed = 0;
  for (const k of Object.keys(wire)) {
    const shot = wire[k];
    if (shot.images?.length) {
      applyImages(state, shot.images);
      for (const im of shot.images) {
        if (im.imgPath && !im.delete) pathOf.set(im.imgId, im.imgPath);
        else if (im.delete) pathOf.delete(im.imgId);
      }
    }
    const want = shot.speakerHeroId !== undefined && shot.speakerHeroId !== null
      ? heroSprites[String(shot.speakerHeroId)] : null;
    applyShotTweens(state, shot);
    if (!want) continue;
    for (const [imgId, lane] of state.lanes) {
      if (pathOf.get(imgId) !== want) continue;    /* 不是说话者的立绘 */
      if (!((lane.alpha ?? 0) > 0) || lane.isDark === false) continue;
      const arr = [...(shot.imgTween ?? [])];
      arr.push({imgId, delay: 0, duration: 0.2, alpha: 1, isDark: false});
      shot.imgTween = arr;
      lane.isDark = false;
      fixed++;
    }
  }
  if (fixed) stats.autoLit = fixed;
}

/* 永不可见立绘的揭示修复：成对模式是「预站位 alpha 0/dur 0 → 揭示
 * alpha 1/dur 0.2」（可同镜可隔镜），但 613 段剧本里有的角色只有
 * alpha 0 条目、揭示半拍在数据里缺失（如 22child_01_03 的安吉拉——
 * 台词连连却在台上隐身；隐身角色不需要 tween，所以这不是故意隐身）。
 * 重建：首条目同镜补揭示，后续 alpha 0 条目升为 1 并复亮（完好数据里
 * 明暗跟着说话节拍走：说话=亮、聆听=暗，丢失的条目一律按「亮」重建，
 * 免得重建角色在自己的台词里还压着阴影）。有揭示的轨迹一律不动。
 * 注意 imgTween 数组与解码件共享，改前必须克隆；先做条目替换再做
 * 插入，避免下标漂移。 */
function revealNeverVisibleCast(wire, stats) {
  const keys = Object.keys(wire);
  const traj = new Map();
  for (const k of keys) {
    const shot = wire[k];
    for (const im of (shot.images ?? [])) {
      if (im && im.imgType === 3 && im.imgPath && !im.delete && !traj.has(im.imgId)) {
        traj.set(im.imgId, {path: im.imgPath, refs: []});
      }
    }
    for (const [i, t] of (shot.imgTween ?? []).entries()) {
      const e = t && traj.get(t.imgId);
      if (e) e.refs.push({k, i, t});
    }
  }
  let fixed = 0;
  for (const e of traj.values()) {
    if (!e.refs.length || e.refs.some(({t}) => (t.alpha ?? 0) > 0)) continue;
    const edits = new Map();                    /* key → 克隆后的数组 */
    const clone = (k) => {
      if (!edits.has(k)) edits.set(k, [...wire[k].imgTween]);
      return edits.get(k);
    };
    e.refs.forEach(({k, i, t}, n) => {
      const arr = clone(k);
      if (n === 0) {
        arr.splice(i + 1, 0, {imgId: t.imgId, delay: 0, duration: 0.2,
          posId: t.posId, alpha: 1, isDark: false});
      } else {
        arr[i] = {...t, alpha: 1, isDark: false};
      }
    });
    for (const [k, arr] of edits) wire[k].imgTween = arr;
    fixed++;
  }
  if (fixed) stats.revealedCast = fixed;
}

/* 悬空立绘 tween 落名：收集 wire 里所有 tween 引用过的 imgId，凡 images[]
 * 从未声明、而全局表里有名字的，在首个可渲染镜补一条 imgType-3 声明
 * （注册先行，之后该角色的 tween 才会被引擎看见；alpha 0 起步，登场
 * 时机仍完全由原 tween 驱动）。键 0 是永不渲染的「开局之前」，跳过。
 *
 * 入场揭示缺失修补：完好剧本的入场对（预站位 → 揭示）是相邻镜（1→2、
 * 9→10）或同镜，但全表角色常丢揭示半拍（1year_prologue 薇洛儿：预站位
 * 在键 2、揭示拖到键 6——她键 4-5 的台词整段隐身）。若首个 alpha 1 与
 * 首条目相隔超过一镜，就在预站位后按揭示半拍补 {alpha 1, 亮}，后续
 * 原有条目照常接管明暗循环。 */
function materializeDanglingCast(wire, imgIds, stats) {
  if (!imgIds) return;
  const keys = Object.keys(wire);
  const declared = new Set();
  const tweened = [];
  for (const k of keys) {
    for (const im of (wire[k].images ?? [])) {
      if (im && im.imgPath && !im.delete) declared.add(im.imgId);
    }
    for (const t of (wire[k].imgTween ?? [])) {
      if (t && t.imgId !== undefined && !tweened.includes(t.imgId)) {
        tweened.push(t.imgId);
      }
    }
  }
  const cast = tweened
      .filter((id) => !declared.has(id) && imgIds[String(id)])
      .map((id) => ({imgId: id, imgType: 3, imgPath: imgIds[String(id)],
        alpha: 0}));
  if (!cast.length) return;
  const firstKey = keys.find((k) => k !== '0');
  if (firstKey === undefined) return;
  const first = wire[firstKey];
  first.images = [...(first.images ?? []), ...cast];
  stats.danglingCast = cast;

  for (const member of cast) {
    const refs = [];
    for (const k of keys) {
      const shot = wire[k];
      for (const [i, t] of (shot.imgTween ?? []).entries()) {
        if (t && t.imgId === member.imgId) refs.push({k, i, t});
      }
    }
    if (!refs.length) continue;
    const firstLit = refs.find(({t}) => (t.alpha ?? 0) > 0);
    if (firstLit && Number(firstLit.k) - Number(refs[0].k) <= 1) continue;

    /* 只补入场揭示半拍（预站位同镜，亮起）；其后的 alpha 0 条目是完好
       数据（退场/换位循环），一概不动。imgTween 与解码件共享，克隆后改。 */
    const {k, i, t} = refs[0];
    const arr = [...wire[k].imgTween];
    arr.splice(i + 1, 0, {imgId: t.imgId, delay: 0, duration: 0.2,
      posId: t.posId, alpha: 1, isDark: false});
    wire[k].imgTween = arr;
  }
}

/* 首张 bg 的隐现物化。游戏语义：images 声明的第一张 imgType-2 注册即
 * 可见（语料普查：九成剧本初见 bg 的 alpha 都是 0，且四成从不 tween 它
 * ——可见性是引擎隐行为，wiki 玩家只认 tween，直接播就是黑屏到底）。
 * 映射层在注册镜补一条 duration 0 的揭示 tween；若故事自己会在前 3 镜
 * 内揭示它（标准淡入开场），不插，保住原演出节奏。键序 = 数字升序
 * （整数键的遍历序），±shift 对距离无影响。 */
function materializeFirstBg(wire, stats) {
  let regKey = null;
  let regId = null;
  for (const k of Object.keys(wire)) {
    for (const im of (wire[k].images ?? [])) {
      if (im?.imgType === 2 && im.imgPath) {
        regKey = k;
        regId = im.imgId;
        break;
      }
    }
    if (regKey !== null) break;
  }
  if (regKey === null) return;
  let tweenKey = null;
  for (const k of Object.keys(wire)) {
    if ((wire[k].imgTween ?? []).some((t) => t?.imgId === regId)) {
      tweenKey = k;
      break;
    }
  }
  if (tweenKey !== null && Number(tweenKey) - Number(regKey) <= 2) return;
  const shot = wire[regKey];
  shot.imgTween = [
    {imgId: regId, delay: 0, duration: 0, alpha: 1, isDark: false},
    ...(shot.imgTween ?? []),
  ];
  stats.bgReveal = {key: regKey, imgId: regId};
}

function resolveStep(step, lang, id, stats, shift) {
  const out = {...step};
  if (shift && typeof out.nextId === 'number') out.nextId += shift;
  for (const field of ['content', 'speakerName', 'SkipScenario']) {
    if (out[field] !== undefined) {
      out[field] = resolveRef(out[field], lang, field, id, stats);
    }
  }
  if (out.branch !== undefined && out.branch !== null) {
    out.branch = resolveBranch(out, lang, id, stats, shift);
  }
  /* 少数剧本的 imgTween 是「imgId 为键 + 命名字段」的混合 Lua 表
     （heroFace 字段混进 tween 表，全语料 3 处），引擎要的是扁平数组——
     按数字键序展平，命名字段丢弃。 */
  for (const field of ['imgTween', 'images', 'heroFace']) {
    const v = out[field];
    if (v !== undefined && !Array.isArray(v)) {
      out[field] = Object.keys(v)
          .filter((k) => /^\d+$/.test(k))
          .sort((a, b) => Number(a) - Number(b))
          .map((k) => v[k]);
    }
  }
  return out;
}

function resolveRef(value, lang, field, id, stats) {
  if (typeof value !== 'number') return value;
  const text = lang[String(value)];
  if (typeof text === 'string') {
    stats.resolved++;
    return toRenderTags(text);
  }
  stats.unresolved.push({field, id, key: value});
  return value;                       /* 保数字可见，不静默吞 */
}

/* 游戏富文本 → 引擎 reformat 的**输出形态**。参考实现的标记正则
 * 「贪婪 .* 吃到最后一个 </>」会把同行多个 <color>/<a> 折叠进一个 span、
 * 无效节点整段丢弃——wiki 转写件绕开了它，游戏原始数据踩中它（镜 4
 * 丢半句）。预转换成 span 后正则不再命中，单标记行为等价、多标记
 * 不再丢内容；<b>/<cmdr>/<TA> 引擎原生支持保持原样。 */
const toRenderTags = (text) => text
    .replace(/<color=(#?\w+)>/gi, '<span style="color:$1">')
    .replace(/<size=(\d+)>/gi, '<span style="font-size:calc(($1/44)*1em)">')
    .replace(/<a href=Des:(\d+)>/gi, '<span data-ref="$1">')
    .replace(/<i>/gi, '<span style="font-style:italic">')
    .replace(/<\/(color|size|a|i)>/gi, '</span>');

function resolveBranch(out, lang, id, stats, shift) {
  const branch = out.branch;
  const shiftAct = (opt) => {
    if (shift && typeof opt?.jumpAct === 'number') opt = {...opt, jumpAct: opt.jumpAct + shift};
    return opt;
  };
  if (Array.isArray(branch)) {
    return branch.map((opt) => resolveOption(shiftAct(opt), lang, id, stats));
  }
  /* 对象形态：数字键 = 选项（按键序），其余键是旗标，挪到 shot 根。 */
  const numbered = [];
  for (const [key, opt] of Object.entries(branch)) {
    if (/^\d+$/.test(key)) numbered.push([Number(key), opt]);
    else out[key] = opt;
  }
  numbered.sort((a, b) => a[0] - b[0]);
  return numbered.map(([, opt]) => resolveOption(shiftAct(opt), lang, id, stats));
}

function resolveOption(opt, lang, id, stats) {
  return opt && typeof opt === 'object'
    ? {...opt, content: resolveRef(opt.content, lang, 'branch.content', id, stats)}
    : opt;
}

/* 引擎重放链（player.seekShot/playShot 的推进语义：branch[0] 优先于
 * nextId，缺省 +1），返回键序可达的全部镜。分支非首选目标不在链上，
 * 是 seekShot 语义下天然不可停留的孤儿。 */
export function replayChain(wire) {
  const chain = [];
  const seen = new Set();
  let s = 0;                             /* scriptType：开局之前 */
  for (let guard = Object.keys(wire).length + 2; guard--; ) {
    const shot = wire[String(s)];
    s = shot?.branch
      ? shot.branch[0]?.jumpAct ?? s + 1
      : (shot?.nextId ?? s + 1);
    if (s === null || s === undefined || seen.has(s)) break;
    if (!(String(s) in wire)) break;     /* 断档即终局（参考语义） */
    seen.add(s);
    chain.push(String(s));
  }
  return chain;
}
