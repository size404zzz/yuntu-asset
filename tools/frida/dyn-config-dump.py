"""Dump the live (static + CDN-dynamic merged) config tables from MuMu.

The game client fetches a slice of its config (handbook class-3 content, the
2024 review tables, ...) at runtime via ConfigData:LoadDynCfg; those rows are
absent from the static TextAsset we decode in build-story-archive.  This host
attaches Frida to the running game, runs a small Lua chunk inside the live
xLua VM (read-only) and streams every table row back as JSONL.

Usage (game running, ideally at the main screen so dyn config is fetched):
  python tools/frida/dyn-config-dump.py --out dyn-capture.jsonl
  node tools/dyn-config-import.mjs dyn-capture.jsonl
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
MUMU_FALLBACK_SERIAL = "127.0.0.1:7555"
DEFAULT_ADB = r"D:\Program Files\MuMu Player 12\nx_main\adb.exe"
HERE = os.path.dirname(os.path.abspath(__file__))
AGENT = os.path.join(HERE, "dyn-config-dump.js")
SCHEMA = "yuntu-dyn-config/v1"

# 剧情树要用的表：handbook_activity / story_avg 抓 ConfigData 运行时合并真值
# （class 3 content、动态新增的 story_avg 行都在里面）；其余是 LoadDynCfg 动态槽。
DEFAULT_TABLES = [
    "handbook_activity",
    "story_avg",
    "activity_anniversary24_main",
    "activity_carnival23_main",
    "activity_carnival24_main",
    "delivery_activity_main",
    "activity_hero",
    "activity_herolite_avg",
    "activity_herolite_ui_config",
    "activity_anniversary_main",
    "activity_winter23_main",
    "activity_season_main",
    "activity_treasurehunt_main",
    "activity_interact_info",
]


def list_serials(adb):
    out = subprocess.run([adb, "devices"], capture_output=True,
                         text=True, timeout=20).stdout
    return [line.split()[0] for line in out.splitlines()[1:]
            if len(line.split()) >= 2 and line.split()[1] == "device"]


def adb_path(value):
    if value:
        return value
    candidates = [
        DEFAULT_ADB,
        os.path.join(os.environ.get("ANDROID_HOME", ""), "platform-tools", "adb.exe"),
        shutil.which("adb") or "",
    ]
    for path in candidates:
        if path and os.path.exists(path):
            return path
    return None


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


def resolve_pid(adb, serial):
    out = subprocess.run([adb, "-s", serial, "shell", "pidof", PACKAGE],
                         capture_output=True, text=True, timeout=20)
    pids = out.stdout.split()
    if not pids:
        raise SystemExit(f"没有找到正在运行的 {PACKAGE}（serial={serial}）——"
                         "先启动 MuMu、游戏，进到主界面（动态配置在登录后下发）")
    return int(pids[0])


def main():
    ap = argparse.ArgumentParser(description="抓取云图计划运行时配置表（只读）")
    ap.add_argument("--out", default=None, help="JSONL 输出路径")
    ap.add_argument("--pid", type=int, default=None, help="直接指定进程 PID")
    ap.add_argument("--adb", default=None, help="adb.exe 路径")
    ap.add_argument("--serial", default=None)
    ap.add_argument("--no-forward", action="store_true")
    ap.add_argument("--tables", default=",".join(DEFAULT_TABLES),
                    help="要抓的表名，逗号分隔")
    ap.add_argument("--all", action="store_true",
                    help="扫整个 eDynConfigData 枚举（动态槽全量，比较大）")
    ap.add_argument("--meta-only", action="store_true",
                    help="只看运行时环境（槽位清单），不抓表")
    args = ap.parse_args()

    out_path = args.out or os.path.join(
        HERE, "captures", time.strftime("dyn-config-%Y%m%d-%H%M%S.jsonl"))
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    # 行级增量落盘（追加）：游戏进程/Lua 状态可能在抓取途中重启（实测会），
    # 分多次跑时同一份 JSONL 可以续写，导入端按 (name, source, key) 去重。
    sink = open(out_path, "a", encoding="utf-8")

    tables = {}
    rows = []
    errors = []

    def on_message(message, data):
        kind = message.get("type")
        if kind == "send":
            payload = message.get("payload") or {}
            if payload.get("type") == "record":
                try:
                    row = json.loads(payload.get("line", ""))
                except json.JSONDecodeError:
                    errors.append("bad json line")
                    return
                if row.get("schema") == SCHEMA:
                    rows.append(row)
                    sink.write(json.dumps(row, ensure_ascii=False,
                                          separators=(",", ":")) + "\n")
                    sink.flush()
                    if row.get("kind") == "table":
                        key = (row.get("name"), row.get("source"))
                        tables[key] = row.get("count", 0)
            else:
                print(payload.get("msg", payload), flush=True)
        elif kind == "error":
            errors.append(message.get("description"))
            print("FRIDA ERROR", message.get("description"), flush=True)

    adb = adb_path(args.adb)
    if not args.pid:
        serial = resolve_serial(adb, args.serial)
        print("serial:", serial, flush=True)
        if not args.no_forward:
            subprocess.run([adb, "-s", serial, "forward", "tcp:27042", "tcp:27042"],
                           capture_output=True, text=True, timeout=20, check=True)
        pid = resolve_pid(adb, serial)
    else:
        pid = args.pid
    device = frida.get_device_manager().add_remote_device(ENDPOINT)
    session = device.attach(pid)
    print(f"attached pid={pid}; output={out_path}", flush=True)
    with open(AGENT, encoding="utf-8") as fh:
        script = session.create_script(fh.read())
    script.on("message", on_message)
    script.load()
    api = script.exports_sync
    print("ping:", api.ping(), flush=True)

    def ev(code):
        result = api.eval(code)
        time.sleep(0.4)
        if not result.get("ok"):
            errors.append(result.get("error"))
        return result

    if args.all:
        raise SystemExit("--all 需要先 --meta-only 拿槽位清单，再把名单传给 --tables"
                         "（dumpAll 走钩子路径，不在会话里做二次 eval）")

    if args.meta_only:
        # 交互探针路径：setup 抓 L 后 eval（调试用；主路径走 dumpAll 钩子）
        ev("_YDYN.meta()")
        meta = next((r for r in rows if r.get("kind") == "meta"), None)
        if meta:
            print(f"dyn slots: {len(meta.get('dynSlots') or [])}"
                  f" · loadDynCfg={meta.get('loadDynCfg')}", flush=True)
    else:
        table_list = [t for t in args.tables.split(",") if t]
        # 主路径：armDump——在 lua_pcall 钩子内部（游戏线程被拦截时）同步
        # 抓完全部表，避免 Frida 线程与游戏线程同踩 lua_State 的竞态。
        api.dumpAll(json.dumps(table_list))
        print(f"armed; dumping {len(table_list)} tables …", flush=True)
        deadline = time.time() + 180
        last = 0
        while time.time() < deadline:
            time.sleep(1)
            if any(r.get("kind") == "done" for r in rows):
                break
            if len(rows) != last:
                last = len(rows)
                print(f"  … {last} 行", flush=True)
        got_done = any(r.get("kind") == "done" for r in rows)
        print(f"{'完成' if got_done else '未完成（会话中断，已抓部分保留在文件里）'}",
              flush=True)
    sink.close()
    print(f"done: {len(rows)} 行 → {out_path}", flush=True)
    if errors:
        print("errors:", *errors[:5], sep="\n  ", flush=True)

    try:
        session.detach()
    except Exception:
        pass
    return 0


def _quote(name):
    return "'" + name.replace("'", "\\'") + "'"


if __name__ == "__main__":
    sys.exit(main())
