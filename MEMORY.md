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

## 宿舍 M1 竖切 —— 已结(2026-09-05)
- **产物**:`dorm/index.html`(three.js 竖切:单房间 + 5 家具 + croque 走/站/坐/躺/说话演出链)+ `dorm/README.md` + `tools/dorm/` 三件套(anim_decode / export_gltf / export_dorm_m1)+ `dorm/assets/` 25 件(3.6MB)
- **管线定案**:不走 FBX 中转(无 blender/assimp),自研 **Unity→glTF 直出**。动画是运行时打包格式(通用曲线,非人形肌肉流):Streamed(Hermite)/Dense(30fps)/Constant 三层 + Avatar m_TOS 反解路径哈希;格式参考 UtinyRipper/AssetRipper
- **网格顶点通道(实测)**:2021+ 通道序,ch12=blendWeight f32、ch13=blendIndices u32;**流区域 16B 对齐**(内联)/.resS 无对齐;个别家具 channel dim 字段损坏按下一通道 offset 收敛;家具网格在外部 .resS(shared_models.ab)
- **骨架结论**:宿舍用 `dmodel_<角色>` 专用包;**18/18 角色人形核心链(40 节 Bip001)逐路径一致**,差异仅网格节点名与附加骨(发/裙/眼)⇒ 动画按各角色 `<角色>_dorm_animator`(277 个 × 41 clip)播放,零重定向
- **shader 结论**:自研卡通 shader(_FirstShadowMultColor/_LightMapTex ramps)用 MeshStandardMaterial + 主贴图近似,观感成立;明暗层留 M2
- **页面坑**:GLTFLoader 报 `reading 'count'` = 蒙皮 primitive 漏 JOINTS_0/WEIGHTS_0(且 JOINTS_0 必须 u8/u16 非 u32);OrbitControls `minDistance` 会把近距相机每帧推开(调试时先调小)
- **下一步输入**:交互落点换 DormConfigAsset 的 278 条 CharacterDisposition + 21 类移动曲线(现手调常量在 dorm.js 顶部);lightmap 映射需实机 Frida 抓拼装;宿舍逻辑 151 个 Lua 可走现有 lundump/lvm

## 宿舍 M2:摆放编辑器 —— 已结(2026-09-05)
- **产物**:`dorm/editor.html`(20 件家具目录 / 0.5m 网格吸附 / R 旋转 / 拖动 / Del / IndexedDB 存档)+ `tools/dorm/export_dorm_m2.py` + `data/dorm/furniture-catalog.json`(20 件含 BoxCollider 占位)+ `data/dorm/dorm-interact.json`(278 角色 × {animType,dispositionType} + 21 类移动曲线;interact 本体只有这两个字段,moveTime 在 disposition.moveCurves 上)
- **新发现**:交互类家具(anniversary/dwc/etj/srt)是**蒙皮骨骼件**(自带 Animator+Avatar+clips);其蒙皮有第三种通道形态 —— 只有索引通道(ch13 u32,可能 dim1)、无权重通道(隐式 1.0),索引带脏数据需按 bindposes 数收敛
- **坑**:GLTFLoader 报 `reading 'count'` 的根因是 SkinnedMesh primitive 缺 WEIGHTS_0;manifest 多进程写入要共享同一对象(m1.manifest),否则 aabb 读到旧副本
- **调试方法**:模块级错误要用**内联 <script> 装错误捕获**(handler 随页面销毁,evaluate 后装+reload 是白装);`window.__edb` 阶段标记定位卡点
- **待办**:lightmap 映射需实机 Frida(`nc-capture/dorm_trace.py` 已就绪,--scene-dorm 需 CS 桥验证);家具动画(自带 AnimatorController)未挂;编辑器→巡游态联动未做

