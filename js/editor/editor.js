/* editor.js —— M9 编排层：doc ← 订阅 → 三级失效 → player 公开方法。
   player 不订阅 doc（play.html 零失效逻辑），这里也不碰播放器 DOM——
   只调 setScene/seekShot/patchShot。
   失效：L3 定点补丁（不重启镜）；L2 seek(timed) 防抖 120ms（过渡起值来自
   prev，M9 关键回归）；L1 重装载 + seek 防抖 60ms。undo/redo 走 L1。 */

import {h, clear} from '../ui/dom.js';
import {Doc, L1, L2, L3} from '../core/doc.js';
import {serializeScript, insertShot, removeShot, moveShot, isTerminal} from '../core/script.js';
import {shotSummary} from '../core/schema.js';
import {renderInspector} from './inspector.js';
import {mountTimeline} from './timeline.js';

const debounce = (ms, fn) => {
  let t = null;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};

export class Editor {
  constructor({player, registry, characters, dom, meta, onState}) {
    this.player = player;
    this.registry = registry;
    this.characters = characters;
    this.dom = dom;               // {shotList, inspector, report, pos, undo, redo, mode}
    this.meta = meta;
    this.index = 0;
    this.mode = 'freeze';         // freeze | once | chain
    this.onState = onState ?? (() => {});
    this._reload = debounce(60, () => this._seekInto('freeze'));
    this._reseek = debounce(120, () => this._seekInto('timed'));
    this._timelineHost = h('div.ins-timeline');
  }

  useStory(story) {
    this.doc = new Doc(story);
    this.index = 0;
    this.doc.subscribe((e) => this._invalidate(e));
    this.renderList();
    this.renderInspector();
    this._seekInto('freeze');
  }

  get key() {
    const story = this.doc.story;
    return story.format === 'array' ? this.index : story.indexToWire[this.index];
  }

  _wireButtons() {
    const {undo, redo} = this.dom;
    undo.onclick = () => { this.doc.undo(); this._afterHistory(); };
    redo.onclick = () => { this.doc.redo(); this._afterHistory(); };
  }

  _afterHistory() {
    this.renderList();
    this.renderInspector();
    this._seekInto('freeze');
  }

  /* —— 三级失效 —— */
  _invalidate({index, level, kind}) {
    this._wireButtons();
    if (kind === 'patch' && level === L3) {
      if (index === this.index && this.player.scene) {
        this.player.patchShot(this.doc.story.shots[index]);
      }
      this.renderList();
      return;
    }
    if (kind === 'patch' && level === L2 && index === this.index) {
      this.renderList();
      this._reseek();
      return;
    }
    this.renderList();
    this.renderInspector();
    this._reload();
  }

  /* 可停留判定：本地按 story 镜算（player.scene 在首次 setScene 前是空的，
     依赖 isPausableKey 会全员误判）。语义与 player.isPausableKey 一致。 */
  _pausable(i) {
    const story = this.doc.story;
    const shot = story.shots[i];
    if (!shot) return false;
    if (shot.branch || !shot.autoContinue) return true;
    return isTerminal(story, i);
  }

  async _seekInto(mode) {
    const story = this.doc.story;
    let key = this.key;
    if (!this._pausable(this.index)) {
      const alt = this._nearestPausable(this.index);
      if (alt === null) {
        this.dom.pos.textContent = `#${this.index} 无法预览（场景没有可停留镜）`;
        return;
      }
      this.index = alt;
      key = this.key;
      this.renderList();
      this.renderInspector();
    }
    try {
      this.player.setScene(serializeScript(story),
          this.meta?.title ?? story.title ?? '未命名',
          '1', this.meta?.sector ?? '', '');
      await this.player.seekShot(key, {timed: mode === 'timed'});
      this._syncPos();
    } catch (error) {
      this.dom.pos.textContent = String(error.message);
    }
  }

  /* 就近可停靠镜：优先向后，同距取靠后（与 M5 传输条同规则）。 */
  _nearestPausable(from) {
    const story = this.doc.story;
    const cand = story.order.filter((i) => this._pausable(i));
    if (!cand.length) return null;
    let best = cand[0];
    for (const i of cand) {
      if (Math.abs(i - from) < Math.abs(best - from)
          || (Math.abs(i - from) === Math.abs(best - from) && i > best)) best = i;
    }
    return best;
  }

  _syncPos() {
    this.dom.pos.textContent =
        `#${this.index} · key=${this.player.shotId} · ${this.mode}`;
    this.onState(this);
  }

  /* —— A 栏分镜列表 —— */
  renderList() {
    const list = clear(this.dom.shotList);
    const story = this.doc.story;
    story.shots.forEach((shot, index) => {
      const {text} = shotSummary(shot);
      const badges = [
        shot.images?.length ? '●' : '',
        shot.imgTween?.length ? '◐' : '',
        shot.audio ? '♪' : '',
        shot.effect ? '✳' : '',
        shot.branch ? '★' : '',
        index === story.shots.length - 1 ? '⏤' : '',
      ].filter(Boolean).join(' ');
      const speaker = shot.speakerName === 'bravo' ? '教授'
          : shot.speakerName || (shot.speakerHeroId != null
              ? `#${shot.speakerHeroId}` : '');
      const row = h('div', {
        className: index === this.index ? 'shot-row selected' : 'shot-row',
        onclick: () => this.select(index),
      },
          h('span.num', {text: String(index)}),
          h('span.speaker', {text: `${shot.contentType ?? '-'} ${speaker}`}),
          h('span.text', {text: text || '（无文案）'}),
          h('span.badges', {text: badges}),
          h('span.ins-ops', {},
              h('button.tiny', {text: '＋', title: '下方插入',
                onclick: (e) => {
                  e.stopPropagation();
                  this.doc.structure((s) => insertShot(s, index + 1, {}),
                      {label: '插入'});
                  this.select(index + 1);
                }}),
              h('button.tiny', {text: '↑', onclick: (e) => {
                e.stopPropagation();
                if (index === 0) return;
                this.doc.structure((s) => moveShot(s, index, index - 1));
                this.select(index - 1);
              }}),
              h('button.tiny', {text: '✕', onclick: (e) => {
                e.stopPropagation();
                this.doc.structure((s) => removeShot(s, index));
                this.select(Math.max(0, index - 1));
              }})));
      list.append(row);
    });
  }

  select(index) {
    this.index = index;
    this.renderList();
    this.renderInspector();
    this._seekInto(this.mode === 'freeze' ? 'freeze' : 'freeze');
  }

  renderInspector() {
    renderInspector(this.dom.inspector, {
      doc: this.doc, index: this.index,
      registry: this.registry, characters: this.characters,
      timelineHost: this._timelineHost,
    });
    clear(this._timelineHost);
    if (this.index != null) {
      mountTimeline(this._timelineHost, this.doc, this.index, {
        onSeek: (t) => {
          /* 轨道游标 = 本镜内时间：seekTime 用全局粗模型，这里先取整镜
             起点（编辑停留镜的动画预览从 0 起重放）。 */
          this._seekInto('timed');
          void t;
        },
      });
    }
  }
}
