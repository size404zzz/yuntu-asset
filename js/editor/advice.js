/* advice.js —— M23 退场建议面板。
 *
 * 分工：core/fadeadvice 只负责「在无说话人镜上把滞留者列出来 + 预检收掉
 * 之后的语法后果并按实测命中率分档」，**判「该不该收」的是人**——判据
 * 在旁白语义里（22christ_02#15 的炽：旁白「黑影又出现在了炽的身后」
 * 要求人必须在台上），没有任何结构特征能替人读这句话。所以这里每一行
 * 都把该镜的旁白文本摊在用户眼前，收与不收一次点击，走 doc.patch
 * （L2 timed seek 立刻看得见、撤销栈可回退）。
 *
 * 默认不列 silent 档（「之后再不提」）：39 段外源对拍里这一档 ±1 命中
 * 只有 7%，wiki 转写者遇到它一律不收——她就是静静站在台上到段落结束，
 * 没有后续条目不等于她退场了。想看可以勾出来，但徽章会明写不推荐。
 */

import {h, clear} from '../ui/dom.js';
import {analyzeFadeAdvice, applyFadeOut, TIERS, NEXT_LABEL}
    from '../core/fadeadvice.js';

export function openFadeAdvice({editor, title = '退场建议'}) {
  const doc = editor?.doc;
  if (!doc) return null;
  const overlay = h('div.picker-overlay');
  const box = h('div.picker-box.picker-story-box');
  const bar = h('div.picker-bar');
  const list = h('div.picker-grid.picker-story-list');
  const counter = h('span.muted');
  let showSilent = false;

  function refill() {
    const {items, stats} = analyzeFadeAdvice(doc.story);
    const shown = items.filter((it) => showSilent || it.tier !== 'silent');
    clear(list);
    counter.textContent = `${shown.length}/${items.length} 条 · 无说话人镜 ${stats.narration}`
        + ` · 滞留 ${stats.lingering}`;
    if (!shown.length) {
      list.append(h('div.muted', {
        style: {padding: '10px'},
        text: items.length
            ? '都收干净了（只剩「之后再不提」那档，默认不列）'
            : '没有滞留的立绘',
      }));
      return;
    }
    let lastTier = null;
    for (const it of shown) {
      if (it.tier !== lastTier) {
        lastTier = it.tier;
        const t = TIERS[it.tier];
        list.append(h('div.picker-group', {text: `${t.label} · ${t.hit}`}));
      }
      list.append(row(it));
    }
  }

  function row(it) {
    const tier = TIERS[it.tier];
    const next = it.next;
    const nextText = !next ? '之后再不提'
        : `${next.distance === 1 ? '下 1 镜' : `下 ${next.distance} 镜`}`
            + `${NEXT_LABEL[next.kind] ?? next.kind}（#${next.index}）`
            + (it.needReveal ? ' · 回来要补揭示' : '');
    return h(`div.advice-row.${it.tier}`, {},
        h('span.advice-shot', {text: `#${it.index} · key ${it.wire}`}),
        h('span.advice-id', {text: `${it.imgId} ${it.imgPath ?? ''}`}),
        h('span.advice-tier', {text: tier.label, title: tier.hit}),
        h('span.advice-next', {text: nextText}),
        h('span.advice-text', {text: it.text || '（无文案）'}),
        h('span.spacer'),
        h('button.tiny', {text: '收 α0/0.2', title: '追加一条 α0/d0.2 淡出，可撤销',
          onclick: () => {
            const shot = doc.story.shots[it.index];
            doc.patch(it.index, 'imgTween', applyFadeOut(shot, it.imgId),
                {label: '退场建议'});
          }}),
        h('button.tiny', {text: '定位', onclick: () => {
          editor.select(it.index);
          close();
        }}));
  }

  const silentBox = h('label', {style: {fontSize: '11px'}},
      h('input', {type: 'checkbox',
        onchange: (e) => { showSilent = e.target.checked; refill(); }}),
      ' 含「之后再不提」（不推荐）');

  bar.append(
      h('b', {text: title}), silentBox, h('span.spacer'), counter,
      h('span.muted', {text: '判据在旁白里，机器只列候选'}),
      h('button.tiny', {text: '关闭', onclick: () => close()}));
  box.append(bar, list);
  overlay.append(box);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  /* 打开期间订阅 doc：收一条、或在别处改动了 wire，列表跟着重算。 */
  const off = doc.subscribe(() => refill());
  function close() { off(); overlay.remove(); }

  document.body.append(overlay);
  refill();
  return overlay;
}