## 宿舍实机抓包(M2.5)—— 已结(2026-09-05,用户配合进宿舍楼)
- **dorm_trace.py 打通**:adb 串号变了(127.0.0.1:16416,非 7555),需先 `adb forward tcp:27042 tcp:27042`;CS 桥可用(`CS.UnityEngine` 全量可读,Application.version=3.0.1)
- **决定性发现:游戏运行时 renderer.lightmapIndex 全部 = -1** —— 宿舍根本没烘光照贴图,明暗全靠实时卡通 shader。three.js 实时光照方案就是正解,lightmap 工作取消
- **房间数据模型**(scene dump → `data/dorm/capture-dorm-scene.json`):DormHolder 下 7 个房间 `<gx>_<gz>`,pos=(4*gx, 2.6 错层, 4*gz);每房 Furniture/Floor/Wall(1-4 面各自 0/90/180/270)/Character/Effect 五个 holder;家具节点={实例id, pos(米), rotY(0/90/180/270)} + prefab(Clone) 带 anchor 偏移(clonePos)
- **家具清单扩充**:实机 47 种 prefab 全部导出,目录 67 件(data/dorm/furniture-catalog.json);编辑器新增「导入实机房间」(capture-dorm-scene.json → 格子)
- **角色在室确认**:5 个 dmodel 实例(professor/sol/simo/taisch/turing)在房 -1_1,带 pos+rotY —— M3 角色巡游的真值
- **待办**:墙饰/门挂墙语义(在 WallHolder 局部系,导入当落地件会悬空);相机 fov=40 euler(10,225,0) 可做巡游默认视角

## 宿舍 M3:角色巡游 —— 已结(2026-09-05)
- **产物**:`dorm/patrol.html`(房间 -1_1 实机家具布局 + 5 角色 dmodel 巡游)+ `tools/dorm/export_dorm_chars.py`(批量角色导出:professor/simo/sol/taisch/turing,每人 2 蒙皮网格 + 15~18 宿舍 clip)
- **共享包解析**:dmodel 的 `AssetBundle.m_Dependencies`(CAB 名)→ `tools/dorm/cab-index.json`(UnityPy 扫 shared 包内部 SerializedFile 名建的索引);cab-5883…= dormanimationcontroller(全员公共依赖);sol/taisch/turing 的贴图包**不在已提取集合**(灰模,拿到包重跑脚本即可)
- **坑**:agent home 是 [x,z] 二元组,误走 toWorld([x,y,z]) → NaN 位置(JSON 里显示 null 就是 NaN);gltf 的 animations 在根对象不在 scene 上
- **待办**:巡游角色接 dorm-interact 配置坐/躺家具;sol/taisch/turing 贴图包定位;编辑器↔巡游页联动(编辑的布局喂给巡游)

## 宿舍 M3:交互演出链 —— 已结(2026-09-05)
- **产物**:patrol.js 角色状态机升级为七态:walk / idle / walk→sit / walk→lie / sitting / lying / getup;45% 概率在 idle 结束时选最近空闲交互点,到站立点后按 **DormConfigAsset 的 moveCurves(moveX/Y/Z + moveTime,角色自己的 dispositionType)** 滑入座位,播 dorm_sit→dorm_sit_loop(休憩 5~9s)→dorm_getup→回巡游;床/地毯/吊床走 lie 链(lie_start→lie_loop)
- **座位点推导**:交互点真值在 C# 配置侧不在包里(fntCfg.interCfg 有 coord/start_coord/angle/bind_path/move_curve_id 字段名,反汇编 DormInterPointData 确认);当前用 BoxCollider 顶面-0.57(sit)/-0.05(lie) 启发式,椅子实测与 M1 手调值吻合
- **字节码工具链**:tools/lua-disasm.mjs 反汇编自定义 Lua 5.3 可当源码读(152 支宿舍脚本已导出 tools/dorm/lua-out/);GetInterAnimType=interCfg.anime_type、GetInterBindPath=bind_path
- **坑**:patrol.js 改重了会撞 `const agents` 重复声明(node --check 先行);模块级错误必须在 HTML 内联 <script> 装 handler
- **待办**:座位点精确值等 fntCfg 数据源(pb.ab/服务端);家具自身动画(蒙皮家具自带 AnimatorController)未挂;墙饰挂墙语义
