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

### D1b：根级镜像 —— 待决
- 10 个角色根 localScale.x < 0（arrow / betty / croque / simo 系等）
- SetPosType 拿槽位 scale 作用到根 scale 时是赋值还是相乘，在 il2cpp 里读不出
- 若相乘：croque 在左/中槽是 -1.9 × -1 = 未翻转、只在右两槽翻
- 我们和 wiki 参考件完全一致（AvgPlayer.js:235 与 sprite.js:20 都是 `Math.abs(m_LocalScale)`）
- 更像"参考件一起漏了根级镜像"，而非我们的偏离

### test-io 超时 —— 既有的脆弱点（非回归）
- 默认 `--timeout=120`，但这条链要走 serve.py 的 wiki 图片代理拉 UI 素材
- 网络一慢就报"没拿到报告"——慢网络与真卡死不可区分，且失败信息不指认原因
- A/B 确认：把 508 个新 layout 和 hero-slots.json 全挪走仍然红，不是 P0-1 改动引起的
- 给到 `--timeout=560` 后 59 断言全过
- **待定**：是否把默认超时提到 300s 或让失败时打出最后一次页面状态（判据取舍，等用户定）

## P0 剩余
- 折叠模型断言化：把已确认的语义变成带字节码锚点的回归（lvm.js 修复是其前置，现已完成）
