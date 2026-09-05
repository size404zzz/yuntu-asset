/* inspector.js —— 分层检查器：台上状态就地编辑（M24 重构）。
   旧版第 0 区「舞台状态」只读罗列，改台上得跳回出处镜；现在拆进各层：
   - 背景（2）：台上全部非立绘图层（远景/背景/前景/Movie）+ 底色；
   - 立绘（3）：台上全部立绘（槽位/可见度/明暗/表情/通讯框）；
   - 动画（4）：imgTween 时间轴 + 在场元素幽灵轨道（点空白插首帧）；
   - 音乐（5）：当前台上 BGM（出处可跳）+ 本镜 bgm/sfx 调用；
   - 特效（7）：台上特效/后处理 + 死字段 JSON 兜底。
   每行展示「台上现状」（延续项注明于第几镜起，可跳转），控件改的是
   「本镜看到的状态」，写路径全部只落本镜：
   - 可见度/槽位/明暗 → 本镜 imgTween 的 0 号状态帧（upsertStateFrame）；
   - 表情 → 本镜 heroFace；
   - 换图/换装/通讯框 → 本镜 delete+重注册（语料换装语义：回收后重建全新
     item），structure 打包注册+状态帧成一步撤销；
   - BGM/底色 → 本镜调用（引擎语义：自本镜起延续到下一次改动）。
   前后的镜数据一字不动；后续镜按引擎语义继承本镜结果，直到它们自己改动。
   失效配合：editor 对 L2/L3 只重建受影响分区（refreshSections，时间轴
   自持 sel 不丢）；时间轴指针交互期间挂起重建（onBusy，见 timeline.js）。 */

import {h, clear} from '../ui/dom.js';
import {CONTENT_TYPES, BUBBLE_POSITIONS, splitPages} from '../core/schema.js';
import {L1} from '../core/doc.js';
import {isValidPos} from '../core/state.js';
import {foldShotState, LAYER_NAMES, BG_COLORS} from '../core/shotstate.js';
import {fldRow, fldText, fldArea, fldNumber, fldCheck, fldSelect, fldSpeaker} from './fld.js';
import {openPicker, openAudioPicker, toggleAudioPreview} from './picker.js';

const sec = (key, title, ...rows) => h('details.ins-sec',
    {open: true, dataset: {insSection: key}},
    h('summary', {text: title}), ...rows);

const fmt = (n) => String(Number.isInteger(n) ? n : Math.round(n * 100) / 100);

