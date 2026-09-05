# 云图计划 · 宿舍 M1 竖切

把游戏内 3D 宿舍资源还原成可交互的宿舍玩法——第一阶段(M1)竖切:
**单房间(ab2024 套系)+ 5 件家具 + croque 走/站/坐/躺/说话全演出链**。
纯静态页面,three.js ESM 本地 vendor,无构建。

## 运行

```bash
python tools/ref/serve.py 8080     # 仓库根为服务根
# 打开 http://127.0.0.1:8080/dorm/index.html
```

页面右侧为 M1 验收清单(加载后自动逐项打勾);按钮可手动触发各姿态,
默认自动巡游:走路 → 说话 → 坐椅子(4s)→ 起身 → 躺地毯(4s)→ 起身,循环。

## 资产管线(本轮核心产出)

`tools/dorm/` 三件套,输入为 MuMu 提取的 Unity AssetBundle:

| 文件 | 作用 |
|---|---|
| `anim_decode.py` | 运行时打包动画 clip → 线性轨道。三层结构:Streamed(Hermite 三次曲线重采样)/ Dense(30fps 采样)/ Constant(双键);骨骼路径哈希用 Avatar `m_TOS` 反解。格式参考 UtinyRipper + AssetRipper AnimationClipConverter |
| `export_gltf.py` | Unity→glTF 2.0 手写导出器:层级、网格(顶点通道 2021+ 语义)、蒙皮(JOINTS_0 u16 / WEIGHTS_0 f32)、材质+主贴图、动画轨道。坐标 Unity→glTF:pos (x,y,−z)、quat (−x,−y,z,w)、矩阵 Z 共轭 |
| `export_dorm_m1.py` | 驱动:croque dmodel + 14 个宿舍 clip、地板/墙、5 家具 → `dorm/assets/*.gltf` + manifest.json |

**不走 FBX 中转**(无 blender/assimp),直接 Unity→glTF,骨骼路径与动画轨道天然一致。

### 网格顶点通道(本作实测,字节级验证)

- 2021+ 通道序:0 pos f32×3 · 1 normal f32×3 · 2 tangent f32×4 · 3 color unorm8×4 · 4 UV0(f16/f32)×2 · **12 blendWeight f32×N · 13 blendIndices u32×N**
- 流区域 **16 字节对齐补齐**(内联数据);外部 .resS 流无对齐
- 个别家具网格 channel dimension 字段损坏(如 52),按同流下一通道 offset 收敛
- 内联数据在 `m_VertexData.m_DataSize`;家具在 `shared_models.ab` 的 `.resS`(`m_StreamData`,经 `env.find_file` 定位)

## M1 结论(两大风险定案)

1. **骨架一致性 ✅**:宿舍用专用 `dmodel_<角色>` 包(非战斗模型)。18/18 个角色的
   dmodel **人形核心链(40 节 Bip001 骨)逐路径一致**;差异只是网格节点名
   (`<角色>_body`)与附加骨(发/裙 Bone00x、Dy_*、眼骨)。
   ⇒ 宿舍动画按**角色各自的 `<角色>_dorm_animator`(277 个,每人 41 clip)**
   播放,零重定向;未来跨角色共享动画只需核心链 40 节。
2. **shader 近似 ✅(可接受)**:游戏用自研卡通 shader(_FirstShadowMultColor/
   _SecondShadowMultColor/_LightMapTex 明暗 ramps)。M1 用 MeshStandardMaterial +
   主贴图,观感成立;卡通明暗层(LightMapTex)留给 M2 做自定义 shader。

## 关键数据(后续阶段的输入)

- `dormanimationcontroller.ab`(27MB):394 clip + 277 controller,含家具专属交互动画
- `dormconfigasset.ab`:278 条 CharacterDisposition(按皮肤逐条)+ 556 条 CharacterInteract
  (animType + moveTime)+ 21 种交互类型 XYZ 移动曲线 → **M3 交互落点用这套数据驱动**,
  替换 M1 手调的 SEAT/LIE 常量(`dorm.js` 顶部)
- `luascripts.ab`:151 个 Game.Dorm Lua 5.3 字节码(A* 寻路、AI 状态机、家具实体),
  可用仓库现有 lundump.js/lvm.js 反解/执行
- 家具 prefab 无数据组件,网格占位可从 BoxCollider 推导

## 已知边界(留给 M2/M3)

- 光照贴图(`rooms_001/shared_lightmaps.ab`)未应用——需先从实机抓房间拼装时的
  lightmap→部件映射(可用 Frida 配合)
- 无网格摆放编辑器、无吸附(地板 4×4m,编辑网格件 `dormfloorgrid.ab` 已定位未用)
- 交互落点为手调常量;家具占位/价格等元数据原生在服务端,需本地桩
- 宿舍大作战(dorm_pvp)是独立玩法,未纳入
