# 云图计划 · AVG 剧情播放器编辑器

像素级复刻 GFWiki「行动记录/绿洲防线」的 AVG 剧情播放器（`MediaWiki:Gadget-AvgPlayer.js`），
并在此之上提供背景 / 音乐 / 说话人 / 对白 / 立绘的完整编辑能力。
纯静态、无构建、无依赖：原生 ES Module + 普通 CSS，任何静态目录都能跑。

## 快速开始

```bash
python tools/ref/serve.py 8080     # 或任意静态服务器，根 = 本仓库
# 打开 http://127.0.0.1:8080/index.html       编辑器
#        http://127.0.0.1:8080/cal.html       立绘标定
#        http://127.0.0.1:8080/lib-editor.html 剧本库分类编辑
```

`tools/ref/serve.py` 额外提供三样开发期能力：`/images/<名>` 的 wiki 素材代理
（按 md5 目录寻址、本地缓存优先）、`/freeze?scene=X` 的冻结件落盘——所有回归
跑者都依赖它——和 `/archive-save` 的剧本库手动分类落盘（见 M32）。用别的服务器
时页面照常工作，只是代理与自动落盘通道关闭，编辑页退化为导出 JSON + 本地草稿。

## 保真方法论

参考实现是「神谕」：`tools/ref/AvgPlayer.js` 与参考逐字节相同（仅 import 路径本地化），
由 `tools/ref/driver.mjs`（播放）与 `tools/ref/uidriver.mjs`（交互）在无头 Chrome 里
跑出**冻结表**（`data/fixtures/expected-*.json`），我们的引擎逐项对拍。
「复刻完成」的定义 = 冻结对拍全绿，而不是看着像。

## 回归矩阵

单入口全量回归：`node tools/test-all.mjs`（注册表驱动，纯 Node 链 4 并发、
浏览器链 2 并发分池跑，`--only/--skip/--list` 可选子集；浏览器链失败时带
页内心跳诊断，能打出卡在哪一步）。逐条跑也可以：

| 命令 | 内容 | 判据 |
|---|---|---|
| `node tools/test-script.mjs` | 剧本双格式归一化 | 逐项通过 |
| `node tools/test-markup.mjs` | 分词/分页/打字机三态（真 DOM reformat） | 数千断言 |
| `node tools/test-skeleton.mjs` | 舞台骨架逐 id | 结构保真 |
| `node tools/test-style.mjs` | avg/pandect.css 移植 | 逐声明+白名单 |
| `node tools/test-sprite.mjs` | 画布合成/换脸/推导 | 像素判据 |
| `node tools/test-play.mjs` | 播放器逐镜（虚拟钟回放，冻结表对拍） | 快照逐字节 |
| `node tools/test-seek.mjs` | seek ≡ 连播暂停（A/B 两路对拍；`--speed=8` 过渡提速约 6×，报告与 `--speed=1` 逐字节一致） | 到达点全等 |
| `node tools/test-gamefold.mjs` | 镜像/抖动/z 序等折叠语义锚点 | 12 项 |
| `node tools/test-gameplay.mjs` | state.js 与游戏折叠对账 | 分歧全在已知语义差内 |
| `node tools/test-avgcfg.mjs` | AvgCfg/AvgLang 字节码解释器 + wire 映射层（格式+VM 锚点+悬空立绘落名+揭示重建+槽位类型门+折叠 alpha 继承+pos/scale 折叠+说话镜入场揭示+全语料口径） | 全部通过 |
| `node tools/test-avg-e2e.mjs` | 语料端到端：现场解码→映射→播放器逐镜 seek（cpt00 主线 + 23concert 立绘/分支 + cpt_kimie 绝对定位），台词/站位/绝对定位对拍 | 3 段全对 |
| `node tools/test-editor.mjs` | 编辑器失效三级 + prev 起值回归 + 并发 seek 交接 + 退场建议面板 | 真实钟采样 |
| `node tools/test-assets.mjs` | IDB/注册表/标定挂载 + 编辑器冒烟 | 冒烟全过 |
| `node tools/test-io.mjs` | 导出→导入→连播快照全等 + bundle 完整性（含音频资产） | 全部通过 |
| `node tools/test-audio.mjs` | 音频编排（FakeCtx 纯 Node，含 M15 CV 语音通道） | 10 项 |
| `node tools/test-doc.mjs` | 撤销栈/失效分级 | 7 项 |
| `node tools/test-shotstate.mjs` | 检查器「舞台状态」折叠：出处（于第N镜起）/延续/一次性/孤儿镜退化 | 9 组 |
| `node tools/test-zip.mjs` | STORE 打包可复现 | 4 项 |
| `node tools/test-repo-index.mjs` | 素材索引/搜索/R13 退化（含音频索引与三级解析） | 9 项 |
| `node tools/test-storylib.mjs` | 剧本库：分组/搜索/loadStory 装载链/索引增强件/语音映射/行动记录剧情树/手动覆盖层（改名·移动·新增活动）/无年份分类与空节点剔除 | 全部通过 |
| `node tools/test-avg-runtime.mjs` | Frida 运行时 JSONL → 可重放 Act/场景导入链 | 1 项 |
| `node tools/test-fadeadvice.mjs` | 退场建议：触发器/排除项/分档/落笔幂等 + wiki 淡出真值下的梯度锚点 | 全部通过 |
| `node tools/test-recorder.mjs` | 录制剧情视频：mime 优先级/参数清洗/假钟自动驱动/假件采集监测/FakeRecorder 协商/fake 内核转码取消路径 | 12 组断言 |
| `node tools/test-layers.mjs` | 五层舞台折叠模型断言 | 全部通过 |
| `node tools/test-layers-browser.mjs` | 五层舞台浏览器冒烟（effect/ppv/bgColor/缺件占位） | 冒烟通过 |
| `node tools/test-sg.mjs` | 23sg 专属演出：SG 窗标记、手机聊天窗（发信/确认/收信横幅/两种关闭）、世界线特效、终端镜只能显式标注 + 缺帧降级 | 语料口径 5 项 + 页内 25 断言 |
| `node tools/build-asset-index.mjs` | 重建索引（自带 731 背景 / ≥514 _avg 验收 + 剧本清单 + 槽位类型过滤） | — |

