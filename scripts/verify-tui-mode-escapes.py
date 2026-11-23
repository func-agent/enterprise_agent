#!/usr/bin/env python3
"""实测 MCode 在不同 --tui-mode 下实际发出的转义序列。

目的：确认 `--tui-mode regular` **不会**开启鼠标追踪（1000h/1002h/1003h/1006h）
与备用屏（1049h）—— 这决定了终端原生拖拽选区与右键粘贴能不能用。

用法：python3 scripts/verify-tui-mode-escapes.py [regular|fullscreen|both]
"""
from __future__ import annotations

import os
import pty
import re
import select
import signal
import sys
import time

SESSION = "mvs_929ec42da5c547318b4da4273077ffdf"

# 关注的序列（用可读名，避免正则里的转义 headache）
PROBES = {
    "1049h 进备用屏(alt screen)": b"\x1b[?1049h",
    "1049l 退备用屏": b"\x1b[?1049l",
    "1000h 开鼠标追踪(按键)": b"\x1b[?1000h",
    "1002h 开鼠标追踪(拖拽)": b"\x1b[?1002h",
    "1003h 开鼠标追踪(全移动)": b"\x1b[?1003h",
    "1006h 开鼠标追踪(SGR)": b"\x1b[?1006h",
    "2004h 开 bracketed paste": b"\x1b[?2004h",
}


def capture(mode: str, seconds: float = 6.0) -> bytes:
    """在伪终端里跑 mcode，抓取它写出的原始字节。"""
    cmd = [
        "/usr/local/bin/mcode",
        "--session", SESSION,
        "--tui-mode", mode,
    ]
    env = dict(os.environ)
    # MCode 运行时数据目录：优先 root 家目录，回退到既有实例目录
    data_dir = "/root/.minimax"
    if not os.path.isdir(data_dir):
        data_dir = "/home/ibox/.minimax"
    env.update({
        "HOME": os.path.dirname(data_dir),
        "MINIMAX_DATA_DIR": data_dir,
        "TERM": "xterm-256color",
        "LINES": "40",
        "COLUMNS": "120",
    })

    pid, fd = pty.fork()
    if pid == 0:
        os.execvpe(cmd[0], cmd, env)
        os._exit(127)

    buf = bytearray()
    deadline = time.time() + seconds
    try:
        while time.time() < deadline:
            r, _, _ = select.select([fd], [], [], 0.3)
            if fd in r:
                try:
                    chunk = os.read(fd, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                buf.extend(chunk)
    finally:
        try:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        except Exception:
            pass
        try:
            os.close(fd)
        except Exception:
            pass
    return bytes(buf)


def report(mode: str, data: bytes) -> bool:
    print(f"\n=== --tui-mode {mode} ===")
    print(f"  捕获字节数: {len(data)}")
    found = {}
    for name, seq in PROBES.items():
        hit = seq in data
        found[name] = hit
        print(f"  {'✅ 发现' if hit else '❌ 未发现'}  {name}")
    mouse = any(found[n] for n in PROBES if "鼠标追踪" in n)
    alt = found["1049h 进备用屏(alt screen)"]
    print(f"  → 鼠标追踪: {'开启' if mouse else '未开启'} | 备用屏: {'使用' if alt else '未使用'}")
    if mode == "regular":
        ok = (not mouse) and (not alt)
        print(f"  → 结论: {'✅ 终端原生选区/右键粘贴可用' if ok else '❌ 鼠标被应用接管'}")
        return ok
    print(f"  → 结论: {'⚠ 鼠标被应用接管，需用 TUI 自带选区' if mouse else '鼠标未被接管'}")
    return True


def main() -> int:
    modes = sys.argv[1:] or ["regular"]
    if modes == ["both"]:
        modes = ["regular", "fullscreen"]
    results = {}
    for m in modes:
        results[m] = report(m, capture(m))
    print()
    if "regular" in results:
        print("最终:", "✅ regular 模式可用（原生选区 + 右键粘贴）" if results["regular"]
              else "❌ regular 模式仍被应用接管鼠标")
        return 0 if results["regular"] else 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
