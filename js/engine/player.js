import {dashToCamel} from '../ui/dom.js';
import {Scheduler} from '../core/scheduler.js';
import {
  emptyState, applyImages, applyShotTweens, applyFaces, isValidPos,
  isValidPosVec,
} from '../core/state.js';
import {formatPages, DEFAULT_VARS, hops} from '../core/markup.js';
import {Typewriter} from './typewriter.js';
import {createPandect} from './nouns.js';
import {
  CANVAS, buildCharaRules, faceRegion, compositeBody, drawFace, buildChara,
  baseTranslate,
} from './sprite.js';

/* 舞台骨架：逐字符照抄参考的 Template:剧情播放器。
   样式全部靠 id 选中，所以这里必须是可比对的字符串常量，而不是 h() 组装树
   （tools/test-skeleton.mjs 会拿它和参考抓取件比结构、并校验 CSS 引用的 id 都在）。
   唯一新增是初始 class="empty"：参考 clearStage() 也会把 className 置回 'empty'。
   字符串是仓库内常量、不含外部输入，故 innerHTML 装载无注入风险。 */
const SKELETON_HTML = `
  <div id="avg-container">
    <div id="height-tester"></div>
    <div id="avg-stage">
      <div id="avg-bg">
        <div id="avg-bg-overlay"></div>
      </div>
      <div id="avg-charas"></div>
      <div id="avg-dialog"><span id="avg-speaker"></span><span id="avg-line"></span></div>
      <div id="avg-choices"></div>
    </div>
    <div id="avg-controls">
      <div id="avg-control-log"></div>
      <div id="avg-control-hide-ui"></div>
      <div id="avg-control-dict"></div>
      <div id="avg-control-auto">自动</div>
      <div id="avg-control-skip">跳过</div>
    </div>
    <div id="avg-overlay">
      <div id="avg-log">
        <div id="avg-log-box"></div>
      </div>
      <div id="avg-pandect">
        <ul id="avg-des-type"></ul>
        <ul id="avg-des-entries"></ul>
        <div id="avg-des">
          <div id="avg-des-return">〈〈</div>
          <div id="avg-des-dt"></div>
          <div id="avg-des-dd"></div>
          <div id="avg-des-expand">展开阅读</div>
        </div>
      </div>
      <div id="avg-skip">
        <div id="avg-skip-dialog">
          <div id="avg-location">
            <div id="avg-sector-en"></div>
            <div id="avg-sector-location"></div>
          </div>
          <div id="avg-skip-title"></div>
          <div id="avg-scene-brief"></div>
          <div id="avg-skip-buttons">
            <div id="avg-skip-cancel">取消</div>
            <div id="avg-skip-confirm">确认</div>
          </div>
        </div>
      </div>
    </div>
  </div>`;

export function buildSkeleton() {
  const host = document.createElement('div');
  host.innerHTML = SKELETON_HTML;
  const container = host.firstElementChild;
  container.className = 'empty';
  const refs = {};
  for (const el of container.querySelectorAll('[id]')) {
    refs[dashToCamel(el.id)] = el;
  }
  refs.avgContainer = container;
  return {container, refs};
}

export const STAGE_WIDTH = 1200;
export const STAGE_HEIGHT = 540;

/* 适配策略。实测参考页面 getComputedStyle(#avg-container) = 893.5×540
   （父容器 .mw-parser-output 宽 894），也就是 width:1200px + max-width:100%
   + height:540px 的"压窄宽度、高度不动"，参考并不做等比缩放。
   - 'clamp'：不加任何 transform，完全交给 CSS —— 与 wiki 逐像素同源，是默认档。
   - 'scale' ：外层 transform:scale(k) 等比缩放，编辑器窄栏里想看 1200 设计稿时用。
   - 'none'  ：钉死 1200×540，既不压也不缩，供像素比对截图。
   font-size 恒为 16px（参考靠运行时改写它来缩放，我们不这么做），
   所以 scale 档下所有 em 仍等于逻辑像素，注入的立绘规则无需随 resize 重算。 */
export function buildStage(mount, {mode = 'clamp'} = {}) {
  const {container, refs} = buildSkeleton();
  let wrapper = null;
  if (mode !== 'clamp') {
    wrapper = document.createElement('div');
    wrapper.className = `avg-fit avg-fit-${mode}`;
    wrapper.append(container);
    mount.replaceChildren(wrapper);
  } else {
    mount.replaceChildren(container);
  }
  const instance = {container, refs, wrapper, mount, mode};

  instance.setScale = (k) => {
    if (!wrapper) return;
    container.style.transform = `scale(${k})`;
    container.style.transformOrigin = 'top left';
    wrapper.style.width = `${STAGE_WIDTH * k}px`;
    wrapper.style.height = `${STAGE_HEIGHT * k}px`;
  };

  /* clamp 档恒返回 1：没有 transform，"缩放比"这个概念不适用。 */
  instance.fitToContainer = () => {
    if (!wrapper || mode !== 'scale') return 1;
    const avail = mount.clientWidth || STAGE_WIDTH;
    const k = Math.min(1, avail / STAGE_WIDTH);
    instance.setScale(k);
    return k;
  };

  return instance;
}

