/* play.js —— ZIP bundle / 目录落盘的独立播放页入口（M10）。
   只依赖包内文件：project.json 提供剧本、角色表、词典、标定 layout 与
   素材（base64 内联或 assets/ 真文件）。解析三件套直接复用 io.js 的
   projectResolvers——导出→导入→播放是同一条代码，不是测试特供近似。 */

import {Player} from './engine/player.js';
import {AudioEngine} from './engine/audio.js';
import {projectResolvers} from './editor/io.js';

export async function bootProject(project, mount, {fetchImpl = fetch} = {}) {
  const {filePathOf, layoutOf} = projectResolvers(project);
  const story = project.stories[0];
  let characters = project.characters;
  if (!characters) {
    characters = await (await fetchImpl('data/Avg_character.json')).json();
  }
  const audio = new AudioEngine({
    resolve: (sheet, cue) => `assets/audio/${sheet}/${cue}.ogg`,
  });
  addEventListener('pointerdown', () => audio.unlock(), {once: true});
  const player = new Player({
    mount,
    mode: 'clamp',
    filePathOf,
    layoutOf,
    getName: () => '教授',
    getGender: () => 'TA',
    characters,
    nouns: project.glossary ?? undefined,
    audio,
  });
  player.setScene(story.shots, story.title, '1', '', '');
  return player;
}
