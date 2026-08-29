/* picker.js —— M8 素材选择器：搜索仓库索引 / 上传本地文件 / 选一张回一个
   {name, url, kind}。模态浮层，纯 DOM（ui/dom.js），不依赖播放器。
   立绘条目回的是「角色 id」——选中后由调用方决定拿 lpic 还是进标定。 */

import {h, clear} from '../ui/dom.js';
import {searchBackgrounds, searchCharacters} from '../core/repo-index.js';

const PAGE = 120;

export function openPicker(registry, {title = '选择素材', kind = 'bg', onPick} = {}) {
  const overlay = h('div.picker-overlay');
  const box = h('div.picker-box');
  const search = h('input', {
    className: 'picker-search', placeholder: '搜索名字 / 分组…',
  });
  const grid = h('div.picker-grid');
  const bar = h('div.picker-bar');
  let query = '';
  let offset = 0;
  let items = [];

  const label = (it) => (kind === 'bg' ? it.name : it.id);
  const urlOf = (it) => (kind === 'bg'
      ? registry.resolve(it.name + '.png')?.url ?? it.path
      : registry.resolve(`Lpic_${it.id}.png`)?.url ?? it.lpic);

  function refill(reset = true) {
    if (reset) { offset = 0; clear(grid); }
    const more = kind === 'bg'
        ? searchBackgrounds(registry.repo, query)
        : searchCharacters(registry.repo, query, {avgOnly: false});
    items = more;
    for (const it of more.slice(offset, offset + PAGE)) {
      const thumb = h('img', {src: urlOf(it), loading: 'lazy', alt: label(it)});
      const badge = kind === 'chara' && !registry.layoutEntry(it.id)
          ? h('span.picker-warn', {text: '⚠'}) : null;
      grid.append(h('button.picker-cell', {onclick: () => onPick({
        name: label(it), url: urlOf(it), kind, item: it,
      })}, thumb, badge, h('span', {text: label(it)})));
    }
    offset += PAGE;
    if (offset < items.length) {
      grid.append(h('button.picker-more',
          {text: `加载更多（${items.length - offset}）`, onclick: () => refill(false)}));
    }
  }

  search.addEventListener('input', () => { query = search.value.trim(); refill(); });

  const kindBtn = h('button.tiny', {text: kind === 'bg' ? '切到立绘' : '切到背景'});
  kindBtn.addEventListener('click', () => {
    kind = kind === 'bg' ? 'chara' : 'bg';
    kindBtn.textContent = kind === 'bg' ? '切到立绘' : '切到背景';
    refill();
  });

  const file = h('input', {type: 'file', multiple: true, className: 'picker-file'});
  file.addEventListener('change', async () => {
    for (const f of file.files) {
      await registry.upload(f.name, f, {kind: 'image'});
    }
    file.value = '';
    if (kind === 'bg') {
      const added = [];
      for (const f of [...registry.listUploads({kind: 'image'})]) {
        if (!registry.repo.backgrounds.some((b) => f.name.toLowerCase() === b.name + '.png')) {
          added.push({name: f.name.replace(/\.png$/i, ''), group: '上传', path: f.key});
        }
      }
      registry.repo.backgrounds = added.concat(registry.repo.backgrounds);
    }
    refill();
  });

  bar.append(
      h('b', {text: title}), kindBtn,
      h('button.tiny', {text: '上传文件…', onclick: () => file.click()}),
      file,
      h('span.spacer'),
      h('button.tiny', {text: '关闭', onclick: () => overlay.remove()}));
  box.append(bar, search, grid);
  overlay.append(box);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.append(overlay);
  search.focus();
  refill();
  return overlay;
}
