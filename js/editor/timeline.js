/* timeline.js —— ★ imgTween 轨道编辑器（M9）。
   一 lane = 一个 imgId（posId 只有 1–5，lane 天然有界）；
   一个关键帧 = 一个 imgTween 项：x=delay、宽=duration、填充高=alpha。
   拖中心改 delay、拖右缘改 duration、纵向拖改 alpha，吸附 0.05s；
   点轨道空白插入关键帧并继承前帧全部属性；选中帧给数值微调与删除。
   点击标尺 → onSeek(t)（编辑器据此 seekTime/游标）。
   纪律：任何写路径都不原地改 doc 里的对象——先算新数组再 doc.patch，
   否则撤销快照拍到的是改后值（第一版就在这栽过）。 */

import {h, clear} from '../ui/dom.js';

const W = 560;
const H = 26;
const SNAP = 0.05;
const snap = (t) => Math.max(0, Math.round(t / SNAP) * SNAP);

export function mountTimeline(root, doc, i, {onSeek} = {}) {
  let sel = null;                   // {imgId, k}

  const tweenOf = () => doc.story.shots[i].imgTween ?? [];
  /* 用新数组替换第 idx 帧（或删帧）后走 patch。 */
  function setFrame(idx, patchObj, label, remove = false) {
    const arr = tweenOf();
    const next = remove ? arr.filter((_, n) => n !== idx)
        : arr.map((f, n) => n === idx ? {...f, ...patchObj} : f);
    doc.patch(i, 'imgTween', next.length ? next : undefined, {label});
  }

  function render() {
    const tween = tweenOf();
    clear(root);
    root.append(h('div.tl-hint', {
      text: '点轨道空白插帧（继承前帧）· 拖中心=delay 右缘=duration 纵向=alpha · 吸附0.05s',
    }));
    if (!tween.length) {
      root.append(h('button.tiny', {text: '+ 关键帧', onclick: () => {
        doc.patch(i, 'imgTween',
            [{imgId: 101, alpha: 1, delay: 0, duration: 0.5}], {label: '加 tween'});
        render();
      }}));
      return;
    }
    const lanes = [];
    const byId = new Map();
    tween.forEach((f, n) => {
      if (!byId.has(f.imgId)) { byId.set(f.imgId, []); lanes.push(f.imgId); }
      byId.get(f.imgId).push({f, n});
    });
    const maxT = Math.max(2, ...tween.map((f) => (f.delay ?? 0) + (f.duration ?? 0)) + 0.5);
    const pxs = W / maxT;

    const ruler = h('div.tl-ruler', {style: {width: `${W}px`}});
    for (let t = 0; t <= maxT + 1e-6; t += 0.5) {
      ruler.append(h('span', {style: {left: `${t * pxs}px`}, text: t.toFixed(1)}));
    }
    if (onSeek) ruler.addEventListener('pointerdown', (e) => {
      const r = ruler.getBoundingClientRect();
      onSeek(snap((e.clientX - r.left) / pxs));
    });
    root.append(ruler);

    for (const imgId of lanes) {
      const entries = byId.get(imgId);
      const lane = h('div.tl-lane');
      const track = h('div.tl-track', {style: {width: `${W}px`, height: `${H}px`}});
      for (const {f, n} of entries) {
        const k = entries.findIndex((x) => x.n === n);
        const isSel = sel && sel.n === n;
        const bar = h('div', {
          className: isSel ? 'tl-frame sel' : 'tl-frame',
          style: {
            left: `${(f.delay ?? 0) * pxs}px`,
            width: `${Math.max(3, (f.duration ?? 0) * pxs)}px`,
            height: `${3 + (f.alpha ?? 0) * (H - 6)}px`,
          },
          title: `α${f.alpha} d${f.delay} t${f.duration}`,
        });
        bar.append(h('i.tl-handle'));
        dragify(bar, f, n, pxs);
        bar.addEventListener('pointerup', (e) => {
          if (!bar.dataset.dragged) { sel = {n, imgId}; render(); }
        });
        track.append(bar);
      }
      track.addEventListener('pointerdown', (e) => {
        if (e.target !== track) return;
        const r = track.getBoundingClientRect();
        const t = snap((e.clientX - r.left) / pxs);
        const before = entries.map((x) => x.f).filter((f) => (f.delay ?? 0) <= t).pop();
        doc.patch(i, 'imgTween', [...tween, {
          ...(before ? JSON.parse(JSON.stringify(before)) : {}),
          imgId, delay: t, duration: before?.duration ?? 0.5,
          alpha: before?.alpha ?? 1,
        }], {label: '插帧'});
        sel = {n: tween.length, imgId};
        render();
      });
      lane.append(h('span.tl-lname', {text: `#${imgId}`}), track);
      root.append(lane);

      const hit = sel && entries.find((x) => x.n === sel.n);
      if (hit) root.append(detailRow(hit.f, sel.n, entries, render));
    }
  }

  function detailRow(f, n, entries, render) {
    const num = (label, key, step, max) => {
      const inp = h('input', {type: 'number', value: String(f[key] ?? ''),
        min: 0, max, step, style: {width: '70px'}});
      inp.addEventListener('change', () => {
        setFrame(n, {[key]: Number(inp.value)}, label);
        render();
      });
      return h('label', {}, label, inp);
    };
    const posSel = h('select', {}, h('option', {value: '', text: '位置-'}),
        ...[1, 2, 3, 4, 5].map((p) => h('option', {
          value: String(p), text: `pos${p}`, selected: f.posId === p})));
    posSel.addEventListener('change', () => {
      setFrame(n, {posId: posSel.value ? Number(posSel.value) : undefined}, '位置');
      render();
    });
    const dark = h('label', {}, h('input', {
      type: 'checkbox', checked: !!f.isDark,
      onchange: (e) => {
        setFrame(n, {isDark: e.target.checked ? true : undefined}, '明暗');
        render();
      },
    }), '暗');
    return h('div.tl-detail.row', {},
        num('delay', 'delay', 0.05), num('时长', 'duration', 0.05),
        num('alpha', 'alpha', 0.05, 1), posSel, dark,
        h('span.muted', {text: `imgId=${f.imgId}`}),
        h('button.tiny', {text: '删帧', onclick: () => {
          sel = null;
          setFrame(n, null, '删帧', true);
          render();
        }}));
  }

  /* 拖拽：起点值 + 位移纯函数 → 新帧；不原地改 doc 对象。
     拖动中只就地改被拖条的样式（重建 DOM 会丢指针捕获），抬起才重绘。 */
  function dragify(el, f, n, pxs) {
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      const isHandle = e.target.classList.contains('tl-handle');
      el.setPointerCapture(e.pointerId);
      const start = {x: e.clientX, y: e.clientY,
        delay: f.delay ?? 0, duration: f.duration ?? 0, alpha: f.alpha ?? 0};
      let moved = false;
      const move = (ev) => {
        const dx = (ev.clientX - start.x) / pxs;
        const dy = (ev.clientY - start.y) / H;
        if (!moved && Math.abs(ev.clientX - start.x)
            + Math.abs(ev.clientY - start.y) <= 3) return;
        moved = true;
        const patchObj = isHandle
            ? {duration: Math.max(0, snap(start.duration + dx))}
            : {
              delay: snap(start.delay + dx),
              alpha: Math.min(1, Math.max(0,
                  Math.round((start.alpha - dy) * 20) / 20)),
            };
        setFrame(n, patchObj, '拖帧');
        const g = doc.story.shots[i].imgTween[n];
        el.style.left = `${(g.delay ?? 0) * pxs}px`;
        el.style.width = `${Math.max(3, (g.duration ?? 0) * pxs)}px`;
        el.style.height = `${3 + (g.alpha ?? 0) * (H - 6)}px`;
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        if (moved) { sel = {n, imgId: f.imgId}; render(); }
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
  }

  render();
  return {render, get sel() { return sel; }, setSel(v) { sel = v; }};
}
