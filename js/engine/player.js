import {dashToCamel} from '../ui/dom.js';
import {Scheduler, REAL_TIMER} from '../core/scheduler.js';
import {
  emptyState, applyImages, applyShotTweens, applyFaces, isValidPos,
  isValidPosVec, laneZOrder,
} from '../core/state.js';
import {formatPages, DEFAULT_VARS, hops} from '../core/markup.js';
import {Typewriter} from './typewriter.js';
import {createPandect} from './nouns.js';
import {
  CANVAS, buildCharaRules, faceRegion, compositeBody, drawFace, buildChara,
  baseTranslate, slotMirrorSign, shakeKeyframes,
} from './sprite.js';

/* 游戏侧 AvgImgTweenUntil.Tween 全程不调 SetEase，且全 6402 支游戏 Lua 里
   没有一处 SetDefaultEase/DOTween.Init ⇒ 立绘与背景补间用的是 DOTween 内置
   默认 Ease.OutQuad。CSS 没有 ease-out-quad 关键字，按端点斜率拟合
   （f'(0)=2、f'(1)=0，逐点最大偏差 3e-5）。 */
const EASE_OUT_QUAD = 'cubic-bezier(.3,.6,.64,1)';

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

const VISUAL_TYPES = new Set([1, 4, 5]);

/* 参考自动播放的两拍节拍（typeWriteScrambled/readLine 的 2s、起跳的 1s）。
   抽成常量是为了 setRate 能按新速率重排已挂起的那一拍。 */
const AUTO_START_DELAY = 1000;
const AUTO_LINE_DELAY = 2000;

/* 特效索引里的 size 是预制件单位的正方形 quad 边长（tools/build-avg-effects.py
   按 Unity 的 scalingMode 从 bundle 算出来）。换算口径与立绘 pos 同一条：
   ÷32 得 em（16px em ⇒ 1 单位 = 0.5px），所以刀光 174.8 单位 = 87px。 */
function fxQuadEm(size) {
  const units = Number(size);
  return Number.isFinite(units) && units > 0 ? units / 32 : null;
}

/* 游戏 UIAVGSystem 的五层不是五套逻辑：它们都由 UINAvgImgItem 管理，
   只是在 Unity prefab 里挂到了不同 parent。这里动态补 parent，静态骨架仍
   保持和参考页逐元素一致（test-skeleton 依旧可以做 DOM 契约检查）。 */
