#!/usr/bin/env python3
"""
把 MCode 会话渲染成可读的 Markdown 对话。

用法（root 或任意用户均可）：
  python3 scripts/session-dump.py                       # 自动定位当前/最新会话
  python3 scripts/session-dump.py <session-id>          # 指定 session id
  python3 scripts/session-dump.py <session-id> --tail 20
  python3 scripts/session-dump.py <session-id> --user   # 只看用户消息

会话数据目录按顺序探测：EAP_SESSION_ROOT 环境变量 → /root/.minimax → 既有实例目录。
"""
import json
import os
import re
import sys
from pathlib import Path

SEARCH_ROOTS = [
    Path(os.environ["EAP_SESSION_ROOT"]) if os.environ.get("EAP_SESSION_ROOT") else None,
    Path("/root/.minimax/v2/sessions"),
    Path("/home/ibox/.minimax/v2/sessions"),
]


def find_sessions(session_id: str | None = None):
    """列出所有会话目录：(session_dir, session_id, mtime)"""
    out = []
    for root in SEARCH_ROOTS:
        if not root:
            continue
        try:
            if not root.is_dir():
                continue
        except PermissionError:
            continue  # 例如以非 root 身份运行时 /root/.minimax 不可读
        try:
            candidates = [p for p in root.rglob("*") if "session_" in p.name]
        except PermissionError:
            continue
        for p in candidates:
            if not p.is_dir():
                continue
            sid = p.name.split("session_", 1)[1] if "session_" in p.name else p.name
            out.append((p, sid, p.stat().st_mtime))
    out.sort(key=lambda x: x[2], reverse=True)
    if session_id:
        for p, sid, mt in out:
            if sid == session_id:
                return [(p, sid, mt)]
        return []
    return out


def text_of(part: dict) -> str:
    t = part.get("type")
    if t == "text":
        return part.get("text", "")
    if t == "thinking":
        return ""
    if t == "toolCall":
        args = part.get("arguments", {})
        return f"`{part.get('name')}({json.dumps(args, ensure_ascii=False)[:400]})`"
    if t == "toolResult":
        c = part.get("content", "")
        if isinstance(c, list):
            c = "\n".join(x.get("text", "") for x in c if isinstance(x, dict))
        return f"```\n{str(c)[:800]}\n```"
    return ""


def render(session_dir: Path, tail: int | None = None, only_user: bool = False):
    msgs_file = session_dir / "messages.jsonl"
    if not msgs_file.exists():
        print(f"找不到 messages.jsonl：{msgs_file}", file=sys.stderr)
        return 1

    entries = []
    with open(msgs_file, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue

    mcode_id = ""
    manifest = session_dir / "manifest.json"
    if manifest.exists():
        try:
            mcode_id = json.loads(manifest.read_text(encoding="utf-8")).get("sessionId", "")
        except Exception:
            pass

    print(f"# 会话 {session_dir.name.split('session_', 1)[-1]}")
    print(f"\n- 目录：`{session_dir}`")
    print(f"- 消息条数：{len(entries)}")
    if mcode_id:
        print(f"- MCode session id（用于 `mcode --session`）：`{mcode_id}`")
    print()

    out = []
    for e in entries:
        msg = e.get("message", {})
        role = msg.get("role")
        if only_user and role != "user":
            continue
        parts = msg.get("content")
        if isinstance(parts, str):
            body = parts
        elif isinstance(parts, list):
            body = "\n".join(filter(None, (text_of(p) for p in parts if isinstance(p, dict))))
        else:
            body = ""
        body = re.sub(r"<system-reminder>.*?</system-reminder>", "", body, flags=re.S).strip()
        if not body:
            continue
        label = {"user": "👤 用户", "assistant": "🤖 助手", "toolResult": "🔧 工具"}.get(role, role)
        out.append(f"### {label}\n\n{body}\n")

    if tail:
        out = out[-tail:]

    print("\n---\n\n".join(out))
    return 0


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = {a for a in sys.argv[1:] if a.startswith("--")}
    tail = None
    if "--tail" in flags:
        i = sys.argv.index("--tail")
        tail = int(sys.argv[i + 1]) if i + 1 < len(sys.argv) else 20
    only_user = "--user" in flags

    sessions = find_sessions(args[0] if args else None)
    if not sessions:
        print("未找到会话。可用 ID：", file=sys.stderr)
        for p, sid, _ in find_sessions():
            print(f"  {sid}  {p}", file=sys.stderr)
        return 1

    if not args:
        print("最近会话：")
        for p, sid, mt in sessions[:10]:
            import datetime

            print(f"  {sid}  {datetime.datetime.fromtimestamp(mt):%Y-%m-%d %H:%M}  {p}")
        print("\n用法：scripts/session-dump.py <session-id> [--tail N] [--user]")
        return 0

    return render(sessions[0][0], tail=tail, only_user=only_user)


if __name__ == "__main__":
    sys.exit(main())
