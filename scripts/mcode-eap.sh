#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# MCode 启动器 —— root 一条命令直接进入指定 session
#
# 解决三件事：
#   1. **以 root 直接跑**：不再切用户（原先是 root → runuser 切 ibox）。
#      MCode CLI 的运行时数据目录通过 MINIMAX_DATA_DIR 显式指定，
#      因此不需要 su，也不需要 sudo。
#   2. **鼠标能粘贴**：加 --tui-mode regular。
#      MCode 0.7.7 里 `beforeTerminalStart()`（写 1049h 进 alt 屏 + 写
#      1000h/1003h/1006h 抢鼠标追踪）**只在 fullscreen 渲染器 Ca 上**；
#      regular 渲染器 Bs 没有这段 → 终端保留原生 scrollback，
#      鼠标拖拽选区、**右键粘贴**、Ctrl+Shift+C/V 全部由终端原生处理。
#      （fullscreen 是固定视口 + 应用内滚动，终端 scrollback 里没有历史可选。）
#   3. **不自动滚屏**：MCODE_NO_FOLLOW_TAIL=1 关掉「自动粘底」。
#      该补丁只改 regular 渲染器的 hostFollowsBottom()，正好配合 regular 用。
#      补丁本体见 scripts/patch-mcode-follow-tail.sh。
#
# 用法：
#   mcode-eap                          # 进入默认 session（本项目当前会话）
#   mcode-eap <session-id>             # 进入指定 session
#   mcode-eap --continue               # 继续最近一次会话
#   mcode-eap --list                   # 列出本机已有 session
#
# 安装：scripts/install-mcode-eap.sh（会把本脚本装到 /usr/local/bin/mcode-eap）
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

TARGET_USER="root"
TARGET_HOME="/root"
# MCode 运行时数据目录 —— MCode CLI 进程以 root 运行（HOME=/root）。
# 但会话历史可能分散在多个运行时目录：
#   /root/.minimax       —— root 自己的运行时
#   /home/ibox/.minimax  —— 既有实例的运行时（当前活跃会话在这里）
# 因此按「该目录里是否真的有 v2/sessions」来定候选，
# 并在确定目标 session 后，再收敛到**真正含该 session** 的那个目录 ——
# 否则 MCode CLI 会报「会话不存在」。
DATA_DIR_CANDIDATES=(/root/.minimax /home/ibox/.minimax)

# 某个目录里是否含指定会话
#
# ⚠ 会话目录名里放的是 **base64 编码后的** session id，不是原始 id：
#   mvs_6eb432c8058443d48460c84ae4a1352d
#     → 13-57-10-293-session_bXZzXzZlYjQzMmM4MDU4NDQzZDQ4NDYwYzg0YWU0YTEzNTJk
# 所以要按编码后的名字匹配（目录名形如 <时间>-session_<base64>）。
has_session() {
  local dir="$1" sid="$2" enc
  [ -n "$sid" ] || return 1
  [ -d "$dir/v2/sessions" ] || return 1
  enc="$(printf '%s' "$sid" | base64 -w0 2>/dev/null)" || return 1
  [ -n "$enc" ] || return 1
  find "$dir/v2/sessions" -maxdepth 5 -type d -name "*session_${enc}" 2>/dev/null | grep -q .
}

# 第一个含会话数据的目录（root 优先）
first_data_dir() {
  local c
  for c in "${DATA_DIR_CANDIDATES[@]}"; do
    if [ -d "$c/v2/sessions" ]; then
      echo "$c"
      return 0
    fi
  done
  echo "/root/.minimax"
}

latest_data_dir() {
  python3 - "${DATA_DIR_CANDIDATES[@]}" <<'PY'
import json, os, sys

best = None
for data_dir in sys.argv[1:]:
    root = os.path.join(data_dir, "v2", "sessions")
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        if "manifest.json" not in filenames:
            continue
        try:
            with open(os.path.join(dirpath, "manifest.json"), encoding="utf-8") as f:
                manifest = json.load(f)
            ts = float(manifest.get("updatedAtMs") or manifest.get("createdAtMs") or 0)
        except Exception:
            continue
        if best is None or ts > best[0]:
            best = (ts, data_dir)
print(best[1] if best else sys.argv[1])
PY
}

TARGET_DATA_DIR="$(first_data_dir)"
MCODE_PKG="/usr/local/lib/node_modules/@minimax-ai/code"

# 默认 session：当前这个会话
DEFAULT_SESSION="mvs_929ec42da5c547318b4da4273077ffdf"

log()  { printf '%s\n' "$*"; }
err()  { printf '%s\n' "$*" >&2; }

