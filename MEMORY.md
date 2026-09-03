# 项目记忆

## P0 进度

### P0-1：几何真源 —— 已结（M40）
- m_LocalScale = 立绘 prefab 根 RectTransform 的 m_LocalScale.x（带符号）
- sizeDelta = 同节点 m_SizeDelta.x
- 工具：`tools/build-hero-layouts.py`（UnityPy 按 PathID 读）
- 产出：`data/layouts/*.json`，511/515 角色落成（3 份人工标定件不动）
- 比对：除新增 alpha 一列外逐格全等——证明读取路径正确 + 当年 layout-cal 人眼标定准确
- posId 覆盖率：55.2% → 98.7%，只剩 hubble_avg（291 条，bundle 无 CommonPicController）
- 旧的 215 份 `data/index/hero-slots.json` 已删（被 data/layouts/ 取代）

### lvm.js EQ/LT/LE/SETTABUP 修复 —— 已结
- **bug**：EQ/LT/LE 的 A（标志位）与 C（操作数）角色互换——旧代码用 `R[A]` 当操作数、`C` 当标志，正确语义是 `rk(B)` / `rk(C)` 当操作数、`A` 当标志
- **bug**：SETTABUP 的 B 硬取 `K[B].value`，应走 `rk(B)`（B≥256 取常量池，B<256 取寄存器）
- **根因**：数据脚本（AvgCfg/AvgLang）不触发这四个 opcode 故全语料 0 失败，但 Game.Avg.* 逻辑脚本会中招（EQ 404 / LT 28 / LE 3 / SETTABUP 14 条）
- **回归**：test-avgcfg.mjs 新增 1 个测试块（6 条手工 Proto 断言），18/18 绿
- **影响范围**：17 条纯 Node 回归链全绿（test-script 15 / test-markup M2 / test-doc 7 / test-zip 4 / test-audio 10 / test-repo-index 9 / test-storylib 7 / test-fadeadvice 7 / test-avgcfg 18）

### D1b：根级镜像 —— 已结（实机定案，2026-09-02）
- **取法**：Frida hook `libxlua.so` 的 `lua_pcall` 抓活的 `lua_State*`，注入 bootstrap 包 `Game.Avg.*`，在引擎执行完槽位后读回 `lpic_*(Clone)` 根节点与 `HeroItem` 槽位节点的 `localScale`/`eulerAngles`。产物 `nc-capture\geom3.jsonl` + `d1b_verify.py`。
- **825/825 行零反例**：`rootEuler.y == 180 ⟺ rootScale.x < 0`。两个负 scale 角色 `croque`(-1.9) 与 `simo`(-1.3) 都被补了 180°，11 个正 scale 角色 eulerY 全 0。
- **静态对照**：扫 `res/character/*/lpic_*.ab` 根 RectTransform **1084 个角色，非零 eulerY = 0 个**，负 `m_LocalScale.x` 恰好 10 个 ⇒ 那 180° 是**引擎运行时补的**（最可能 il2cpp 侧 `SetPosType`），不是素材里写的。
- **结论**：负 scale 与 180° 在 X 轴互相抵消 ⇒ **净镜像完全等于 `sign(HeroItem.localScale.x)`**（712 行 lane 正→不镜像 / 113 行 lane 负→镜像，无例外）。⇒ `Math.abs(m_LocalScale)` 是对的，原来怀疑的"参考件一起漏了根级镜像"**不成立**。
- **两条附带事实**：① 负号**按皮肤不按角色**——`croque_spring_avg`/`fool_croque_avg` 是 +1.8，只有本体 `croque_avg` 是 -1.9，判镜像必须逐皮肤读；② `HeroItem.localScale.x` **不是恒 ±1 的纯开关**（`croque_spring_avg` 有 10 行取到 1.4），折叠层要当带符号连续值存。
- **陷阱**：`lossyScale` 在"负 scale + 180° 旋转"组合下**不可信**（Unity 不折叠旋转），实测 croque `lossy.x=-0.093` 但净效果不镜像。
- **G3 已落地（同日）**：真实缺陷不是"没实现镜像"——`sprite.js:58-66` 早就把 `AvgHeroN.scale` 发成 `.posN` 规则里的 `scale(-1,1)`。缺陷是 **`player.js` 对带 `scale` 的条目写行内 `transform`，整条覆盖了 `.posN` 的 transform ⇒ 镜像槽一遇缩放条目就翻正**。修法：新增 `slotMirrorSign(config, posId)` 作唯一判据，行内 transform 把该符号乘回 X 分量。回归：`test-gamefold` A7（钉住 simo 中槽镜像 / croque_spring 与 chelsea 不镜像 / 全语料槽位 `scale[0]` 只取 ±1 / 镜像槽×缩放条目仍镜像）。
- **G1 已落地（同日）**：抖动两套通道。① 条目级 `shake`/`shakeIntensity`（语料 4155 条 / 827 段）在 `_blockChara` 里对 `.avg-chara` 播 `shakeKeyframes`；② 镜级 `contentShake` 在 `_lineFinished`（= 游戏 `OnChapterTextTweenComplete`）对 `avgLine` 播，参数从 `UINAvgChapter` f3 L60 读出：`DOShakePosition(0.4, Vector3(10,10,0), 20)`。`shakeKeyframes(seed, si)` 照抄振幅 `10·si` 与振荡 `20·si`，LCG 定种保证同镜重放逐字节一致。回归：A8。机制已在真 Chrome 探针验证 `composite:'add'` 能叠加在含镜像的 CSS transform 上、播完 `restored:true` 不留落定态残影。

