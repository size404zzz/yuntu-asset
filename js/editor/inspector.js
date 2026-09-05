/* inspector.js —— M9 检查器：按分区把一镜的 wire 字段映射成控件。
   对白 textarea 存 wire 原串（<color=#ff0>、<|>），绝不 round-trip 成 HTML；
   立绘以槽位表为主体（不暴露 delete/imagesToDelete 漂移语义）；
   音乐行带「选曲」（openAudioPicker）与 ▶ 试听（解析三级与播放器一致，
   解析不到时禁用）；效果区是死字段 JSON 兜底。
   第 0 区是「舞台状态（截至本镜）」：用 shotstate 折叠推进链 0..本镜，
   场上立绘/图层/BGM/底色/特效都带出处（于第N镜起，可点击跳转）——
   调用从某镜触发后，被它覆盖的每一镜都注明该调用存在及起点。
   第 4 区（动画）由 editor.js 挂 timeline，本模块给挂载点。 */

import {h, clear} from '../ui/dom.js';
import {CONTENT_TYPES, BUBBLE_POSITIONS, nextSpriteImgId} from '../core/schema.js';
import {splitPages} from '../core/schema.js';
import {L1} from '../core/doc.js';
import {foldShotState, LAYER_NAMES, BG_COLORS} from '../core/shotstate.js';
import {fldRow, fldText, fldArea, fldNumber, fldCheck, fldSelect, fldSpeaker} from './fld.js';
import {openPicker, openAudioPicker, toggleAudioPreview} from './picker.js';

const sec = (title, ...rows) => h('details.ins-sec', {open: true},
    h('summary', {text: title}), ...rows);

const fmt = (n) => String(Number.isInteger(n) ? n : Math.round(n * 100) / 100);

