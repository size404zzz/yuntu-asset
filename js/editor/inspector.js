/* inspector.js —— M9 检查器：按分区把一镜的 wire 字段映射成控件。
   对白 textarea 存 wire 原串（<color=#ff0>、<|>），绝不 round-trip 成 HTML；
   立绘以槽位表为主体（不暴露 delete/imagesToDelete 漂移语义）；
   音乐行带「选曲」（openAudioPicker）与 ▶ 试听（解析三级与播放器一致，
   解析不到时禁用）；效果区是死字段 JSON 兜底。
   第 4 区（动画）由 editor.js 挂 timeline，本模块给挂载点。 */

import {h, clear} from '../ui/dom.js';
import {CONTENT_TYPES, BUBBLE_POSITIONS, nextSpriteImgId} from '../core/schema.js';
import {splitPages} from '../core/schema.js';
import {L1} from '../core/doc.js';
import {fldRow, fldText, fldArea, fldNumber, fldCheck, fldSelect, fldSpeaker} from './fld.js';
import {openPicker, openAudioPicker, toggleAudioPreview} from './picker.js';

const sec = (title, ...rows) => h('details.ins-sec', {open: true},
    h('summary', {text: title}), ...rows);

export function renderInspector(host, {doc, index, registry, characters, audio,
    timelineHost}) {
  clear(host);
  if (index == null) {
    host.append(h('div.muted', {text: '选一个分镜'}));
    return;
  }
  const shot = doc.story.shots[index];
  const P = (field, v, opts) => doc.patch(index, field, v, opts);

  /* —— 1 对白 —— */
  const pages = splitPages(shot.content ?? '');
  const pageTabs = pages.length > 1 ? h('div.row', {},
      ...pages.map((_, n) => h('span.ins-tag', {text: `第${n + 1}页`}))) : null;
  host.append(sec('1 · 对白',
      fldRow('呈现方式', fldSelect(doc, index, 'contentType',
          Object.entries(CONTENT_TYPES).map(([v, t]) => [Number(v), t.label]))),
      fldRow('说话人', fldSpeaker(doc, index, characters),
          h('datalist', {id: 'hero-list'}, ...Object.entries(characters).map(
              ([id, name]) => h('option', {value: id, text: String(name)})))),
      fldRow('气泡位（type3）', fldSelect(doc, index, 'speakerHeroPosId',
          [[undefined, '（默认）'], ...Object.entries(BUBBLE_POSITIONS)
              .map(([v, t]) => [Number(v), t])])),
      pageTabs,
      fldRow('文案（wire 原串，<|> 分页）', fldArea(doc, index, 'content',
          {rows: 3 + Math.min(6, pages.length * 2),
            placeholder: '支持 <color=#ff0> <size=44> <a href=Des:17>'})),
      fldRow('乱码打字机', fldCheck(doc, index, 'scrambleTypeWriter',
          {text: 'scrambleTypeWriter'}))));

  /* —— 2 背景 —— */
  const imgs = shot.images ?? [];
  const bgRows = imgs.filter((im) => im.imgType === 2).map((im) =>
      h('div.row', {},
          h('span.ins-tag', {text: `#${im.imgId}`}),
          h('input', {type: 'text', value: im.imgPath,
            onchange: (e) => replaceImage(index, im,
                {...im, imgPath: e.target.value.trim()})}),
          h('button.tiny', {text: '选图', onclick: () => openPicker(registry, {
            title: `背景 #${im.imgId}`, kind: 'bg',
            onPick: (s) => {
              replaceImage(index, im,
                  {...im, imgPath: (s.item?.group ?? '') + '/' + s.name});
              document.querySelector('.picker-overlay')?.remove();
            }})}),
          h('button.tiny', {text: '删', onclick: () => replaceImage(index, im, null)})));
  host.append(sec('2 · 背景',
      ...bgRows,
      h('button.tiny', {text: '+ 背景层', onclick: () => {
        const id = Math.max(0, ...imgs.map((m) => m.imgId)) + 1;
        P('images', [...imgs, {imgId: id, imgType: 2, imgPath: 'cpt00/xxx',
          alpha: 0, fullScreen: true}], {label: '加背景'});
      }})));

  /* —— 3 立绘槽位表 —— */
  const sprites = imgs.filter((im) => im.imgType === 3);
  const spriteRows = sprites.map((im) => {
    const face = (shot.heroFace ?? []).find((f) => f.imgId === im.imgId);
    return h('div.row.ins-sprite', {},
        h('span.ins-tag', {text: `#${im.imgId}`}),
        h('input', {type: 'text', value: im.imgPath, size: 16,
          onchange: (e) => replaceImage(index, im,
              {...im, imgPath: e.target.value.trim()})}),
        fldInline('pos', h('select', {}, ...[undefined, 1, 2, 3, 4, 5].map((p) =>
            h('option', {value: String(p), text: p ?? '-',
              selected: im.posId === p}),
        ), {onchange: (e) => replaceImage(index, im,
            {...im, posId: e.target.value === 'undefined' ? undefined
                : Number(e.target.value)})})),
        h('label', {}, h('input', {type: 'checkbox', checked: !!im.comm,
          onchange: (e) => replaceImage(index, im,
              {...im, comm: e.target.checked ? true : undefined})}), '通讯框'),
        h('label', {}, h('input', {type: 'checkbox', checked: !!face,
          onchange: (e) => {
            const next = (shot.heroFace ?? []).filter(
                (f) => f.imgId !== im.imgId);
            if (e.target.checked) next.push({imgId: im.imgId, faceId: 1});
            P('heroFace', next.length ? next : undefined, {label: '表情'});
          }}), '表情'),
        face ? h('input', {type: 'number', value: face.faceId, min: 0,
          style: {width: '56px'},
          onchange: (e) => P('heroFace', (shot.heroFace ?? []).map((f) =>
              f.imgId === im.imgId ? {...f, faceId: Number(e.target.value)} : f),
              {label: '表情'})}) : null);
  });
  host.append(sec('3 · 立绘',
      ...spriteRows,
      h('button.tiny', {text: '+ 立绘槽', onclick: () => {
        P('images', [...imgs, {imgId: nextSpriteImgId(imgs),
          imgType: 3, imgPath: 'new_avg', alpha: 0}], {label: '加立绘'});
      }}),
      sprites.some((im) => !registry.layoutEntry(im.imgPath)?.layout)
          ? h('div.row', {}, h('span.warn', {text: '⚠ 有立绘未标定'}),
              h('button.tiny', {text: '去标定', onclick: () => {
                const bad = sprites.find(
                    (im) => !registry.layoutEntry(im.imgPath)?.layout);
                location.href = `cal.html?id=${encodeURIComponent(bad.imgPath)}`;
              }})) : null));

  /* —— 4 动画（timeline 由 editor 提供容器）—— */
  host.append(sec('4 · 动画', timelineHost ?? h('div')));

  /* —— 5 音乐 ——
     选曲回填 cue+sheet（bgm 保留已有淡入淡出、清掉 stop——选了曲就是要它响）；
     回填用 forceLevel L1：L3 的 patchShot 不触发音频，重装载才能在预览里
     听见挂载效果。sfx 不随 seek 补放，听效果走行内 ▶。 */
  const bgm = shot.audio?.bgm;
  const sfx = shot.audio?.sfx;
  const hearBtn = (part) => {
    const a = part === 'bgm' ? bgm : sfx;
    const url = a?.cue ? registry.resolveAudio(a.sheet, a.cue)?.url ?? null : null;
    const btn = h('button.tiny', {text: '▶', title: url ? '试听' : '解析不到音频',
      disabled: !url});
    if (url) btn.addEventListener('click', () => toggleAudioPreview(url, btn));
    return btn;
  };
  const pickBtn = (part) => h('button.tiny', {text: '选曲', onclick: () =>
      openAudioPicker(registry, {
        title: part === 'bgm' ? '选 BGM' : '选音效',
        onPick: ({sheet, cue}) => {
          document.querySelector('.picker-overlay')?.remove();
          P('audio', part === 'bgm'
              ? {...shot.audio, bgm: {cue, sheet,
                  fadeIn: bgm?.fadeIn, fadeOut: bgm?.fadeOut}}
              : {...shot.audio, sfx: {cue, sheet}},
              {label: part, forceLevel: L1});
        }})});
  host.append(sec('5 · 音乐', h('div.ins-music', {},
      fldRow('bgm', fldText(doc, index, 'audio.bgm.cue', {placeholder: 'Mus_...'}),
          pickBtn('bgm'), hearBtn('bgm'),
          fldNumber(doc, index, 'audio.bgm.fadeIn', {min: 0, step: 0.5}),
          fldNumber(doc, index, 'audio.bgm.fadeOut', {min: 0, step: 0.5}),
          fldCheck(doc, index, 'audio.bgm.stop', {text: '停'})),
      fldRow('sfx', fldText(doc, index, 'audio.sfx.cue', {placeholder: 'AVG_...'}),
          fldText(doc, index, 'audio.sfx.sheet', {placeholder: 'sheet'}),
          pickBtn('sfx'), hearBtn('sfx')))));

  /* —— 6 CV（M15）—— voice={heroId, voiceId} 由宿主的 resolveVoice 解到
     VO_<代号>/<代号>_<语音名>.ogg（data/index/voices.json）；解析不到给 ⚠。
     播放语义：新句掐旧句、seek 不补。 */
  const voice = shot.voice;
  const voiceUrl = voice && audio?.resolveVoice ? audio.resolveVoice(voice) : null;
  const voiceBtn = h('button.tiny', {
    text: '▶',
    title: voiceUrl ? '试听 CV' : '解析不到语音包',
  });
  if (voiceUrl) {
    voiceBtn.addEventListener('click', () => toggleAudioPreview(voiceUrl, voiceBtn));
  } else {
    voiceBtn.disabled = true;
  }
  const voiceTip = voice && !voiceUrl
      ? h('span.muted', {text: '解析不到语音包'})
      : null;
  host.append(sec('6 · CV', h('div.ins-music', {},
      fldRow('heroId', fldNumber(doc, index, 'voice.heroId', {step: 1})),
      fldRow('voiceId', fldNumber(doc, index, 'voice.voiceId', {step: 1}),
          voiceBtn, voiceTip))));

  /* —— 7 效果/死字段 JSON 兜底 —— */
  const RAW = ['effect', 'contentShake', 'bgColor', 'SkipScenario',
    'storyAvgId', 'pre_condition'];
  const rawJson = h('textarea', {rows: 4,
    value: JSON.stringify(Object.fromEntries(RAW.filter(
        (k) => shot[k] !== undefined).map((k) => [k, shot[k]])), null, 1)});
  rawJson.style.width = '100%';
  rawJson.addEventListener('change', () => {
    try {
      const obj = JSON.parse(rawJson.value || '{}');
      for (const k of RAW) {
        if (obj[k] !== undefined) P(k, obj[k], {label: k});
        else if (shot[k] !== undefined) P(k, undefined, {label: k});
      }
      rawJson.classList.remove('bad');
    } catch { rawJson.classList.add('bad'); }
  });
  host.append(sec('6 · 效果/其他', rawJson));

  function replaceImage(i0, im, next) {
    const arr = doc.story.shots[index].images ?? [];
    P('images', next === null ? arr.filter((m) => m !== im)
        : arr.map((m) => m === im ? next : m), {label: 'images'});
  }
  function fldInline(label, el) {
    return h('label', {style: {display: 'inline-flex', gap: '2px'}}, label, el);
  }
}