export function resetStage({container, refs}) {
  container.className = 'empty';
  refs.avgStage.className = '';
  refs.avgDialog.className = '';
  refs.avgChoices.className = '';
  refs.avgBgOverlay.className = '';
  refs.avgControlAuto.className = '';
  refs.avgOverlay.className = '';
  refs.avgPandect.className = '';
  refs.avgCharas.replaceChildren();
  refs.avgSpeaker.replaceChildren();
  refs.avgLine.replaceChildren();
  refs.avgChoices.replaceChildren();
  refs.avgLogBox.replaceChildren();
  refs.avgSceneBrief.replaceChildren();
  Object.assign(refs.avgBg.style, {
    backgroundImage: null, transition: null, opacity: null,
    backgroundSize: null, backgroundPositionX: null, backgroundPositionY: null,
  });
  refs.avgDialog.style.minHeight = null;
  refs.avgLine.style.minHeight = null;
  return refs;
}

/* 播放器：参考 AvgPlayer.js 控制流的逐位移植，但所有时序走可注入的
   Scheduler（真实播放 = REAL_TIMER；回归测试 = 虚拟时钟），所有状态折叠走
   state.js 的纯 reducer（M5 seek 时从 emptyState 重放）。
   与参考的两处刻意偏离：
   - setScene 先把 content 格式化进**副本**（参考原地改写 wire，编辑器不能接受）；
   - loadImages 的删除直接落 DOM（参考推迟到 Promise.all，settled 态等价）。
   其余（推进算术、compose 链、明暗累积翻转、打字不等待、行尾收尾）逐位一致。 */
export class Player {
  constructor({
    mount,
    mode = 'clamp',
    timer,
    filePathOf = (path) => path,
    layoutOf = async () => ({}),
    getName = () => DEFAULT_VARS.name,
    getGender = () => DEFAULT_VARS.gender,
    characters = {},
    nouns = null,
    audio = null,
    canvasSize = CANVAS,      // M11：低端设备可降到 512（数学与分辨率无关）
    logClickCloses = false,   // 宿主偏离项：log 面板任意点击收起（编辑器开）
  } = {}) {
    Object.assign(this, buildStage(mount, {mode}));
    this.sched = new Scheduler(timer);
    this.audio = audio;
    this.logClickCloses = logClickCloses;
    this.canvasSize = canvasSize;
    this.filePathOf = filePathOf;
    this.layoutOf = layoutOf;
    this.getName = getName;
    this.getGender = getGender;
    this.characters = characters;
    /* 参考的 NounDes.js 在页面加载时 initialize()；这里按实例接入
       （编辑器多舞台互不串台，词典数据由宿主注入）。 */
    this.pandect = nouns ? createPandect({refs: this.refs, nouns}) : null;

    /* 参考的 <style id="chara-img-styles">：规则表由布局集重建（可复现），
       而不是参考的只增不删拼接（那张表会随重复加载翻倍，见冻结结论 B10）。 */
    this.styles = document.createElement('style');
    (mount.ownerDocument || document).head.append(this.styles);

    this.state = emptyState();
    this.layouts = new Map();
    this.defaultFaces = new Map();
    this.pendingLoads = new Set();
    /* compose 链（playShot 的重载→manageImg→speak）单独登记：链内部会
       await 串行门的 sched.promise，虚拟钟不推进就不落定 —— 绝不能混进
       pendingLoads（idle() 会被它吊死）；fastForward 的收敛判据才看它。 */
    this.pendingChains = new Set();
    this.typewriter = null;

    this.scene = undefined;
    this.scriptType = undefined;
    this.shotId = undefined;
    this.lineNum = 0;
    this.shotEnd = true;
    this.playEnd = true;
    this.readingLine = false;
    /* 参考的自动播放三全局（autoPlaying/toAutoPlay/autoPlayTimeout）：
       挂起的推进定时器走 sched.after，句柄只用于手动取消（epoch 换页兜杀）。 */
    this.autoPlaying = false;
    this.toAutoPlay = false;
    this.autoPlayHandle = null;

    this.container.addEventListener('click', (e) => this.click(e.target));
    this.refs.avgControls.addEventListener('click', (e) => this.controlClick(e));
  }

  /* —— 场景装载（参考 setScene:70）—— */

  setScene(scene, title, number, sector, sectorEn) {
    this.clearStage();
    /* 原始剧本与标题元数据留在实例上（clearStage 不清）：seekShot 靠它
       重开同一场景，编辑器改稿后重调 setScene 即可刷新。 */
    this.rawScene = scene;
    this.sceneMeta = {title, number, sector, sectorEn};
    const vars = {name: this.getName(), gender: this.getGender()};
    const copy = Array.isArray(scene) ? [] : {};
    for (const id of Object.keys(scene)) {
      const shot = scene[id];
      copy[id] = shot.content
          ? {...shot, content: formatPages(shot.content, vars)}
          : shot;
    }
    this.scene = copy;
    /* 全场立绘预热：tween 揭示的瞬间就得把图画上画布，冷缓存下
       2048px 的解码会让登场肉眼可见地迟到（游戏侧是流式预载的）。
       旁路加载不进 pendingLoads——不影响 idle/fastForward 的收敛判据。 */
    for (const shot of Object.values(copy)) {
      for (const im of (shot.images ?? [])) {
        if (im.imgType === 3 && im.imgPath && !im.delete) {
          const warm = new Image();
          warm.src = this.filePathOf('Lpic_' + im.imgPath + '.png');
        }
      }
    }
    this.scriptType = Array.isArray(scene) ? -1 : 0;
    this.shotId = this.scriptType;
    /* 预载回退链：本镜 images → 下一镜 → nextId 镜（参考同序）。 */
    const first = copy[this.scriptType + 1];
    const preload = first.images
        ?? copy[this.scriptType + 2]?.images
        ?? (first.nextId ? copy[first.nextId]?.images : undefined);
    if (preload) this._track(this.loadImages(preload));
    this.refs.avgSkipTitle.textContent = title;
    this.refs.avgSectorEn.textContent = sectorEn || '';
    const location = [];
    if (sector) location.push(sector);
    if (number) location.push('#PART.' + number);
    this.refs.avgSectorLocation.textContent = location.join(' ');
    this.refs.avgSceneBrief.textContent = first.SkipScenario || '';
    this.playEnd = false;
    this.container.classList.remove('empty');
  }

