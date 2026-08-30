/* avgwire.js —— AvgCfg/AvgLang 解码件 → 引擎 wire（map 格式）的唯一映射入口。
 *
 * 引擎的 normalizeScript 原生吃「原始游戏导出」的 map 格式（键 = 步骤 ID，
 * nextId = 键名，scene2 夹具自带断档键），字段词汇与游戏脚本同名同形
 * （wiki 格式本就是游戏脚本的转写），所以映射只做两类事：
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
 *
 * voice={heroId,voiceId} 是 CV 引用（468 处），引擎 M7 尚无 voice 通道，
 * 原样透传；images/imgTween/heroFace/effect/audio/ppv 等与 wire 同形直接过。
 */

/* 0 起始平移：引擎 map 格式的 shotId 从 scriptType=0 起步、键 0 是
 * 「开局之前」，永远渲染不到（语料 1555 段 0 起始：21 段纯视频 + 1534 段
 * 首镜在 0）。凡键 '0' 存在的剧本，全部键与 nextId/jumpAct 统一 +1；
 * 1 起始的 323 段原样不动。 */
export function storyToWire(cfg, lang) {
  const stats = {resolved: 0, unresolved: [], shifted: false, bgReveal: null};
  const shift = '0' in cfg ? 1 : 0;
  stats.shifted = shift === 1;
  const wire = {};
  for (const [id, step] of Object.entries(cfg)) {
    wire[String(Number(id) + shift)] =
        resolveStep(step ?? {}, lang, id, stats, shift);
  }
  materializeFirstBg(wire, stats);
  return {wire, stats};
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
