#!/usr/bin/env python3
"""
把 compose 里所有「发布到宿主」的端口统一改绑到 127.0.0.1。

为什么必须做：
  容器发布端口默认绑 0.0.0.0，**绕过 ufw 的 INPUT 链**（走 Docker 的 DOCKER chain
  nat 转发），只配防火墙是收不住的。真正有效的做法是改绑定地址。

只改「宿主侧地址」，容器间通信（compose 网络内按服务名）完全不受影响；
宿主进程访问这些端口也不受影响（127.0.0.1 本来就在监听范围）。

只处理形如 `"<host>:<container>"` / `"<host>:<container>:<proto>"` 的发布条目；
`- "80"` 这类只声明容器端口（expose）的条目不动。

用法：python3 scripts/bind-ports-localhost.py [--dry-run]
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILES = [
    ROOT / "deploy/compose/docker-compose.yml",
    ROOT / "deploy/compose/docker-compose.heavy.yml",
]

PORT_LINE = re.compile(r'^(\s*-\s*)"([^"]+)"(\s*(?:#.*)?)$')
IPV4 = re.compile(r'^\d{1,3}(\.\d{1,3}){3}$')


def split_ports(value: str) -> list[str]:
    """
    按冒号切分，但要忽略 ${VAR:-default} 里的冒号。
    例："${POSTGRES_PORT:-5432}:5432" → ["${POSTGRES_PORT:-5432}", "5432"]
    """
    parts: list[str] = []
    buf: list[str] = []
    depth = 0
    for ch in value:
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth = max(0, depth - 1)
        if ch == ":" and depth == 0:
            parts.append("".join(buf))
            buf = []
            continue
        buf.append(ch)
    parts.append("".join(buf))
    return parts


def transform(text: str) -> tuple[str, int]:
    out = []
    changed = 0
    for line in text.splitlines(keepends=True):
        m = PORT_LINE.match(line.rstrip("\n"))
        if not m:
            out.append(line)
            continue
        prefix, value, suffix = m.groups()
        parts = split_ports(value)
        if len(parts) < 2:
            out.append(line)  # 只声明容器端口（expose），不动
            continue
        host = parts[0]
        if host == "127.0.0.1" or IPV4.match(host):
            out.append(line)  # 已带 IP 前缀，避免重复加
            continue
        # 容器端口必须是纯数字（"80" / "5432"），否则不是端口映射
        if not parts[1].isdigit():
            out.append(line)
            continue
        newline = "\n" if line.endswith("\n") else ""
        out.append(f'{prefix}"127.0.0.1:{value}"{suffix}{newline}')
        changed += 1
    return "".join(out), changed


def main() -> int:
    dry = "--dry-run" in sys.argv
    for path in FILES:
        if not path.exists():
            print(f"跳过（不存在）：{path}")
            continue
        original = path.read_text(encoding="utf-8")
        updated, changed = transform(original)
        if changed == 0:
            print(f"{path.name}: 无需改动")
            continue
        if dry:
            print(f"[dry-run] {path.name}: 将改动 {changed} 处")
        else:
            path.write_text(updated, encoding="utf-8")
            print(f"{path.name}: 已改绑 {changed} 处到 127.0.0.1")
    return 0


if __name__ == "__main__":
    sys.exit(main())