  /* —— 图片注册（参考 loadImages:112 的数据层 + 立绘规则/重合成）—— */

  async loadImages(images) {
    const epoch = this.sched.epoch;
    const {touched, deletions} = applyImages(this.state, images);
    for (const imgId of deletions) {
      this._charaEl(imgId)?.remove();
      this.defaultFaces.delete(imgId);
    }
    for (const {img, reenter} of touched) {
      if (img.imgType !== 3) continue;
      /* 缺素材不致命（M11）补上 layout 侧：单张立绘取不到布局（lpic 404 /
         标定件缺席，语料里成批剧本踩中）只降级为无规则占位（_degradeChara），
         不许 rejection 顺 loadImages → idle()/compose 链把整镜的背景、
         对白和其余立绘全部带走。 */
      let config;
      try {
        config = await this.layoutOf(img);
      } catch {
        continue;
      }
      /* seek 的 bump 会整场重来：跨过 await 后 epoch 已换就立刻收手，
         不把旧场景的 layout/画布写进新回合。 */
      if (epoch !== this.sched.epoch || !this.scene) return;
      this.layouts.set(img.imgId, config);
      this._refreshRules();
      if (reenter) {
        const chara = this._charaEl(img.imgId);
        if (!chara) continue;
        chara.firstElementChild.getContext('2d')
            .clearRect(0, 0, this.canvasSize, this.canvasSize);
        this.defaultFaces.delete(img.imgId);
        await this._paintLpic(chara, img, config);
        if (epoch !== this.sched.epoch) return;
      }
    }
  }

  _refreshRules() {
    const fontSize = parseFloat(getComputedStyle(this.container).fontSize);
    this.styles.textContent = buildCharaRules(
        [...this.layouts].map(([imgId, config]) => ({imgId, config})),
        {width: this.container.clientWidth,
         height: this.container.clientHeight, fontSize});
  }

  /* lpic 装载 + 合成 + 默认脸捕获（参考的 onload 分支；2048→CANVAS 等价）。 */
  _paintLpic(chara, img, config, {faceId} = {}) {
    const context = chara.firstElementChild.getContext('2d');
    const region = config && faceRegion(config, CANVAS);
    const born = this.sched.epoch;
    const load = new Promise((resolve) => {
      const charaImg = new Image();
      charaImg.onload = () => {
        /* 图片解码是真实异步：seek 重开后旧 onload 不得再写共享状态。 */
        if (born !== this.sched.epoch) return resolve();
        /* 有图无 layout：尺寸/站位规则整表缺席，合成数学无从谈起，
           同样按缺素材占位（语料里 lpic 与 layout 可各自缺席）。 */
        if (!config) {
          this._degradeChara(chara, config);
          return resolve();
        }
        if (img.comm && chara.children.length === 1) {
          chara.append(document.createElement('div'));
        }
        compositeBody(context, charaImg, config,
                      {comm: !!img.comm, canvasSize: this.canvasSize});
        if (!this.defaultFaces.has(img.imgId) && region) {
          const arg = region.slice(0, 2).map(Math.floor)
              .concat(region.slice(2).map(Math.ceil));
          this.defaultFaces.set(img.imgId, context.getImageData(...arg));
        }
        if (faceId !== undefined && region) {
          this._track(this._drawFace(chara, img, faceId, region));
        }
        resolve();
      };
      charaImg.onerror = () => {
        /* M11：缺素材不致命——虚线占位 + 继续播（css/ux.css）。 */
        this._degradeChara(chara, config);
        resolve();
      };
      charaImg.src = this.filePathOf('Lpic_' + img.imgPath + '.png');
    });
    return this._track(load);
  }

  /* 缺素材占位（css/ux.css）。config 也缺席时连尺寸/站位规则都没有，
     盒子会塌成 0 宽缩在左上角——inline 给个居中默认盒；有规则时绝不写
     inline，保住「占位站在原立绘位置」的 M11 观感（规则表特异性更高，
     但同特异性时靠源序取胜，不能赌）。 */
  _degradeChara(chara, config) {
    chara.classList.add('img-missing');
    if (!config) {
      Object.assign(chara.style, {
        bottom: '2em', left: '50%', width: '6em', height: '12em',
        transform: 'translateX(-50%)',
      });
    }
  }

  _drawFace(chara, img, faceId, region) {
    const context = chara.firstElementChild.getContext('2d');
    return drawFace(context, this.layouts.get(img.imgId), faceId, region, {
      filePathOf: (fid) => this.filePathOf(
          `Icon_face_${img.imgPath.replace(/_avg$/, '')}_${fid}.png`),
      defaultFace: this.defaultFaces.get(img.imgId),
    });
  }

  /* —— 镜头动画（参考 manageImg:714 / tween:677）—— */

