#!/usr/bin/env bash
# =============================================================================
# Envoy 出网代理健康探针
#
# 为什么不用 curl/wget：envoyproxy/envoy 官方镜像刻意做小，只含 envoy 本体与
# bash，**不含 curl 也不含 wget**（已实测：command -v curl / wget 均无输出）。
# 而 bash 的 /dev/tcp 可以直接发原始 HTTP 请求，无需任何外部工具。
#
# 注意：必须显式用 bash 执行 —— /bin/sh 在 Ubuntu 上是 dash，不支持 /dev/tcp。
# =============================================================================
set -euo pipefail

PORT="${ENVOY_ADMIN_PORT:-9901}"

exec 3<>"/dev/tcp/127.0.0.1/${PORT}"
printf 'GET /ready HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n' >&3
if grep -q '200 OK' <&3; then
  exit 0
fi
exit 1
