/* fld.js —— 检查器字段控件工厂：每个控件绑定 doc 的一个 (index, field)。
   值语义：checkbox 取消 = undefined（删键，wire 里不留 false）；
   number 空 = undefined；文本清空 = undefined。折叠由 doc 负责。 */

import {h} from '../ui/dom.js';
import {getPath} from '../core/doc.js';

const val = (v) => (v === '' ? undefined : v);

export function fldRow(label, ...widgets) {
  return h('div.field', {}, h('label', {text: label}),
      h('div.row', {}, ...widgets));
}

export function fldText(doc, i, field, {placeholder = ''} = {}) {
  const inp = h('input', {
    type: 'text', placeholder,
    value: String(getPath(doc.story.shots[i], field) ?? ''),
  });
  inp.addEventListener('change', () =>
      doc.patch(i, field, val(inp.value.trim())));
  return inp;
}

export function fldArea(doc, i, field, {rows = 4, placeholder = ''} = {}) {
  const inp = h('textarea', {
    rows, placeholder,
    value: String(getPath(doc.story.shots[i], field) ?? ''),
  });
  inp.style.width = '100%';
  inp.addEventListener('change', () =>
      doc.patch(i, field, val(inp.value.replace(/\n+$/, ''))));
  return inp;
}

export function fldNumber(doc, i, field, {min, max, step = 1} = {}) {
  const inp = h('input', {
    type: 'number', min, max, step,
    value: (getPath(doc.story.shots[i], field) ?? '') === '' ? ''
        : String(getPath(doc.story.shots[i], field)),
  });
  inp.addEventListener('change', () => {
    const n = inp.value === '' ? undefined : Number(inp.value);
    doc.patch(i, field, n);
  });
  return inp;
}

export function fldCheck(doc, i, field, {text = '是'} = {}) {
  const inp = h('input', {
    type: 'checkbox', checked: !!getPath(doc.story.shots[i], field),
  });
  inp.addEventListener('change', () =>
      doc.patch(i, field, inp.checked ? true : undefined));
  return h('label', {}, inp, text);
}

export function fldSelect(doc, i, field, options) {
  const sel = h('select', {}, ...options.map(([v, t]) =>
      h('option', {value: String(v), text: t,
        selected: String(getPath(doc.story.shots[i], field) ?? '') === String(v)})));
  sel.addEventListener('change', () => {
    const hit = options.find(([v]) => String(v) === sel.value);
    doc.patch(i, field, hit?.[0] === '' ? undefined : hit?.[0]);
  });
  return sel;
}

/* 说话人三态：无名 / speakerName（含 bravo=玩家名）/ speakerHeroId。 */
export function fldSpeaker(doc, i, characters) {
  const shot = doc.story.shots[i];
  const mode = shot.speakerHeroId != null ? 'hero'
      : shot.speakerName ? 'name' : 'none';
  const sel = h('select', {},
      h('option', {value: 'none', text: '（无名）', selected: mode === 'none'}),
      h('option', {value: 'name', text: '具名', selected: mode === 'name'}),
      h('option', {value: 'hero', text: '角色', selected: mode === 'hero'}));
  const name = fldText(doc, i, 'speakerName', {placeholder: '人形们的声音 / bravo'});
  const hero = h('input', {
    type: 'number', list: 'hero-list', value: shot.speakerHeroId ?? '',
  });
  const apply = (m) => {
    if (m === 'none') doc.patch(i, 'speakerName', undefined, {label: '说话人'});
    if (m === 'hero') doc.patch(i, 'speakerName', undefined, {label: '说话人'});
    if (m === 'name') doc.patch(i, 'speakerHeroId', undefined, {label: '说话人'});
  };
  sel.addEventListener('change', () => { apply(sel.value); rerender(); });
  hero.addEventListener('change', () => {
    if (hero.value !== '') doc.patch(i, 'speakerHeroId', Number(hero.value),
        {label: '说话人'});
  });
  const rerender = () => wrap.replaceChildren(
      h('div.row', {}, sel,
          sel.value === 'name' ? name : null,
          sel.value === 'hero' ? hero : null));
  const wrap = h('div');
  rerender();
  return wrap;
}