  async _manageImg() {
    const shot = this.scene[this.shotId];
    const imgTween = shot.imgTween;
    const heroFace = shot.heroFace;
    if (!(imgTween || heroFace)) return;
    applyFaces(this.state, shot);
    if (!imgTween) {
      for (const face of heroFace) {
        const chara = this._charaEl(face.imgId);
        const region = chara
            && faceRegion(this.layouts.get(face.imgId), this.canvasSize);
        if (region) {
          this._track(this._drawFace(
              chara, this.state.imgMap.get(face.imgId), face.faceId, region));
        }
      }
      return;
    }
    const {events, lastEnding} = applyShotTweens(this.state, shot);
    for (const event of events) {
      const faceId = heroFace?.find((f) => f.imgId == event.imgId)?.faceId;
      if (event.imgType === 2) {
        for (const entry of event.entries) this._tweakBg(event.imgId, entry);
      } else {
        this._tweenChara(event.imgId, event.entries, faceId, event.entering);
      }
    }
    /* 串行门（R8）：打字要等最晚的 delay+duration 跑完才开始。 */
    await this.sched.promise(lastEnding * 1000);
  }

  _tweakBg(imgId, entry) {
    this.sched.after((entry.delay || 0) * 1000, () => {
      const img = this.state.imgMap.get(imgId);
      const bg = this.refs.avgBg;
      bg.style.backgroundImage =
          'url(' + this.filePathOf(img.imgPath.split('/')[1] + '.png') + ')';
      bg.style.transition = `opacity ${entry.duration}s`;
      if (entry.alpha !== undefined) bg.style.opacity = entry.alpha;
      const overlay = this.refs.avgBgOverlay;
      if (overlay.classList.contains('dark') != entry.isDark) {
        overlay.style.transition = `background ${entry.duration}s`;
        overlay.classList.toggle('dark');
      }
    });
  }

  _tweenChara(imgId, entries, faceId, entering) {
    const config = this.layouts.get(imgId);
    const img = this.state.imgMap.get(imgId);
    let chara = this._charaEl(imgId);
    if (chara) {
      const region = config && faceRegion(config, this.canvasSize);
      if (faceId !== undefined && region) {
        this._track(this._drawFace(chara, img, faceId, region));
      }
      if (!img.comm) chara.children[1]?.remove();
    } else {
      chara = buildChara(imgId, this.canvasSize);
      this._paintLpic(chara, img, config, {faceId});
    }
    let enter = entering;
    for (const entry of entries) {
      this._blockChara(entry, imgId, chara, enter);
      if (enter) enter = false;
    }
  }

  _blockChara(entry, imgId, chara, entering) {
    this.sched.after((entry.delay || 0) * 1000, () => {
      const duration = entry.duration;
      let posId = entry.posId;
      /* pos/scale 扩展演出（参考不实现、语料 421+734 条）：绝对坐标与
         缩放入行内样式。普通条目完全不碰这些属性，夹具字节不变。 */
      const hasPos = isValidPosVec(entry.pos);
      const hasScale = isValidPosVec(entry.scale);
      const backToSlot = isValidPos(entry.posId)
          && !chara.classList.contains('img-missing');  /* 占位盒的行内居中不清 */
      /* alpha 缺省 = 保持：不写 opacity（CSSOM 忽略 undefined 会碰巧继承，
         这里改成显式不写，语义与 reducer 的继承口径一致）。入场没有
         现值可继承，按新 lane 的初始 0 显式钉住。 */
      const style = {
        /* 带 pos/scale 的条目多出 bottom/transform 过渡轴，移动/缩放才动画。 */
        transition: (hasPos || hasScale)
            ? `opacity ${duration}s, left ${duration}s, bottom ${duration}s,`
                + ` transform ${duration}s, filter ${duration}s`
            : `opacity ${duration}s, left ${duration}s, filter ${duration}s`,
      };
      if (entry.alpha !== undefined) style.opacity = entry.alpha;
      else if (entering) style.opacity = 0;
      if (hasPos) {
        /* 与 AvgHeroN 槽位同一坐标空间：÷32 得 em；行内覆盖 posN 规则。 */
        style.left = entry.pos[0] / 32 + 'em';
        style.bottom = entry.pos[1] / 32 + 'em';
      } else if (backToSlot && chara.style.left) {
        style.left = null;      /* 回槽：定位交还 posN 规则 */
        style.bottom = null;
      }
      if (hasScale) {
        const config = this.layouts.get(imgId);
        if (config) {   /* 缺标定件走占位，缩放数学无依据，跳过 */
          const fontSize = parseFloat(getComputedStyle(this.container).fontSize);
          const t = baseTranslate(config, {width: this.container.clientWidth,
            height: this.container.clientHeight, fontSize});
          style.transform = `translate(${t.x}em, ${t.y}em)`
              + ` scale(${entry.scale[0]}, ${entry.scale[1]})`;
        }
      } else if (backToSlot && chara.style.transform) {
        style.transform = null;   /* 恢复类规则的基础位移 */
      }
      Object.assign(chara.style, style);
      if (entering) {
        if (posId === undefined) posId = this.state.imgMap.get(imgId)?.posId;
        /* 与 state.js 的 lane 折叠同口径：无有效槽位落居中，不产
           posundefined（语料的悬空入场/编辑器空选都会走到这里）。 */
        if (!isValidPos(posId)) posId = 3;
        chara.classList.add('pos' + posId);
        chara.dataset.posId = posId;
      } else if (isValidPos(posId) && chara.dataset.posId != posId) {
        chara.classList.replace('pos' + chara.dataset.posId, 'pos' + posId);
        chara.dataset.posId = posId;
      }
      if (entry.isDark != chara.classList.contains('dark')) {
        chara.classList.toggle('dark');
      }
      if (entering) this.refs.avgCharas.append(chara);
    });
  }

