#!/usr/bin/env bash
# =============================================================================
# 出网代理容器入口脚本
#
# 1) 校验 TLS 解密证书是否就绪（缺失直接失败，避免以明文方式偷偷放行）
# 2) 按 EGRESS_ALLOWED_HOSTS 重新渲染 envoy.yaml 的白名单区块
#    （ALLOWED HTTP VHOSTS / ALLOWED SNI CHAINS / EGRESS CLUSTERS）
# 3) 启动 Envoy
# =============================================================================
set -euo pipefail

TEMPLATE="${ENVOY_CONFIG_TEMPLATE:-/etc/envoy/envoy.yaml}"
RENDERED="${ENVOY_CONFIG_RENDERED:-/etc/envoy/envoy.rendered.yaml}"
RENDERER="${ENVOY_RENDERER:-/etc/envoy/render-allowlist.awk}"
ALLOW="${EGRESS_ALLOWED_HOSTS:-api.openai.com,dashscope.aliyuncs.com,api.deepseek.com,open.bigmodel.cn,agent.minimaxi.com}"
CERT_DIR="${ENVOY_CERT_DIR:-/etc/envoy/certs}"

# —— 1) 证书检查（fail closed）
if [ ! -s "$CERT_DIR/server.crt" ] || [ ! -s "$CERT_DIR/server.key" ]; then
  echo "[egress] 错误：缺少 TLS 解密证书 $CERT_DIR/server.crt|server.key" >&2
  echo "[egress] 请先执行 deploy/compose/envoy/generate-certs.sh 生成证书" >&2
  exit 1
fi

# —— 2) 渲染白名单
if [ ! -f "$RENDERER" ]; then
  echo "[egress] 错误：缺少白名单渲染脚本 $RENDERER" >&2
  exit 1
fi

awk -v hosts="$ALLOW" -f "$RENDERER" "$TEMPLATE" > "$RENDERED"

echo "[egress] SNI 白名单：$ALLOW"
echo "[egress] 渲染完成：$RENDERED"

# —— 3) 启动 Envoy
exec envoy -c "$RENDERED" --log-level "${ENVOY_LOG_LEVEL:-info}"
