#!/usr/bin/env bash
# =============================================================================
# 为 Harbor 配置本机别名
#
# 为什么需要：
#   Harbor 的 prepare 会硬性拒绝把 '127.0.0.1' 当 hostname
#   （源码 utils/configs.py：if conf.get('hostname') == '127.0.0.1': raise）。
#   而本项目的 Harbor 只绑回环、按方案要求不对外暴露（见 docs/network-access.md），
#   所以需要一个「指向 127.0.0.1、但不是字面量 127.0.0.1」的名字。
#
# 为什么别名指向 127.0.0.1 就能走 HTTP 推送：
#   Docker daemon 的默认 insecure registries 含 127.0.0.0/8 与 ::1/128（docker info 实测），
#   daemon 解析域名后按**解析到的 IP** 判定是否 insecure —— 别名解析到 127.0.0.1
#   即落在默认 insecure 段，因此 HTTP 推送无需改 daemon 配置、无需重启 dockerd。
#
# 用法：
#   ./scripts/setup-harbor-hosts.sh            # 添加
#   ./scripts/setup-harbor-hosts.sh --remove   # 移除
#   ./scripts/setup-harbor-hosts.sh --status
# =============================================================================
set -uo pipefail

HOSTNAME_ALIAS="${HARBOR_HOSTNAME_ALIAS:-harbor.eap.local}"
HOSTS_FILE="/etc/hosts"

do_status() {
  if grep -qE "^[^#]*\b${HOSTNAME_ALIAS}\b" "$HOSTS_FILE"; then
    echo "✅ $HOSTNAME_ALIAS 已在 $HOSTS_FILE："
    grep -E "^[^#]*\b${HOSTNAME_ALIAS}\b" "$HOSTS_FILE"
  else
    echo "⚠️  $HOSTNAME_ALIAS 不在 $HOSTS_FILE"
    return 1
  fi
}

do_add() {
  if grep -qE "^[^#]*\b${HOSTNAME_ALIAS}\b" "$HOSTS_FILE"; then
    echo "✅ 已存在，无需修改"
    do_status
    return 0
  fi
  if [ "$(id -u)" -eq 0 ]; then
    printf '\n# Harbor 本机别名（只绑回环，不对外暴露）\n127.0.0.1 %s\n' "$HOSTNAME_ALIAS" >> "$HOSTS_FILE"
  else
    printf '\n# Harbor 本机别名（只绑回环，不对外暴露）\n127.0.0.1 %s\n' "$HOSTNAME_ALIAS" \
      | sudo tee -a "$HOSTS_FILE" >/dev/null
  fi
  echo "✅ 已写入 $HOSTS_FILE"
  do_status
}

do_remove() {
  if ! grep -qE "^[^#]*\b${HOSTNAME_ALIAS}\b" "$HOSTS_FILE"; then
    echo "✅ 本就不存在"
    return 0
  fi
  local tmp
  tmp=$(mktemp)
  grep -vE "^[^#]*\b${HOSTNAME_ALIAS}\b" "$HOSTS_FILE" | grep -v "^# Harbor 本机别名" > "$tmp"
  if [ "$(id -u)" -eq 0 ]; then
    cat "$tmp" > "$HOSTS_FILE"
  else
    sudo cp "$tmp" "$HOSTS_FILE"
  fi
  rm -f "$tmp"
  echo "✅ 已移除 $HOSTNAME_ALIAS"
}

case "${1:-add}" in
  add)     do_add ;;
  remove)  do_remove ;;
  status)  do_status ;;
  *) echo "用法：$0 [add|remove|status]" >&2; exit 1 ;;
esac
