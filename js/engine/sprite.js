/* sprite.js —— 立绘的规则表 + 画布合成。
   几何（em 尺寸）与画布分辨率**无关**：宽高 = sizeDelta·|m_LocalScale|/2，
   再 ÷16 得 em；left/bottom = AvgHeroN.pos ÷32；平移量按舞台尺寸算。
   这套公式已被冻结表第 4 检逐立绘验证过（42 个全命中），所以这里生成的规则
   可以直接和冻结表的 charaRules 对拍。
   画布分辨率按 R3 定 1024（参考是 2048，数学等价：2048→CANVAS、1024→CANVAS/2、
   4096→2·CANVAS），Persicaria 盒子 806px 仍有 1.27× 超采样，省一半以上显存。
   参考用 jQuery 的 $(canvas).prop({width,height})，这里直接赋 canvas.width/height。 */

export const CANVAS = 1024;
export const SPRITE_SLOTS = [101, 103, 105, 107, 109];

export function sizeDeltaOf(config) {
  const sd = config.sizeDelta;
  return Array.isArray(sd) ? sd[1] : sd;
}

/* 立绘盒子边长（逻辑像素）。参考的 ÷2 规则。 */
export function imgSizeOf(config) {
  return sizeDeltaOf(config) * Math.abs(config.m_LocalScale) / 2;
}

/* 立绘盒子的基础位移（把画布中心挪到舞台坐标原点的平移量）。
   规则表与播放器的行内 pos/scale transform 共用，口径必须一致。 */
export function baseTranslate(config, stage) {
  const imgSize = imgSizeOf(config);
  const {width: stageWidth, height: stageHeight, fontSize} = stage;
  return {
    x: stageWidth / (2 * fontSize) - imgSize / 32,
    y: imgSize / 32 - stageHeight / (2 * fontSize),
  };
}

/* 槽位镜像符号：`AvgHeroN.scale[0] < 0` ⇒ 该槽要左右翻。全部 2490 个槽位里
   只有 [1,1] 与 [-1,1] 两种，所以这个符号就是镜像开关。
   实机定案（2026-09-02，Frida 钩活的 Lua VM）：净镜像 = sign(HeroItem.localScale.x)，
   由「槽位符号 × scale 条目的补间量级」相乘得到；立绘根的负 `m_LocalScale`
   会被引擎运行时补的 180° Y 旋转抵消，**不参与**镜像判定（故尺寸仍用
   Math.abs）。行内 transform 会整条覆盖 .posN 类规则的 transform ⇒ 播放器写
   scale 条目时必须把这个符号乘回 X 分量，否则镜像槽一遇缩放条目就翻正。 */
export function slotMirrorSign(config, posId) {
  const hero = config?.['AvgHero' + posId];
  return hero?.scale && hero.scale[0] < 0 ? -1 : 1;
}

/* 震屏抖动。游戏侧是 `transform:DOShakePosition(duration,
   Vector3(10,10,0) * (shakeIntensity or 1), 20 * shakeIntensity)`
   —— 振幅 10·si 设计单位、约 20·si 次振荡、随时间衰减。DOTween 的随机曲线
   无法逐帧复刻，这里复刻的是可观测特征，并用线性同余按 seed 定种，
   使同一镜重放逐字节一致（夹具对拍要求可复现）。单位沿用本模块口径：÷32 得 em。 */
export function shakeKeyframes(seed, intensity) {
  const si = intensity || 1;
  const amp = 10 * si;
  const vibrato = Math.min(96, Math.max(6, Math.round(20 * si)));
  let s = (seed >>> 0) || 1;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x3fffffff - 1;                 /* [-1, 1) */
  };
  const frames = [];
  for (let i = 0; i <= vibrato; i++) {
    const decay = 1 - i / vibrato;
    frames.push({transform: `translate(${(rnd() * amp * decay / 32).toFixed(4)}em,`
        + ` ${(rnd() * amp * decay / 32).toFixed(4)}em)`});
  }
  frames.push({transform: 'translate(0em, 0em)'});
  return frames;
}

/* —— 单个立绘的 CSS 规则（参考 presetCharaImgStyle:228 的移植）——
   顺序固定为「基础盒 → 通讯框 → pos1..5」，与参考一致；多立绘时由调用方按
   imgId 排序拼接（参考的顺序是网络竞态，见冻结结论，这里改成可复现）。 */
