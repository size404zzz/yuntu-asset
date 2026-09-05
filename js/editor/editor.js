/* editor.js —— M9 编排层：doc ← 订阅 → 三级失效 → player 公开方法。
   player 不订阅 doc（play.html 零失效逻辑），这里也不碰播放器 DOM——
   只调 setScene/seekShot/patchShot。
   失效：L3 定点补丁（不重启镜）；L2 seek(timed) 防抖 120ms（过渡起值来自
   prev，M9 关键回归）；L1 重装载 + seek 防抖 60ms。undo/redo 走 L1。 */

import {h, clear} from '../ui/dom.js';
import {Doc, L1, L2, L3} from '../core/doc.js';
import {serializeScript, insertShot, removeShot, moveShot, isTerminal} from '../core/script.js';
import {shotSummary, CONTENT_TYPES} from '../core/schema.js';
import {renderInspector, refreshSections} from './inspector.js';
import {mountTimeline} from './timeline.js';

const debounce = (ms, fn) => {
  let t = null;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};

/* L2 字段 → 需要定点重建的分区（台上状态随这些字段变；未列出的字段
   控件自持，不必重建）。时间轴不在列：imgTween 由它自绘（sel 不丢）。 */
const L2_SECTIONS = {
  imgTween: ['bg', 'sprite'],
  heroFace: ['sprite'],
  bgColor: ['bg'],
  speakerHeroPosId: [],
  scrambleTypeWriter: [],
};

export class Editor {
  constructor({player, registry, characters, dom, meta, onState, onDoc}) {
    this.player = player;
    this.registry = registry;
    this.characters = characters;
    this.dom = dom;               // {shotList, inspector, report, pos, undo, redo, mode}
    this.meta = meta;
    this.index = 0;
    this.mode = 'freeze';         // freeze | once | chain
    this.onState = onState ?? (() => {});
    this.onDoc = onDoc ?? (() => {});
    this._reload = debounce(60, () => this._seekInto('freeze'));
    this._reseek = debounce(120, () => this._seekInto('timed'));
    /* 在途 seek 的世代号：连点分镜会让多轮 _seekInto 交叠，陈旧轮不许
       再写位置读数（它读到的是新一轮的 shotId，与屏上镜对不上）。 */
    this._seekGen = 0;
    this._timelineHost = h('div.ins-timeline');
    /* 时间轴句柄与指针交互窗口（timeline 拖拽期间 DOM 一换指针捕获就丢，
       分区重建要挂起；松开后一次性补课）。 */
    this._tl = null;
    this._tlBusy = false;
    this._tlDirty = false;
  }

  useStory(story) {
    this.doc = new Doc(story);
    this.index = 0;
    this.doc.subscribe((e) => this._invalidate(e));
    this.onDoc(this.doc);
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

  /* —— 三级失效 ——
     合并视图下检查器各层显示「台上状态」，L2/L3 提交后也要跟上：按字段
     定点重建受影响分区（refreshSections），全量重建只留给 L1/结构/撤销。 */
  _invalidate({index, field, level, kind}) {
    this._wireButtons();
    if (kind === 'patch' && level === L3) {
      if (index === this.index && this.player.scene) {
        this.player.patchShot(this.doc.story.shots[index]);
      }
      this.renderList();
      if (index === this.index && field?.startsWith('audio')) {
        this.refreshSections(['music']);
      }
      return;
    }
    if (kind === 'patch' && level === L2 && index === this.index) {
      this.renderList();
      if (field === 'imgTween' && !this._tlBusy) this._tl?.refresh();
      if (this._tlBusy) {
        this._tlDirty = true;
      } else {
        this.refreshSections(L2_SECTIONS[field] ?? ['bg', 'sprite']);
      }
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
    const gen = ++this._seekGen;
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
      const landed = await this.player.seekShot(key, {timed: mode === 'timed'});
      /* landed === null = 播放器侧判陈旧撒手；gen 过期 = 宿主侧又起了一轮。
         两种都交给新一轮去写读数，陈旧轮一律闭嘴。 */
      if (landed === null || this._seekGen !== gen) return;
      this._syncPos();
    } catch (error) {
      if (this._seekGen !== gen) return;
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

  /* —— A 栏分镜列表 ——
     每框两个信息量：这一镜是旁白还是对话（旁白 / 说话人名字），加一行
     文案预览。说话人取 speakerName（bravo=教授），缺名落 characters 表，
     再缺落 #heroId；无名镜一律归「旁白」。类型细节进行内 tooltip。 */
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
              ? (this.characters?.[shot.speakerHeroId]
                  ?? `#${shot.speakerHeroId}`) : '');
      const typeLabel = CONTENT_TYPES[shot.contentType]?.label ?? `类型${shot.contentType}`;
      const row = h('div', {
        className: index === this.index ? 'shot-row selected' : 'shot-row',
        title: `第 ${index} 镜 · ${typeLabel}`,
        onclick: () => this.select(index),
      },
          h('span.num', {text: String(index)}),
          h('span.speaker' + (speaker ? '' : '.narr'), {
            text: speaker || '旁白'}),
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
    const stage = renderInspector(this.dom.inspector, {
      doc: this.doc, index: this.index,
      registry: this.registry, characters: this.characters,
      audio: this.player?.audio ?? null,
      timelineHost: this._timelineHost,
      onGoto: (i) => this.select(i),
    });
    this._mountTimeline(stage);
  }

  /* 定点重建部分分区（L2/L3 提交后）；时间轴宿主原地保留，sel 不丢。 */
  refreshSections(keys) {
    if (this.index == null || !keys.length) return;
    refreshSections(this.dom.inspector, {
      doc: this.doc, index: this.index,
      registry: this.registry, characters: this.characters,
      audio: this.player?.audio ?? null,
      onGoto: (i) => this.select(i),
    }, keys);
  }

  _mountTimeline(stage) {
    this._tl?.dispose();
    this._tl = null;
    this._tlBusy = false;
    this._tlDirty = false;
    clear(this._timelineHost);
    if (this.index == null) return;
    this._tl = mountTimeline(this._timelineHost, this.doc, this.index, {
      stage,
      onSeek: (t) => {
        /* 轨道游标 = 本镜内时间：seekTime 用全局粗模型，这里先取整镜
           起点（编辑停留镜的动画预览从 0 起重放）。 */
        this._seekInto('timed');
        void t;
      },
      onBusy: (busy) => {
        this._tlBusy = busy;
        if (!busy && this._tlDirty) {
          this._tlDirty = false;
          this.refreshSections(['bg', 'sprite']);
        }
      },
    });
  }
}
