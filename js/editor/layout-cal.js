/* layout-cal.js —— M8 立绘标定工具。
   所见即所得的关键：预览不另画近似图，而是把播放器那套数学原样搬进来——
   charaRulesFor 生成真规则、compositeBody 合成真画布、槽位标记用同款
   left/bottom = pos/32em 公式摆放（pos = 2×舞台像素，M3 的逆运算）。
   标定完保存进 AssetRegistry（IDB kv layout:<id>），预览 Player 的
   layoutOf 立刻走 calibrated 分支——所见即所存。

   起点三来源：已标定件 > 仓库已知 layout > deriveLayout（⚠ 提示槽位与
   脸框是启发式默认值，必须人工确认）。
   交互：点选槽位 → 直接拖拽或数字微调；身高滑杆（反解 m_LocalScale，
   deriveLayout 同款公式）；脸框/通讯框数值；朝向镜像。 */

import {h, clear} from '../ui/dom.js';
import {charaRulesFor, compositeBody, faceRegion, CANVAS, deriveLayout,
  imgSizeOf, sizeDeltaOf} from '../engine/sprite.js';

const STAGE = {width: 1200, height: 540, fontSize: 16};
const PX_PER_EM = 16;
const posOf = (px) => Math.round(px * 32 / PX_PER_EM);