export function charaRulesFor(imgId, config, stage) {
  const imgSize = imgSizeOf(config);
  const {fontSize} = stage;
  const t = baseTranslate(config, stage);
  const transform =
      `transform: translate(${t.x.toFixed(4)}em, ${t.y.toFixed(4)}em)`;
  const styles = [];
  styles.push(`.avg-chara[data-img-id="${imgId}"] {\n`
      + `  height: ${(imgSize / 16).toFixed(4)}em;\n`
      + `  ${transform};\n`
      + `  width: ${(imgSize / 16).toFixed(4)}em;\n}\n`);
  const commTransform =
      `transform: translate(${(imgSize / (2 * fontSize) - 331 / 32).toFixed(4)}em,`
      + `${(462 / 32 - imgSize / (2 * fontSize)).toFixed(4)}em)`;
  const commPos = config.avgCommPos;
  styles.push(`.avg-chara[data-img-id="${imgId}"] div {\n`
      + `  bottom: ${commPos[1] / 32}em;\n`
      + `  height: ${462 / 16}em;\n`
      + `  left: ${commPos[0] / 32}em;\n`
      + `  ${commTransform};\n`
      + `  width: ${331 / 16}em;\n}\n`);
  for (let i = 1; i <= 5; i++) {
    const hero = config['AvgHero' + i];
    if (!hero) continue;
    const scale = hero.scale;
    const toScale = scale[0] != 1.0 || scale[1] != 1.0;
    styles.push(`.avg-chara.pos${i}[data-img-id="${imgId}"] {\n`
        + `  bottom: ${hero.pos[1] / 32}em;\n`
        + `  left: ${hero.pos[0] / 32}em;`
        + `${toScale ? `\n${transform} scale(${scale[0]}, ${scale[1]})` : ''}\n}\n`);
  }
  return styles.join('\n');
}

/* 整表重建：按 imgId 升序输出，可复现、可 diff。 */
export function buildCharaRules(entries, stage) {
  return [...entries]
      .sort((a, b) => Number(a.imgId) - Number(b.imgId))
      .map(({imgId, config}) => charaRulesFor(imgId, config, stage))
      .join('');
}

/* 脸部区域（参考 calculateFaceArg:698，按画布尺寸缩放）。
   返回 [x, y, w, h]，用于换脸的 clearRect / drawImage / getImageData。
   deriveLayout 的起点配置没有脸部数据（avgFaceSize 为 null）→ 返回 null，
   标定之前禁止换脸。 */
export function faceRegion(config, canvasSize = CANVAS) {
  const sizeDelta = sizeDeltaOf(config);
  const faceSize = config.avgFaceSize;
  if (!faceSize) return null;
  const [fx, fy] = config.avgFacePos;
  const half = canvasSize / 2;
  return [
    half * ((sizeDelta - faceSize + 2 * fx) / sizeDelta),
    half * ((sizeDelta - faceSize - 2 * fy) / sizeDelta),
    canvasSize * faceSize / sizeDelta,
    canvasSize * faceSize / sizeDelta,
  ];
}

/* 把立绘原图绘进画布（参考 tweenChara 的 onload 分支，按画布尺寸缩放）。
   comm=true 走通讯框裁切数学（参考写了两遍、此处合并为一份）。 */
export function compositeBody(context, charaImg, config, {comm = false, canvasSize = CANVAS} = {}) {
  const half = canvasSize / 2;
  let sizeDelta = config.sizeDelta;
  if (!Array.isArray(sizeDelta)) sizeDelta = [sizeDelta, sizeDelta];
  if (comm) {
    const coeffX = (2 * canvasSize) / (sizeDelta[0] * Math.abs(config.m_LocalScale));
    const coeffY = (2 * canvasSize) / (sizeDelta[1] * Math.abs(config.m_LocalScale));
    const coeffX2 = canvasSize / charaImg.width;
    const coeffY2 = canvasSize / charaImg.height;
    const paramsS = [
      (half - (300 - config.avgCommPos[0]) * coeffX / 2) / coeffX2,
      (half - (426 + config.avgCommPos[1]) * coeffY / 2) / coeffY2,
      300 * coeffX / coeffX2, 426 * coeffY / coeffY2,
    ];
    const paramsD = [paramsS[0] * coeffX2, paramsS[1] * coeffY2,
                     paramsS[2] * coeffX2, paramsS[3] * coeffY2];
    context.drawImage(charaImg, ...paramsS, ...paramsD);
  } else {
    const coeffX = canvasSize * sizeDelta[0] / (charaImg.width * sizeDelta[1]);
    const coeffY = canvasSize / charaImg.height;
    context.drawImage(
        charaImg,
        half - charaImg.width * coeffX / 2,
        half - charaImg.height * coeffY / 2,
        charaImg.width * coeffX,
        charaImg.height * coeffY);
  }
}

