# 云图计划 · AVG 剧情播放器编辑器

像素级复刻 GFWiki「行动记录/绿洲防线」的 AVG 剧情播放器（`MediaWiki:Gadget-AvgPlayer.js`），
并在此之上提供背景 / 音乐 / 说话人 / 对白 / 立绘的完整编辑能力。
纯静态、无构建、无依赖：原生 ES Module + 普通 CSS，任何静态目录都能跑。

## 快速开始

```bash
python tools/ref/serve.py 8080     # 或任意静态服务器，根 = 本仓库
# 打开 http://127.0.0.1:8080/index.html   编辑器
#        http://127.0.0.1:8080/cal.html   立绘标定
```

`tools/ref/serve.py` 额外提供两样开发期能力：`/images/<名>` 的 wiki 素材代理
（按 md5 目录寻址、本地缓存优先）和 `/freeze?scene=X` 的冻结件落盘——
所有回归跑者都依赖它。用别的服务器时页面照常工作，只是代理与自动冻结通道关闭。

## 保真方法论

参考实现是「神谕」：`tools/ref/AvgPlayer.js` 与参考逐字节相同（仅 import 路径本地化），
由 `tools/ref/driver.mjs`（播放）与 `tools/ref/uidriver.mjs`（交互）在无头 Chrome 里
跑出**冻结表**（`data/fixtures/expected-*.json`），我们的引擎逐项对拍。
「复刻完成」的定义 = 冻结对拍全绿，而不是看着像。

## 回归矩阵

| 命令 | 内容 | 判据 |
|---|---|---|
| `node tools/test-script.mjs` | 剧本双格式归一化 | 15 项 |
| `node tools/test-markup.mjs` | 分词/分页/打字机三态 | 对拍参考 |
| `node tools/test-skeleton.mjs` | 舞台骨架逐 id | 结构保真 |
| `node tools/test-style.mjs` | avg/pandect.css 移植 | 逐声明+白名单 |
| `node tools/test-sprite-rules.mjs` | 立绘规则表 | 与冻结逐条等 |
| `node tools/test-sprite.mjs` | 画布合成/换脸/推导 | 像素判据 |
| `node tools/test-freeze.mjs` | 冻结表自可信性 | 参考公式重算 |
| `node tools/test-play.mjs [--scene=sceneN]` | 播放器逐镜（scene1/scene4） | 2164 断言级 |
| `node tools/test-seek.mjs` | seek ≡ 连播暂停 | 120 到达点全等 |
| `node tools/test-ui.mjs` | 交互路径（面板/词典/自动/skip/分支） | 908 断言 |
| `node tools/test-editor.mjs` | 编辑器失效 + prev 起值回归 | 真实钟采样 |
| `node tools/test-io.mjs` | 导出→导入→连播快照全等 + 解包离线探针（含音频资产） | 59 断言 |
| `node tools/test-assets.mjs` | IDB/注册表/标定挂载 + 编辑器冒烟 | 27+冒烟 |
| `node tools/test-audio.mjs` | 音频编排（FakeCtx 纯 Node，含 M15 CV 语音通道） | 10 项 |
| `node tools/test-doc.mjs` | 撤销栈/失效分级 | 7 项 |
| `node tools/test-zip.mjs` | STORE 打包可复现 | 4 项 |
| `node tools/test-repo-index.mjs` | 素材索引/搜索/R13 退化（含音频索引与三级解析） | 9 项 |
| `node tools/test-avgcfg.mjs` | AvgCfg/AvgLang 字节码解释器 + wire 映射层（格式+VM 锚点+全语料口径） | 9 项 |
| `node tools/test-avg-e2e.mjs` | 语料端到端：现场解码→映射→播放器逐镜 seek（cpt00 主线 + 23concert 立绘/分支） | 2 段全对 |
| `node tools/test-storylib.mjs` | 剧本库：分组/搜索/loadStory 装载链/索引增强件/语音映射/剧情目录 | 7 项 |
| `node tools/build-asset-index.mjs` | 重建索引（自带 639/496 验收 + 剧本清单） | — |

scene4 是 M11 补的形态夹具：type1、多页 `<|>`、通讯框、delete、type5、nextId
跳转——M4 时代「本轮没跑到的形态」现已全部纳入逐字节对拍。

## 目录

