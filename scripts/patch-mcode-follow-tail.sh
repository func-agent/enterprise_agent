#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# 给 MCode CLI 打补丁：关掉「自动跟随尾部（粘底）」行为
#
# ── 根因（源码级，已定位到具体行）────────────────────────────────────
# MCode 的 regular 渲染模式里，「是否跟随底部」不是由**用户视口位置**决定的，
# 而是这样判定的（launcher-*.js，regular 渲染器）：
#
#     hostFollowsBottom(){
#       return this.forceHistoryReplay
#           || performance.now() - this.lastUserInputAt <= b_;   // b_ = 1000ms
#     }
#
# 也就是说：**只要最近 1 秒内有键盘输入，就判定为「跟随底部」**。
# 鼠标滚轮在 regular 模式下由终端原生 scrollback 处理，程序看不见，
# 于是「一边打字一边往上翻历史」时，每来一条新输出都会被判定为跟随 →
# 视口立刻被拽回底部（用户看到的「自动滚回输入框」）。
#
# Fullscreen 模式没有这个问题：它用 ScrollView.isFollowingEnd 精确跟踪视口，
# 滚上去后就不再跟随（见官方 docs/superpowers/specs/2026-09-23-tui-follow-tail-design.md，
# 该设计文档明确写了「不提供 followTail 配置项」——本脚本就是补上这个开关）。
#
# ── 补丁做了什么 ─────────────────────────────────────────────────────
# 把判定改成「只有强制历史重放才跟随」，并额外读一个环境变量：
#
#     MCODE_NO_FOLLOW_TAIL=1   → 完全关闭自动跟随
#     未设置                    → 保持官方原行为（本次输入 1 秒内仍跟随）
#
# 这样开关由环境变量控制，**改一次包、以后随便开/关**。
#
# ── 用法 ─────────────────────────────────────────────────────────────
#   ./scripts/patch-mcode-follow-tail.sh            # 打补丁（幂等）
#   ./scripts/patch-mcode-follow-tail.sh --status   # 查看状态
#   ./scripts/patch-mcode-follow-tail.sh --revert   # 还原
#
# ── 重要 ─────────────────────────────────────────────────────────────
#   1. **需要重启 mcode 才生效**（当前进程已加载旧代码）。
#   2. `mcode update` 会覆盖安装目录 —— update 后需重新执行本脚本。
#      建议加到升级流程后：mcode update && ./scripts/patch-mcode-follow-tail.sh
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_SUFFIX=".eap-follow-tail.bak"

# 补丁前后的判定表达式（必须与源码逐字一致，否则拒绝继续）
OLD_PATTERN='hostFollowsBottom(){return this.forceHistoryReplay||performance.now()-this.lastUserInputAt<=b_}'
NEW_PATTERN='hostFollowsBottom(){return this.forceHistoryReplay||(process.env.MCODE_NO_FOLLOW_TAIL==="1"?!0:performance.now()-this.lastUserInputAt<=b_)}'

log()  { printf '%s\n' "$*"; }
err()  { printf '%s\n' "$*" >&2; }

# ── 定位 mcode 包根目录 ───────────────────────────────────────────────
resolve_pkg_root() {
  local bin link
  bin="$(command -v mcode 2>/dev/null || true)"
  if [ -z "$bin" ]; then
    err "未找到 mcode 命令（PATH 里没有 mcode）"
    return 1
  fi
  link="$(readlink -f "$bin" 2>/dev/null || echo "$bin")"
  # .../node_modules/@minimax-ai/code/cli.js → 包根目录
  local dir
  dir="$(dirname "$link")"
  while [ "$dir" != "/" ] && [ "$dir" != "." ]; do
    if [ -f "$dir/package.json" ] && grep -q '"@minimax-ai/code"' "$dir/package.json" 2>/dev/null; then
      echo "$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  err "无法从 $link 推断 @minimax-ai/code 包根目录"
  return 1
}

PKG_ROOT="$(resolve_pkg_root)" || exit 1
CHUNKS="$PKG_ROOT/chunks"

log "MCode 包目录: $PKG_ROOT"

# ── 找出承载 regular 渲染器的 chunk ───────────────────────────────────
# 文件名带内容 hash（launcher-XXXX.js），update 后会变 → 必须按内容定位，不能按文件名。
TARGET=""
while IFS= read -r f; do
  if grep -qF -- "$OLD_PATTERN" "$f" 2>/dev/null; then
    TARGET="$f"
    break
  fi