  /* —— 对话框与打字（参考 manageContentType:752 / presetDialogHeight:768 / speak:780）—— */

  _manageContentType() {
    const {avgDialog, avgLine} = this.refs;
    avgDialog.style.minHeight = null;
    avgLine.style.minHeight = null;
    const shot = this.scene[this.shotId];
    if (shot.contentType == 3) {
      avgDialog.className = 'pos' + (shot.speakerHeroPosId || 2);
    } else if (shot.contentType == 5) {
      avgDialog.className = 'type5 fade-in';
      this.sched.after(200, () => avgDialog.classList.remove('fade-in'));
    } else {
      avgDialog.className = 'type' + shot.contentType;
    }
  }

  _presetDialogHeight(content, type) {
    const {heightTester, avgDialog, avgLine, avgSpeaker} = this.refs;
    let target = avgDialog;
    if (type == 1) {
      heightTester.className = 'type1';
      target = avgLine;
    }
    /* content 以数组进模板串——逗号连接是参考既有行为，照抄。 */
    heightTester.innerHTML =
        (type == 1 ? '' : avgSpeaker.textContent + '\uff1a') + content;
    target.style.minHeight = heightTester.clientHeight + 'px';
    heightTester.className = '';
  }

  _speak() {
    const shot = this.scene[this.shotId];
    if (shot.speakerName == 'bravo') {
      this.refs.avgSpeaker.textContent = this.getName();
    } else {
      this.refs.avgSpeaker.innerHTML =
          shot.speakerName || this.characters[shot.speakerHeroId] || '';
    }
    if (shot.contentType == 1 || shot.contentType == 3) {
      this._presetDialogHeight(shot.content, shot.contentType);
    }
    if (shot.content) {
      this.readingLine = true;
      if (shot.scrambleTypeWriter) {
        this.refs.heightTester.innerHTML = shot.content[this.lineNum];
      }
      this._typeLine();
    } else {
      this.shotEnd = true;
    }
  }

  _typeLine() {
    const shot = this.scene[this.shotId];
    this.typewriter = new Typewriter({
      line: this.refs.avgLine,
      wait: () => this.sched.promise(50),
      /* scramble 的乱码尾巴长度参照整页（参考读 heightTester.innerHTML.length）。 */
      measureLen: () => this.refs.heightTester.innerHTML.length,
      onEnd: () => this._lineFinished(),
    });
    this.typewriter.start(
        shot.content[this.lineNum], {scramble: !!shot.scrambleTypeWriter});
  }

  _lineFinished() {
    if (this.refs.avgDialog.classList.contains('type5')) {
      this.sched.after(500, () => this.refs.avgDialog.classList.add('fade-out'));
    }
    this.shotEnd = true;
    this.readingLine = false;
    /* 参考 readLine/typeWriteScrambled 的行尾：自动播放每 2s 续一帧。 */
    if (this.autoPlaying && !this.playEnd) {
      this.toAutoPlay = true;
      this.autoPlayHandle = this.sched.after(2000, () => this._prepareAutoPlay());
    }
  }

  /* —— 推进（参考 playShot:802）—— */

  playShot(jumpAct) {
    if (this.playEnd) return this.clearStage();
    let shot = this.scene[this.shotId];
    if (jumpAct) {
      this.shotId = jumpAct + this.scriptType;
      this.refs.avgChoices.className = '';
      this.sched.after(5, () => {
        this.refs.avgStage.classList.remove('choice');
        this.refs.avgChoices.replaceChildren();
      });
    } else if (!shot || !shot.content ||
               this.lineNum === shot.content.length - 1) {
      this.shotId = (shot?.nextId)
          ? shot.nextId + this.scriptType : this.shotId + 1;
      this.lineNum = 0;
    } else {
      this.lineNum++;
    }
    shot = this.scene[this.shotId];
    if (shot.isEnd || !(shot?.nextId || this.scene[this.shotId + 1])) {
      this.playEnd = true;
    }
    this.shotEnd = false;
    this.audio?.shot(shot);
    if (!shot.contentType) {
      this.refs.avgDialog.className = '';
      this.refs.avgSpeaker.innerHTML = '';
      this.refs.avgLine.replaceChildren();
    }
    if (shot.branch) {
      const logDiv = this._makeLogDiv();
      const choices = [];
      shot.branch.forEach((info, i) => {
        const choice = document.createElement('div');
        choice.className = 'avg-choice';
        choice.textContent = info.content;
        choice.dataset.jumpAct = info.jumpAct;
        choice.dataset.index = i;
        this.refs.avgChoices.append(choice);
        choices.push(`<span>${i + 1}.${info.content}</span>`);
      });
      const logLine = document.createElement('p');
      logLine.innerHTML = choices.join('<br>');
      logDiv.children[1].append(logLine);
      this.refs.avgStage.classList.add('choice');
      this.sched.after(5, () => this.refs.avgChoices.className = 'choice');
      this.refs.avgLogBox.append(logDiv);
      this.shotEnd = true;
    } else if (!this.lineNum) {
      if (shot.content) {
        const logDiv = this._makeLogDiv();
        let speaker;
        if (shot.speakerName == 'bravo') {
          speaker = this.getName();
        } else {
          speaker = shot.speakerName || this.characters[shot.speakerHeroId] || '';
        }
        logDiv.children[0].innerHTML = speaker;
        const logLine = document.createElement('p');
        logLine.innerHTML = shot.content[0];
        logDiv.children[1].append(logLine);
        this.refs.avgLogBox.append(logDiv);
      }
      const reload = this.shotId !== this.scriptType + 1 && shot.images;
      const epoch = this.sched.epoch;
      /* compose 链挂进 pendingChains：fastForward（seek 重放）要看得见
         「链已起步、还在等 layout fetch / 串行门」的空档。 */
      this._trackChain((async () => {
        if (reload) {
          /* 链里的素材加载必须可被 idle() 看见：虚拟钟在 settle/排干的
             微任务紧循环里远快于真实 fetch，不登记的话钟会烧穿整个
             settle 预算、链在「240s 之后」才续上（相位全毁）。
             loadImages 内部只有 fetch/Image 加载，不依赖虚拟钟，安全。 */
          await this._track(this.loadImages(shot.images));
          if (this.sched.epoch !== epoch) return;
        }
        await this._manageImg();
        if (this.sched.epoch !== epoch) return;
        this._manageContentType();
        this._speak();
        if (shot.autoContinue && !this.playEnd) {
          this.sched.after(0, () => this.playShot());
        }
      })());
    } else if (shot.content) {
      const logLine = document.createElement('p');
      logLine.innerHTML = shot.content[this.lineNum];
      this.refs.avgLogBox.lastElementChild.append(logLine);
      this._typeLine();
    } else {
      this.shotEnd = true;
    }
  }