```
css/       avg.css pandect.css（参考逐声明移植）· app.css（编辑器）· ux.css（动效降级/缺素材占位）
js/core/   schema markup scheduler state script doc idb repo-index assets lundump lvm avgwire
js/engine/ player sprite typewriter nouns audio
js/editor/ editor inspector fld picker storylib timeline layout-cal io
js/ui/     dom zip
js/test/   harness.js（观测件：虚拟钟/settle/snapshot，两套回归共用）
js/play.js 离线 bundle 播放入口
data/      fixtures（夹具+冻结表）· index（可浏览素材索引）· layouts · fonts · ui
tools/     test-*.mjs 回归跑者 · build-asset-index.mjs · avg-dump.mjs · media/unpack-{acb,avgconfig}.mjs · media/build-voice-index.mjs · shot.mjs
tools/ref/ 参考件（.gitignore 排除）+ driver/uidriver/serve/setup（我们写的观测工具）
```

依赖严格单向：`core ← engine ← editor/宿主`；只有 `player/sprite/nouns` 碰播放器 DOM，
编辑器一律走 Player 公开方法（`setScene/seekShot/seekTime/playShot/patchShot`）。

## 引擎要点

- **可注入时钟**：引擎时序全走 `Scheduler`（真实播放 = REAL_TIMER；回归 = 虚拟钟），
  `flush()` 把挂起的等待按注册序瞬间跑完——seek 的重放因此不真等。
- **seek = 重放真实播放路径**：`seekShot(key)` 从空场重开沿 `playShot` 推进，
  「seek 落点 ≡ 连播暂停」是构造保证；`{timed:true}` 让最后一跳走真实钟，
  过渡起值来自上一镜 settled（编辑器 L2 失效用）。
- **失效三级**（编辑器）：L3 文案定点补丁、L2 tween 防抖 120ms timed seek、
  L1 结构防抖 60ms 重装载；player 不订阅文档。
- **epoch 护栏**：每次 seek/清场 `bump()`，在途回调全部哑火（参考没有的概念，
  它的陈旧链会在 clearStage 后抛 TypeError——DOM 结果一致，console 噪声已记录）。

## 与参考的刻意偏离（都有回归背书）

1. 画布 2048²→1024²（R3：数学等价、省显存；像素比对仅剩立绘边缘重采样差）。
2. `setScene` 写副本不改原始 wire（编辑器不能接受原地格式化）。
3. 立绘规则表按 imgId 确定性重建（参考是网络竞态序 + 重复装载翻倍）。
4. 自动播放/打字等时序在浏览器里与参考同参（50ms/2s/1s），虚拟钟下坍缩。
5. 音频是净新增（参考对 `audio` 字段零实现）：bgm 交叉淡化、sfx 叠响、
   手势前静音 + 解锁按流逝续播。
6. 忠实照抄的参考怪癖：skip 弹层取消/确认无 handler（点击=推进）、dict 面板
   可叠开、多页 `<p>` 挂在 logDiv 本体、`charaRules` 模板空白
   进 innerHTML——完整清单见 `data/fixtures/expected-ui_scene*.json` 与计划文档。
   一处宿主偏离：编辑器里 log 面板任意点击收起、日志键再点切换
   （`logClickCloses`，参考默认是点击照常推进且面板常驻——冻结 UI 测试
   仍走参考语义）。

## 音频实装（M12）

`res/Assets/media` 的 CRIWARE 音源（.acb/.awb，HCA 加密）由
`node tools/media/unpack-acb.mjs` 转码到 `data/audio/<sheet>/<cue>.ogg`
（vgmstream 解码 → ffmpeg → ogg vorbis，支持 `--only/--force` 增量），索引落在
`data/index/audio.json`（{sheets, byCue}，缺席 = 空音频库，不阻塞其余功能）。
真实剧本语义：sfx 的 sheet=ACB 表名（AVG_gf、Chara_*），bgm 的 sheet=cue
（瘦表一曲一表）；解析三级 = 上传件 > sheet/cue 精确 > byCue 全局兜底。
检查器音乐区带「选曲」（搜索 + sheet 过滤 + 行内试听）与 ▶ 试听；
选曲回填 cue+sheet 并按 L1 重装载（预览立刻出声）。导出三形态都带音频：
工程 JSON 记 repoPath（键 `audio:<sheet>/<cue>`），ZIP/目录 bundle 落
`assets/audio/<sheet>/<cue>.ogg` 真文件。

## 素材树重构（M13）

`res/` 按「剧情复原需要」收敛为专用子集（11GB → 4.1GB），构成：

