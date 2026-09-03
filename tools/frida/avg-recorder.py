"""Record official AVG runtime calls from MuMu with Frida.

The game remains in the foreground.  Open an AVG story in MuMu, run this
script, then play through the desired acts normally.  The output is a JSONL
ground-truth stream; use tools/avg-runtime-import.mjs to turn it into replay
scenes.

Example:
  python tools/frida/avg-recorder.py --duration 600 --out capture.jsonl
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time

import frida

PACKAGE = "com.sunborn.neuralcloud.cn"
ENDPOINT = "127.0.0.1:27042"
# MuMu serial 不固定（实测有时只列 emulator-5556）；这个值只在 adb devices
# 列出多台设备时用作首选消歧。
MUMU_FALLBACK_SERIAL = "127.0.0.1:7555"
DEFAULT_ADB = r"D:\Program Files\MuMu Player 12\nx_main\adb.exe"
HERE = os.path.dirname(os.path.abspath(__file__))
AGENT = os.path.join(HERE, "avg-recorder.js")


def list_serials(adb):
    out = subprocess.run([adb, "devices"], capture_output=True,
                         text=True, timeout=20).stdout
    return [line.split()[0] for line in out.splitlines()[1:]
            if len(line.split()) >= 2 and line.split()[1] == "device"]


def resolve_serial(adb, requested):
    if not adb:
        raise SystemExit("找不到 adb.exe；请用 --adb 指定 MuMu 的 adb.exe")
    if requested:
        return requested
    devices = list_serials(adb)
    if not devices:
        raise SystemExit("adb 没有在线设备；请确认 MuMu 与 VM 已启动")
    if len(devices) == 1:
        return devices[0]
    if MUMU_FALLBACK_SERIAL in devices:
        return MUMU_FALLBACK_SERIAL
    raise SystemExit("检测到多台设备，请用 --serial 指定: " + ", ".join(devices))


def adb_path(value):
    if value:
        return value
    candidates = [
        DEFAULT_ADB,
        os.path.join(os.environ.get("ANDROID_HOME", ""), "platform-tools", "adb.exe"),
        os.path.join(os.environ.get("ANDROID_SDK_ROOT", ""), "platform-tools", "adb.exe"),
        shutil.which("adb") or "",
    ]
    for path in candidates:
        if path and os.path.exists(path):
            return path
    return None


def resolve_pid(adb, serial):
    if not adb:
        raise SystemExit("找不到 adb.exe；请用 --adb 指定 MuMu 的 adb.exe")
    try:
        out = subprocess.run([adb, "-s", serial, "shell", "pidof", PACKAGE],
                             capture_output=True, text=True, timeout=20)
    except OSError as exc:
        raise SystemExit(f"无法启动 adb: {exc}")
    pids = out.stdout.split()
    if not pids:
        detail = (out.stderr or out.stdout).strip()
        raise SystemExit(
            f"没有找到正在运行的 {PACKAGE}（serial={serial}）。"
            f" 请启动 MuMu、游戏和 AVG；{detail}")
    return int(pids[0])


def main():
    ap = argparse.ArgumentParser(description="MuMu 云图计划 AVG Frida 运行时录制器")
    ap.add_argument("--duration", type=float, default=300,
                    help="录制秒数，默认 300")
    ap.add_argument("--out", default=None, help="JSONL 输出路径")
    ap.add_argument("--pid", type=int, default=None, help="直接指定进程 PID")
    ap.add_argument("--adb", default=None, help="adb.exe 路径")
    ap.add_argument("--serial", default=None,
                    help="adb serial；默认按 adb devices 自动检测（唯一设备直接选中）")
    ap.add_argument("--no-forward", action="store_true",
                    help="不自动执行 adb forward tcp:27042")
    ap.add_argument("--refresh", type=float, default=2.0,
                    help="刷新新加载 Lua 模块的间隔，0=关闭")
    ap.add_argument("--native-rate", type=int, default=60,
                    help="Unity 运行时采样频率，默认 60 Hz，范围 1-120；0 = 关闭原生采样"
                         "（只录 Lua；原生层实测可能把游戏打崩）")
    ap.add_argument("--native-all", action="store_true",
                    help="记录 AVG 播放期间所有 Transform（默认按 AVG 对象名过滤）")
    args = ap.parse_args()

    out_path = args.out or os.path.join(
        HERE, "captures", time.strftime("avg-%Y%m%d-%H%M%S.jsonl"))
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    sink = open(out_path, "a", encoding="utf-8")
    host_seq = 0

    def write(row):
        nonlocal host_seq
        host_seq += 1
        if isinstance(row, str):
            try:
                row = json.loads(row)
            except json.JSONDecodeError:
                row = {"schema": "yuntu-avg-runtime/v1", "kind": "raw", "text": row}
        row.setdefault("hostSeq", host_seq)
        row.setdefault("hostTime", round(time.time(), 3))
        sink.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
        sink.flush()

    def on_message(message, data):
        kind = message.get("type")
        if kind == "send":
            payload = message.get("payload") or {}
            if payload.get("type") == "record":
                write(payload.get("line", ""))
                print("record", host_seq, flush=True)
            else:
                print(payload.get("msg", payload), flush=True)
        elif kind == "error":
            write({"schema": "yuntu-avg-runtime/v1", "kind": "agent-error",
                   "description": message.get("description"),
                   "stack": message.get("stack")})
            print("FRIDA ERROR", message.get("description"), flush=True)

    adb = adb_path(args.adb)
    serial = None
    if args.serial and not adb:
        raise SystemExit("找不到 adb.exe；请用 --adb 指定 MuMu 的 adb.exe")
    if args.pid and args.no_forward:
        pid = args.pid
    else:
        serial = resolve_serial(adb, args.serial)
        print("serial:", serial, flush=True)
        if not args.no_forward:
            subprocess.run([adb, "-s", serial, "forward", "tcp:27042", "tcp:27042"],
                           capture_output=True, text=True, timeout=20, check=True)
        pid = args.pid or resolve_pid(adb, serial)
    device = frida.get_device_manager().add_remote_device(ENDPOINT)
    print("device:", device.name, flush=True)
    session = device.attach(pid)
    print(f"attached pid={pid}; output={out_path}", flush=True)
    with open(AGENT, encoding="utf-8") as fh:
        script = session.create_script(fh.read())
    script.on("message", on_message)
    script.load()
    api = script.exports_sync
    print("ping:", api.ping(), flush=True)
    try:
        print("native configure:", api.configure(args.native_rate, args.native_all),
              flush=True)
    except Exception as exc:
        print("native configure skipped:", exc, flush=True)
    started = api.start()
    if isinstance(started, dict) and not started.get("ok", True):
        raise SystemExit(f"录制器启动失败：{started}")

    deadline = time.time() + max(0, args.duration)
    next_refresh = time.time() + max(0.2, args.refresh) if args.refresh else deadline + 1
    try:
        while time.time() < deadline:
            time.sleep(0.25)
            if args.refresh and time.time() >= next_refresh:
                try:
                    api.refresh()
                except Exception as exc:
                    print("refresh skipped:", exc, flush=True)
                next_refresh = time.time() + args.refresh
    except KeyboardInterrupt:
        print("interrupted", flush=True)
    finally:
        try:
            api.stop()
        except Exception as exc:
            print("stop skipped:", exc, flush=True)
        try:
            api.stats()
        except Exception:
            pass
        session.detach()
        sink.close()
    print("done:", out_path, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