function createVisualLayers(refs) {
  const doc = refs.avgStage.ownerDocument;
  const make = (className) => {
    const el = doc.createElement('div');
    el.className = `avg-layer-host ${className}`;
    return el;
  };
  const distant = make('avg-layer-distant');
  const foreground = make('avg-layer-foreground');
  const movie = make('avg-layer-movie');
  const effects = [1, 2, 3].map((layer) => {
    const host = make(`avg-layer-effects avg-layer-effects-${layer}`);
    host.dataset.layer = String(layer);
    return host;
  });
  refs.avgStage.insertBefore(distant, refs.avgBg);
  refs.avgStage.insertBefore(foreground, refs.avgDialog);
  refs.avgStage.insertBefore(movie, refs.avgDialog);
  effects.forEach((host) => refs.avgStage.insertBefore(host, refs.avgDialog));
  /* SG 专属演出层（23sg 联动：CRT 终端镜 / 手机聊天窗 / 世界线变动），
     盖在对话框之上——手机窗在游戏里是独立 UI 窗（UIWindowTypeID.SteinsGateAvg），
     浮在 AVG 窗之上。 */
  const sg = make('avg-layer-sg');
  refs.avgStage.append(sg);
  /* effects 保留旧别名给宿主/夹具；真实游戏按 1/2/3 三个 parent 分层。 */
  return {distant, foreground, movie, effects: effects[2], effectHosts: effects, sg};
}

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
  instance.visualLayers = createVisualLayers(refs);

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
  refs.avgStage.querySelectorAll('.avg-layer-host').forEach((el) => el.replaceChildren());
  refs.avgBg.querySelectorAll('.avg-layer-item').forEach((el) => el.remove());
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
  refs.avgStage.style.backgroundColor = null;
  refs.avgStage.style.filter = null;
  refs.avgStage.style.transition = null;
  refs.avgStage.classList.remove('avg-ppv');
  refs.avgStage.classList.remove('avg-rgb-split');
  for (const prop of [
    '--avg-ppv-saturation', '--avg-ppv-dof-focus', '--avg-ppv-dof-blur',
    '--avg-rgb-radius',
  ]) refs.avgStage.style.removeProperty(prop);
  delete refs.avgStage.dataset.ppv;
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
    videoPathOf = null,            // 可选：游戏 vedioPath / Movie 资源解析器
    effectAssetOf = null,           // 可选：prefab → 浏览器可消费的贴图元数据
    canvasSize = CANVAS,      // M11：低端设备可降到 512（数学与分辨率无关）
    logClickCloses = false,   // 宿主偏离项：log 面板任意点击收起（编辑器开）
  } = {}) {
    Object.assign(this, buildStage(mount, {mode}));
    this.sched = new Scheduler(timer);
    this.audio = audio;
    this.videoPathOf = videoPathOf;
    this.effectAssetOf = effectAssetOf;
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
    this.layerEls = new Map();
    this.bgLayerEls = new Map();
    this.effectEls = new Map();
    /* ChangeAvgPP 的三个独立 tween 通道。focusDistance 是本体的归一化
       景深焦距，不是 CSS blur 像素；视觉降级只从它派生 blur。 */
    this.ppvState = {
      saturation: 1,
      dofFocus: 0.5,
      rgbRadius: 0,
      rgbVisible: false,
    };
    this._ppvTweenSeq = 0;
    this.currentBgId = null;
    this._shakeSeq = 0;
    this._videoStarted = false;
    this._cancelVideoWait = null;
    this._runtimeSeq = 0;
    this._runtimeShot = null;
    this._runtimeObjects = new Map();
    this._runtimeBindings = [];
    /* 23sg 专属演出（contentStyle/sgMobile/sgLineChange/sgMonitorFrame）
       的回合态：sgStyle 全段粘滞（游戏按首镜 cfg 选
       SteinsGateAvgDialog prefab），其余逐镜生效。 */
    this.sgStyle = null;
    this.sgMonitorEl = null;
    this._sgMobileEl = null;

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
      this._removeLayerEl(imgId);
      this.defaultFaces.delete(imgId);
      if (this.currentBgId === imgId) {
        this.currentBgId = null;
        this.refs.avgBg.style.backgroundImage = null;
        this.refs.avgBg.style.opacity = null;
      }
    }
    for (const {img, reenter} of touched) {
      if (VISUAL_TYPES.has(img.imgType)) {
        /* Movie 与普通图片共用同一注册流程；视频没有本地解析器时由
           _loadVisualLayer 降级成明确占位，不阻塞剧情。 */
        await this._loadVisualLayer(img);
        if (epoch !== this.sched.epoch || !this.scene) return;
        continue;
      }
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
      } else {
        /* 不带 delete 的重复注册：游戏侧 NewImgItem 照样重跑 InitAvgHeroPic
           → InitAvgHeroPicParam，comm/ripple 按新条目重新赋值（两 helper 都
           幂等）。comm 模式翻转时合成数学跟着变（comm 视图只画 300×426 子
           区域），旧脸像素也随模式失效——走 reenter 同款清底重画；
           模式没变就只同步 ripple（水波纹是材质件，不牵动画布）。 */
        const chara = this._charaEl(img.imgId);
        if (chara && !!chara.querySelector('.avg-communication') !== !!img.comm) {
          chara.firstElementChild.getContext('2d')
              .clearRect(0, 0, this.canvasSize, this.canvasSize);
          this.defaultFaces.delete(img.imgId);
          await this._paintLpic(chara, img, config);
          if (epoch !== this.sched.epoch) return;
        } else if (chara) {
          this._setRipple(chara, !!img.ripple);
        }
      }
    }
    this._applyZOrder();
    this._applyVisualZOrder();
  }

  _assetPath(img) {
    if (!img?.imgPath) return null;
    if (img.imgType === 5) return this.videoPathOf?.(img.imgPath) ?? null;
    const name = img.imgPath.split('/').pop();
    return this.filePathOf(name + (/[.][a-z0-9]+$/i.test(name) ? '' : '.png'));
  }

  _layerParent(imgType) {
    if (imgType === 1) return this.visualLayers.distant;
    if (imgType === 4) return this.visualLayers.foreground;
    if (imgType === 5) return this.visualLayers.movie;
    return null;
  }

  _loadVisualLayer(img) {
    const old = this.layerEls.get(img.imgId);
    old?.remove();
    const parent = this._layerParent(img.imgType);
    if (!parent) return Promise.resolve();
    const doc = parent.ownerDocument;
    const isMovie = img.imgType === 5;
    const el = doc.createElement(isMovie ? 'video' : 'img');
    el.className = 'avg-layer-item';
    el.dataset.imgId = String(img.imgId);
    el.dataset.imgType = String(img.imgType);
    el.dataset.path = img.imgPath || '';
    el.draggable = false;
    el.style.opacity = Number.isFinite(img.alpha) ? String(img.alpha) : '0';
    el.style.zIndex = String(img.order ?? 0);
    if (isMovie) {
      el.muted = true;
      el.loop = !!img.loop;
      el.playsInline = true;
      el.preload = 'auto';
    } else {
      el.alt = '';
      el.decoding = 'async';
      el.style.objectFit = img.fullScreen === false ? 'contain' : 'cover';
    }
    parent.append(el);
    this.layerEls.set(img.imgId, el);

    const src = this._assetPath(img);
    if (!src) {
      this._degradeLayer(el, isMovie ? img.imgPath : null);
      return Promise.resolve();
    }
    const ready = new Promise((resolve) => {
      const done = () => { el.classList.remove('img-loading'); resolve(); };
      const fail = () => { this._degradeLayer(el, img.imgPath); done(); };
      el.classList.add('img-loading');
      el.addEventListener(isMovie ? 'loadeddata' : 'load', done, {once: true});
      el.addEventListener('error', fail, {once: true});
      el.src = src;
      /* jsdom/旧浏览器没有 decode，真实浏览器仍以 load 事件为准。 */
      if (!isMovie && typeof el.decode === 'function') el.decode().then(done, fail);
    });
    return this._track(ready);
  }

  _degradeLayer(el, label) {
    el.classList.add('img-missing');
    if (label) el.dataset.missing = label;
  }

  _removeLayerEl(imgId) {
    this.layerEls.get(imgId)?.remove();
    this.layerEls.delete(imgId);
    this.bgLayerEls.get(imgId)?.remove();
    this.bgLayerEls.delete(imgId);
  }

  _applyVisualZOrder() {
    const entries = this.state.layerOrder
        .map((imgId, seq) => ({imgId, seq, order: this.state.imgMap.get(imgId)?.order ?? 0}))
        .sort((a, b) => (a.order - b.order) || (a.seq - b.seq));
    entries.forEach(({imgId}, rank) => {
      const el = this.layerEls.get(imgId) ?? this.bgLayerEls.get(imgId);
      if (el) el.style.zIndex = String(rank + 1);
    });
  }

  /* 立绘 z 序：游戏按 order 升序逐个 SetAsLastSibling ⇒ 后面上面。这里写行内
     z-index 而不重排 DOM 兄弟序 —— 快照与冻结对拍都按 DOM 序取样，重排会误伤。
     #avg-charas 自身是层叠上下文（css/avg.css:86），故只在立绘之间比高低。 */
  _applyZOrder() {
    laneZOrder(this.state).forEach(
        (imgId, rank) => {
          const el = this._charaEl(imgId);
          if (el) el.style.zIndex = String(rank + 1);
        });
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
        compositeBody(context, charaImg, config,
                      {comm: !!img.comm, canvasSize: this.canvasSize});
        this._setCommunication(chara, !!img.comm);
        this._setRipple(chara, !!img.ripple);
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
    if (!(imgTween || heroFace)) {
      this._scheduleRuntimeFrames(shot);
      return;
    }
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
      this._scheduleRuntimeFrames(shot);
      return;
    }
    const {events, lastEnding} = applyShotTweens(this.state, shot);
    for (const event of events) {
      const faceId = heroFace?.find((f) => f.imgId == event.imgId)?.faceId;
      if (event.imgType === 2) {
        for (const entry of event.entries) this._tweakBg(event.imgId, entry);
      } else if (event.imgType === 3) {
        this._tweenChara(event.imgId, event.entries, faceId, event.entering);
      } else {
        this._tweenLayer(event.imgId, event.entries);
      }
    }
    /* Native capture is scheduled after the static tween callbacks so its
       first frame wins the same tick and subsequent frames become the source
       of truth for breathing/shake/material-driven motion. */
    this._scheduleRuntimeFrames(shot);
    /* 串行门（R8）：打字要等最晚的 delay+duration 跑完才开始。 */
    await this.sched.promise(lastEnding * 1000);
  }

  _scheduleRuntimeFrames(shot) {
    const runtime = shot?.runtime;
    const frames = Array.isArray(runtime?.frames) ? runtime.frames : [];
    if (!frames.length || this._runtimeShot === shot) return;
    this._runtimeShot = shot;
    this._runtimeObjects = new Map();
    this._runtimeBindings = Array.isArray(runtime.bindings)
      ? runtime.bindings : [];
    const born = this.sched.epoch;
    const seq = ++this._runtimeSeq;
    let index = 0;
    let previous = 0;
    const next = () => {
      if (born !== this.sched.epoch || seq !== this._runtimeSeq
          || index >= frames.length) return;
      const frame = frames[index++];
      const t = Math.max(previous, Number(frame.t) || 0);
      const delay = (t - previous) * 1000;
      previous = t;
      this.sched.after(delay, () => {
        if (born !== this.sched.epoch || seq !== this._runtimeSeq) return;
        this._applyRuntimeFrame(frame);
        next();
      });
    };
    next();
  }

  _runtimeImgId(object) {
    if (object?.imgId != null) return object.imgId;
    const key = String(object?.key ?? '');
    const path = String(object?.path ?? '');
    for (const binding of this._runtimeBindings) {
      if (binding?.root && String(binding.root) === key) return binding.imgId;
      if (binding?.path && (path === binding.path
          || path.startsWith(binding.path + '/'))) return binding.imgId;
    }
    return null;
  }

  _applyRuntimeFrame(frame) {
    for (const object of frame?.objects ?? []) {
      const key = String(object?.key ?? object?.path ?? '');
      if (!key) continue;
      const old = this._runtimeObjects.get(key) ?? {};
      const next = {...old};
      for (const field of ['name', 'path', 'pos', 'rotation', 'scale',
        'color', 'material', 'active', 'siblingIndex']) {
        if (object[field] !== undefined && object[field] !== null) {
          next[field] = object[field];
        }
      }
      if (next.imgId == null) next.imgId = this._runtimeImgId(object);
      this._runtimeObjects.set(key, next);
    }
    const grouped = new Map();
    for (const object of this._runtimeObjects.values()) {
      if (object.imgId == null) continue;
      const id = String(object.imgId);
      if (!grouped.has(id)) grouped.set(id, []);
      grouped.get(id).push(object);
    }
    for (const [id, objects] of grouped) {
      const chara = this._charaEl(id);
      if (!chara) continue;
      /* The binding root owns position/scale/rotation; RawImage descendants
         own color/material.  Keep the shortest bound path as the root while
         still accepting a sparse frame where only a descendant changed. */
      const root = [...objects].sort((a, b) =>
        String(a.path ?? '').length - String(b.path ?? '').length)[0];
      const colorObject = [...objects].reverse().find((object) => object.color);
      this._applyRuntimeTransform(chara, id, root);
      if (colorObject?.color) this._applyRuntimeColor(chara, colorObject.color);
      const active = root.active;
      if (active !== undefined) chara.style.display = active ? '' : 'none';
      if (root.siblingIndex !== undefined && root.siblingIndex !== null) {
        chara.style.zIndex = String(Number(root.siblingIndex) + 1);
      }
    }
  }

  _applyRuntimeTransform(chara, imgId, object) {
    const pos = object?.pos;
    const valid = (value) => value && Number.isFinite(Number(value.x))
        && Number.isFinite(Number(value.y));
    if (valid(pos)) {
      chara.style.left = `${Number(pos.x) / 32}em`;
      chara.style.bottom = `${Number(pos.y) / 32}em`;
    }
    const scale = object?.scale;
    const rotation = object?.rotation;
    if (!valid(scale) && !valid(rotation)) return;
    const config = this.layouts.get(Number(imgId)) ?? this.layouts.get(imgId);
    if (!config) return;
    const fontSize = parseFloat(getComputedStyle(this.container).fontSize);
    const t = baseTranslate(config, {width: this.container.clientWidth,
      height: this.container.clientHeight, fontSize});
    const transform = [`translate(${t.x}em, ${t.y}em)`];
    if (valid(scale)) transform.push(`scale(${Number(scale.x)}, ${Number(scale.y)})`);
    if (valid(rotation)) transform.push(`rotateZ(${Number(rotation.z || 0)}deg)`);
    chara.style.transform = transform.join(' ');
    chara.style.transition = 'none';
  }

  _applyRuntimeColor(chara, color) {
    const rgba = ['r', 'g', 'b', 'a'].map((key) => Number(color[key]));
    if (!rgba.every(Number.isFinite)) return;
    chara.style.opacity = String(rgba[3]);
    if (Math.abs(rgba[0] - rgba[1]) < 0.001
        && Math.abs(rgba[1] - rgba[2]) < 0.001) {
      chara.style.filter = `brightness(${rgba[0]})`;
    }
    chara.style.transition = 'none';
  }

  _tweakBg(imgId, entry) {
    this.sched.after((entry.delay || 0) * 1000, () => {
      const img = this.state.imgMap.get(imgId);
      if (!img) return;
      const backgrounds = [...this.state.layers.values()]
          .filter((layer) => layer.imgType === 2);
      /* 一个 #avg-bg 足够覆盖绝大多数镜头；出现并行背景时才切到多实例
         容器，避免把现有单背景的 CSSOM 形状改掉。 */
      if (backgrounds.length > 1 || this.bgLayerEls.size) {
        this._ensureBackgroundStack(backgrounds);
        const layer = this.bgLayerEls.get(imgId);
        if (!layer) return;
        layer.style.transition = `opacity ${entry.duration}s ${EASE_OUT_QUAD}`;
        if (entry.alpha !== undefined) layer.style.opacity = entry.alpha;
      } else {
        const bg = this.refs.avgBg;
        bg.style.backgroundImage = 'url(' + this._assetPath(img) + ')';
        bg.style.transition = `opacity ${entry.duration}s ${EASE_OUT_QUAD}`;
        if (entry.alpha !== undefined) bg.style.opacity = entry.alpha;
        this.currentBgId = imgId;
      }
      const overlay = this.refs.avgBgOverlay;
      /* 赋值不是翻转（与 state.js 折叠层同口径）：条目不带 isDark 就不碰遮罩。
         旧写法 contains('dark') != entry.isDark 在 isDark 为 undefined 时恒真，
         每来一条无 isDark 的背景条目就白翻一次。 */
      if (entry.isDark !== undefined
          && overlay.classList.contains('dark') !== (entry.isDark === true)) {
        overlay.style.transition = `background ${entry.duration}s ${EASE_OUT_QUAD}`;
        overlay.classList.toggle('dark', entry.isDark === true);
      }
    });
  }

  /* UINAvgHeroPic does not bake comm/ripple into the script image itself.
     游戏侧这两个可见性只在注册时赋值：InitAvgHeroPicParam L143/L147 把
     imgCfg.comm/ripple 原值传给 __ShowCommunication/__ShowRipple，两个 helper
     都幂等（show 假 + 无挂件 = no-op，show 假 + 有挂件 = 摘除）；回收
     （Delete L363/365）强制 false。tween 全链路（AvgImgTweenUntil）从不触碰
     它们——语料 229 个带 comm 的剧本里 imgTween 条目 0 例携带 comm/ripple。
     所以 DOM 侧只由注册事件驱动：_paintLpic（首建/reenter）与本函数调用方
     loadImages 的重复注册分支；动 tween 会把通讯框从后续镜头整批抹掉。 */
  _setCommunication(chara, show) {
    const old = chara.querySelector('.avg-communication');
    if (!show) {
      if (old?.classList.contains('avg-communication')) old.remove();
      return;
    }
    if (old?.classList.contains('avg-communication')) return;
    const comm = document.createElement('div');
    comm.className = 'avg-communication';
    comm.setAttribute('aria-hidden', 'true');
    chara.append(comm);
  }

  _setRipple(chara, show) {
    const old = chara.querySelector('.avg-chara-ripple');
    if (!show) {
      old?.remove();
      return;
    }
    if (old) return;
    const ripple = document.createElement('span');
    ripple.className = 'avg-chara-ripple';
    ripple.setAttribute('aria-hidden', 'true');
    chara.append(ripple);
  }

  _ensureBackgroundStack(backgrounds) {
    const bg = this.refs.avgBg;
    const parent = bg;
    const migrating = !this.bgLayerEls.size;
    if (migrating) {
      /* #avg-bg 上的 opacity 会连带遮罩；迁移到 item 后父层恢复为透明。
         迁移中的旧背景必须读取 DOM 当前值，不能读 state.layers：
         applyShotTweens 已经把本镜所有终值折叠进 state，直接读取会把
         尚未到 delay 的动画提前显示/隐藏。 */
      const oldId = this.currentBgId;
      const oldOpacity = parseFloat(getComputedStyle(bg).opacity);
      const oldImage = bg.style.backgroundImage;
      bg.style.backgroundImage = null;
      bg.style.opacity = null;
      this._backgroundMigration = {oldId, oldOpacity, oldImage};
    }
    /* 不只处理首次迁移：新的背景可能在已经启用堆栈的后续镜头注册。 */
    for (const layer of backgrounds) {
      if (this.bgLayerEls.has(layer.imgId)) continue;
      const img = this.state.imgMap.get(layer.imgId);
      const el = bg.ownerDocument.createElement('img');
      el.className = 'avg-layer-item';
      el.dataset.imgId = String(layer.imgId);
      el.dataset.imgType = '2';
      el.alt = '';
      el.decoding = 'async';
      el.draggable = false;
      el.src = this._assetPath(img);
      el.style.objectFit = img?.fullScreen === false ? 'contain' : 'cover';
      const migrated = this._backgroundMigration?.oldId === layer.imgId;
      const initial = migrated
          ? (Number.isFinite(this._backgroundMigration.oldOpacity)
              ? this._backgroundMigration.oldOpacity : 1)
          : (img?.alpha ?? 0);
      el.style.opacity = String(initial);
      el.addEventListener('error', () => this._degradeLayer(el,
          this.state.imgMap.get(layer.imgId)?.imgPath), {once: true});
      parent.insertBefore(el, this.refs.avgBgOverlay);
      this.bgLayerEls.set(layer.imgId, el);
    }
    if (migrating) this._backgroundMigration = null;
    this._applyVisualZOrder();
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
    } else {
      chara = buildChara(imgId, this.canvasSize);
      this._paintLpic(chara, img, config, {faceId});
    }
    /* comm/ripple 不在此处赋值：注册事件（loadImages/_paintLpic）已按
       img.comm/img.ripple 定死，tween 链路在游戏里从不改它（见
       _setCommunication 注）。此前按「条目缺 comm 即摘框」处理，语料里
       tween 条目 0 例携带 comm ⇒ 通讯框登场一拍就被整批抹掉。 */
    let enter = entering;
    for (const entry of entries) {
      this._blockChara(entry, imgId, chara, enter);
      if (enter) enter = false;
    }
  }

  _tweenLayer(imgId, entries) {
    const el = this.layerEls.get(imgId) ?? this.bgLayerEls.get(imgId);
    if (!el) return;
    for (const entry of entries) this._blockLayer(entry, el, imgId);
  }

  _blockLayer(entry, el, imgId) {
    this.sched.after((entry.delay || 0) * 1000, () => {
      const duration = Number(entry.duration) || 0;
      const hasPos = Array.isArray(entry.pos) && entry.pos.length >= 2
          && entry.pos.slice(0, 2).every(Number.isFinite);
      const hasScale = Array.isArray(entry.scale) && entry.scale.length >= 2
          && entry.scale.slice(0, 2).every(Number.isFinite);
      const hasRot = Array.isArray(entry.rot) && entry.rot.length >= 3
          && entry.rot.slice(0, 3).every(Number.isFinite);
      const transforms = [];
      if (hasScale) transforms.push(`scale(${entry.scale[0]}, ${entry.scale[1]})`);
      if (hasRot) transforms.push(`rotateZ(${entry.rot[2]}deg)`);
      Object.assign(el.style, {
        transition: `opacity ${duration}s ${EASE_OUT_QUAD}, left ${duration}s ${EASE_OUT_QUAD},`
            + ` bottom ${duration}s ${EASE_OUT_QUAD},`
            + ` transform ${duration}s ${EASE_OUT_QUAD}, filter ${duration}s ${EASE_OUT_QUAD}`,
      });
      if (entry.alpha !== undefined) el.style.opacity = entry.alpha;
      if (hasPos) {
        el.style.left = `calc(50% + ${entry.pos[0] / 32}em)`;
        el.style.bottom = `calc(50% + ${entry.pos[1] / 32}em)`;
        el.style.right = null;
        el.style.top = null;
      }
      if (transforms.length) el.style.transform = transforms.join(' ');
      if (entry.isDark !== undefined) {
        el.classList.toggle('dark', entry.isDark === true);
        if (entry.isDark === true) el.style.filter = 'brightness(0.5)';
        else el.style.filter = null;
      }
      if (entry.shake && duration > 0 && typeof el.animate === 'function') {
        this._shakeSeq = (this._shakeSeq || 0) + 1;
        el.animate(
            shakeKeyframes((Number(imgId) || 0) * 131 + this._shakeSeq,
                entry.shakeIntensity),
            {duration: duration * 1000, easing: 'linear', composite: 'add'});
      }
      if (entry.dissolve && duration > 0) {
        el.classList.add('dissolving');
        this.sched.after(duration * 1000, () => el.classList.remove('dissolving'));
      }
      if (el.tagName === 'VIDEO' && entry.alpha > 0) {
        el.play?.().catch?.(() => {});
      }
    });
  }

  /* —— 游戏镜头的非对白演出 —— */

  _applyBgColor(value) {
    /* eBgColor = clear(1) / black(2) / white(3)。写的是游戏五层最底那张 img_bg，
       远景层（DistantView=1）在它之上，所以底色必须落在所有图层的下面：写在
       #avg-bg（= background 容器）上会把整个远景糊掉，背景全走远景层的剧本
       （23sg 15 段 / cpt04_e_01_01）就整段黑屏。clear 退成无行内值，
       由 css/avg.css 的 #avg-stage 底色接手。 */
    const color = {1: '', 2: 'black', 3: 'white'}[value];
    if (color === undefined) return;
    this.refs.avgStage.style.backgroundColor = color;
  }

  /* —— 23sg 专属演出（命运石之门联动）——
     游戏侧真值：res/Assets/Res/LuaScripts/_logic/Game.Avg.SteinsGate.*。
     contentStyle:1 → AvgResUtil.GetAvgDialogRes 落
     「Res/UIPrefabs/Avg/SteinsGateAvgDialog.prefab」整窗替换（74 段）；
     prefab 贴图不在本地素材树（UIPrefab 未提取），对话框皮肤维持标准件，
     这里标记舞台供 css/宿主降级，CRT 终端镜与手机窗按语料还原。 */

  _applyContentStyle(style) {
    this.sgStyle = style === 1 ? 1 : this.sgStyle;
    this.refs.avgStage.classList.toggle('avg-sg', this.sgStyle === 1);
  }

  /* 「OASIS 老电脑终端」全屏镜：sg_theme_001..010 是 23sg_a01 开场世界线
     独白的逐行预烤帧（帧文本与语料 cid10..110 逐行对上；009/010 是删节拍
     与标题变体的备帧）。触发条件在 prefab 侧、语料欠定（a01 本身无
     contentStyle；「开场 Chapter 连排」签名全语料命中 31 段，自动推导必
     误触发），因此按 wire 显式字段 sgMonitorFrame 直驱：运行时真值
     （tools/frida 录制）接入后在映射层标注即可，引擎不猜。 */
  _applySgMonitor(shot) {
    const stage = this.refs.avgStage;
    if (shot.sgMonitorFrame === undefined) {
      stage.classList.remove('sg-monitor');
      this.sgMonitorEl?.classList.remove('show');
      return;
    }
    const frame = `sg_theme_${String(shot.sgMonitorFrame).padStart(3, '0')}.png`;
    const src = this.filePathOf(frame);
    const doc = stage.ownerDocument;
    const el = this.sgMonitorEl ??= (() => {
      const img = doc.createElement('img');
      img.className = 'avg-sg-monitor';
      img.alt = '';
      img.addEventListener('error', () => {
        /* 帧不存在：不是本段的终端镜，退回标准 type1 卡。 */
        img.classList.remove('show');
        img.removeAttribute('src');
        this.refs.avgStage.classList.remove('sg-monitor');
      });
      this.visualLayers.sg.append(img);
      return img;
    })();
    el.dataset.frame = frame;
    el.src = src;
    el.classList.add('show');
    stage.classList.add('sg-monitor');
  }

  /* 手机聊天窗（UISteinsGateAvg）。showSgMobile 开关整窗，hideImmediate 是
     独立的不带动画关闭（语料 23sg_b2s03_5#5 单用）；sendMsg 追加消息泡
     （收信人 = Lang 解引用后的联系人名）；showReceiveNewMsg 弹「新消息」
     横幅（语料无载荷，横幅是通用件 obj_Info）；sendMsgConfirm 是发送键确认
     闪动。窗口隐藏即销毁（DeleteWindow）→ 消息列表清空。 */
  _applySgMobile(m) {
    const doc = this.refs.avgStage.ownerDocument;
    const el = this._sgMobileEl ??= (() => {
      const win = doc.createElement('div');
      win.className = 'avg-sg-mobile';
      win.innerHTML = '<div class="avg-sg-mobile-title"></div>'
          + '<div class="avg-sg-mobile-msgs"></div>'
          + '<div class="avg-sg-mobile-receive">新消息</div>';
      this.visualLayers.sg.append(win);
      return win;
    })();
    const titleEl = el.firstElementChild;
    const msgs = el.children[1];
    const receive = el.lastElementChild;
    const show = () => el.classList.add('show');
    if (m.showSgMobile === false || m.hideImmediate) {
      el.classList.toggle('immediate', !!m.hideImmediate);
      el.classList.remove('show');
      this.sched.after(450, () => {
        if (!el.classList.contains('show')) msgs.replaceChildren();
      });
      return;
    }
    if (m.showSgMobile) {
      titleEl.textContent = '';
      show();
    }
    if (m.showReceiveNewMsg) {
      receive.classList.add('show');
      this.sched.after(2000, () => receive.classList.remove('show'));
    }
    if (m.sendMsgConfirm) {
      el.classList.add('confirm');
      this.sched.after(900, () => el.classList.remove('confirm'));
    }
    if (m.sendMsg && typeof m.sendMsg === 'object') {
      el.classList.remove('immediate');
      show();
      titleEl.textContent = String(m.sendMsg.receiver ?? '');
      const item = doc.createElement('div');
      item.className = 'avg-sg-mobile-item';
      item.innerHTML = '<div class="avg-sg-mobile-contact"></div>'
          + '<div class="avg-sg-mobile-text"></div>';
      item.children[0].textContent = String(m.sendMsg.receiver ?? '');
      item.children[1].textContent = String(m.sendMsg.contentMsg ?? '');
      msgs.append(item);
      /* scrollIntoView 会连页面级滚动一起拽，这里只滚消息列表自己。 */
      msgs.scrollTop = msgs.scrollHeight;
      item.classList.add('sent');
    }
  }

  /* 世界线变动（sgLineChange.worldChangeId）：游戏走
     CameraEffectFunction.SteinLineChange 相机特效并 SetWaitAvgSGAnim 等待。
     网页近似：1.2s 的闪白 + 横向撕裂抖动（时长待实机校准）。 */
  _applySgLineChange() {
    const stage = this.refs.avgStage;
    stage.classList.remove('avg-sg-worldline');
    void stage.offsetWidth;
    stage.classList.add('avg-sg-worldline');
    this.sched.after(1200, () => stage.classList.remove('avg-sg-worldline'));
  }

  _applyPostProcess(ppv) {
    if (!ppv || typeof ppv !== 'object') return;
    const stage = this.refs.avgStage;
    const state = this.ppvState;
    const computed = getComputedStyle(stage);
    const read = (prop, fallback) => {
      const value = Number.parseFloat(computed.getPropertyValue(prop));
      return Number.isFinite(value) ? value : fallback;
    };
    /* 取当前过渡中的值，避免在上一镜的 PPV 还没结束时突然跳回旧终值。 */
    state.saturation = read('--avg-ppv-saturation', state.saturation);
    state.dofFocus = read('--avg-ppv-dof-focus', state.dofFocus);
    state.rgbRadius = stage.classList.contains('avg-rgb-split')
        ? read('--avg-rgb-radius', state.rgbRadius) : 0;

    const changes = [];
    const number = (value, fallback) => {
      const n = Number(value);
      return Number.isFinite(n) ? n : fallback;
    };
    const add = (prop, from, to, duration) => {
      changes.push({prop, from, to, duration: Math.max(0, duration)});
    };
    const saturationInput = ppv.cg?.saturation;
    if (saturationInput !== undefined) {
      const target = Math.max(0, 1 + number(saturationInput, 0) / 100);
      /* AvgPostProcess.lua 对 cg.saturation 固定使用 5 秒 DOTween。 */
      add('--avg-ppv-saturation', state.saturation, target, 5000);
      state.saturation = target;
    }

    const dofTween = ppv.dofTween;
    let dofInput;
    if (dofTween && typeof dofTween === 'object') {
      dofInput = number(dofTween.startValue, NaN);
      if (Number.isFinite(dofInput)) {
        /* 本体：startValue → (1 - startValue) * 0.5，目标恒为 0.5。 */
        const startFocus = (1 - dofInput) * 0.5;
        const duration = number(dofTween.duration, 0) * 1000;
        add('--avg-ppv-dof-focus', state.dofFocus, 0.5, duration);
        add('--avg-ppv-dof-blur', this._dofBlur(state.dofFocus),
            this._dofBlur(0.5), duration);
        /* 起值需要在 transition 开始前写入，不能把 startValue 当 blur。 */
        changes.at(-2).from = startFocus;
        changes.at(-1).from = this._dofBlur(startFocus);
        state.dofFocus = 0.5;
      }
    }

    const rgbTween = ppv.rRgbSTween;
    let rgbInput;
    if (rgbTween && typeof rgbTween === 'object') {
      const show = rgbTween.isShow === true;
      rgbInput = number(rgbTween.blurRadius, 0);
      const duration = number(rgbTween.duration, 0) * 1000;
      const from = state.rgbRadius;
      add('--avg-rgb-radius', from, show ? rgbInput : 0, duration);
      state.rgbRadius = show ? rgbInput : 0;
      state.rgbVisible = show;
      /* 关闭通道时先保持节点到 tween 结束，和 Lua 的 OnComplete 一致。 */
      stage.classList.toggle('avg-rgb-split', show || from > 0);
    }

    if (changes.length) {
      stage.classList.add('avg-ppv');
      stage.style.transition = 'none';
      for (const change of changes) {
        stage.style.setProperty(change.prop, String(change.from));
      }
      /* 让起值先提交；随后写目标值才会触发浏览器的可见过渡。 */
      void stage.offsetWidth;
      stage.style.transition = changes
          .filter((change) => change.duration > 0)
          .map((change) => `${change.prop} ${change.duration}ms ${EASE_OUT_QUAD}`)
          .join(', ') || 'none';
      for (const change of changes) {
        stage.style.setProperty(change.prop, String(change.to));
      }

      const born = this.sched.epoch;
      const tweenSeq = ++this._ppvTweenSeq;
      const timed = changes.filter((change) => change.duration > 0);
      let pending = timed.length;
      const done = () => {
        if (born !== this.sched.epoch || tweenSeq !== this._ppvTweenSeq) return;
        pending--;
        if (pending > 0) return;
        stage.style.transition = null;
        if (!state.rgbVisible) stage.classList.remove('avg-rgb-split');
      };
      if (!pending) done();
      else for (const change of timed) this.sched.after(change.duration, done);
    }

    stage.dataset.ppv = [
      saturationInput !== undefined ? `sat:${saturationInput}` : '',
      rgbInput !== undefined && (state.rgbVisible || rgbInput > 0)
        ? `rgb:${rgbInput}` : '',
      dofInput !== undefined ? `dof:${dofInput} focus:${state.dofFocus}` : '',
    ].filter(Boolean).join(' ');
  }

  _dofBlur(focusDistance) {
    /* 没有深度缓冲时的浏览器降级：焦距只用来推导可见的全局模糊量。
       0.5 是本体目标焦距，达到目标即回到清晰，不把 startValue 当像素。 */
    return Math.max(0, (0.5 - Number(focusDistance || 0)) * 8);
  }

  _effectEntries(effect) {
    if (!effect || typeof effect !== 'object') return [];
    return Object.entries(effect).filter(([key]) => key !== 'stopList');
  }

  _applyEffects(effect) {
    if (!effect || typeof effect !== 'object') return;
    const stop = Array.isArray(effect.stopList) ? effect.stopList : [];
    for (const [id, cfg] of this._effectEntries(effect)) {
      if (!cfg || typeof cfg !== 'object') continue;
      this.effectEls.get(id)?.remove();
      const el = this.refs.avgStage.ownerDocument.createElement('div');
      const prefab = String(cfg.prefabName || id);
      const key = prefab.toLowerCase();
      const asset = this.effectAssetOf?.(prefab);
      const kind = key.includes('hit-knife') ? 'hit-knife'
        : key.includes('smook') || key.includes('smoke') ? 'smoke'
        : key.includes('snow') ? 'snow'
        : key.includes('ripple') || key.includes('wave') ? 'ripple'
        : key.includes('dis') ? 'dissolve'
        /* 一次性件（Unity 里粒子寿命一到全死）：没有这条包络，贴图会一直糊在
           画面上直到 stopList——而语料里多数一次性冲击根本没有 stopList。 */
        : asset?.url && asset.loop === false ? 'burst'
        /* 名字判不出但有素材：走满幅 sheet。.avg-effect-generic 是给缺素材的
           ✳ 占位写的 auto 尺寸，套在有贴图的件上会塌成 0×0。 */
        : asset?.url || asset?.parts?.length ? 'sheet' : 'generic';
      el.className = `avg-effect avg-effect-${kind}`;
      if (kind === 'burst') {
        el.style.animationDuration =
            `${Number(asset.life) || Number(asset.duration) || 200}ms`;
      }
      el.dataset.effectId = id;
      el.dataset.prefab = prefab;
      el.setAttribute('aria-label', prefab);
      /* 语料里的 Lua 数组常把末尾的 z=0 省略；本体仍按
         Vector3.New(x, y, z) 取值，所以二维位置应保留 x/y、z 补 0。 */
      const pos = Array.isArray(cfg.pos) && cfg.pos.length >= 2
          && cfg.pos.slice(0, 2).every(Number.isFinite)
        ? [cfg.pos[0], cfg.pos[1], Number.isFinite(cfg.pos[2]) ? cfg.pos[2] : 0]
        : [0, 0, 0];
      /* effect 是铺满舞台的全屏盒，位置是对整张粒子图的平移，不能再
         translate(-50%,-50%)；否则 x/y 偏移会叠加半个舞台尺寸而跑出屏幕。
         Unity 的 y 轴向上，因此屏幕 top 偏移为 -y。
         索引带 quad 尺寸的 sheet 件例外：盒子会收成以落点为中心的正方形，
         所以下面 sheet 分支改写成了 calc(50% + …)。 */
      el.style.left = `${(Number(pos[0]) || 0) / 32}em`;
      el.style.top = `${-(Number(pos[1]) || 0) / 32}em`;
      const layer = Math.min(3, Math.max(1, Number(cfg.layer) || 2));
      const z = Number(pos[2]) || 0;
      el.dataset.posZ = String(z);
      el.style.setProperty('--avg-effect-z', `${z}px`);
      /* layer 仍是 Unity parent 的第一排序键，z 只在 parent 内细分。 */
      el.style.zIndex = String(layer * 100000 + Math.round(z));
      const parent = this.visualLayers.effectHosts?.[layer - 1]
          ?? this.visualLayers.effects;
      if (asset?.parts?.length) {
        el.dataset.parts = String(asset.parts.length);
        for (const [partIndex, part] of asset.parts.entries()) {
          if (!part?.url) continue;
          const sprite = el.ownerDocument.createElement('span');
          sprite.className = 'avg-effect-part';
          if (part.className) sprite.classList.add(part.className);
          sprite.dataset.part = String(partIndex);
          sprite.style.opacity = String(part.opacity ?? asset.opacity ?? 1);
          sprite.style.mixBlendMode = part.blendMode || asset.blendMode || 'screen';
          this._paintEffectSprite(sprite, part.url,
              Number(part.columns) || 1, Number(part.rows) || 1, part.tint,
              part.maskMode);
          /* billboard 粒子是正方形 quad，尺寸来自预制件；没有尺寸的旧索引才退回
             按舞台百分比摆（那种情况下贴图会被拉成舞台比例）。 */
          const side = fxQuadEm(part.size);
          sprite.style.width = side === null ? `${Number(part.width) || 100}%` : `${side}em`;
          sprite.style.height = side === null ? `${Number(part.height) || 100}%` : `${side}em`;
          sprite.style.left = `${Number(part.left) || 50}%`;
          sprite.style.top = `${Number(part.top) || 50}%`;
          const rotate = Number(part.rotate) || 0;
          const scale = Number(part.scale) || 1;
          sprite.style.transform =
              `translate(-50%, -50%) rotate(${rotate}deg) scale(${scale})`;
          const dur = Number(part.duration) || Number(asset.duration) || 0;
          if (dur > 0) sprite.style.animationDuration = `${dur}ms`;
          el.append(sprite);
        }
      } else if (asset?.url) {
        const side = fxQuadEm(asset.size);
        if (side !== null) {
          /* 尺寸给外层：子件与 .avg-effect-smoke 那层渐变底都跟着收，
             left/top 50% 是相对整舞台盒的，所以要减掉半个盒。 */
          el.style.width = el.style.height = `${side}em`;
          el.style.left = `calc(50% + ${(pos[0] / 32 - side / 2)}em)`;
          el.style.top = `calc(50% + ${(-pos[1] / 32 - side / 2)}em)`;
        }
        const sprite = el.ownerDocument.createElement('span');
        sprite.className = 'avg-effect-sprite';
        const columns = Math.max(1, Number(asset.columns) || 1);
        const rows = Math.max(1, Number(asset.rows) || 1);
        this._paintEffectSprite(sprite, asset.url, columns, rows, asset.tint,
            asset.maskMode);
        sprite.style.opacity = String(asset.opacity ?? 1);
        sprite.style.mixBlendMode = asset.blendMode || 'screen';
        el.dataset.asset = asset.url;
        el.dataset.frames = String(Math.max(1,
            Number(asset.frames) || columns * rows));
        el.append(sprite);
        this._animateEffectSprite(sprite, asset, columns, rows,
            asset.loop !== false);
      } else if (kind === 'generic') {
        el.textContent = '✳';
      }
      parent.append(el);
      this.effectEls.set(id, el);
      /* 本体不按粒子 duration 自动销毁 GameObject；生命周期由 stopList
         的 StopAvgEffect 明确控制。粒子/序列帧播完后节点保留到 stopList。 */
    }
    /* 顺序照 UINAvgEffectNode：先 pairs(effectCfg) 建/播，再 pairs(stopList) 停。
       同槽同镜「又开又停」因此结果是停（Test 段镜 14 就是这个形状）。 */
    for (const id of stop) {
      this.effectEls.get(String(id))?.remove();
      this.effectEls.delete(String(id));
    }
  }

  /* 粒子色在 Unity 里是 texture × startColor。染色件因此不能画贴图本身，
     而要拿颜色层被贴图当 mask 剪形——filter 的色相近似会连高光一起偏。 */
  _paintEffectSprite(sprite, url, columns, rows, tint, maskMode) {
    const size = `${columns * 100}% ${rows * 100}%`;
    if (!tint) {
      sprite.style.backgroundImage = `url("${url}")`;
      sprite.style.backgroundSize = size;
      sprite.style.backgroundRepeat = 'no-repeat';
      return;
    }
    sprite.style.backgroundColor = String(tint);
    const mask = `url("${url}")`;
    sprite.style.maskImage = mask;
    sprite.style.maskSize = size;
    sprite.style.maskRepeat = 'no-repeat';
    sprite.style.webkitMaskImage = mask;
    sprite.style.webkitMaskSize = size;
    sprite.style.webkitMaskRepeat = 'no-repeat';
    /* 黑底发光图的 alpha 全平，按 alpha 剪形会剪出满矩形（整块纯色）；
       Unity 那种图是按亮度相乘的。 */
    if (maskMode) {
      sprite.style.maskMode = String(maskMode);
      sprite.style.webkitMaskMode = String(maskMode);
    }
  }

  _animateEffectSprite(sprite, asset, columns, rows, loop) {
    const frames = Math.min(columns * rows,
        Math.max(1, Number(asset.frames) || columns * rows));
    const duration = Math.max(1, Number(asset.duration) || 1000);
    if (typeof sprite.animate !== 'function' || frames < 2) return;
    const frame = (i) => {
      const x = columns === 1 ? 0 : (i % columns) * 100 / (columns - 1);
      const y = rows === 1 ? 0 : Math.floor(i / columns) * 100 / (rows - 1);
      const at = `${x}% ${y}%`;
      /* 染色件走 mask，逐帧要挪 mask-position；两条都给，未用的那条被忽略。 */
      return {backgroundPosition: at, maskPosition: at};
    };
    sprite.animate(Array.from({length: frames}, (_, i) => frame(i)), {
      duration: duration * (frames > 1 && asset.durationIsPerFrame ? frames : 1),
      iterations: loop ? Infinity : 1,
      easing: 'steps(1, end)',
    });
  }

  _videoPath(path) {
    if (!path) return null;
    return this.videoPathOf?.(path) ?? null;
  }

  _playVideo(path, {loop = false, loopFrame = null} = {}) {
    const src = this._videoPath(path);
    const host = this.visualLayers.movie;
    this._cancelVideoWait?.();
    this._cancelVideoWait = null;
    host.replaceChildren();
    const video = host.ownerDocument.createElement('video');
    video.className = 'avg-video';
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.loop = loop;
    /* 媒体元素有自己的时钟，Scheduler 压不到它：不提 playbackRate 的话
       倍速通读会在一整段 PV 上原地堵住（Chrome 实现上限 16×）。 */
    video.playbackRate = Math.min(this.rate, 16);
    host.append(video);
    if (!src) {
      /* 缺件的视频面时长按 0 计，随镜结束即撤：否则 #20 这类 PV 缺件镜的
         占位纹会一直糊在 Movie 层上，把后面没有视频的镜（e_01_01 #21 起
         本该显现的 bg）整个盖住。 */
      video.remove();
      return Promise.resolve();
    }
    video.src = src;
    if (Array.isArray(loopFrame) && loopFrame.length >= 2) {
      video.addEventListener('timeupdate', () => {
        if (video.currentTime >= loopFrame[1]) video.currentTime = loopFrame[0];
      });
    }
    const done = new Promise((resolve) => {
      const finish = () => {
        /* 播完/失败即撤面，对应游戏 MovieManager 完成回调里的销毁；
           跨镜存续的是 images 里注册的 imgType-5 条目（走 _loadVisualLayer）。 */
        video.remove();
        if (this._cancelVideoWait === cancel) this._cancelVideoWait = null;
        resolve();
      };
      const cancel = () => finish();
      this._cancelVideoWait = cancel;
      video.addEventListener('ended', finish, {once: true});
      video.addEventListener('error', finish, {once: true});
    });
    video.play?.().catch?.(() => {});
    return loop ? Promise.resolve() : this._track(done);
  }

  async _manageAux(shot) {
    if (shot.bgColor !== undefined) this._applyBgColor(shot.bgColor);
    if (shot.ppv) this._applyPostProcess(shot.ppv);
    if (shot.effect) this._applyEffects(shot.effect);
    /* 23sg 专属演出（contentStyle 74 段 / sgMobile 16 段 / sgLineChange 4 段；
       游戏侧 AvgSteinsGate.PlayAvgActSG）。contentStyle 粘滞，其余逐镜生效。 */
    if (shot.contentStyle !== undefined) this._applyContentStyle(shot.contentStyle);
    if (shot.sgMobile !== undefined) this._applySgMobile(shot.sgMobile);
    if (shot.sgLineChange !== undefined) this._applySgLineChange(shot.sgLineChange);
    this._applySgMonitor(shot);
    /* 游戏的 hasVideo 分支只在本镜没有 content/branch 时独占推进门；有
       对白的镜头仍先展示对白，下一次推进再处理视频。 */
    if (shot.vedioPath && !shot.content && !shot.branch) {
      const video = this._playVideo(shot.vedioPath, {
        loop: false,
        loopFrame: shot.vedioLoopFrame,
      });
      if (this.sched.timer === REAL_TIMER) await video;
      else this._cancelVideoWait?.(); /* seek 虚拟钟不真等媒体时长 */
    } else if (shot.vedioLoopPath) {
      this._playVideo(shot.vedioLoopPath, {
        loop: !shot.vedioLoopStop,
        loopFrame: shot.vedioLoopFrame,
      });
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
      const hasRot = Array.isArray(entry.rot) && entry.rot.length >= 3
          && entry.rot.slice(0, 3).every(Number.isFinite);
      const backToSlot = isValidPos(entry.posId)
          && !chara.classList.contains('img-missing');  /* 占位盒的行内居中不清 */
      /* 槽位镜像（AvgHeroN.scale[0] < 0）写在 .posN 类规则的 transform 里，
         而行内 transform 会整条覆盖该类规则 ⇒ 带 scale 的条目必须自己把符号
         乘回去，否则镜像槽一遇缩放条目就翻正。游戏侧只有一个 HeroItem 节点
         同时承载槽位符号与补间量级（实机 lane.x 既见过 -1 也见过 1.4），
         故按相乘建模。 */
      const config = (hasScale || hasRot) ? this.layouts.get(imgId) : null;
      const slotId = isValidPos(entry.posId) ? entry.posId
          : (isValidPos(Number(chara.dataset.posId)) ? Number(chara.dataset.posId) : null);
      const slotSign = slotId === null ? 1 : slotMirrorSign(config, slotId);
      /* alpha 缺省 = 保持：不写 opacity（CSSOM 忽略 undefined 会碰巧继承，
         这里改成显式不写，语义与 reducer 的继承口径一致）。入场没有
         现值可继承，按新 lane 的初始 0 显式钉住。 */
      const style = {
        /* 带 pos/scale 的条目多出 bottom/transform 过渡轴，移动/缩放才动画。 */
        transition: (hasPos || hasScale || hasRot)
            ? `opacity ${duration}s ${EASE_OUT_QUAD}, left ${duration}s ${EASE_OUT_QUAD},`
                + ` bottom ${duration}s ${EASE_OUT_QUAD},`
                + ` transform ${duration}s ${EASE_OUT_QUAD}, filter ${duration}s ${EASE_OUT_QUAD}`
            : `opacity ${duration}s ${EASE_OUT_QUAD}, left ${duration}s ${EASE_OUT_QUAD},`
                + ` filter ${duration}s ${EASE_OUT_QUAD}`,
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
      if (hasScale || hasRot) {
        if (config) {   /* 缺标定件走占位，缩放数学无依据，跳过 */
          const fontSize = parseFloat(getComputedStyle(this.container).fontSize);
          const t = baseTranslate(config, {width: this.container.clientWidth,
            height: this.container.clientHeight, fontSize});
          const transform = [`translate(${t.x}em, ${t.y}em)`];
          if (hasScale) transform.push(
              `scale(${entry.scale[0] * slotSign}, ${entry.scale[1]})`);
          else if (slotSign !== 1) transform.push(`scale(${slotSign}, 1)`);
          if (hasRot) transform.push(`rotateZ(${entry.rot[2]}deg)`);
          style.transform = transform.join(' ');
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
      /* 赋值不是翻转：条目不带 isDark 时不碰明暗（与 state.js 折叠同口径；
         旧写法在 isDark 缺省时把 undefined 与 false 相比，白翻一次）。 */
      if (entry.isDark !== undefined) {
        chara.classList.toggle('dark', entry.isDark === true);
      }
      if (entering) {
        this.refs.avgCharas.append(chara);
        this._applyZOrder();    /* 元素此刻才存在，z 序要补一次 */
      }
      /* 抖动是瞬时效应，不改进入行的任何落定态：composite:'add' 叠在基础
         transform 上，fill 默认 none ⇒ 播完自动消失，夹具对拍不受扰。 */
      if (entry.shake && duration > 0 && typeof chara.animate === 'function') {
        this._shakeSeq = (this._shakeSeq || 0) + 1;
        chara.animate(
            shakeKeyframes((Number(imgId) || 0) * 131 + this._shakeSeq, entry.shakeIntensity),
            {duration: duration * 1000, easing: 'linear', composite: 'add'});
      }
      if (entry.dissolve && duration > 0) {
        chara.classList.add('dissolving');
        this.sched.after(duration * 1000, () => chara.classList.remove('dissolving'));
      }
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
    const shot = this.scene[this.shotId];
    /* 游戏在对白完成回调之后才切入 vedioPath。等待门与 _manageAux 的
       无对白视频一致；seek/clearStage 用 epoch 杀掉陈旧回调。 */
    if (shot?.vedioPath && !this._videoStarted) {
      this._videoStarted = true;
      const epoch = this.sched.epoch;
      const video = this._playVideo(shot.vedioPath, {loop: false,
        loopFrame: shot.vedioLoopFrame}).then(() => {
        if (epoch === this.sched.epoch && this.scene?.[this.shotId] === shot) {
          this._lineFinished();
        }
      });
      if (this.sched.timer !== REAL_TIMER) this._cancelVideoWait?.();
      void video;
      return;
    }
    if (this.refs.avgDialog.classList.contains('type5')) {
      const hold = Number(shot?.tipsShowDuration);
      this.sched.after((Number.isFinite(hold) && hold > 0 ? hold * 1000 : 500),
          () => this.refs.avgDialog.classList.add('fade-out'));
    }
    /* 镜级文字震：游戏在 OnChapterTextTweenComplete 里对文本节点做
       DOShakePosition(0.4, Vector3(10,10,0), 20)，与条目级 shake 是两套通道，
       所以挂在行尾回调而不是 _blockChara。 */
    if (shot?.contentShake && typeof this.refs.avgLine.animate === 'function') {
      this._shakeSeq = (this._shakeSeq || 0) + 1;
      this.refs.avgLine.animate(
          shakeKeyframes(Number(this.shotId) * 17 + this._shakeSeq),
          {duration: 400, easing: 'linear', composite: 'add'});
    }
    this.shotEnd = true;
    this.readingLine = false;
    /* 参考 readLine/typeWriteScrambled 的行尾：自动播放每 2s 续一帧。 */
    if (this.autoPlaying && !this.playEnd) {
      this.toAutoPlay = true;
      this.autoPlayHandle = this.sched.after(AUTO_LINE_DELAY,
          () => this._prepareAutoPlay());
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
    this._videoStarted = false;
    if (shot.isEnd || !(shot?.nextId || this.scene[this.shotId + 1])) {
      this.playEnd = true;
    }
    this.shotEnd = false;
    /* 倍速下每镜只剩几百毫秒，逐句起 CV/sfx 只会糊成杂音：只留 bgm。 */
    if (this.rate > 1) this.audio?.bgmOnly(shot);
    else this.audio?.shot(shot);
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
        await this._manageAux(shot);
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

  /* 公开选支入口（录制器自动选第一项 / 宿主脚本化推进）：与点击选项
     同一落点——回廊打 selected + playShot(jumpAct)。非分支镜上静默忽略。 */
  chooseBranch(index) {
    if (this.scene?.[this.shotId]?.branch) this._chooseBranch(index);
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
        this.autoPlayHandle = this.sched.after(AUTO_START_DELAY,
            () => this._prepareAutoPlay());
      }
    }
  }

  /* 预览倍速（净新增，参考无此行为）：唯一收口点是 Scheduler.rate，
     打字 tick、串行门、自动节拍、type5 停留、runtime 帧一并压缩。
     不吃这份钟的是 CSS 过渡与 WAAPI（真实文档时间线），所以 10× 下
     演出会跑在画面前面——快速通读要的就是这个取舍。 */
  get rate() {
    return this.sched.rate;
  }

  setRate(rate) {
    this.sched.rate = rate > 1 ? rate : 1;
    /* 已挂起的那一拍按新速率重排，否则切换要等满旧时长才见效。 */
    if (this.toAutoPlay) {
      this.sched.clear(this.autoPlayHandle);
      this.autoPlayHandle = this.sched.after(AUTO_LINE_DELAY,
          () => this._prepareAutoPlay());
    }
  }

  /* —— 收尾（参考 clearStage:393）—— */

  clearStage() {
    this.sched.bump();
    this._cancelVideoWait?.();
    this._cancelVideoWait = null;
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
    this.layerEls.clear();
    this.bgLayerEls.clear();
    this.effectEls.clear();
    this._ppvTweenSeq++;
    this._runtimeSeq++;
    this._runtimeShot = null;
    this._runtimeObjects.clear();
    this._runtimeBindings = [];
    this.ppvState = {
      saturation: 1,
      dofFocus: 0.5,
      rgbRadius: 0,
      rgbVisible: false,
    };
    this.currentBgId = null;
    this._videoStarted = false;
    this.sgStyle = null;
    this.sgMonitorEl = null;
    this._sgMobileEl = null;
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