/* —— 写路径工厂：所有写入都只落 doc.story.shots[index] —— */
function makeWriters(doc, index) {
  const P = (field, v, opts) => doc.patch(index, field, v, opts);

  /* imgTween 的「状态帧」：该元素在本镜 0 号位的落定值。已有 0 号帧就并入
     （同值不写），没有就插到该元素首帧之前保持时序（后帧仍按自己的窗口
     覆盖，编排在时间轴里继续可调）。 */
  function upsertStateFrame(imgId, fields, label) {
    const arr = doc.story.shots[index].imgTween ?? [];
    const at = arr.findIndex((t) => t && t.imgId === imgId && (t.delay ?? 0) === 0);
    if (at >= 0) {
      const cur = arr[at];
      if (Object.entries(fields).every(([k, v]) => cur[k] === v)) return;
      P('imgTween', arr.map((t, n) => n === at ? {...t, ...fields} : t), {label});
      return;
    }
    const first = arr.findIndex((t) => t && t.imgId === imgId);
    const frame = {imgId, delay: 0, duration: 0.5, ...fields};
    const next = first >= 0
        ? [...arr.slice(0, first), frame, ...arr.slice(first)]
        : [...arr, frame];
    P('imgTween', next, {label});
  }

  function upsertFace(imgId, faceId) {
    const arr = (doc.story.shots[index].heroFace ?? [])
        .filter((f) => f && f.imgId !== imgId);
    arr.push({imgId, faceId});
    P('heroFace', arr, {label: '表情'});
  }

  function dropFace(imgId) {
    const arr = (doc.story.shots[index].heroFace ?? [])
        .filter((f) => f && f.imgId !== imgId);
    P('heroFace', arr.length ? arr : undefined, {label: '表情'});
  }

  /* 移出舞台。本镜注册的直接摘条目（delete 语义是先删后注册=没删）；
     延续条目追加 delete 标记。都顺手摘掉本镜给它的帧（条目没了帧是死的）。 */
  function removeFromStage(row, label = '移除') {
    doc.structure((story) => {
      const s = story.shots[index];
      let images = s.images ?? [];
      if (row.since === index) {
        images = images.filter((im) =>
            !(im && !im.delete && im.imgId === row.imgId));
      } else {
        images = [...images.filter((im) =>
            !(im && im.delete && im.imgId === row.imgId)),
            {imgId: row.imgId, delete: true}];
      }
      if (images.length) s.images = images; else delete s.images;
      const tween = (s.imgTween ?? []).filter((t) => !(t && t.imgId === row.imgId));
      if (tween.length) s.imgTween = tween; else delete s.imgTween;
    }, {label});
  }

  /* 重注册（换图/换装/通讯框）：本镜 delete + 复制原注册条目改字段重列
     （语料换装语义：回收后重建全新 item，可见度/明暗从新条目重算），再补
     一条 0 号状态帧把台上的可见度/槽位/明暗原样接回来（并入已有 0 号帧）。
     structure 打包 images+imgTween 成一步撤销。 */
  function reRegister(row, fields, label) {
    doc.structure((story) => {
      const s = story.shots[index];
      const src = row.src
          ?? {imgId: row.imgId, imgType: row.imgType, imgPath: row.imgPath};
      const entry = {...src, ...fields};
      for (const [k, v] of Object.entries(entry)) if (v === undefined) delete entry[k];
      const images = (s.images ?? []).filter((im) =>
          !(im && im.imgId === row.imgId));
      images.push({imgId: row.imgId, delete: true}, entry);
      s.images = images;
      const restore = {alpha: row.alpha};
      if (row.imgType === 3) restore.posId = isValidPos(row.posId) ? row.posId : 3;
      if (row.isDark) restore.isDark = true;
      const arr = s.imgTween ?? [];
      const at = arr.findIndex((t) => t && t.imgId === row.imgId
          && (t.delay ?? 0) === 0);
      if (at >= 0) {
        s.imgTween = arr.map((t, n) => n === at ? {...t, ...restore} : t);
        return;
      }
      const frame = {imgId: row.imgId, delay: 0, duration: 0.5, ...restore};
      const first = arr.findIndex((t) => t && t.imgId === row.imgId);
      s.imgTween = first >= 0
          ? [...arr.slice(0, first), frame, ...arr.slice(first)]
          : [...arr, frame];
    }, {label});
  }

  return {P, upsertStateFrame, upsertFace, dropFace, removeFromStage, reRegister};
}

/* 新条目 id 要避开「台上已有」的 id——旧版只看本镜 images，会撞延续条目。 */
function usedIds(doc, index, st) {
  const used = new Set([...st.sprites.map((s) => s.imgId),
      ...st.layers.map((l) => l.imgId)]);
  for (const im of doc.story.shots[index].images ?? []) {
    if (im && !im.delete) used.add(im.imgId);
  }
  return used;
}

/* —— 通用行控件 —— */
function pathInput({reRegister}, row) {
  const inp = h('input', {type: 'text', value: row.imgPath ?? '',
      title: '路径（改动=本镜重注册：回收旧条目+列新条目+状态帧接回台上）',
      style: {flex: '1 1 110px', minWidth: '84px'}});
  inp.addEventListener('change', () => {
    const v = inp.value.trim();
    if (!v || v === row.imgPath) { inp.value = row.imgPath ?? ''; return; }
    reRegister(row, {imgPath: v}, row.imgType === 3 ? '换装' : '换图');
  });
  return inp;
}

