/* unpack-avgconfig.mjs —— 把 AssetStudio 从 avgconfig.ab 解出的 TextAsset
   归位到 res/Assets/Res/LuaScripts/。
 *
 * AssetStudio 命令（原始 bundle 在游戏镜像，--game 用与全库一致的 FakeHeader）：
 *   AssetStudio.CLI.exe <镜像>/res/luascripts/avgconfig.ab <临时输出> --game FakeHeader
 * 产出 <临时输出>/TextAsset/AvgConfig.<剧情ID>.<资源名>.lua.bytes
 *   （1878 段 × AvgCfg_<id> 演出指令 + AvgLang_<id>_ZH_CN 中文台词，
 *     Lua 5.3 字节码，字符串常量明文）。
 *
 * 本脚本做的事：剥掉「AvgConfig.<id>.」容器前缀与 .bytes 尾缀，落到
 *   res/Assets/Res/LuaScripts/Avg/<资源名>.lua
 * 归位后跑 `node tools/build-asset-index.mjs` 重建剧本清单
 * （data/index/avg-scripts.json）。
 *
 * 用法：node tools/media/unpack-avgconfig.mjs <AssetStudio输出目录>
 *       [--root <仓库根，默认 cwd>]
 */
import {readdirSync, mkdirSync, copyFileSync} from 'node:fs';
import {join, resolve} from 'node:path';

const src = resolve(process.argv[2] ?? '');
const ROOT = resolve(process.argv.includes('--root')
    ? process.argv[process.argv.indexOf('--root') + 1] : '.');
const OUT = join(ROOT, 'res', 'Assets', 'Res', 'LuaScripts', 'Avg');

/* 输入可以是 AssetStudio 输出根（含 TextAsset/）或直接是 TextAsset 目录。 */
let dir = src;
try {
  if (readdirSync(dir).includes('TextAsset')) dir = join(dir, 'TextAsset');
} catch {
  console.error(`找不到输入目录：${src}`);
  process.exit(1);
}

mkdirSync(OUT, {recursive: true});
let cfg = 0, lang = 0, skip = 0;
for (const f of readdirSync(dir)) {
  const m = /^AvgConfig\..+?\.(AvgCfg_.+|AvgLang_.+?_ZH_CN)\.lua\.bytes$/.exec(f);
  if (!m) { skip++; continue; }
  copyFileSync(join(dir, f), join(OUT, `${m[1]}.lua`));
  m[1].startsWith('AvgCfg_') ? cfg++ : lang++;
}
console.log(`归位 ${cfg} AvgCfg + ${lang} AvgLang → ${OUT}` +
    (skip ? `（跳过 ${skip} 个非剧本 TextAsset）` : ''));
if (cfg !== lang) console.warn(`  ⚠ AvgCfg/AvgLang 数量不等，检查提取完整性`);