| 子树 | 内容 | 来源 bundle |
|---|---|---|
| `res/Assets/Res/Images/Avg/<章>/` | 639 背景/CG，18 章（cpt00–cpt11、sg、oath、summer、pola、21winter、cpt001） | `res/images/avg/*.ab` |
| `res/Assets/Res/Character/<id>/` | 1067 个立绘目录：`lpic_<id>.png` + `Face/<id>_face_N.png`（515 个 `_avg` + boss/NPC） | `res/character/*/face.ab + lpic_*.ab` |
| `res/Assets/Res/LuaScripts/Avg/` | **1878 段剧情** = `AvgCfg_<id>.lua`（演出指令）+ `AvgLang_<id>_ZH_CN.lua`（中文台词），Lua 5.3 字节码、字符串明文，共 3756 文件 | `res/luascripts/avgconfig.ab` |
| `res/Assets/Res/LuaScripts/Configs/` | 活动剧情入口（`activity_23steinsgate_storyline.lua`） | `res/luascripts/configs.ab` |
| `res/Assets/media/audios/` | CRIWARE 音源 acb/awb（含 `Voice/JA_JP`，M15 起已转码至 `data/audio/`；**不入库**，仅本地保留） | — |

已清离（原始镜像里都在，可随时再提取）：Images 非 Avg（商城/活动图 ~1GB）、
Character 的 `L2D/`（858MB——全部 3756 个剧本零 `l2d/cubism` 引用，AVG 全是
静态立绘+表情差分）、`skill/`+`IconEffcet/`（战斗图标 162MB）、202 个无 lpic
的目录（14MB，不在索引内）、`SpriteAtlas/`（UI 图集 180MB）、`Fairy/`、
`media/videos/`（523MB）、audios 顶层 `.wav` 手工解码中间产物（3.9GB，
可由 acb/awb 经 vgmstream 再生）。

**剧本清单**：`build-asset-index.mjs` 额外扫 `LuaScripts/`，产出
`data/index/avg-scripts.json`（`{stories:[{id,cfg,lang}], configs}`）——
后续剧情库/解释器按剧情 ID 枚举用；引擎图片解析仍走扁平 asset-index 不变。

**剧本解释器**：`js/core/lundump.js`（字节码 → Proto 树）+ `js/core/lvm.js`
（46 opcode 全集执行 + `toJS` 序列化）。游戏的 dump 与官方 5.3 的全部差异
（四尺寸字节头、顶层 upvalue 数、255 转义 4 字节长度、SETTABLE/GETTABLE/
GETTABUP 的 RK 编码）都记录在 lundump.js 头注并经语料逐文件验证；VM 按
「数据脚本」裁剪（数值不分 int/float、upvalue 快照、pairs 插入序——语料
零 CLOSURE）。解码形态：Cfg = 步骤 ID → `{content, contentType, images[],
imgTween, audio{bgm,sfx}, effect, ppv, nextId…}`，Lang = content-id → 台词
文本（含 `<color>`/`<a href=Des:N>` 富文本）。CLI：`node tools/avg-dump.mjs
<ID> [--lang]` 单段解码、`--scan` 全语料普查。回归 `tools/test-avgcfg.mjs`
含格式护栏、语义锚点（与 strings 侧写核对）与 1878 段 0 失败门槛。

**wire 映射层（`js/core/avgwire.js`）**：`storyToWire` 把解码件转成引擎
原生吃下的 map 格式 wire，四条规则都有语料口径背书——
1. Lang 解引用：content/speakerName/SkipScenario/branch[].content 的数字键
   解析成本剧本台词（全语料 121016 处命中；128 处跨剧本引用保数字可见，
   storyAvgId 指向全局标题命名空间原样透传）；
2. 0 起始平移：键 '0' 存在的剧本（1555 段）整体 +1（引擎 map 格式的键 0
   是"开局之前"，永远渲染不到）；
3. branch 双形态归一：对象形态（选项 + disableSelected/finalAct 旗标）展平
   为数组，旗标挪到 shot 根；
4. 富文本预转换：`<color>/<size>/<a href=Des>/<i>` 转成 span 输出形态——
   参考 reformat 的贪婪正则会把同行多标记折叠丢弃，预转换后单标记等价、
   多标记不丢（`<b>/<cmdr>/<TA>` 引擎原生支持保持原样）。

**语料端到端**（`selftest-avg.html` + `tools/test-avg-e2e.mjs`）：浏览器里
现场 fetch 字节码 → 解码 → 映射 → `setScene` 真机 `seekShot` 逐镜跑通，
台词逐镜与 Node 侧同源解码对拍。覆盖纯文本主线（cpt00_e_01_01，46 镜）
与立绘+分支（23concert_undline_03，无标定立绘走 deriveLayout 兜底）。

**剧本库（M14，`js/editor/storylib.js`）**：顶栏「剧本库」按钮 → 模态列表
（搜索 ID + 按首段分组 + 镜数/简介），点选即经 `loadStory` 装载进编辑器，
走与夹具完全相同的 useStory/保存/导出管线；编辑器冒烟（test-assets）把
装载链纳入回归。索引增强：build-asset-index 现场解码全语料给每段补
`steps`/`brief`，并把「解码+映射 0 失败」升格为构建门槛。