function alphaInput({upsertStateFrame}, row) {
  const inp = h('input', {type: 'number', min: 0, max: 1, step: 0.05,
      value: row.alpha ?? 0, title: '可见度（写本镜 0 号状态帧）',
      style: {width: '56px', flex: 'none'}});
  inp.addEventListener('change', () => {
    if (inp.value === '') return;
    upsertStateFrame(row.imgId,
        {alpha: Math.min(1, Math.max(0, Number(inp.value)))}, '可见度');
  });
  return inp;
}

function darkCheck({upsertStateFrame}, row) {
  const inp = h('input', {type: 'checkbox', checked: !!row.isDark,
      title: '压暗（明暗是赋值：写本镜状态帧，缺省不碰）'});
  inp.addEventListener('change', () =>
      upsertStateFrame(row.imgId, {isDark: inp.checked}, '明暗'));
  return h('label', {}, inp, '暗');
}

/* —— 1 · 对白（只属本镜，无延续态）—— */
function buildDialog({doc, index, shot, characters}) {
  const pages = splitPages(shot.content ?? '');
  const pageTabs = pages.length > 1 ? h('div.row', {},
      ...pages.map((_, n) => h('span.ins-tag', {text: `第${n + 1}页`}))) : null;
  return sec('dialog', '1 · 对白',
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
          {text: 'scrambleTypeWriter'})));
}

/* —— 2 · 背景：台上全部非立绘图层 + 底色 —— */
function buildBg(ctx) {
  const {doc, index, shot, st, registry, since, P,
      upsertStateFrame, removeFromStage, reRegister} = ctx;
  const rows = st.layers.map((ly) => h('div.ins-item', {},
      h('div.row.ss-row', {},
          h('span.ins-tag', {text: `#${ly.imgId}`}),
          h('span.ss-type', {text: LAYER_NAMES[ly.imgType] ?? `层${ly.imgType}`}),
          pathInput(ctx, ly),
          ly.imgType === 2 ? h('button.tiny', {text: '选图',
              onclick: () => openPicker(registry, {
                title: `换背景 #${ly.imgId}`, kind: 'bg',
                onPick: (s) => {
                  document.querySelector('.picker-overlay')?.remove();
                  reRegister(ly,
                      {imgPath: (s.item?.group ?? '') + '/' + s.name}, '换图');
                }})}) : null,
          since(ly.since)),
      h('div.row.ss-row', {},
          alphaInput(ctx, ly),
          darkCheck(ctx, ly),
          h('span.ss-meta', {text: ly.pos
              ? `pos(${ly.pos.map(fmt).join(',')})` : ''}),
          ly.touched ? h('span.ss-flag', {text: '本镜有动'}) : null,
          h('span.spacer'),
          h('button.tiny', {text: '移除',
              title: '本镜移出舞台（回收条目，后续镜也不再显示）',
              onclick: () => removeFromStage(ly)}))));

  const bgc = h('select', {title: '底色（写本镜 bgColor；「不动」=删本镜键，延续现状）'},
      h('option', {value: '', text: '（本镜不动）',
        selected: shot.bgColor === undefined}),
      ...Object.entries(BG_COLORS).map(([v, t]) =>
          h('option', {value: v, text: t,
            selected: Number(shot.bgColor) === Number(v)})));
  bgc.addEventListener('change', () => P('bgColor',
      bgc.value === '' ? undefined : Number(bgc.value), {label: '底色'}));

  return sec('bg', `2 · 背景（台上 ×${st.layers.length}）`,
      ...rows,
      h('div.row.ss-row', {},
          h('span.ss-type', {text: '底色'}),
          bgc,
          st.bgColor
              ? h('span.ss-meta', {text: `台上：${BG_COLORS[st.bgColor.value]}`})
              : h('span.ss-meta', {text: '（无）'}),
          st.bgColor ? since(st.bgColor.since) : null),
      h('button.tiny', {text: '+ 背景层', onclick: () => {
        openPicker(registry, {title: '加背景层', kind: 'bg',
          onPick: (s) => {
            document.querySelector('.picker-overlay')?.remove();
            const imgId = Math.max(0, ...usedIds(doc, index, st)) + 1;
            P('images', [...(doc.story.shots[index].images ?? []),
                {imgId, imgType: 2,
                  imgPath: (s.item?.group ?? '') + '/' + s.name,
                  alpha: 0, fullScreen: true}], {label: '加背景'});
          }});
      }}));
}

