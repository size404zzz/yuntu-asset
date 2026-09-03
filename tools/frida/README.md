# AVG Frida 运行时录制

这条链用于把 MuMu 中官方 AVG 播放器的运行时真值录下来。它不修改游戏
内存、不替换 Lua 返回值，只在 xLua VM 中包装 `Game.Avg.*` 方法并读出：

- 运行时实际进入的 `actCfg`；
- `imgId` 到立绘实例/Prefab 的绑定和生命周期；
- `posId` 解析后的真实位置、缩放、旋转、alpha、明暗和抖动参数；
- Tween 前后 `RectTransform`、RawImage、层级状态；
- 溶解、通讯框、水波纹、特效、后处理、视频和完成回调。

## 使用

1. 启动 MuMu、云图计划并进入要录制的剧情播放器。
2. 确认模拟器内 `frida-server` 在监听 `27042`。serial 不必手动确认：
   脚本默认按 `adb devices` 自动选唯一在线设备（MuMu 有时只暴露
   `emulator-5556` 而不是 `127.0.0.1:7555`），多台在线时才用 `--serial` 指定。
3. 在本仓库根目录运行：

```powershell
python tools/frida/avg-recorder.py --duration 600 --out .\avg-capture.jsonl
```

默认还会以 60 Hz 记录 Unity 实际写入的立绘 Transform、RawImage 颜色、
材质浮点参数和粒子 Play/Stop。需要排查对象名不含 AVG 的 prefab 时，可临时
使用 `--native-all`；需要减小文件体积则用 `--native-rate 30`。

正常播放、点击分支即可；录制器会自动记录实际走过的每个 Act。结束后
转换为播放器可读取的场景：

```powershell
node tools/avg-runtime-import.mjs .\avg-capture.jsonl --out .\avg-scenes.json
```

输出的 `scenes[剧情ID][ActID]` 是普通 AvgCfg-like 镜头，并附带
`runtime.events` 真值事件流。录制一次只覆盖实际播放到的路径；分支需要
分别播放录制，不能从未执行的分支凭空恢复运行时状态。

## 连接故障

```powershell
& 'D:\Program Files\MuMu Player 12\nx_main\adb.exe' devices
# 用上面列出的 serial 替换 <serial>
& 'D:\Program Files\MuMu Player 12\nx_main\adb.exe' -s <serial> shell pidof com.sunborn.neuralcloud.cn
```

如果第二条没有 PID，先启动游戏并进入 AVG；如果 Frida 连接失败，检查
模拟器内 `frida-server` 的架构、端口和 root 权限。
