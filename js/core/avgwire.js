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
 *    （旧 4.「悬空立绘 tween 落名」已于 2026-09-03 退役：修 lvm.js 的 SETLIST
 *     off-by-one 后全语料「tween 引用从未声明的 id」归零——原来说的「94% 剧本
 *     都有悬空 tween」正是那个 bug 把 images[] 末条吞掉后的画像。imgIds 表保留
 *     在索引里供编辑器查槽位，但映射层不再消费。）
 * 4. 说话者节拍补齐（autoLightCast，游戏契约下立绘可见度的唯一合成点）：
 *    原版行为是「说话镜 ⇒ 说话人现身」（实机逐镜核对 + 全语料量化坐实，
 *    见 plan「契约切换」D6），数据里的 α 条目只覆盖作者自己那部分调度。
 *    依 heroSprites 桥表——heroId → 她的立绘路径集（众数件 + 揭示跳变票
 *    归属件），在说话镜补揭示/复亮；桥表路径在这段从未注册时先按同角色
 *    换装件改宗（retargetHeroSprites），否则换装/周年剧本整条门哑火。
 *    判据是「隐身来路」：`α0 + duration>0` 是作者显式画外（修 lvm 后重算：
 *    全语料这类淡出 34820 条，按桥表口径落在本人说话镜 1017 条——桥表含同族
 *    变体，这是上界而非精确数），一概不碰；`α0 / duration:0` 预站位不阻止现身。
 *    不变量：**同族同镜最多一件 α>0**，除非作者本镜显式点亮多件——点亮
 *    一件的同时收掉只由本层点亮的兄弟件（换装退场），这是双件同屏
 *    （tools/audit-dual-lit.mjs）的防线。
 *    收场：补出来的揭示不能淌进下一场。本镜摆了预站位（舞台重排）就把
 *       **只由本修复点亮**的立绘淡出收掉（注册与 lane 都留着，后续揭示照常）。
 *       作者自己点亮的立绘不收到场外的判据还没找到——「重排」「换背景」
 *       「两者都」三种按「作者后面还提到它」严判误清率都在 23% 上下。
 *
 * voice={heroId,voiceId} 是 CV 引用（468 处），引擎 M7 尚无 voice 通道，
 * 原样透传；images/imgTween/heroFace/effect/audio/ppv 等与 wire 同形直接过。
 */
import {emptyState, applyImages, applyShotTweens} from './state.js';

/* 0 起始平移：引擎 map 格式的 shotId 从 scriptType=0 起步、键 0 是
 * 「开局之前」，永远渲染不到（语料 1555 段 0 起始：21 段纯视频 + 1534 段
 * 首镜在 0）。凡键 '0' 存在的剧本，全部键与 nextId/jumpAct 统一 +1；
 * 1 起始的 323 段原样不动。 */
export function storyToWire(cfg, lang, {heroSprites, pathOwner} = {}) {
  const stats = {resolved: 0, unresolved: [], shifted: false, bgReveal: null,
    autoLit: 0, entranceLit: 0, entranceExit: 0};
  const shift = '0' in cfg ? 1 : 0;
  stats.shifted = shift === 1;
  const wire = {};
  for (const [id, step] of Object.entries(cfg)) {
    wire[String(Number(id) + shift)] =
        resolveStep(step ?? {}, lang, id, stats, shift);
  }
  materializeFirstBg(wire, stats);
  const speakers = retargetHeroSprites(wire, heroSprites, pathOwner);
  autoLightCast(wire, speakers, stats);
  return {wire, stats};
}