/* —— 3 · 立绘：台上全部立绘 —— */
function buildSprite(ctx) {
  const {doc, index, shot, st, registry, since,
      upsertStateFrame, removeFromStage, reRegister} = ctx;
  const rows = st.sprites.map((sp) => h('div.ins-item', {},
      h('div.row.ss-row', {},
          h('span.ins-tag', {text: `#${sp.imgId}`}),
          h('span.ss-type', {text: '立绘'}),
          pathInput(ctx, sp),
          h('button.tiny', {text: '选人', onclick: () => openPicker(registry, {
              title: `换装 #${sp.imgId}`, kind: 'chara',
              onPick: (s) => {
                document.querySelector('.picker-overlay')?.remove();
                reRegister(sp, {imgPath: s.name}, '换装');
              }})}),
          since(sp.since)),
      h('div.row.ss-row', {},
          alphaInput(ctx, sp),
          darkCheck(ctx, sp),
          posSelect(ctx, sp),
          commCheck(ctx, sp),
          faceInput(ctx, sp),
          h('span.ss-meta', {text: [
              !sp.entered ? '未揭示'
                  : sp.alpha > 0 ? `α${fmt(sp.alpha)}${sp.isDark ? ' · 压暗' : ''}`
                  : '隐身',
              sp.comm ? '通讯框' : null,
              sp.faceId ? `表情${sp.faceId}`
                  : sp.faceId === 0 ? '默认脸' : null,
            ].filter(Boolean).join(' · ')}),
          sp.touched ? h('span.ss-flag', {text: '本镜有动'}) : null,
          h('span.spacer'),
          !sp.entered ? h('button.tiny', {text: '揭示',
              title: '本镜入场：0 号帧 α1（时序可在动画区再调）',
              onclick: () => upsertStateFrame(sp.imgId,
                  {alpha: 1, posId: isValidPos(sp.posId) ? sp.posId : 3}, '揭示')}) : null,
          sp.entered && sp.alpha > 0 ? h('button.tiny', {text: '退场',
              title: '本镜淡出 α0/0.2（条目仍在台上，可再揭示）',
              onclick: () => upsertStateFrame(sp.imgId,
                  {alpha: 0, duration: 0.2}, '退场')}) : null,
          h('button.tiny', {text: '移除',
              title: '本镜移出舞台（回收条目，后续镜也不再显示）',
              onclick: () => removeFromStage(sp)}))));

  const bad = st.sprites.filter((sp) => !registry.layoutEntry(sp.imgPath)?.layout);
  return sec('sprite', `3 · 立绘（台上 ×${st.sprites.length}）`,
      ...rows,
      h('button.tiny', {text: '+ 立绘槽', onclick: () => {
        openPicker(registry, {title: '加立绘', kind: 'chara',
          onPick: (s) => {
            document.querySelector('.picker-overlay')?.remove();
            const used = usedIds(doc, index, st);
            let imgId = 101;
            while (used.has(imgId)) imgId += 2;
            doc.patch(index, 'images',
                [...(doc.story.shots[index].images ?? []),
                    {imgId, imgType: 3, imgPath: s.name, alpha: 0}],
                {label: '加立绘'});
          }});
      }}),
      bad.length ? h('div.row', {},
          h('span.warn', {text: `⚠ ${bad.length} 个立绘未标定`}),
          h('button.tiny', {text: '去标定', onclick: () => {
            location.href = `cal.html?id=${encodeURIComponent(bad[0].imgPath)}`;
          }})) : null);
}