# ── 自检：follow-tail 补丁必须在位，否则「不自动滚屏」不生效 ──────────
if ! grep -qF 'MCODE_NO_FOLLOW_TAIL' "$MCODE_PKG"/chunks/*.js 2>/dev/null; then
  err "⚠ 未检测到 follow-tail 补丁，自动粘底不会被关闭。"
  err "  请先执行：/opt/agent/scripts/patch-mcode-follow-tail.sh"
  exit 1
fi

# ── 解析参数 ──────────────────────────────────────────────────────────
SESSION_ID="$DEFAULT_SESSION"
EXTRA_ARGS=()
DRY_RUN=0

# 先把 --dry-run / -n 从参数里摘出来 —— 它可以出现在任意位置，
# 否则 `mcode-eap <session-id> --dry-run` 会把它当成透传参数传给 mcode。
DRY_ARGS=()
for A in "$@"; do
  case "$A" in
    --dry-run|-n) DRY_RUN=1 ;;
    *) DRY_ARGS+=("$A") ;;
  esac
done
set -- ${DRY_ARGS[@]+"${DRY_ARGS[@]}"}

case "${1:-}" in
  --continue|-C)
    SESSION_ID=""
    TARGET_DATA_DIR="$(latest_data_dir)"
    EXTRA_ARGS+=(--continue)
    shift
    ;;
  --dry-run|-n)
    DRY_RUN=1
    shift
    ;;
  --list|-l)
    log "本机 session（--session 用的就是左边的 mvs_ id）："
    python3 - "${DATA_DIR_CANDIDATES[@]}" <<'PY'
import json, os, sys, datetime

# 多个运行时目录一起扫，按 session id 去重
roots = [os.path.join(d, "v2", "sessions") for d in sys.argv[1:]]


def first_user_text(path):
    """取首条真实用户输入作为标题（跳过 system-reminder 注入块）"""
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                m = o.get("message") or {}
                if m.get("role") != "user":
                    continue
                content = m.get("content")
                texts = []
                if isinstance(content, str):
                    texts = [content]
                elif isinstance(content, list):
                    texts = [
                        b.get("text", "")
                        for b in content
                        if isinstance(b, dict) and b.get("type") == "text"
                    ]
                for t in texts:
                    t = t.strip()
                    if t and not t.startswith("<system-reminder>"):
                        return " ".join(t.split())[:44]
    except Exception:
        pass
    return ""


rows = []
seen = set()
for root in roots:
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]  # 跳过隐藏子目录
        if "manifest.json" not in filenames:
            continue
        try:
            with open(os.path.join(dirpath, "manifest.json"), encoding="utf-8") as f:
                m = json.load(f)
        except Exception:
            continue
        sid = m.get("sessionId") or "?"
        if sid in seen:  # 同一会话可能落在多个运行时目录里
            continue
        seen.add(sid)
        ts = m.get("updatedAtMs") or m.get("createdAtMs") or 0
        when = (
            datetime.datetime.fromtimestamp(ts / 1000).strftime("%m-%d %H:%M") if ts else "?"
        )
        title = first_user_text(os.path.join(dirpath, "messages.jsonl"))
        rows.append((ts, sid, when, title))

rows.sort(reverse=True)
for _, sid, when, title in rows:
    print(f"  {sid}  {when}  {title}")
PY
    exit 0
    ;;
  --help|-h)
    sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  "")
    ;;
  *)
    SESSION_ID="$1"
    shift
    ;;
esac

# 其余参数原样透传
while [ $# -gt 0 ]; do
  EXTRA_ARGS+=("$1")
  shift
done

# ── 数据目录收敛：指向真正含目标会话的那个运行时目录 ──────────────────
# 会话可能落在 /root/.minimax 或既有实例目录里，指向错的那个
# MCode CLI 会报「会话不存在」。--continue 已按 manifest 选中最近更新的运行时目录。
if [ -n "$SESSION_ID" ] && ! has_session "$TARGET_DATA_DIR" "$SESSION_ID"; then
  for CAND in "${DATA_DIR_CANDIDATES[@]}"; do
    if has_session "$CAND" "$SESSION_ID"; then
      TARGET_DATA_DIR="$CAND"
      break
    fi
  done
fi

# ── 组装命令 ─────────────────────────────────────────────────────────
# 注意：不能加 `-i`（会清空环境），TERM 必须带过去，否则 TUI 渲染会异常。
MCODE_BIN="$(command -v mcode || echo /usr/local/bin/mcode)"

CMD=(
  env
  "HOME=$TARGET_HOME"
  "MINIMAX_DATA_DIR=$TARGET_DATA_DIR"
  "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  "MCODE_NO_FOLLOW_TAIL=1"
  "$MCODE_BIN"
  --tui-mode regular
)
[ -n "$SESSION_ID" ] && CMD+=(--session "$SESSION_ID")
[ ${#EXTRA_ARGS[@]} -gt 0 ] && CMD+=("${EXTRA_ARGS[@]}")

# ── 以 root 直接跑（不再切用户）───────────────────────────────────────
if [ "$DRY_RUN" -eq 1 ]; then
  log "DRY-RUN —— 将执行："
  log "  user    : $(id -un)"
  log "  data dir: $TARGET_DATA_DIR"
  log "  session : $SESSION_ID"
  log "  cmd     : ${CMD[*]}"
  exit 0
fi

exec "${CMD[@]}"