**空壳 bundle 结论**：18 个 `_avg` 角色（abigail/betty/bonee…zion）的
`lpic_*.ab` 解析出 0 资源——游戏本体就没给这些角色出立绘，不是提取缺口；
镜像与本地树已逐目录核对一致（抽查 abigail/mag2 65=65）。

**再提取**（原始 bundle 在游戏镜像目录，工具 `AssetStudio-net10.0-win/`）：

```bash
# 背景/CG：ByContainer 直接得到 Assets/Res/Images/Avg 布局，输出根=res/ 即免搬运
AssetStudio.CLI.exe <镜像>/res/images/avg/cpt00.ab res/ --types Texture2D \
    --group_assets ByContainer --game FakeHeader
# 立绘（每角色一个目录：face.ab + lpic_*.ab）
AssetStudio.CLI.exe <镜像>/res/character/persicaria_avg res/ --types Texture2D \
    --group_assets ByContainer --game FakeHeader
# 剧本：解出 TextAsset 后归位（剥容器前缀/.bytes 尾缀）
AssetStudio.CLI.exe <镜像>/res/luascripts/avgconfig.ab /tmp/avgcfg --game FakeHeader
node tools/media/unpack-avgconfig.mjs /tmp/avgcfg && node tools/build-asset-index.mjs
# 语音/剧情目录映射：解出 configs.ab 后生成 voices.json + story-catalog.json
AssetStudio.CLI.exe <镜像>/res/luascripts/configs.ab /tmp/cfgs --game FakeHeader
node tools/media/build-voice-index.mjs /tmp/cfgs/TextAsset
node tools/media/unpack-acb.mjs --voice      # Voice/JA_JP 转码（约 690MB ogg）
```

## 剧情 CV 语音与剧情线（M15）

语料 voice 字段 `{heroId, voiceId}`（93 英雄 468 对引用）经
`data/index/voices.json` 解到 CRIWARE cue，三层规则全部实证自游戏配置表
（configs.ab）：
- heroId → 代号：`skin.lua` 默认皮肤的 `src_id_pic`（1002→anna、
  1034→abigail；`hero_data.name_en` 是本地化名，Antonina≠abigail，不通；
  无皮肤条目的英雄回退 name_en 小写，如 1001 帕斯卡→persicaria）；
- voiceId → 语音名：`audio_voice.lua[voiceId].name`（112-116=
  RELATIONSHIP1-5 好感度语音、117=OATH 誓约、1=MORNING）；
- cue = `<代号>_<语音名>`，落在 `Voice/JA_JP/VO_<代号>.awb`——
  `unpack-acb.mjs --voice` 转码（**AWB 优先**：其 ACB 只内嵌首条 cue，
  完整波形全在 AWB）。

引擎 voice 通道：单声道新句掐旧句、seek 不补放、手势前丢弃、缺素材静默。
检查器新增 CV 行（heroId/voiceId 可改 + ▶ 试听）。
`build-voice-index.mjs` 消费 configs.ab 解出件产出 voices.json（语料
468 对引用 **100% 命中**真实 cue）与 `story-catalog.json`（story_avg.lua
剧情目录：1137 组 / 1067 段在册），剧本库随之新增「剧情线」分组视图。

## 已知边界

- 移动端全屏分支不实现（桌面编辑器不适用；参考行为已记录）。
- `res/` 素材树为剧情专用子集（4.1GB，构成与再提取见下节）；R13：无 res/
  时自动退化为纯上传模式。
- 分镜列表未虚拟化（夹具 <150 镜；计划 M11 记录项）。
- `prefers-reduced-motion` 下过渡归零，打字机不受影响（它不是 CSS 动画）。
- 本仓库即**全量本地部署包**：`res/`（背景/立绘/剧本）与音频转码件
  `data/audio/`（含 Voice 剧情语音约 689MB）均随 git 分发，clone 后
  `python tools/ref/serve.py 8080` 即得完整功能。音源原料
  `res/Assets/media`（acb/awb，1.1GB）与转码工具 `vgmstream-win64/`
  不入库——前者仅本地保留，后者需另行获取；要重建转码件时按上文命令
  从游戏镜像再提取。同名 cue 碰撞的 sheet（如 Ambience）按索引内序取
  唯一名，wire 按名引用本就不可区分。
- BGM 的 CRI 循环段（前奏→循环）暂按整曲循环（M7 引擎语义）。