function posSelect({upsertStateFrame}, sp) {
  const sel = h('select', {title: '槽位（写本镜状态帧 posId）'},
      ...[undefined, 1, 2, 3, 4, 5].map((p) =>
          h('option', {value: String(p), text: p ? `槽${p}` : '-',
            selected: sp.posId === p})));
  sel.addEventListener('change', () => {
    const p = sel.value === 'undefined' ? undefined : Number(sel.value);
    upsertStateFrame(sp.imgId, {posId: p}, '槽位');
  });
  return sel;
}

function commCheck({reRegister}, sp) {
  const inp = h('input', {type: 'checkbox', checked: !!sp.comm,
      title: '通讯框随注册生效：改动=本镜重注册（回收重建，可撤销）'});
  inp.addEventListener('change', () =>
      reRegister(sp, {comm: inp.checked}, '通讯框'));
  return h('label', {}, inp, '通讯');
}

function faceInput({shot, upsertFace, dropFace}, sp) {
  const inp = h('input', {type: 'number', min: 0, step: 1,
      value: sp.faceId ?? '',
      title: '表情号（写本镜 heroFace）：0=默认脸；清空=删本镜表情，延续此前',
      style: {width: '52px', flex: 'none'}});
  inp.addEventListener('change', () => {
    if (inp.value === '') {
      if ((shot.heroFace ?? []).some((f) => f && f.imgId === sp.imgId)) {
        dropFace(sp.imgId);
      }
      return;
    }
    upsertFace(sp.imgId, Math.max(0, Number(inp.value)));
  });
  return h('label', {}, '表情', inp);
}

/* —— 4 · 动画（timeline 由 editor 提供容器并负责挂载/失效）—— */
function buildAnim({timelineHost}) {
  return sec('anim', '4 · 动画', timelineHost ?? h('div'));
}

/* —— 5 · 音乐：当前台上 BGM（出处可跳）+ 本镜调用 ——
   选曲回填 cue+sheet（bgm 保留已有淡入淡出、清掉 stop——选了曲就是要它响）；
   回填用 forceLevel L1：L3 的 patchShot 不触发音频，重装载才能在预览里
   听见挂载效果。sfx 不随 seek 补放，听效果走行内 ▶。 */
function buildMusic(ctx) {
  const {doc, index, shot, st, registry, audio, since} = ctx;
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
          doc.patch(index, 'audio', part === 'bgm'
              ? {...shot.audio, bgm: {cue, sheet,
                  fadeIn: bgm?.fadeIn, fadeOut: bgm?.fadeOut}}
              : {...shot.audio, sfx: {cue, sheet}},
              {label: part, forceLevel: L1});
        }})});
  return sec('music', '5 · 音乐',
      h('div.row.ss-row', {},
          h('span.ss-type', {text: '当前BGM'}),
          st.bgm
              ? h('span.ss-main', {text: [
                  st.bgm.cue,
                  st.bgm.sheet && st.bgm.sheet !== st.bgm.cue ? st.bgm.sheet : null,
                  `淡入${fmt(st.bgm.fadeIn ?? 1)} 淡出${fmt(st.bgm.fadeOut ?? 1)}`,
                ].filter(Boolean).join(' · ')})
              : h('span.ss-meta', {text: st.bgmStop
                  ? `（已于第 ${st.bgmStop.since} 镜停止）` : '（无）'}),
          st.bgm ? since(st.bgm.since) : null),
      h('div.ins-music', {},
          fldRow('bgm', fldText(doc, index, 'audio.bgm.cue', {placeholder: 'Mus_...'}),
              pickBtn('bgm'), hearBtn('bgm'),
              fldNumber(doc, index, 'audio.bgm.fadeIn', {min: 0, step: 0.5}),
              fldNumber(doc, index, 'audio.bgm.fadeOut', {min: 0, step: 0.5}),
              fldCheck(doc, index, 'audio.bgm.stop', {text: '停'})),
          fldRow('sfx', fldText(doc, index, 'audio.sfx.cue', {placeholder: 'AVG_...'}),
              fldText(doc, index, 'audio.sfx.sheet', {placeholder: 'sheet'}),
              pickBtn('sfx'), hearBtn('sfx'))));
}