export async function mountCal(root, registry, {id, onSaved}) {
  clear(root);
  const state = {layout: null, source: '?', bitmap: null, opaqueH: 2048, selected: 3};

  const styleEl = document.createElement('style');
  const info = h('div.cal-info');
  const stageBox = h('div.cal-stagebox');
  const stage = h('div.cal-stage');
  const chara = h('div.avg-chara', {dataset: {imgId: 'cal'}});
  const canvas = document.createElement('canvas');
  canvas.width = CANVAS;
  canvas.height = CANVAS;
  chara.append(canvas);
  stage.append(chara);
  stageBox.append(stage);
  const controls = h('div.cal-controls');
  root.append(styleEl, info, stageBox, controls);

  function applyLayout() {
    const layout = state.layout;
    styleEl.textContent = charaRulesFor('cal', layout, STAGE);
    for (const m of [...stage.querySelectorAll('.cal-slot,.cal-face')]) m.remove();
    for (let i = 1; i <= 5; i++) {
      const hero = layout['AvgHero' + i];
      if (!hero) continue;
      const dot = h('button.cal-slot', {
        dataset: {slot: i},
        style: {
          left: `${hero.pos[0] / 32 * PX_PER_EM}px`,
          bottom: `${hero.pos[1] / 32 * PX_PER_EM}px`,
        },
        text: String(i),
      });
      if (i === state.selected) dot.classList.add('selected');
      stage.append(dot);
    }
    const size = imgSizeOf(layout);
    const region = faceRegion(layout, CANVAS);
    if (region) {
      stage.append(h('div.cal-face', {
        style: {
          left: `${region[0] / size * 100}%`,
          top: `${region[1] / size * 100}%`,
          width: `${region[2] / size * 100}%`,
          height: `${region[3] / size * 100}%`,
        },
      }));
    }
    const hero = layout['AvgHero' + state.selected] ?? {pos: [0, 0]};
    const footY = STAGE.height - hero.pos[1] / 32 * PX_PER_EM;
    const shown = size * state.opaqueH / 2048;
    info.textContent = `来源=${state.source} · 显示身高=${shown.toFixed(0)}px`
        + ` · pos${state.selected} 脚底舞台 y=${footY.toFixed(0)}px`
        + `（成人参考 740±25）`
        + (layout.derived ? ' · ⚠ 启发式起点，请确认槽位与脸框' : '');
    renderControls();
  }

  function repaintBitmap() {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, CANVAS, CANVAS);
    if (state.bitmap) {
      compositeBody(ctx, state.bitmap, state.layout, {canvasSize: CANVAS});
    }
  }

  /* —— 拖拽 —— */
  let dragging = null;
  stage.addEventListener('pointerdown', (e) => {
    const slot = e.target.closest?.('.cal-slot');
    if (!slot) return;
    dragging = Number(slot.dataset.slot);
    state.selected = dragging;
    slot.setPointerCapture(e.pointerId);
    applyLayout();
  });
  stage.addEventListener('pointermove', (e) => {
    if (dragging === null) return;
    const r = stage.getBoundingClientRect();
    const k = r.width / STAGE.width;
    const x = (e.clientX - r.left) / k;
    const y = (r.height - (e.clientY - r.top)) / k;
    state.layout['AvgHero' + dragging].pos = [posOf(x), posOf(y)];
    applyLayout();
  });
  stage.addEventListener('pointerup', () => { dragging = null; });

  /* —— 控件 —— */
  function num(label, value, step, on) {
    const inp = h('input', {type: 'number', value: String(Math.round(value)), step});
    inp.addEventListener('change', () => on(Number(inp.value)));
    return h('label.cal-num', {}, label, inp);
  }

  function renderControls() {
    const layout = state.layout;
    const hero = layout['AvgHero' + state.selected];
    clear(controls);
    if (!hero) return;
    controls.append(
        h('div.cal-row', {},
            h('b', {text: `槽位 ${state.selected}：`}),
            num('x', hero.pos[0], 10, (v) => {hero.pos[0] = v; applyLayout();}),
            num('y', hero.pos[1], 10, (v) => {hero.pos[1] = v; applyLayout();}),
            h('label', {}, h('input', {
              type: 'checkbox', checked: hero.scale[0] < 0,
              onchange: (e) => {hero.scale[0] = e.target.checked ? -1 : 1; applyLayout();},
            }), ' 镜像'),
            h('label', {}, h('input', {
              type: 'checkbox', checked: !!layout.derived,
              onchange: (e) => {layout.derived = e.target.checked; applyLayout();},
            }), ' 未标定⚠')),
        h('div.cal-row', {},
            h('label', {}, '显示身高 ', h('input', {
              type: 'range', min: 600, max: 950, step: 1,
              value: String(Math.round(imgSizeOf(layout) * state.opaqueH / 2048)),
              oninput: (e) => {
                layout.m_LocalScale = 2 * Number(e.target.value) * 2048
                    / state.opaqueH / sizeDeltaOf(layout);
                applyLayout();
                repaintBitmap();
              },
            }), ' 朝向 ', h('label', {}, h('input', {
              type: 'checkbox', checked: (layout.m_LocalScale ?? 1) < 0,
              onchange: (e) => {
                layout.m_LocalScale = Math.abs(layout.m_LocalScale)
                    * (e.target.checked ? -1 : 1);
                applyLayout();
              },
            }), ' 镜像'))),
        h('div.cal-row', {},
            num('脸x', layout.avgFacePos?.[0] ?? 0, 10,
                (v) => {layout.avgFacePos = [v, layout.avgFacePos?.[1] ?? 0]; applyLayout();}),
            num('脸y', layout.avgFacePos?.[1] ?? 0, 10,
                (v) => {layout.avgFacePos = [layout.avgFacePos?.[0] ?? 0, v]; applyLayout();}),
            num('脸边长', layout.avgFaceSize ?? 400, 10,
                (v) => {layout.avgFaceSize = v; applyLayout();})),
        h('div.cal-row', {},
            num('通讯x', layout.avgCommPos[0], 10,
                (v) => {layout.avgCommPos = [v, layout.avgCommPos[1]]; applyLayout();}),
            num('通讯y', layout.avgCommPos[1], 10,
                (v) => {layout.avgCommPos = [layout.avgCommPos[0], v]; applyLayout();}),
            h('button', {
              text: '保存标定',
              onclick: async () => {
                const clean = JSON.parse(JSON.stringify({...layout, derived: false}));
                await registry.saveLayout(id, clean);
                state.source = 'calibrated';
                applyLayout();
                onSaved?.(id);
              },
            }),
            h('button', {
              text: '重新推导',
              onclick: () => {
                Object.assign(state.layout, deriveLayout(state.bitmap));
                state.source = 'derived';
                applyLayout();
                repaintBitmap();
              },
            })));
  }

  /* —— 装载 —— */
  const entry = registry.layoutEntry(id);
  let start = null;
  let source = 'derived';
  if (entry?.source === 'calibrated') {
    start = entry.layout;
    source = 'calibrated';
  } else if (entry) {
    start = await (await fetch(registry.layoutUrl(id))).json();
    source = 'repo';
  }
  const url = registry.resolve(`Lpic_${id}.png`)?.url;
  if (!url) {
    clear(root);
    root.append(h('div.cal-missing',
        {text: `找不到立绘图 ${id}：先在素材库上传，或检查 res/ 索引`}));
    return null;
  }
  const bitmap = await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('lpic 解码失败'));
    img.src = url;
  });
  state.bitmap = bitmap;
  /* 不透明包围盒高（deriveLayout 同款口径），供身高滑杆反解。 */
  const probe = document.createElement('canvas');
  probe.width = probe.height = 512;
  const pctx = probe.getContext('2d', {willReadFrequently: true});
  pctx.drawImage(bitmap, 0, 0, 512, 512);
  const data = pctx.getImageData(0, 0, 512, 512).data;
  let top = 512;
  let bottom = -1;
  for (let y = 0; y < 512; y++) {
    for (let x = 0; x < 512; x++) {
      if (data[(y * 512 + x) * 4 + 3] > 0) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        break;
      }
    }
  }
  if (bottom >= 0) state.opaqueH = (bottom + 1 - top) / 512 * bitmap.height;

  state.layout = JSON.parse(JSON.stringify(start ?? deriveLayout(bitmap)));
  state.source = source;
  repaintBitmap();
  applyLayout();
  return {state, applyLayout, repaintBitmap};
}