/* 说话者桥表的剧本内改宗。heroSprites 给的是该角色的立绘路径**集**（字符串
 * 或按权威度降序的数组：众数件在前，语料投票出的换装/别名件在后），换装/周年
 * 剧本里她穿的可能是 persicaria_dress_avg —— 路径全对不上时，
 * autoLightCast 的「开口却隐身」补揭示整条门哑火
 * （1year_anniversary_persicaria 键 16：帕斯卡连说六句，人在台上却是 α0）。
 * 桥表路径在这段剧本从未注册时，认「同一角色的换装件 + 本段剧本点亮过 +
 * 不是别的角色的众数件」的立绘为她的替身，返回 hid → 路径集。
 * 同一角色 = 两个 imgPath 去掉 `_avg` 尾后，**一方按 `_` 切的词列是另一方的
 * 前缀**：换装件多出的词（persicaria → persicaria_dress）与剧本只留基础件
 * （evelyn_rookie → evelyn）都算；只是同命名属的不同角色不算
 * （fool_anna 与 fool_mie、burbank_npc1 与 burbank_npc3、undline_w1 与
 * undline_w2、sol 与 sold 首词列就在数字/词根上分家）。
 * 从未点亮的候选（换装备用件、整段没上台）不算替身，免得凭空立个幻影；
 * 一个候选都没有就不改（宁可不修，也不凭命名猜身份）。 */
const stemTokens = (path) => path.replace(/_avg\d*$/, '').split('_');

/* 一方词列是另一方的前导段（等长即同 stem，已被精确匹配吃掉）。 */
const sameCast = (a, b) => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true;
};
const charRoot = (p) => stemTokens(p).join('_').replace(/\d+$/, '');
/* 同一角色的两件：前缀同族，或者只差一个数字尾变体（olivia2_avg 之于
   olivia_avg —— 克罗琦的二代装、信的二号装都是这种编号换装件）。
   数字尾不能无条件并族：eos2_avg 属 hid 96/72、eos_avg 属 hid 99，mag2_avg
   属 1028、mag_avg 属 71/88，那是两个角色。所以只在 pathOwner 没有把两件
   判给不同人时才并。 */
const sameChar = (a, b, owner) => {
  if (sameCast(stemTokens(a), stemTokens(b))) return true;
  if (a === b || charRoot(a) !== charRoot(b)) return false;
  const oa = owner?.[a];
  const ob = owner?.[b];
  return !oa || !ob || oa === ob;
};

const asPaths = (v) => (Array.isArray(v) ? v.filter(Boolean) : (v ? [v] : []));

function retargetHeroSprites(wire, heroSprites, pathOwner) {
  const registered = new Set();
  const lit = new Set();
  const pathOf = new Map();
  for (const shot of Object.values(wire)) {
    for (const im of (shot.images ?? [])) {
      if (!im?.imgPath || im.delete) continue;
      pathOf.set(im.imgId, im.imgPath);
      if (im.imgType === 3) registered.add(im.imgPath);
    }
    for (const t of (shot.imgTween ?? [])) {
      const p = t && pathOf.get(t.imgId);
      if (p && (t.alpha ?? 0) > 0) lit.add(p);
    }
  }
  /* 别的角色的件不能当替身：认领过的路径一律排除。 */
  const entries = Object.entries(heroSprites ?? {}).map(([h, v]) => [h, asPaths(v)]);
  const claimed = new Set(entries.flatMap(([, ps]) => ps));
  const out = new Map();
  for (const [hid, bases] of entries) {
    const want = [...bases];
    for (const base of bases) {
      if (registered.has(base)) continue;
      for (const p of registered) {
        if (!lit.has(p) || claimed.has(p)) continue;
        if (sameChar(base, p, pathOwner) && !want.includes(p)) want.push(p);
      }
    }
    /* 选件优先级要认身份：桥表是召回口径，可能 admit 到她说话时同台路人的件；
       按「她的主件 > 同族换装件 > 其他」排，才不会出现「为她的台词点亮别人」。 */
    const primary = want[0];
    out.set(String(hid), {
      set: new Set(want),
      rank: (p) => (p === primary ? 0 : primary && sameChar(primary, p, pathOwner) ? 1 : 2),
    });
  }
  return out;
}