/* —— 6 CV（M15）—— voice={heroId, voiceId} 由宿主的 resolveVoice 解到
   VO_<代号>/<代号>_<语音名>.ogg（data/index/voices.json）；解析不到给 ⚠。
   播放语义：新句掐旧句、seek 不补。 */
function buildCV({doc, index, shot, audio}) {
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
  return sec('cv', '6 · CV', h('div.ins-music', {},
      fldRow('heroId', fldNumber(doc, index, 'voice.heroId', {step: 1})),
      fldRow('voiceId', fldNumber(doc, index, 'voice.voiceId', {step: 1}),
          voiceBtn, voiceTip)));
}

/* —— 7 特效/其他：台上特效（出处可跳）+ 死字段 JSON 兜底 —— */
function buildFx({doc, index, shot, st, since, P}) {
  const rows = [];
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
  if (st.ppv) {
    rows.push(h('div.row.ss-row', {},
        h('span.ss-type', {text: '后处理'}),
        h('span.ss-main', {text: 'ppv'}),
        since(st.ppv.since)));
  }
  if (!rows.length) rows.push(h('div.muted', {text: '（台上无特效）'}));

  const RAW = ['effect', 'contentShake', 'bgColor', 'SkipScenario',
    'storyAvgId', 'pre_condition', 'vedioPath'];
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
  return sec('fx', '7 · 特效/其他', ...rows, rawJson);
}

const SECTION_BUILDERS = {
  dialog: buildDialog,
  bg: buildBg,
  sprite: buildSprite,
  anim: buildAnim,
  music: buildMusic,
  cv: buildCV,
  fx: buildFx,
};

function makeCtx(opts, st) {
  const {doc, index, onGoto} = opts;
  const jump = (i) => h('button.ss-jump', {text: `第${i}镜`,
      title: `跳到第 ${i} 镜`, onclick: () => onGoto?.(i)});
  const since = (i) => h('span.ss-since', {}, '于', jump(i), '起',
      i === index ? h('span.ss-now', {text: '本镜起'}) : null);
  return {...opts, st, shot: doc.story.shots[index], since,
      ...makeWriters(doc, index)};
}

/* 在场元素清单：给 timeline 的幽灵轨道（点空白即为本镜插首帧）。 */
function stageOf(st) {
  return [
    ...st.sprites.map((sp) => ({imgId: sp.imgId, label: sp.imgPath, imgType: 3,
        alpha: sp.alpha, posId: sp.posId, entered: sp.entered})),
    ...st.layers.map((ly) => ({imgId: ly.imgId, label: ly.imgPath,
        imgType: ly.imgType, alpha: ly.alpha})),
  ];
}

/* 全量渲染（选镜/结构变更/撤销后）。返回在场元素清单给 editor 挂时间轴。 */
export function renderInspector(host, opts) {
  clear(host);
  if (opts.index == null) {
    host.append(h('div.muted', {text: '选一个分镜'}));
    return [];
  }
  const st = foldShotState(opts.doc.story, opts.index);
  const ctx = makeCtx(opts, st);
  host.append(h('div.ins-note', {text:
      '各层列出「台上现状」：延续项注明出处，可点击跳转。改动只写入本镜——'
      + '前后的镜数据不动；后续镜按引擎语义继承本镜结果，直到它们自己改动。'}));
  for (const build of Object.values(SECTION_BUILDERS)) host.append(build(ctx));
  return stageOf(st);
}

/* 定点重建（L2/L3 提交后）：只换列出的分区，时间轴宿主原地保留。 */
export function refreshSections(host, opts, keys) {
  if (opts.index == null) return;
  const st = foldShotState(opts.doc.story, opts.index);
  const ctx = makeCtx(opts, st);
  for (const key of keys) {
    const next = SECTION_BUILDERS[key]?.(ctx);
    if (!next) continue;
    const old = host.querySelector(`[data-ins-section="${key}"]`);
    if (old) old.replaceWith(next);
    else host.append(next);
  }
}