  /* —— L3 定点补丁（编辑器）：文案/说话人变了，shot 不重启 ——
     只重绘说话人、当前页文本与回廊末条；时序、打字机、调度器一概不碰。
     rawShot 是编辑器的 wire 原串镜，这里重新 formatPages 进场景副本。 */
  patchShot(rawShot) {
    if (!this.scene) return;
    const vars = {name: this.getName(), gender: this.getGender()};
    const copy = this.scene[this.shotId];
    Object.assign(copy, rawShot);
    copy.content = rawShot.content
        ? formatPages(rawShot.content, vars) : rawShot.content;
    const speaker = copy.speakerName == 'bravo' ? this.getName()
        : copy.speakerName || this.characters[copy.speakerHeroId] || '';
    if (copy.speakerName == 'bravo') this.refs.avgSpeaker.textContent = speaker;
    else this.refs.avgSpeaker.innerHTML = speaker;
    const page = copy.content?.[this.lineNum];
    if (page !== undefined) this.refs.avgLine.innerHTML = page;
    const logDiv = this.refs.avgLogBox.lastElementChild;
    if (logDiv && copy.content) {
      logDiv.children[0].innerHTML = speaker;
      logDiv.children[1].replaceChildren();
      for (let i = 0; i <= this.lineNum; i++) {
        const p = document.createElement('p');
        p.innerHTML = copy.content[i];
        /* 复刻 playShot 的两条落点：page0 在 children[1]，后续页挂 logDiv。 */
        (i === 0 ? logDiv.children[1] : logDiv).append(p);
      }
    }
  }

  /* —— 交互（参考 handleStageClick:333 / handleControlClick:285）—— */

  /* 点选项：回廊对应行打上 selected + 按选项跳镜。seek 重放同款走这里。 */
  _chooseBranch(index) {
    const choiceP = this.refs.avgLogBox.lastElementChild.children[1].children[0];
    choiceP.querySelectorAll('span')[index].className = 'selected';
    this.playShot(+this.scene[this.shotId].branch[index].jumpAct);
  }

  click(target = this.container) {
    if (!this.scene) return;
    /* 宿主可选项（编辑器开）：log 面板打开时任意点击先收起——参考的
       行为是点击照常推进剧情且面板常驻，冻结 UI 测试仍走参考语义。 */
    if (this.logClickCloses && this.refs.avgOverlay.classList.contains('log')) {
      this.refs.avgOverlay.classList.remove('log');
      return;
    }
    if (this.toAutoPlay) {
      this.toAutoPlay = false;
      this.sched.clear(this.autoPlayHandle);
      this.autoPlayHandle = null;
    }
    if (this.container.classList.contains('hide-ui')) {
      this.container.classList.remove('hide-ui');
      return;
    }
    if (target.className == 'avg-choice') {
      this._chooseBranch(+target.dataset.index);
    } else if (target.dataset.ref && this.shotEnd) {
      this.pandect?.showRef(target.dataset.ref);
    } else if (!this.refs.avgChoices.className) {
      if (this.readingLine) {
        this.typewriter?.setInterrupt();
      } else if (this.shotEnd && !this.playEnd) {
        this.playShot();
      } else if (this.playEnd) {
        this.clearStage();
      }
    }
  }

  controlClick(event) {
    if (!this.scene || event.target === this.refs.avgControls) return;
    event.stopPropagation();
    const {avgControlLog, avgControlHideUi, avgControlDict, avgControlAuto,
      avgControlSkip} = this.refs;
    /* 参考 quirk：log/dict 用 classList.add，两个面板会叠着一起开；
       skip 整体替换 className。取消/确认在参考包里没有任何 handler，
       点击冒泡到舞台推进逻辑——这里照抄，不发明行为。 */
    switch (event.target) {
      case avgControlLog:
        if (this.autoPlaying) this.toggleAutoPlay();
        if (this.logClickCloses && this.refs.avgOverlay.classList.contains('log')) {
          this.refs.avgOverlay.classList.remove('log');   /* 再点日志键 = 收起 */
        } else {
          this.refs.avgOverlay.classList.add('log');
        }
        break;
      case avgControlHideUi:
        if (this.autoPlaying) this.toggleAutoPlay();
        this.container.classList.add('hide-ui');
        break;
      case avgControlDict:
        if (this.autoPlaying) this.toggleAutoPlay();
        this.refs.avgOverlay.classList.add('des');
        this.refs.avgDesEntries.scrollTop = 0;
        break;
      case avgControlAuto:
        this.toggleAutoPlay();
        break;
      case avgControlSkip:
        this.refs.avgOverlay.className = 'skip';
        break;
      default:
    }
  }