浏览器链的公共样板（Chrome 探测、宿主、报告轮询、心跳诊断、结论打印）
收口在 `tools/lib/run.mjs`，页面侧报告/心跳通道在 `js/test/report.js`。

scene4 是 M11 补的形态夹具：type1、多页 `<|>`、通讯框、delete、type5、nextId
跳转——M4 时代「本轮没跑到的形态」现已全部纳入逐字节对拍。

## 目录

```
css/       avg.css pandect.css（参考逐声明移植）· app.css（编辑器）· ux.css（动效降级/缺素材占位）
js/core/   schema markup scheduler state script doc shotstate idb repo-index assets lundump lvm avgwire fadeadvice
js/engine/ player sprite typewriter nouns audio
js/editor/ editor inspector fld picker storylib timeline layout-cal io advice recorder
js/ui/     dom zip
js/test/   harness.js（观测件：虚拟钟/settle/snapshot，两套回归共用）
js/play.js 离线 bundle 播放入口
js/lib-editor.js 剧本库分类编辑页（lib-editor.html）→ 手动覆盖层 story-archive-manual.json
data/      fixtures（夹具+冻结表+外源淡出真值）· index（可浏览素材索引）· layouts · fonts · ui
tools/     test-*.mjs 回归跑者 · build-asset-index.mjs · build-fade-fixture.mjs · build-story-archive.mjs · migrate-story-classes.mjs · avg-dump.mjs · media/unpack-{acb,avgconfig}.mjs · media/build-voice-index.mjs · shot.mjs
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
   预览窗口的 `1×/10×` 按钮（`tp-rate` → `Player.setRate`）是净新增便利件：
   只压缩走 `Scheduler` 的 JS 定时（CSS 过渡与 WAAPI 不吃这份钟，倍速下演出会
   跑在画面前面），音频只留 bgm、视频镜提 `playbackRate`；1× 时逐位不变。
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
| `res/Assets/media/audios/` | CRIWARE 音源 acb/awb（含 `Voice/JA_JP`，M15 起已转码至 `data/audio/`；**不入库**，源件已从本地清除） | — |

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
（搜索 ID + 按分组筛选（组名口径见 M24）+ 镜数/简介），点选即经 `loadStory` 装载进编辑器，
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
# 语音映射 + 行动记录档案：解出 configs.ab 后生成 voices.json / story-archive.json
AssetStudio.CLI.exe <镜像>/res/luascripts/configs.ab /tmp/cfgs --game FakeHeader
node tools/media/build-voice-index.mjs /tmp/cfgs/TextAsset
node tools/build-story-archive.mjs /tmp/cfgs/TextAsset
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
468 对引用 **100% 命中**真实 cue）。剧本库的分类视图见下一节 M24。

## 退场建议（M23）

M22 遗留的「作者点亮却从不写退场」不再找自动判据，改为**编辑器内一键建议**
（`js/core/fadeadvice.js` 纯函数 + `js/editor/advice.js` 面板，顶栏「退场建议」）：
机器只在**无说话人镜**（wiki 淡出 68% 的落点，1186/1734）上把滞留者列出来、
预检「收掉之后她会不会回来、以什么形态回来」并按实测命中率分档，收与不收由人
读旁白拍板（22christ_02#15 的炽：旁白「黑影又出现在了炽的身后」要求人必须在台
上，任何结构判据都读不出这句话）。落笔 `α0/d0.2` 走 doc.patch('imgTween') →
L2 timed seek 预览、撤销栈可回退，参数与 autoLightCast 收场条目同口径。

**外源对拍**（GFWiki「行动记录/无律背反」= 23carnival，39 段转写件冻结为
`data/fixtures/wiki-fades-23carnival.json`；`node tools/build-fade-fixture.mjs`
可重采，需 wiki 可达）：转写件是游戏 dump 的超集（+2887/−1 条立绘条目，台词
逐镜对位 100% 命中），即「演出实际发生过」的调度的显式化。两个硬结论：

1. 「作者后面还提到它」当严判基准本身是错的——wiki 淡出里 50%（860/1734）
   在 ≤3 镜后重新点亮，「淡出+再亮」是正常语法对；这就是 M22 三种判据
   23% 误清率的根因。
2. 换景滞留 wiki 留 19/21；「之后再不提」档命中率垫底（本镜 1.7%/±1 7.4%）
   ——wiki 转写者遇到「点亮后再无条目」一律不收，她只是静静站到段落结束。
   与 M22「只修自造部分」的停手决策互为印证。

建议分档取「下次提及距离」这条实测梯度（39 段 / 1133 条候选）：imminent
（≤3 镜，本镜 20.7%/±1 65.2%）> distant（4-10 镜，±1 43%）> far（>10 镜，±1
22%）> silent（之后再不提，±1 7%，**默认不列**）。另一处直觉修正：落点规律
不能反着用——P(无说话人|淡出)=68% 不等于 P(淡出|无说话人+滞留)=8%（基率倒
置），所以无说话人镜只是候选收集器，不做任何判定。

## 剧本库分类改用游戏「行动记录」（M24，M26 改三层剧情树）

此前剧本库的分组只有「按 ID 首段」一条路，而 `story_avg.group_id` 有 1455 组
≈一组一条，等于没分。游戏侧其实有一套现成分类——**「行动记录」（HandBook
ActBook）**：大型活动 / 常规活动 / 专属剧情 三类，每类按年份挂活动，每个活动
挂剧情段。`tools/build-story-archive.mjs` 把它还原成
`data/index/story-archive.json`，剧本库即按它出**三层剧情树**：左轨 = 分类
（三大类 + 主线 + 未归档）与选中分类的年份组，右栏 = 该年的活动卡 → 点开看
剧情段（`archiveTree` 纯函数，`tools/test-storylib.mjs` 背书）。主线扇区与
未归档首段没有真活动层，同名虚拟活动由 UI 直通剧情。搜索框一有输入就切回按
ID 的平铺结果，清空恢复树。

年份口径：三大类的 `year` 来自 `handbook_activity.yearDic`（游戏权威数据）；
专属剧情整类没有 yearDic，按活动 `rewardEnd_time` 的档期年份补（跨年活动归
结束侧——冥刃沐辉 2023-12 开启归 2024，与游戏时间轴一致）。

## 活体剧情分类：Frida 直取游戏现算结果（M28）

树要的「活动 → 剧本段」归属，最终裁决者是活体游戏——静态表里 2024 三活动
的回顾表走 LoadDynCfg 动态下发、type 10 专属剧情的真分组在角色章节表里，
纯静态路由只能拿到残缺版。`tools/frida/dyn-config-dump.py/.js` 增加
`classifyAll`：在 `lua_pcall` 钩子内部（游戏线程被拦截挂起、零竞态）直接
调用 `HandBookActReviewFunc[type](series)`——游戏「行动记录」卡片渲染用的
同一批处理器——把返回的 `CommonPoltReviewData.avgGroupList`（剧情组名 +
AvgIdList，组序 = 游戏显示序）逐活动接住。

- 覆盖 54/56 活动（type 12 的两个处理器要走 UI 流程，不补，两活动本无回顾
  剧情）；AvgIdList → script_id 映射零缺失。产物
  `data/index/story-classification-live.json`。
- 生成器读到它时 `stories` 以活体为准：行动记录从 278 段扩到 **1010 段**，
  静态 0 段的活动全部补齐（热海飙运 4 = 24summer_cargo01–04、昔影归终
  42 组、致光态 18 = 截图分母全部对上）；type 10 专属剧情按真语义挂角色
  全部主线章节（薄暮葬曲 20 段 = clotho 六章）。主线/未归档随之缩小，
  归属与游戏一致。
- 卡片上的「活动奖励 x/y」「剧情进度 x/y」仍不还原：分子是玩家存档态，
  与分类树无关。

## 主线细分：未分扇区归零（M29）

活体分类接管后，主线剩 259 段（六大章节扇区 110 段 + 一大坨 `sectorId` 为空
的散段）。排查结论：**游戏内不存在这批散段的统一分类函数**——它们的触发
登记是登录后由服务器按账号推送（`AvgPlayController.OnRecvNewAvgTask` →
`avgTaskParamDic`/`triggerTypeDic`，账号态、随推送变化），版本配置表里没有
统一表；游戏里它们散落在各自系统的入口（角色誓约、节日活动、战棋、回归）。
按两条依据细分归组（`mainlineEventOf`）：
1. `set_place` → `sector_stage.sector`（关卡归属，游戏权威数据）→ 归入对应
   扇区（无律背反/致密静点 的剧情关卡与困难模式扇区等）；
2. 其余按段前缀的事件语义建事件组（誓约剧情 11、2022圣诞/七夕角色剧情、
   彩蛋小游戏、悬光升变·补充剧情 23、昔影归终·追忆、战棋玩法 12……）。
「未分扇区」大桶归零；主线共 33 组，树全量 1878 段守恒。

## 未归档 609 段：游戏数据命名（M30）

未归档 = 语料里有、`story_avg` 没登记的段（dorm 465 + 教学关 63 + 章节支线/
试炼 46 + 杂项 35）。按游戏数据命名归组：
- **宿舍互动剧情（465 段）**：`dorm_hero_talk.talk_list` 按英雄登记（93 英雄），
  本里程碑当时用 `avg_character[heroId].name` 取名 → 88 个「宿舍剧情·角色名」组，
  其中 48 组是别人的名字（**M34 已改用 `hero_data` 并一人一支，共 93 组**）；
  ENIAC/Havoc/Inola 三个新角色 talk 表未登记、静态语言表也无中文名（版本差），
  经 voices 代号索引回退英文名。
- **教学关（63 段）**：序章/基洛普斯/柯普利/神导异论·教学（tutorial 段）。
- **活动关卡与支线（46 段）**：逆波共振·试炼 22、抑质链·关卡剧情 11、
  无律背反·支线 8、致密静点·支线 5 等。
- **杂项（35 段）**：后日谈、誓约、彩蛋小游戏、测试与演示等。
未归档节点共 117 组、609 段守恒；旧数据源（无 group 字段）退回 ID 首段分组。

## 小项合并与活动名搜索（M31）

细分产生的散件小组（逆波共振·试炼剧情、抑质链·关卡剧情、无律背反-困难
模式…）按前缀语义回并大项，活动成为其全部剧情的唯一容器：
- 组名前缀（`·`/`-` 前的第一段）命中活动名（全等或活动名以前缀开头，
  如 境界干涉 → 境界干涉的延迟选择）→ 并入该活动；
- 命中主线扇区组（基洛普斯·教学 → 主线-基洛普斯、柯普利·后日谈 → 柯普利）
  或主线同名事件组（未归档-序章·教学 → 主线-序章·教学）→ 并入主线组；
- 无宿主的保留（宿舍剧情·角色 88 组、誓约剧情、2022圣诞·角色剧情、
  测试与演示…）。
合并后：昔影归终 77、无律背反 49、逆波共振 42、悬光升变 46、境界干涉 101
（含试炼/关卡/支线/后日谈），未归档降至 476 段（宿舍 465 + 杂 11）。

搜索框同时支持**剧情 ID** 与**活动/分组名**：输入「逆波」「昔影归终」直接
命中活动，组头标注归属路径（活动名（分类｜年份）），组内剧情整组列出；
ID 命中作为补充结果跟在后面（去重）。

旧版随本改退役：`archiveRows` 平铺分区视图与 `storyLabels` 活动名分组下拉
（归属规则由 `archiveTree` 的未归档首段分组继承：dorm(465)、cpt(42) 这类
才仍可点选）。

链路全部实证自 configs.ab 的 642 张表（解出件见上节命令）：
- `handbook_activity.lua` 顶层 3 条 = 三页签，`content` 给成员、`yearDic`
  直接给 2021–2024 年份归属；
- 活动名三级跳：`activity[actId].name_id` → `activity_name[...].name` →
  `locale_text[key]`（34269 条，story_avg 的段名/简介也靠它解）；
- 专属剧情（class 3）表里 `content` 为空、只给 `content_count=27`，成员实为
  `activity` 里 type=10/54（HeroGrow/HeroGrowV3）的 27 个活动；
- 活动 → 剧情段：游戏侧是 `HandBookActReviewFunc.lua` 按 `eActivityType`
  分发的 21 个处理器，这里照它落三条路由，并按证据强度分档取用：
  ① **处理器路由**（档 4）——类型 → 该类型的回顾表 → 按「同系列序号」定位行，
  序号 = `activity[actId].activity_id`（缺省即首期），行内 `*_sector` /
  `*_stage` / `*_avg` 按语义解到 story_avg（`activity_herolite_avg` 是
  「avg_id → 行」的嵌套图、`sign_theater_task_condition` 按序号归组，各多钻一层）；
  ② **号段**（档 3）——`story_avg.sectorId` 以 actId 打头（59001 → 590011）；
  ③ **表键/外键**（档 1-2）——activity 系表里挂上来的行。
  只收有 `script_id` 的真剧情段，关卡不计；号段天然把普通/困难两难度的同一段
  并成一个。

实测口径：昔影归终(59001) 32 段、无律背反(33001) 28 段、同行礼遇-魔境异闻录
(39003) 2 段（与游戏卡片「剧情进度 2/2」同口径），专属剧情 27 期全收，主线六章
（罗萨姆/基洛普斯/赫里奥斯/恩格玛/庇厄里亚/柯普利）从「未归入活动的扇区」里自动
浮出。**全语料 1878 段 = 行动记录 276 + 主线/其他扇区 993 + 未归档 609。**

两处会咬人的口径：
- story_avg 有 202 段写成 `<容器>.<段名>`（`23sg.23sg_a01`、
  `24winter.24winter_s00`），而语料索引按 AvgCfg 文件名收、不含容器前缀。照原样
  比对这 202 段会全被判成缺件——归一化后未归档从 811 降到 609。
- 号段前缀只是兜底，它会串到邻居活动：致光态(33005) 的真扇区其实是 330061/330062
  （`sector` 表里就叫「致光态-困难模式」），前缀 `33005` 捞回来的是致密静点的段。
  所以有档 4 证据时一律让号段靠边。

未结：**只剩 6 个活动一段没挂上，且都不是绑定缺失**——17001 逆波共振、20001 临界
爆震、19001 拟域作战、22001 诡海迷航 四者的回顾表**首期行里就没有剧情字段**（只有
2/3 期才挂扇区）；18001 雪境奇缘、58001 热海飙运 更彻底，`activity_tiny_game_main`
/ `delivery_activity_main` 整张表在 configs.ab 里是空占位 `{ { } }`，真数据走
`LoadDynCfg` 的动态件、不在配置包里（要收得走 Frida 运行时取真值那条老路）。
12001/12002（type 12 WhiteDay）不算缺口——分发表里就没有 WhiteDay 处理器，这两
活动在「行动记录」里也不显示剧情进度。

## 剧本库分类手工覆盖层（M32）

生成档案（`build-story-archive.mjs` → `story-archive.json`）重跑即覆盖，人工微调
（合并散组、改活动名、把归错的段挪走）没地方落。所以人工调整走**独立覆盖层**
`data/index/story-archive-manual.json`，与生成档案同形（`classes` / `mainline` /
`unarchived`，另加 `manual: true` 与 `savedAt`）：

- **加载优先级**：`main.js` 先探手动件，缺席或 `classes` 为空则回退生成件——
  生成器随便重跑，人工结果不丢。
- **编辑页 `lib-editor.html`**（`js/lib-editor.js`，顶栏「分类编辑」进入，与
  index.html 的剧本库共用 `archiveTree` 口径）：左列三层分组（活动 / 主线组 /
  未归档组，带段数），右侧改组名、改年份、增删活动与主线组、逐条「移出」进
  「待分类」暂存池、按 ID/简介过滤后「+ 加入」补段。撤销栈 50 步；「重新播种」
  拉最新生成档案；静态部署退化为导出 JSON 放回仓库。
- **落盘端点**：`tools/ref/serve.py` 的 `POST /archive-save`（先 `json.loads`
  校验再写，非法 JSON 直接 400，不会写出半个档案）。**只有开发服务器有它**：
  pages.dev 是纯静态，POST 回 405（`python -m http.server` 回 501），编辑页把这
  条路当设计内退路报——导出 `story-archive-manual.json` 并写明放回仓库的路径。
- **本地草稿**：改动实时写 `localStorage['yuntu.lib-editor.draft']`，落盘成功
  即清；下次打开若草稿与仓库档案不一致，顶栏下方给「载入草稿 / 丢弃草稿」，
  标题行标「正在编辑本地草稿（未落盘）」。静态站上刷新不再丢工。
- `_headers` 里 `/data/index/*.json` 用 `max-age=0, must-revalidate`：手动档案
  换版后重新部署立刻可见（原先 86400 会让新分类最长一天不生效）。

`unarchived` 条目从纯 ID 字符串升级为 `{id, group}`（M30 的游戏数据命名）；
`archiveTree` 两种形态都吃，缺 group 时退回 ID 首段分组——那样编辑器与剧本库
会各按一套分组（编辑器侧多出一个无组名的未归档组），所以手动档案里条目必须带
group，控制台 `__libed().badUna` 专查这一条。搬运用的 `removeFromSource` 里
**组名要先于 `splice` 取**：按下标回填时末条已被摘掉，读到的既不是原条目（会串
到邻居组）也可能是 `undefined`（抛错时条目已从数组里消失 = 静默丢段）。

## 未归档拆成宿舍剧情 / 其他剧情，编辑页改拖动（M33）

未归档 476 段里 465 段是 `宿舍剧情·XX`（一层桶里塞了 96 个组，其中角色组的名字
当时还取错了表，见 M34），点选与搜索都很吃力。按手动覆盖层（M32）重排：

- 新增分类 **宿舍剧情**：93 个角色各成一支、每支 5 段，组名去掉「宿舍剧情·」前缀
  （晨曦/芬恩/秋/渡宾…）；
- 新增分类 **其他剧情**：原未归档剩下的 6 组 11 段（测试与演示、挑战关卡、
  主线·内传…）；
- 未归档就此清空，退成编辑器的「待分类」暂存池（有内容时才在剧本库出现）。
- 搬迁件由 `node tools/migrate-story-classes.mjs` 生成（重跑；已有手动档案时
  默认拒绝，`--force` 才覆盖 —— 那里面是人工调整）。

`archiveTree` 为此补三条规则：

- **分类里没有一个年份 → 活动本身即中层组**，不再劈一个「年份未定」空层
  （宿舍剧情/其他剧情就是这种无年份分类）；有年份的分类照旧按年份分桶。
- **单同名活动壳直通到剧情**（原来只对 `kind==='bin'` 开），无年份分类不必
  多点一次活动卡。
- **空节点不进树**：`renderMain` 直接取 `groups[group]`，未归档被抽空后留在树里
  会被点崩。搜索命中的路径头去掉与活动名重复的段（`渡宾（宿舍剧情）`，
  不再是 `渡宾（宿舍剧情｜渡宾）`）。

编辑页交互改成拖动（`lib-editor.js`）：**条目拖到左列分组**＝改归属（候选区的
条目拖过去＝加入，落点按指针位置插入）；**分组拖到另一分组**＝整支并入并删掉空壳
（未归档组由条目派生，搬空即自己消失）；**组内上下拖**＝排序。常驻一个
count=0 的「待分类」靶子，否则未归档搬空后就没有拖出去的落点。落点走
`applyDrop()`：原地拖回原位不留撤销点、也不置脏。顺带修了两处年份显示：
分组描述一直漏带 `year`，所以年份输入框恒空、新增活动恒默认今年；现在读真值，
且无年份分类里新增活动默认留空（填了年份会凭空劈出年份层）。

## 宿舍剧情对号入座：角色名只认 hero_data（M34）

M30 起宿舍角色名取自 `avg_character[heroId].name`，这张表是 **AVG 演出角色表**：
键空间 1..414 混着 NPC 与英雄，同一个 heroId 落在里面是**另一个人**（1056 那行解出来
是「琳德」，而 1056 是 Uranus）。实测 90 个宿舍组里 **48 个报错人**，且会撞名：
`dorm_eos_*`（晨曦）、`dorm_fern_*`（芬恩）、`dorm_dupin_*`（渡宾）三支全被叫成
「渡宾」，`dorm_aki_*`（秋）与 `dorm_horizon_*`（苍青）全被叫成「米约尔」。

改判据：`dorm_hero_talk[heroId].talk_list` 直接登记脚本 ID（归属唯一），
角色名 `hero_data[heroId].name` → `locale_text`；`voices.json` 的 codename
只作 talk 表缺席时的反查（阿比盖尔 1034 就没登记进 talk 表）。

三条独立证据互相咬合：

- ID 里的代号 = 归属英雄的 voices codename：460 段中 430 段字面相同，
  余下 30 段是拼写变体（`zangyin`/`hannah` ↔ codename `crypter`/`hanna`），
  归属仍唯一；
- **剧本自身的语音字段**：465 段里 talk 表登记过的 460 段，台词
  `audio.voice.heroId` 全部等于 talk 表归属英雄（0 段例外）；
- `hero_data.name_en` 与解出的中文名逐一对上（Eos→晨曦、Fern→芬恩、Aki→秋、
  Dupin→渡宾、Kurisu Makise→牧濑红莉栖、Earhart→埃尔赫、Camellia→薮春）。

唯一没名可取的是 **Uranus（1056）**：`hero_data` 那行根本没有 `name` 字段、
静态语言表也无条目（版本差），按游戏英文代号落名 `URANUS`，不硬造译名。
93 英雄 × 5 段 = 465，一人一支不再撞名（`avg_character` 的错名会把两支并成一支，
所以是 90 → 93）。重跑生成档案实测只动宿舍标签：改 340 条 group，
非 dorm 标签 0、活动 0/56、主线组 0/20 变动。

## 录制剧情视频

两个入口（`js/editor/recorder.js`，与 gfStory 播放器同构的管线）：

- **全屏播放页 `record.html?id=<段ID>`**（`js/record.js`）：整段语料的回看 +
  录制一体化。页面本身就是全屏舞台（1200×540 设计稿等比缩放充满视口），
  工具栏 2.5s 无操作自动隐没、录制期间整体退场（`onPhase` →
  `body.record-active`）。装载走剧本库同一条解码链，落点与编辑器同一语义
  ——**首个可停留镜**（开场常是 autoContinue 直通镜，`seekShot` 停不住首镜，
  fastForward 会顺着链自动推进；用 `sceneTimeline()` 的 pausable 判据接住）。
  顶栏「剧本库」可换段，`?id` 随选择写回地址栏。
- **编辑器「录制视频」**：录的是**编辑稿**（getStory 在开录瞬间取 doc 现值），
  开录时舞台经 `stageHostView` 搬进全屏黑底宿主（采集的是整个视口，编辑器
  外壳不能入镜）；模态栏另有「全屏播放页」按钮直达 record.html。

管线：`getDisplayMedia`（ideal 约束 + Chromium 的 `preferCurrentTab` 预选本
标签页；它与 `selfBrowserSurface:'exclude'` 互斥，同给会抛错）→ `MediaRecorder`
mime 优先级协商（`video/mp4;codecs=avc1.640028,mp4a.40.2` 直出 H.264+AAC，零
转码；Firefox 兜底 webm vp9+opus）→ webm 导出时用 ffmpeg.wasm（UMD 从 CDN
拉，约 31MB 仅首次）转 MP4，进度从内核 log 的 `time=` 现算（MediaRecorder 的
webm 缺时长元数据，内核自报 progress 恒 0）；取消/超时
（TRANSCODE_IDLE_TIMEOUT_MS）是逃生门：terminate 内核、直接导原始 webm。
单线程 wasm 求稳，超 15 分钟的录像把转码宽度压到 854。

- **自动播放驱动 `AutoDriver`**（计时器可注入，纯 Node 可测）：轮询目标的最小接口，
  Player 接线在 `playerTarget()`（全走公开量，与 main.js 连播同口径）。两个时序结论：
  `ended = playEnd && shotEnd`——进末镜 ≠ 播完，末行打完才算，否则视频切掉最后一句；
  **choices 判定先于 ended**——末镜是分支镜时 `playEnd` 已置真但选项还等人选。
  选项停留 `dwellMs` 后自动选第一项，走净新增的公开入口 `Player.chooseBranch`
  （与点击选项同一落点）。
- **录制期间页内零指示**：倒计时/授权弹窗都发生在 MediaRecorder 起跑**之前**，
  不进视频；舞台内的点击被会话 capture 截停（防误触推进毁掉整段录像）；
  Esc 停机，标题栏 `●` 兜底。停机后舞台归位、倍率还原、预览落回原分镜。
- **采集质量监测**：2px 隐形 video 吃采集流，`requestVideoFrameCallback` 逐帧计数
  得真实帧率（1s 窗口取最低）——注意探针用 `opacity:0` 而非 `display:none`，
  后者会停掉渲染管线、rVFC 不再逐帧来。停机报告对照请求档位，实测帧率低于目标
  八成提示降档；rVFC 缺席的浏览器降级为只报尺寸。
- **旋钮**（localStorage 记忆）：分辨率 480–**2160（4K）**（16:9 向上取偶 ⇒
  854/1280/1920/2560/3840）、帧率 15–**60**、码率 1–**80Mbps**（默认 8）、
  播放倍速 1–10×（吃引擎 Scheduler 钟，CSS 过渡不压缩——与预览 10× 同一取舍）、
  选项停留 0.5–10s、开录倒计时 0/3/5/10、采集标签页音频复选框。档位是请求值
  （ideal 约束），实际采集受视口/编码器能力钳制，报告里报实测。
- **回归**：`tools/test-recorder.mjs` 12 组纯函数断言（假钟跑满驱动全流程、fake
  rVFC 监测、FakeRecorder mime 协商、fake 内核的转码/取消路径）；编辑器冒烟
  （test-assets）把「录制面板可开」纳入；`tmp-recorder-probe.mjs` 是一次性全流程
  探针——canvas 采集流顶替 getDisplayMedia（无头环境弹不了授权框），其余全真，
  双场景：编辑器舞台出画 + Esc 中停导出；record.html 整段播完 + 工具栏隐没/回归。
- **已知边界**：需要 localhost/https（getDisplayMedia 的安全上下文要求）；采集的
  是视口内容，窗口比例与 20:9 舞台不同时黑边入镜；倍速 >1 时 CV 语音按引擎
  既有语义只留 bgm。

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
  不入库，本地也已清除——`data/audio/` 转码件随仓库分发，日常无需重建；
  确要重建时从游戏镜像再提取源件、另行获取 vgmstream 后按上文命令操作。同名 cue 碰撞的 sheet（如 Ambience）按索引内序取
  唯一名，wire 按名引用本就不可区分。
- BGM 的 CRI 循环段（前奏→循环）暂按整曲循环（M7 引擎语义）。
- 23sg 专属对话 UI：`contentStyle:1` 在游戏里换成 `SteinsGateAvgDialog.prefab`，
  而 UIPrefab 从未提取进 `res/` → 对话框皮肤维持标准件（只挂 `#avg-stage.avg-sg` 标记）；
  手机聊天窗按 `UISteinsGateAvg` 的结构还原、外观近似（窗体贴图同样缺件）。
  OASIS 终端镜（`sg_theme_001..010`，帧内文本即 a01 开场独白）**只在 wire 显式
  `sgMonitorFrame` 时出现**：a01 自身无 `contentStyle`，内容侧签名（开场 Chapter 连排）
  全语料命中 31 段，自动推导必误触发 → 引擎不猜，等 frida 实机真值在映射层标注。