done < <(ls -1 "$CHUNKS"/*.js 2>/dev/null)

# 已打过补丁的情况
PATCHED=""
while IFS= read -r f; do
  if grep -qF -- "$NEW_PATTERN" "$f" 2>/dev/null; then
    PATCHED="$f"
    break
  fi
done < <(ls -1 "$CHUNKS"/*.js 2>/dev/null)

case "${1:-}" in
  --status)
    if [ -n "$PATCHED" ]; then
      log "状态: 已打补丁 -> $PATCHED"
      log "  当前生效值由环境变量 MCODE_NO_FOLLOW_TAIL 决定："
      log "    MCODE_NO_FOLLOW_TAIL=1  → 关闭自动跟随（滚上去不会被拽回）"
      log "    未设置                  → 保持官方行为"
      exit 0
    fi
    if [ -n "$TARGET" ]; then
      log "状态: 未打补丁（官方原样）-> $TARGET"
      exit 0
    fi
    log "状态: 未找到目标判定表达式 —— 上游可能已重构该逻辑，需要重新定位"
    exit 1
    ;;
  --revert)
    if [ -z "$PATCHED" ]; then
      log "当前未打补丁，无需还原"
      exit 0
    fi
    if [ -f "$PATCHED$BACKUP_SUFFIX" ]; then
      cp -f "$PATCHED$BACKUP_SUFFIX" "$PATCHED"
      rm -f "$PATCHED$BACKUP_SUFFIX"
      log "已还原: $PATCHED"
      exit 0
    fi
    # 没有备份就直接反向替换
    python3 - "$PATCHED" "$OLD_PATTERN" "$NEW_PATTERN" <<'PY'
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path, encoding='utf-8').read()
if new not in s:
    sys.exit("补丁内容不存在，无法反向还原")
open(path, 'w', encoding='utf-8').write(s.replace(new, old))
print(f"已反向还原: {path}")
PY
    exit 0
    ;;
esac

if [ -n "$PATCHED" ]; then
  log "已是最新补丁状态，无需重复应用: $PATCHED"
  log "提示：需重启 mcode 才生效；开关用 MCODE_NO_FOLLOW_TAIL=1"
  exit 0
fi

if [ -z "$TARGET" ]; then
  err "未在 $CHUNKS 中找到目标判定表达式。"
  err "上游可能已重构该逻辑 —— 本脚本不做模糊替换，避免改坏客户端。"
  err "如上游有变化，可到 GitHub MiniMax-AI/minimax-code 重新定位后更新本脚本。"
  exit 1
fi

log "目标文件: $TARGET"

# ── 备份 + 打补丁 ─────────────────────────────────────────────────────
cp -p "$TARGET" "$TARGET$BACKUP_SUFFIX"
log "已备份: $TARGET$BACKUP_SUFFIX"

python3 - "$TARGET" "$OLD_PATTERN" "$NEW_PATTERN" <<'PY'
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path, encoding='utf-8').read()
n = s.count(old)
if n != 1:
    sys.exit(f"目标表达式出现 {n} 次（期望恰好 1 次），拒绝修改")
open(path, 'w', encoding='utf-8').write(s.replace(old, new))
print(f"已写入补丁（1 处替换）")
PY

# 校验：语法可解析 + 补丁确实在位
node --check "$TARGET" 2>&1 | head -3 || { err "补丁后语法校验失败，已用备份还原"; cp -f "$TARGET$BACKUP_SUFFIX" "$TARGET"; exit 1; }

if ! grep -qF -- "$NEW_PATTERN" "$TARGET"; then
  err "补丁校验失败，已还原"
  cp -f "$TARGET$BACKUP_SUFFIX" "$TARGET"
  exit 1
fi

log
log "✔ 补丁已应用"
log
log "生效方式（重启 mcode 后）："
log "  MCODE_NO_FOLLOW_TAIL=1 mcode            # 完全关闭自动跟随"
log "  MCODE_NO_FOLLOW_TAIL=1 mcode --session <id>   # 继续当前会话"
log
log "  关闭后：往上翻历史不会被新输出拽回；代价是底部等回复时也不再自动滚动，"
log "  需要自己按 End（或滚到底部）才看到最新内容。"
log
log "回滚: $0 --revert"
log "注意: mcode update 会覆盖安装目录，升级后需重新执行本脚本。"
