# 云图计划 AVG 剧情资源包

从游戏 AssetBundle 完整解包的剧情演出资源，共 3664 张 PNG（约 1.97GB）。

## 目录结构

```
AVG导出/
├── 立绘/                    # 2974 张，523 个角色目录
│   ├── <立绘ID>/            # 目录名 = 剧情脚本引用的立绘 ID（如 aki_avg、persicaria_avg）
│   │   ├── lpic_*.png       # 大立绘（全身/半身图）
│   │   └── *_face_*.png     # 表情差分（贴在立绘脸部区域，5~29 张不等）
│   ├── _控制器数据/          # CommonPicController/RawImage 导出数据（含脸部定位参数）
│   └── _未识别/              # 个别无法归类的文件
└── 背景CG/                  # 690 张，按章节/活动分目录
    ├── cpt00/ ~ cpt11/      # 主线各章（cpt00 含 cpt001 序章扩展）
    ├── sg/                  # 命运石之门联动
    ├── summer/ 21winter/    # 活动背景
    ├── oath/                # 誓约 CG
    ├── pola/                # 拍立得角色照片
    └── 其他/                 # 零散图（转场、特效底图等）
```

## 与剧情脚本的对应关系

- 剧情脚本在 `res/luascripts/avgconfig.ab`（1878 段，Lua 5.3 字节码）：
  - `AvgCfg_<ID>.lua` 演出指令：`imgPath` 引用背景/CG（如 `cpt00/cpt00_e_bg001`
    → `背景CG/cpt00/cpt00_e_bg001.png`），立绘按 ID 引用（如 `persicaria_avg`
    → `立绘/persicaria_avg/lpic_persicaria_avg.png`）
  - `AvgLang_<ID>_ZH_CN.lua` 台词文本
- 全部 1878 段剧情引用的背景前缀（16 种）与立绘 ID（505 种）已 100% 覆盖：
  - 少数角色（如 abigail）的 AVG 立绘是 RawImage 包装包、真图在角色基础目录
    的 `lpic_*.ab`，已一并解包放入对应 `_avg` 目录
  - `cyclope_sg_avg` 复用 `persicaria_avg` 的立绘（石之门联动共享素材）

## 复现方法

```bash
# 背景/CG
AssetStudio.CLI.exe res/images/avg <输出> --game FakeHeader --export_type Convert
# 立绘（face.ab + lpic_*.ab，建议先归集到暂存目录一次性解包）
AssetStudio.CLI.exe <暂存目录> <输出> --game FakeHeader --export_type Convert
```

注：音频（BGM/SFX cue）不在本资源镜像内，游戏为单独流式下载。