/* 说话者节拍补齐（两路）：fold 引擎同款状态（state.js 的纯 reducer），在每个
 * speakerHeroId 命中桥表的镜检查其立绘 lane——
 * - 可见却压暗 = 丢了「复亮」半拍，补 {alpha 1, 亮}；
 * - 不可见且隐身来自「预站位」= 丢了入场「揭示」整拍，同样在本镜补揭示。
 * 预站位 = alpha 0 且 duration 0 的条目（或 images[] 按 alpha 0 注册），
 * 它只是把立绘摆到槽位上等揭示；duration>0 的 alpha 0 是真淡出退场。
 * 只召回前者：后者是作者的镜头调度（反打/画外音），一概不碰。
 * speakers 是 retargetHeroSprites 解析出的 hid → 本段剧本认得的立绘路径集。
 * 补完同步进模拟状态（后续镜的判定基于修正后的世界线）。 */
function autoLightCast(wire, speakers, stats) {
  if (!speakers) return;
  const state = emptyState();
  const pathOf = new Map();
  /* imgId → 最后一次注册它的镜序：换装段里同角色多件在台时用来选「当前那件」 */
  const lastReg = new Map();
  /* 只由本修复点亮的立绘集合：换景时由本修复负责收场（作者点亮的不动）。 */
  const ours = new Set();
  let fixed = 0;
  let entrance = 0;
  let exit = 0;
  for (const k of Object.keys(wire)) {
    const shot = wire[k];
    if (shot.images?.length) {
      applyImages(state, shot.images);
      for (const im of shot.images) {
        if (im.imgPath && !im.delete) {
          pathOf.set(im.imgId, im.imgPath);
          if (im.imgType === 3) lastReg.set(im.imgId, Number(k));
        } else if (im.delete) {
          pathOf.delete(im.imgId);
          lastReg.delete(im.imgId);
        }
      }
    }
    const want = shot.speakerHeroId !== undefined && shot.speakerHeroId !== null
      ? speakers.get(String(shot.speakerHeroId)) : null;
    applyShotTweens(state, shot);
    let pre = false;
    for (const t of (shot.imgTween ?? [])) {
      if (!t || t.alpha === undefined) continue;   /* 缺省 alpha 不改可见度 */
      if (t.alpha === 0 && !t.duration) pre = true;   /* 本镜摆了预站位 = 重排 */
    }
    /* 换景收场：补出来的揭示不能淌进下一场。本镜摆了预站位（舞台重排）就把
     * 只由本修复点亮的立绘淡出收掉——它本来就没被作者揭示过，收它不会跟原稿
     * 对着干。作者自己点亮的立绘**不收**：试过「重排」「换背景」「两者都」三种
     * 判据，按「作者后面还提到它」严判的误清率分别是 1846/7197、281/1070、
     * 80/351（≈23%），比它补的洞更难看，这种数据缺口留给编辑器人工补。 */
    if (pre) {
      for (const id of ours) {
        const lane = state.lanes.get(id);
        if (!lane || (lane.alpha ?? 0) <= 0) { ours.delete(id); continue; }
        if (want && want.set.has(pathOf.get(id))) continue;   /* 本镜说话者，留着 */
        if ((shot.imgTween ?? []).some((t) => t && t.imgId === id)) continue;
        shot.imgTween = [...(shot.imgTween ?? []),
          {imgId: id, delay: 0, duration: 0.2, alpha: 0, isDark: false}];
        lane.alpha = 0;
        ours.delete(id);
        exit++;
      }
    }
    if (!want) continue;
    /* —— 唯一的合成点亮点（三层已合一，见 plan「契约切换」D6）——
       原版行为（实机 + 全语料坐实）：说话镜 ⇒ 说话人的立绘现身；
       `α0 + duration>0` 才是作者显式画外（重算口径见文件头第 4 条）；
       `α0 / duration:0` 预站位不阻止现身（22child_03 键6 就是预站位同镜现身）。
       不变量：**同族（说话者的变体集）同镜最多一件 α>0**，除非作者本镜显式点亮多件。 */
    const entries = shot.imgTween ?? [];
    const outThisShot = new Set(entries
        .filter((t) => t && t.alpha === 0 && (t.duration ?? 0) > 0).map((t) => t.imgId));
    const cand = [];
    for (const [imgId, lane] of state.lanes) {
      const path = pathOf.get(imgId);
      if (!want.set.has(path)) continue;                 /* 不是说话者的立绘 */
      let last = -1;
      entries.forEach((t, i) => { if (t?.imgId === imgId) last = i; });
      cand.push({imgId, lane, path, rank: want.rank(path),
        last, reg: lastReg.get(imgId) ?? -1,
        lit: (lane.alpha ?? 0) > 0,
        authorLit: entries.some((t) => t && t.imgId === imgId && (t.alpha ?? 0) > 0)});
    }
    if (!cand.length) continue;
    /* 本层只动她自己的件：主件（rank 0）与同族换装件（rank 1）。桥表是召回
       口径，rank 2 是「她说话时同台的路人」——点亮它就是凭空立一个幻影，
       连复亮都不许（聆听压暗是原版的镜头语言，不是要修的洞）。
       选件序：作者本镜显式点亮的那件（换装新件）> 已在台上亮着的 > 预站位补揭示。 */
    cand.sort((x, y) => (x.rank - y.rank) || (y.last - x.last)
        || (y.reg - x.reg) || (x.imgId - y.imgId));
    const own = cand.filter((c) => c.rank <= 1
        && !outThisShot.has(c.imgId));                  /* 作者本镜淡出她的 = 画外音 */
    const litOwn = own.filter((c) => c.lit);
    const authorOwn = litOwn.filter((c) => c.authorLit);
    if (authorOwn.length > 1) continue;                 /* 作者本镜就要她的两件同屏 */
    const pick = authorOwn[0] ?? litOwn[0] ?? own[0];
    if (!pick) continue;
    const {imgId, lane} = pick;
    const added = [];
    if (pick.lit) {
      if (lane.isDark === false) continue;               /* 已在台上且亮着，不动数据 */
      fixed++;
    } else {
      entrance++;
      lane.alpha = 1;
      ours.add(imgId);
    }
    added.push({imgId, delay: 0, duration: 0.2, alpha: 1, isDark: false});
    /* 点亮这一件的同时，收掉同族里只由本层点亮过的兄弟件（换装退场）。
       作者本镜显式点亮的不许动——同屏两尊是合法调度。 */
    for (const other of cand) {
      if (other.imgId === imgId || !other.lit) continue;
      if (other.authorLit || !ours.has(other.imgId)) continue;
      added.push({imgId: other.imgId, delay: 0, duration: 0.2, alpha: 0, isDark: false});
      other.lane.alpha = 0;
      ours.delete(other.imgId);
      exit++;
    }
    shot.imgTween = [...entries, ...added];
    lane.isDark = false;
  }
  stats.autoLit = fixed;
  stats.entranceLit = entrance;
  stats.entranceExit = exit;
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
  /* 23sg 手机聊天的收信人/消息体也是 Lang 数字键（游戏侧
     UISteinsGateAvg 走 GetAvgLanguage(receiver/contentMsg)，46 处引用）。 */
  if (out.sgMobile?.sendMsg && typeof out.sgMobile.sendMsg === 'object') {
    const msg = out.sgMobile.sendMsg;
    out.sgMobile = {...out.sgMobile, sendMsg: {
      receiver: resolveRef(msg.receiver, lang, 'sgMobile.receiver', id, stats),
      contentMsg: resolveRef(msg.contentMsg, lang, 'sgMobile.contentMsg', id, stats),
    }};
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
