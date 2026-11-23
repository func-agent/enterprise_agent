#!/usr/bin/env bash
# 启动 MCode 并关闭「自动跟随尾部（粘底）」。
#
# 为什么需要它：regular 渲染模式下，MCode 用「最近 1 秒内有没有敲键盘」
# 来判定是否跟随底部（而不是看用户实际滚到了哪里），
# 所以「一边打字一边往上翻历史」会被新输出立刻拽回底部。
# 补丁见 scripts/patch-mcode-follow-tail.sh。
#
# 用法：
#   mcode-nofollow                       # 新会话
#   mcode-nofollow --session <id>        # 继续指定会话
#   mcode-nofollow --continue            # 继续最近的会话
#
# 说明：
#   - 本脚本不覆盖 `mcode`，两个命令并存，随时可以切回官方行为。
#   - 关闭后：往上翻历史不会被新输出拽回；代价是停在底部等回复时
#     也不再自动滚动，需要自己按 End（或滚到底部）才看到最新内容。
#   - 若补丁尚未应用，本脚本会提示并退回官方行为。
set -euo pipefail

export MCODE_NO_FOLLOW_TAIL=1

MCODE_BIN="$(command -v mcode || true)"
if [ -z "$MCODE_BIN" ]; then
  echo "未找到 mcode 命令" >&2
  exit 1
fi

# 自检：补丁在不在
if ! grep -qF 'MCODE_NO_FOLLOW_TAIL' "$(dirname "$(readlink -f "$MCODE_BIN")")/chunks"/*.js 2>/dev/null; then
  echo "⚠ 未检测到 follow-tail 补丁，MCODE_NO_FOLLOW_TAIL 不生效。" >&2
  echo "  请先执行：/opt/agent/scripts/patch-mcode-follow-tail.sh" >&2
  exit 1
fi

exec "$MCODE_BIN" "$@"