  /* 参考 prepareAutoPlay / toggleAutoPlay。定时器走 sched.after：
     bump（seek/clearStage）天然兜杀，句柄只服务手动取消。 */
  _prepareAutoPlay() {
    if (this.autoPlaying && this.toAutoPlay && !this.refs.avgChoices.className) {
      this.playShot();
      this.toAutoPlay = false;
      this.autoPlayHandle = null;
    }
  }

  toggleAutoPlay() {
    if (this.autoPlaying) {
      this.autoPlaying = false;
      if (this.toAutoPlay) {
        this.toAutoPlay = false;
        this.sched.clear(this.autoPlayHandle);
      }
      this.autoPlayHandle = null;
      this.refs.avgControlAuto.className = '';
    } else {
      this.autoPlaying = true;
      this.refs.avgControlAuto.className = 'on';
      if (this.shotEnd) {
        this.toAutoPlay = true;
        this.autoPlayHandle = this.sched.after(1000, () => this._prepareAutoPlay());
      }
    }
  }

  /* —— 收尾（参考 clearStage:393）—— */

  clearStage() {
    this.sched.bump();
    this.audio?.stopAll();
    resetStage(this);
    this.refs.avgDes.className = '';
    this.styles.textContent = '';
    this.scene = undefined;
    this.scriptType = undefined;
    this.shotId = undefined;
    this.lineNum = 0;
    this.shotEnd = true;
    this.readingLine = false;
    this.typewriter = null;
    this.autoPlaying = false;
    if (this.toAutoPlay) {
      this.toAutoPlay = false;
      this.sched.clear(this.autoPlayHandle);
    }
    this.autoPlayHandle = null;
    this.state = emptyState();
    this.layouts.clear();
    this.defaultFaces.clear();
    this.pendingChains.clear();
  }

  /* —— seek（M5）：重放式跳转 ——
     不另写一套 settled 渲染器：seekShot 把引擎从空场重开，沿真实推进路径
     playShot()（分支镜走「点第一个选项」）逐镜打完再停到目标镜。对话框、
     回廊、minHeight 测量、立绘规则表全走与真实播放同一条代码路径，所以
     「seek 落点」与「从头连续播到该镜暂停」逐字节相等是构造保证。
     「不真等」靠 Scheduler.flush()：时间坍缩、回调次序不变；
     bump() 护栏保证重开后的旧回合残链全部哑火（loadImages/_paintLpic 同查）。 */

  /* 把当前挂着的引擎等待瞬间跑完：定时任务排干、素材加载与 compose 链
     追平、打字机打完全行。收敛判据 = 调度器无任务 && 无在途加载
     && 无在途 compose 链 && 打字机已收尾。 */
  async fastForward({cap = 4000} = {}) {
    const busy = () => this.sched.pending() || this.pendingLoads.size
        || this.pendingChains.size
        || (this.typewriter?.reading && !this.typewriter?.done);
    for (let i = 0; i < cap && busy(); i++) {
      this.sched.flush();
      await this.idle();
      /* 让排干回调拉起的微任务链（compose / 打字机）走到下一个挂起点。 */
      await Promise.resolve();
      await Promise.resolve();
    }
    if (busy()) {
      throw new Error('fastForward: 引擎未在预算内静止（autoContinue 成环？）');
    }
  }

  /* 跳到引擎键为 key 的镜（数组剧本 = 下标；map 剧本 = 键名），落点 =
     「刚进入该镜、首页打完、全部 tween 跑完」的 settled 态。
     直通镜（autoContinue 且非终点）停不住，抛错；编辑器先落到可停留镜。 */
  /* seekShot(key, {timed})：默认整程坍缩（定格，瞬时落到 settled 态）。
     timed=true 时重放到 key-1 后强制一次样式落定，再让目标镜走真实定时器
     ——CSS 过渡的起值因此来自「上一镜的 settled 态」而非 DOM 残留，
     编辑器 L2 失效（改 tween/表情/posId）用它重放动画。 */
  async seekShot(key, {timed = false} = {}) {
    if (!this.rawScene) throw new Error('seekShot: 还没有装过场景');
    /* 重放沿途会逐镜触发 playShot 的音频——整程静音，落点只补目标镜的 bgm。 */
    const audio = this.audio;
    this.audio = null;
    /* 重放循环直接驱动共享的 playShot()：新一轮 seek 一起步（setScene 的
       clearStage bump）旧轮就该立刻撒手，否则旧循环会把镜号推到场景末尾、
       把宿主没要的镜画上去（连点分镜时预览串台）。 */
    let epoch = this.sched.epoch;
    const stale = () => this.sched.epoch !== epoch;
    try {
      this.setScene(this.rawScene, this.sceneMeta.title, this.sceneMeta.number,
          this.sceneMeta.sector, this.sceneMeta.sectorEn);
      epoch = this.sched.epoch;
      if (!(key in this.scene) || Number(key) === this.scriptType) {
        throw new Error(`seekShot: 镜 ${key} 不是可停留的镜`);
      }
      await this.idle();
      if (stale()) return null;
      const guard = (Array.isArray(this.scene)
          ? this.scene.length : Object.keys(this.scene).length) + 4;
      /* timed：先定格重放到目标镜的前一镜，再真实推进最后一跳。 */
      const prevKey = timed ? this._prevKeyOf(key) : null;
      const landOn = timed && prevKey !== null ? prevKey : key;
      for (let left = guard; this.shotId !== landOn; left--) {
        if (stale()) return null;
        if (this.playEnd || left <= 0) {
          throw new Error(
              `seekShot: 停不到镜 ${key}（autoContinue 直通或不在首选项路线上）`);
        }
        if (this.scene[this.shotId]?.branch) {
          this._chooseBranch(0);
        } else {
          this.playShot();
        }
        await this.fastForward();
      }
      if (stale()) return null;
      if (timed && prevKey !== null) {
        void this.container.offsetWidth;   // 前一镜样式落定 = 过渡起值
        this.playShot();
      }
      return this.shotId;
    } finally {
      /* 陈旧回合不许还原 audio：新一轮正靠 this.audio === null 静音重放。 */
      if (!stale()) {
        this.audio = audio;
        if (audio && this.scene && !timed) audio.bgmOnly(this.scene[this.shotId]);
      }
    }
  }

