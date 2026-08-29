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
| `node tools/test-io.mjs` | 导出→导入→连播快照全等 + 解包离线探针 | 53 断言 |
| `node tools/test-assets.mjs` | IDB/注册表/标定挂载 + 编辑器冒烟 | 27+冒烟 |
| `node tools/test-audio.mjs` | 音频编排（FakeCtx 纯 Node） | 8 项 |
| `node tools/test-doc.mjs` | 撤销栈/失效分级 | 7 项 |
| `node tools/test-zip.mjs` | STORE 打包可复现 | 4 项 |
| `node tools/test-repo-index.mjs` | 素材索引/搜索/R13 退化 | 5 项 |
| `node tools/build-asset-index.mjs` | 重建索引（自带 639/496 验收） | — |

scene4 是 M11 补的形态夹具：type1、多页 `<|>`、通讯框、delete、type5、nextId
跳转——M4 时代「本轮没跑到的形态」现已全部纳入逐字节对拍。

## 目录

```
css/       avg.css pandect.css（参考逐声明移植）· app.css（编辑器）· ux.css（动效降级/缺素材占位）
js/core/   schema markup scheduler state script doc idb repo-index assets
js/engine/ player sprite typewriter nouns audio
js/editor/ editor inspector fld picker timeline layout-cal io
js/ui/     dom zip
js/test/   harness.js（观测件：虚拟钟/settle/snapshot，两套回归共用）
js/play.js 离线 bundle 播放入口
data/      fixtures（夹具+冻结表）· index（可浏览素材索引）· layouts · fonts · ui
tools/     test-*.mjs 回归跑者 · build-asset-index.mjs · shot.mjs
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
6. 忠实照抄的参考怪癖：skip 弹层取消/确认无 handler（点击=推进）、
   log/dict 面板可叠开、多页 `<p>` 挂在 logDiv 本体、`charaRules` 模板空白
   进 innerHTML——完整清单见 `data/fixtures/expected-ui_scene*.json` 与计划文档。

## 已知边界

- 移动端全屏分支不实现（桌面编辑器不适用；参考行为已记录）。
- 5GB 的 `res/` 素材树不入库（R13：无 res/ 时自动退化为纯上传模式）。
- 分镜列表未虚拟化（夹具 <150 镜；计划 M11 记录项）。
- `prefers-reduced-motion` 下过渡归零，打字机不受影响（它不是 CSS 动画）。
