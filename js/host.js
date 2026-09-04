/* host.js —— 语料播放宿主的公共引导。
   index.html（编辑器）与 record.html（全屏播放页）共用同一条 boot 链：
   注册表（R13：无 res/ 退化纯上传）→ 特效/语音索引 → 音频引擎 → Player
   解析三件套。从 main.js 原文抽出，两个宿主不许漂移。 */

import {AssetRegistry} from './core/assets.js';
import {Player} from './engine/player.js';
import {AudioEngine, defaultAudioResolve} from './engine/audio.js';
import {deriveLayout} from './engine/sprite.js';

export async function bootCorpusPlayer(mount,
    {mode = 'clamp', logClickCloses = false} = {}) {
  const registry = await new AssetRegistry().boot();

  /* AVG 专用 prefab 的浏览器侧贴图索引。Unity ParticleSystem 本身不能由
     浏览器直接实例化，索引把已确认的 sprite-sheet/时长交给 Player；没有
     导出件的 prefab 仍走可识别的降级占位。 */
  let avgEffects = {};
  try {
    avgEffects = await (await fetch('data/index/avg-effects.json')).json();
  } catch { /* 纯上传/精简部署包可没有特效索引 */ }

  const loadBitmap = (url) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`lpic 加载失败: ${url}`));
    img.src = url;
  });

  const filePathOf = (name) => {
    const hit = registry.resolve(name);
    if (hit) return hit.url;
    const lower = name.toLowerCase();
    const lpic = /^lpic_(.+)\.png$/.exec(lower);
    if (lpic) return `res/Assets/Res/Character/${lpic[1]}/lpic_${lpic[1]}.png`;
    const face = /^icon_face_(.+)_(\d+)\.png$/.exec(lower);
    if (face) {
      return 'res/Assets/Res/Character/'
          + `${face[1]}_avg/Face/${face[1]}_avg_face_${face[2]}.png`;
    }
    return '/images/' + name[0].toUpperCase() + name.slice(1);
  };

  /* 游戏的 MovieManager 用无扩展名的 vedioPath；本地资源库/用户上传件则
     通常带扩展名。先按原名，再试常见容器，给 Player 一个可选的视频解析器。 */
  const videoPathOf = (path) => {
    for (const name of [path, `${path}.mp4`, `${path}.webm`, `${path}.mov`]) {
      const hit = registry.resolve(name);
      if (hit) return hit.url;
    }
    return null;
  };

  const effectAssetOf = (prefab) => {
    const entry = avgEffects[prefab];
    return entry ? {...entry} : null;
  };

  const layoutOf = async (img) => {
    const entry = registry.layoutEntry(img.imgPath);
    if (entry?.source === 'calibrated') return entry.layout;
    if (entry) return (await fetch(registry.layoutUrl(img.imgPath))).json();
    const bmp = await loadBitmap(filePathOf(`Lpic_${img.imgPath}.png`));
    return deriveLayout(bmp);
  };

  /* 音频解析三级：上传件 > 仓库音频索引（sheet/cue）> 全局 cue 表（接住
     bgm 的 sheet=cue 与省略 sheet 的脚本），最后退 data/audio 约定。
     M15 CV：data/index/voices.json 把 {heroId, voiceId} 解到
     VO_<代号>/<代号>_<语音名>（skin.lua 的 src_id_pic + audio_voice 表）。
     手势前静音、首次 pointerdown 解锁续播。 */
  let voiceIndex = null;
  try {
    voiceIndex = await (await fetch('data/index/voices.json')).json();
  } catch { /* 无语音映射：CV 静默跳过 */ }
  const audio = new AudioEngine({
    resolve: (sheet, cue) =>
        registry.resolveAudio(sheet, cue)?.url
        ?? defaultAudioResolve(sheet, cue),
    resolveVoice: voiceIndex ? ({heroId, voiceId}) => {
      const hero = voiceIndex.byHero[String(heroId)];
      const line = voiceIndex.byVoiceId[String(voiceId)];
      if (!hero || !line) return null;
      const sheet = `VO_${hero.codename}`;
      const cue = `${hero.codename}_${line}`;
      return registry.resolveAudio(sheet, cue)?.url
          ?? `data/audio/${sheet}/${cue}.ogg`;
    } : null,
    log: (m) => console.warn('[audio]', m),
  });
  addEventListener('pointerdown', () => audio.unlock(), {once: true});

  const characters = await (await fetch('data/Avg_character.json')).json();
  const nouns = await (await fetch('data/Noun_des.json')).json();

  const player = new Player({
    mount,
    mode,
    logClickCloses,
    filePathOf,
    videoPathOf,
    effectAssetOf,
    layoutOf,
    getName: () => '教授',
    getGender: () => 'TA',
    characters,
    nouns,
    audio,
  });

  return {registry, player, audio, avgEffects, characters, glossary: nouns};
}
