#!/usr/bin/env bash
# 生成内部参数表（真实公网地址、办公出口与内网拓扑），不生成防火墙规则。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/docs/internal"
OUT="$OUT_DIR/host-params.local.md"

usage() {
  cat <<'EOF'
用法：
  ./scripts/gen-host-params.sh [公网IPv4] [办公出口CIDR]
  EAP_PUBLIC_IP=203.0.113.10 EAP_OFFICE_CIDR=198.51.100.20/32 ./scripts/gen-host-params.sh

说明：
  公网 IP 优先取命令行参数，其次 EAP_PUBLIC_IP，最后尝试外网探测。
  办公出口省略时不写入实际值；执行端口转发前必须补充。
  示例中的地址属于文档保留网段，实际使用时必须替换。
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi
if [ "$#" -gt 2 ]; then
  usage >&2
  exit 2
fi
command -v python3 >/dev/null 2>&1 || { echo "错误：需要 python3 校验地址" >&2; exit 1; }

normalise_ipv4() {
  python3 - "$1" <<'PY'
import ipaddress
import sys
try:
    value = ipaddress.ip_address(sys.argv[1])
except ValueError:
    raise SystemExit(1)
if value.version != 4 or value.is_unspecified or value.is_multicast:
    raise SystemExit(1)
print(value)
PY
}

normalise_office_cidr() {
  python3 - "$1" <<'PY'
import ipaddress
import sys
try:
    value = ipaddress.ip_network(sys.argv[1], strict=True)
except ValueError:
    raise SystemExit(1)
if value.version != 4 or value.prefixlen == 0 or value.network_address.is_unspecified or value.network_address.is_multicast:
    raise SystemExit(1)
print(value)
PY
}

PUB_IP="${1:-${EAP_PUBLIC_IP:-}}"
OFFICE_CIDR="${2:-${EAP_OFFICE_CIDR:-}}"
if [ -z "$PUB_IP" ]; then
  PUB_IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
fi
PUB_IP="$(printf '%s' "$PUB_IP" | tr -d '[:space:]')"
OFFICE_CIDR="$(printf '%s' "$OFFICE_CIDR" | tr -d '[:space:]')"

if [ -z "$PUB_IP" ]; then
  echo "错误：未探测到公网 IP，请通过第一个参数或 EAP_PUBLIC_IP 显式提供" >&2
  usage >&2
  exit 1
fi
if ! PUB_IP="$(normalise_ipv4 "$PUB_IP")"; then
  echo "错误：公网 IP 必须是有效的 IPv4 地址" >&2
  exit 1
fi
if [ -n "$OFFICE_CIDR" ]; then
  case "$OFFICE_CIDR" in
    */*) ;;
    *) OFFICE_CIDR="$OFFICE_CIDR/32" ;;
  esac
  if ! OFFICE_CIDR="$(normalise_office_cidr "$OFFICE_CIDR")"; then
    echo "错误：办公出口必须是有效的 IPv4 CIDR；单个地址可不带 /32" >&2
    exit 1
  fi
fi

VM_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") {print $(i+1); exit}}' || true)"
if [ -z "$VM_IP" ]; then
  VM_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
fi
HOST_LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="via") {print $(i+1); exit}}' || true)"
if [ -z "$HOST_LAN_IP" ]; then
  HOST_LAN_IP="$(ip -4 route show default 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="via") {print $(i+1); exit}}' || true)"
fi

if [ -z "$VM_IP" ]; then
  echo "错误：探测不到虚拟机内网 IP" >&2
  exit 1
fi
if ! VM_IP="$(normalise_ipv4 "$VM_IP")"; then
  echo "错误：探测到的虚拟机内网 IP 不是有效 IPv4：$VM_IP" >&2
  exit 1
fi
if [ -n "$HOST_LAN_IP" ] && ! HOST_LAN_IP="$(normalise_ipv4 "$HOST_LAN_IP")"; then
  echo "错误：探测到的宿主内网 IP 不是有效 IPv4：$HOST_LAN_IP" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"

cat > "$OUT" <<EOF
# 内部参数表（**不在公开仓库内**）

> 本文件由 \`scripts/gen-host-params.sh\` 生成，含本部署环境的真实地址。
> 公开文档中的示例地址必须替换为本表实际值。
>
> 生成时间：$(date '+%Y-%m-%d %H:%M:%S')

## 地址参数

| 名称 | 值 | 说明 |
|---|---|---|
| \`PUB_IP\` | \`$PUB_IP\` | 宿主机持有的公网 IPv4（对外入口） |
| \`OFFICE_CIDR\` | \`${OFFICE_CIDR:-<未提供，转发前必须补充>}\` | 办公出口白名单；单个地址使用 /32 |
| \`VM_IP\` | \`$VM_IP\` | 虚拟机内网 IP |
| \`HOST_LAN_IP\` | \`${HOST_LAN_IP:-<未探测到>}\` | 宿主机内网 IP（VM 的默认网关） |
| 控制台端口 | 5173 | Web 控制台（唯一用户入口） |
| Keycloak 端口 | 8082 | OIDC 跳转与换令牌 |
| 网关端口 | 8080 | 网关 API（可选转发） |
| RAGFlow 端口 | 8095 | RAGFlow Web 界面（可选转发） |

## 对外入口

| 地址 | 服务 | 是否必须转发 |
|---|---|---|
| \`http://$PUB_IP:5173\` | Web 控制台 | 必须 |
| \`http://$PUB_IP:8082\` | Keycloak | 必须 |
| \`http://$PUB_IP:8080\` | 网关 API | 可选 |
| \`http://$PUB_IP:8095\` | RAGFlow Web | 可选 |

## 使用约束

1. 转发规则统一按 [宿主交接清单](../host-handoff.md) 配置，本文件不复制防火墙命令。
2. DNAT、FORWARD 和云安全组必须使用同一个 \`OFFICE_CIDR\`，不能放行为 \`0.0.0.0/0\`。
3. 白名单内办公机器验证业务入口可达；公共扫描节点应全部不可达。
4. 地址或拓扑变化后重新生成本表，并重新执行正、负向网络验收。

## 相关文档

- [宿主交接清单](../host-handoff.md)
- [网络暴露与端口收口](../network-access.md)
- [平台访问方式](../access.md)
EOF

chmod 600 "$OUT"
echo "✓ 已生成 $OUT"
echo "  公网 IP：$PUB_IP"
echo "  办公出口：${OFFICE_CIDR:-<未提供，转发前必须补充>}"
echo "  VM 内网 IP：$VM_IP"
echo "  宿主内网 IP：${HOST_LAN_IP:-<未探测到>}"
echo ""
echo "提示：该文件不在公开仓库内（docs/internal/ 已 gitignore）。"