/* —— 0 · 舞台状态（截至本镜）：只读，出处可跳转 —— */
function renderStageState(host, {doc, index, onGoto}) {
  const st = foldShotState(doc.story, index);
  const jump = (i) => h('button.ss-jump', {
    text: `第${i}镜`, title: `跳到第 ${i} 镜`,
    onclick: () => onGoto?.(i),
  });
  const since = (i) => h('span.ss-since', {}, '于', jump(i), '起',
      i === index ? h('span.ss-now', {text: '本镜起'}) : null);
  const cap = (text) => h('div.ss-cap', {text});
  const rows = [];

  if (st.sprites.length) {
    rows.push(cap(`场上立绘 ×${st.sprites.length}`));
    for (const sp of st.sprites) {
      rows.push(h('div.row.ss-row', {},
          h('span.ins-tag', {text: `#${sp.imgId}`}),
          h('span.ss-main', {text: sp.imgPath || '（无路径）'}),
          h('span.ss-meta', {text: [
            !sp.entered ? '未揭示'
                : sp.alpha > 0 ? `可见 α${fmt(sp.alpha)} · ${sp.isDark ? '压暗' : '亮'}`
                : '隐身 α0',
            sp.entered && sp.posId ? `槽${sp.posId}` : null,
            sp.comm ? '通讯框' : null,
            sp.faceId ? `表情${sp.faceId}` : sp.faceId === 0 ? '默认脸' : null,
          ].filter(Boolean).join(' · ')}),
          since(sp.since),
          sp.touched ? h('span.ss-flag', {text: '本镜有动'}) : null));
    }
  }
  if (st.layers.length) {
    rows.push(cap(`场上图层 ×${st.layers.length}`));
    for (const ly of st.layers) {
      rows.push(h('div.row.ss-row', {},
          h('span.ins-tag', {text: `#${ly.imgId}`}),
          h('span.ss-type', {text: LAYER_NAMES[ly.imgType] ?? `层${ly.imgType}`}),
          h('span.ss-main', {text: ly.imgPath || '（无路径）'}),
          h('span.ss-meta', {text: [
            `α${fmt(ly.alpha)}`,
            ly.isDark ? '压暗' : null,
            ly.pos ? `pos(${ly.pos.map(fmt).join(',')})` : null,
          ].filter(Boolean).join(' · ')}),
          since(ly.since),
          ly.touched ? h('span.ss-flag', {text: '本镜有动'}) : null));
    }
  }
  rows.push(cap('音乐'));
  rows.push(st.bgm
      ? h('div.row.ss-row', {},
          h('span.ss-type', {text: 'BGM'}),
          h('span.ss-main', {text: st.bgm.cue}),
          h('span.ss-meta', {text: [
            st.bgm.sheet && st.bgm.sheet !== st.bgm.cue ? st.bgm.sheet : null,
            `淡入${fmt(st.bgm.fadeIn ?? 1)} 淡出${fmt(st.bgm.fadeOut ?? 1)}`,
          ].filter(Boolean).join(' · ')}),
          since(st.bgm.since))
      : h('div.row.ss-row', {},
          h('span.ss-type', {text: 'BGM'}),
          h('span.ss-since', {text: st.bgmStop
              ? `（已于第 ${st.bgmStop.since} 镜停止）` : '（无）'})));
  if (st.bgColor) {
    rows.push(h('div.row.ss-row', {},
        h('span.ss-type', {text: '底色'}),
        h('span.ss-main', {text: BG_COLORS[st.bgColor.value]}),
        since(st.bgColor.since)));
  }
  if (st.ppv) {
    rows.push(h('div.row.ss-row', {},
        h('span.ss-type', {text: '后处理'}),
        h('span.ss-main', {text: 'ppv'}),
        since(st.ppv.since)));
  }
  if (st.effects.length || st.stopNow.length) {
    rows.push(cap('演出特效'));
    for (const fx of st.effects) {
      rows.push(h('div.row.ss-row', {},
          h('span.ins-tag', {text: `#${fx.id}`}),
          h('span.ss-main', {text: fx.prefab}),
          h('span.ss-meta', {text: [
            fx.layer ? `layer${fx.layer}` : null,
            Array.isArray(fx.pos) ? `pos(${fx.pos.map(fmt).join(',')})` : null,
          ].filter(Boolean).join(' · ')}),
          since(fx.since)));
    }
    if (st.stopNow.length) {
      rows.push(h('div.row.ss-row', {},
          h('span.ss-type', {text: '停止'}),
          h('span.ss-main', {text: st.stopNow.map((id) => `#${id}`).join(' ')}),
          h('span.ss-since', {text: '本镜 stopList'})));
    }
  }
  const once = [
    st.sfx?.cue ? ['音效', st.sfx.cue + (st.sfx.sheet ? ` · ${st.sfx.sheet}` : '')] : null,
    st.voice ? ['CV', `hero#${st.voice.heroId} voice#${st.voice.voiceId}`] : null,
    st.vedioPath ? ['视频', String(st.vedioPath)] : null,
    st.contentShake ? ['抖动', typeof st.contentShake === 'object'
        ? JSON.stringify(st.contentShake) : String(st.contentShake)] : null,
  ].filter(Boolean);
  if (once.length) {
    rows.push(cap('本镜一次性'));
    for (const [k, v] of once) {
      rows.push(h('div.row.ss-row', {},
          h('span.ss-type', {text: k}),
          h('span.ss-main', {text: v})));
    }
  }
  if (!rows.length) rows.push(h('div.muted', {text: '（空场）'}));
  host.append(sec(`0 · 舞台状态（截至第 ${index} 镜）`, ...rows));
}

export function renderInspector(host, {doc, index, registry, characters, audio,
    timelineHost, onGoto}) {
  clear(host);
  if (index == null) {
    host.append(h('div.muted', {text: '选一个分镜'}));
    return;
  }
  const shot = doc.story.shots[index];
  const P = (field, v, opts) => doc.patch(index, field, v, opts);

  /* —— 0 舞台状态（截至本镜，含延续调用的出处）—— */
  renderStageState(host, {doc, index, onGoto});

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