  /* 沿播放链找 key 的前一镜（首镜返回 null → timed 退化为普通 seek）。 */
  _prevKeyOf(key) {
    let s = this.scriptType + 1;
    let prev = null;
    while (s != null && s !== Number(key)) {
      const shot = this.scene[s];
      if (!shot) return null;
      prev = s;
      s = shot.branch ? shot.branch[0].jumpAct + this.scriptType
          : (shot.nextId ? shot.nextId + this.scriptType : s + 1);
    }
    return prev;
  }

  /* 确定性时间线（粗模型）：每个到达点的引擎耗时 =
     tween 串行门 horizon·1000 + 首页打字帧数×50；人手点击的间隔不计。
     只服务传输条把时间映射到镜，M9 时间轴再精化。路线 = 分支恒取第一项，
     与 seekShot 的重放路线一致。 */
  sceneTimeline() {
    const out = [];
    if (!this.scene) return out;
    const msOf = (shot) => {
      const horizon = shot?.imgTween?.length
          ? Math.max(...shot.imgTween.map((t) => (t.delay || 0) + (t.duration || 0)))
          : 0;
      return horizon * 1000 + (shot?.content ? hops(shot.content[0]).length * 50 : 0);
    };
    const seen = new Set();
    let key = this.scriptType + 1;
    let at = 0;
    while (key != null && this.scene[key] && !seen.has(key)) {
      seen.add(key);
      const shot = this.scene[key];
      const last = !!(shot.isEnd || !(shot.nextId || this.scene[key + 1]));
      const ms = msOf(shot);
      out.push({key, start: at, ms,
                pausable: !!(shot.branch || !shot.autoContinue || last)});
      at += ms;
      if (last) break;
      key = shot.branch ? shot.branch[0].jumpAct + this.scriptType
          : (shot.nextId ? shot.nextId + this.scriptType : key + 1);
    }
    return out;
  }

  /* t 映射到「t 时刻引擎所在的、可停留的镜」：直通镜的窗口并入前一条
     可停留镜（粗粒度；seekTime(S_k) 恒等于 seekShot(k)）。 */
  async seekTime(t) {
    const pausable = this.sceneTimeline().filter((entry) => entry.pausable);
    if (!pausable.length) throw new Error('seekTime: 场景没有可停留的镜');
    let pick = pausable[0];
    for (const entry of pausable) {
      if (entry.start <= t) pick = entry;
    }
    return this.seekShot(pick.key);
  }

  /* 引擎键 key 是否停得住（编辑器列表据此决定 seek 还是顺延）。 */
  isPausableKey(key) {
    const shot = this.scene?.[key];
    if (!shot) return false;
    if (shot.branch || !shot.autoContinue) return true;
    return !!(shot.isEnd || !(shot.nextId || this.scene[key + 1]));
  }

  /* —— 资产等待（给测试/截图的确定性入口）—— */

  _track(promise) {
    this.pendingLoads.add(promise);
    promise.finally(() => this.pendingLoads.delete(promise));
    return promise;
  }

  /* compose 链的登记（见 pendingChains 注）。bump 后的旧链永不落定，
     由 clearStage 统一清场，不靠 finally。链若 reject，.finally 派生出的
     promise 会把 rejection 冒给页面的 unhandledrejection，不吞。 */
  _trackChain(promise) {
    this.pendingChains.add(promise);
    promise.finally(() => this.pendingChains.delete(promise));
    return promise;
  }

  async idle() {
    while (this.pendingLoads.size) {
      await Promise.all([...this.pendingLoads]);
    }
  }

  _charaEl(imgId) {
    return this.refs.avgCharas.querySelector(
        `.avg-chara[data-img-id="${imgId}"]`);
  }

  _makeLogDiv() {
    const div = document.createElement('div');
    div.className = 'avg-log-div';
    /* 参考是 logTpl.cloneNode：模板里的空白文本节点会留在 innerHTML 序列化
       里（M6 UI 冻结按字节比对 logTail），所以照抄模板的换行缩进。 */
    div.innerHTML = '\n    <div></div>\n    <div></div>\n  ';
    return div;
  }
}