### G4：立绘层 z 序 —— 已结（2026-09-02）
- **`order` 只出现在注册条目**：全语料 images 带 order **680 条**、imgTween 带 order **0 条** ⇒ 纯注册期 z 序，不是逐镜动画属性。
- **语义**（SYS f25 L587 + f28 L654-688）：`NewImgItem` 里 `ChangeAvgImgOrder(imgCfg.order)` 并置 `imgNeedSort[imgType]`；f28 把该层字典摊数组、按 `GetAvgImgOrder()`（= `imgCfg.order or 0`）**升序** `table.sort`、逐个 `SetAsLastSibling` ⇒ order 大的后面上面。
- **落地**：`state.js` 新增 `laneZOrder(state)`，`player.js` 的 `_applyZOrder()` 写行内 `z-index`（**不重排 DOM 兄弟序** —— 快照与冻结对拍都按 DOM 序取样）。回归 A9：`1year_prologue` 真实形状（104 order=6 压在 154/160 之上）+ 缺省 0 + 同值稳定 + 回收重排 + 负 order 垫底。
- **影响面**：立绘层有 **7507 个镜**（全语料 7.2%）台上同时存在 order 不同的立绘。

### ⚠ 顺带量出的缺口：多图层根本没渲染（做 G5/G6 前必须先定口径）
- **背景需要多实例**，但量级比第一眼看到的小得多。按 `alpha>0` 逐镜折叠实测（104850 镜）：可见背景 0 个 36.2% / 1 个 44.9% / **2 个 14.9%** / 3 个 3.5% / 4 个 0.4% / 5 个 0.1% ⇒ **≥2 个同时可见只占 19.9%，上限 5 层**。（注意：按"注册后未回收"算是 74.2%，那个口径会把淡出中的旧背景也算进去，别拿它做决策依据。）
- 各层**最大同时可见**：DistantView 2 / Background 5 / Character 5 / Foreground 1 / Movie 1。
- 三层完全没有容器：`DistantView` 存活于 **1806** 镜、`Foreground` **862**、`Movie` **404**；`state.js` 的 `applyShotTweens` 只处理 imgType 2 和 3。
- 之前记的"imgType 1/4/5 只有 43/16/5 条"是**注册次数**口径，按存活镜数算大一个量级。

### test-io 超时 —— 既有的脆弱点（非回归）
- 默认 `--timeout=120`，但这条链要走 serve.py 的 wiki 图片代理拉 UI 素材
- 网络一慢就报"没拿到报告"——慢网络与真卡死不可区分，且失败信息不指认原因
- A/B 确认：把 508 个新 layout 和 hero-slots.json 全挪走仍然红，不是 P0-1 改动引起的
- 给到 `--timeout=560` 后 59 断言全过
- **待定**：是否把默认超时提到 300s 或让失败时打出最后一次页面状态（判据取舍，等用户定）

## P0 剩余
- 折叠模型断言化：把已确认的语义变成带字节码锚点的回归（lvm.js 修复是其前置，现已完成）