/* 换脸（参考 drawFace:581）。faceId 为空 → 还原默认脸（putImageData）。
   filePathOf 把文件名解析成同源 url（参考 getFilePath）。
   参考是 fire-and-forget，这里额外返回 promise（加载完才 resolve），
   供自检/标定等待；老用法不 await 行为不变。 */
export function drawFace(context, config, faceId, region, {filePathOf, defaultFace} = {}) {
  if (faceId) {
    return new Promise((resolve) => {
      const face = new Image(256, 256);
      face.onload = () => {
        context.clearRect(...region);
        context.drawImage(face, ...region);
        resolve();
      };
      face.onerror = () => resolve();
      face.src = filePathOf(faceId);
    });
  }
  if (defaultFace) {
    const arg = region.slice(0, 2).map(Math.floor)
        .concat(region.slice(2).map(Math.ceil));
    context.clearRect(...arg);
    context.putImageData(defaultFace, ...arg.slice(0, 2));
  }
  return Promise.resolve();
}

/* 造一个 `.avg-chara`（含画布）。posId/dark 等状态由播放器按冻结结论的
   「累积翻转」语义另行驱动，这里只给结构。 */
export function buildChara(imgId, canvasSize = CANVAS) {
  const chara = document.createElement('div');
  chara.className = 'avg-chara';
  const canvas = document.createElement('canvas');
  canvas.width = canvasSize;
  canvas.height = canvasSize;
  chara.append(canvas);
  chara.dataset.imgId = String(imgId);
  return chara;
}

/* 不透明包围盒（原图像素坐标系）。deriveLayout 的地基：
   扫 alpha>0 的像素。工作画布限到 maxSide 以内省扫描量，结果换算回原图尺度。 */
export function opaqueBounds(image, {maxSide = 1024} = {}) {
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  const w = Math.max(1, Math.round(image.width * scale));
  const h = Math.max(1, Math.round(image.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const context = canvas.getContext('2d', {willReadFrequently: true});
  context.drawImage(image, 0, 0, w, h);
  const data = context.getImageData(0, 0, w, h).data;
  let minX = w; let minY = h; let maxX = -1; let maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (data[(row + x) * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) {
    return {left: 0, top: 0, right: image.width, bottom: image.height,
            width: image.width, height: image.height, empty: true};
  }
  return {
    left: minX / scale,
    top: minY / scale,
    right: (maxX + 1) / scale,
    bottom: (maxY + 1) / scale,
    width: (maxX + 1 - minX) / scale,
    height: (maxY + 1 - minY) / scale,
  };
}

/* 三份已知 layout 的「显示身高」（imgSize·不透明高/2048）= 784.4/823.8/766.6，
   聚在 790 附近 —— 从 lpic 包围盒反推整体缩放的锚点。 */
export const DERIVE_TARGET_HEIGHT = 790;

/* 从 lpic 反推 layout 起点（仅整体缩放可靠；槽位/通讯框给三份已知件的
   中位默认值；脸部无从推导置 null，标定前禁换脸）。
   合成数学按高撑满画布：显示身高 = imgSize·opaqueH/2048，
   反解 sizeDelta·|m_LocalScale| = 2·targetHeight·2048/opaqueH。 */
export function deriveLayout(image, {targetHeight = DERIVE_TARGET_HEIGHT} = {}) {
  const bounds = opaqueBounds(image);
  const opaqueH = bounds.height / image.height * 2048;
  const product = 2 * targetHeight * 2048 / opaqueH;
  return {
    sizeDelta: 1024,
    m_LocalScale: product / 1024,
    AvgHero1: {pos: [-455, -430], scale: [1, 1]},
    AvgHero2: {pos: [-380, -430], scale: [1, 1]},
    AvgHero3: {pos: [0, -430], scale: [1, 1]},
    AvgHero4: {pos: [380, -430], scale: [1, 1]},
    AvgHero5: {pos: [455, -430], scale: [1, 1]},
    avgCommPos: [0, 430],
    avgCommScale: 1.65,
    avgFaceSize: null,
    avgFacePos: null,
    derived: true,
  };
}
