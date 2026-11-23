#!/usr/bin/env bash
# 安装 MCode 启动器到 /usr/local/bin/mcode-eap（root 一条命令进 session）。
#
# 用法：sudo ./scripts/install-mcode-eap.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/mcode-eap.sh"
DEST="/usr/local/bin/mcode-eap"

if [ "$(id -u)" -ne 0 ]; then
  echo "需要 root：sudo $0" >&2
  exit 1
fi

if [ ! -f "$SRC" ]; then
  echo "找不到源文件：$SRC" >&2
  exit 1
fi

install -m 0755 "$SRC" "$DEST"
echo "已安装：$DEST"

# 顺带确保 follow-tail 补丁在位（不自动滚屏的前提）
if ! grep -qF 'MCODE_NO_FOLLOW_TAIL' /usr/local/lib/node_modules/@minimax-ai/code/chunks/*.js 2>/dev/null; then
  echo "⚠ follow-tail 补丁不在位，自动粘底不会被关闭。"
  echo "  请执行：$SCRIPT_DIR/patch-mcode-follow-tail.sh"
  exit 1
fi

echo
echo "用法："
echo "  mcode-eap                 # 进入默认 session"
echo "  mcode-eap --continue      # 继续最近一次会话"
echo "  mcode-eap --list          # 列出本机 session"
echo "  mcode-eap <session-id>    # 进入指定 session"
echo
echo "（root 直接执行即可，不需要切用户）"
