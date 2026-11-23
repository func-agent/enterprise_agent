#!/usr/bin/env bash
# =============================================================================
# 生成出网代理 TLS 解密证书（开发/测试用占位证书）
#
# 出网代理要做 TLS 解密审计（见 8.3 出网安全），必须持有一张由企业 CA 签发、
# 覆盖全部白名单域名的服务端证书。本脚本生成：
#   certs/ca.crt     企业 CA 证书（需下发到客户端信任库）
#   certs/ca.key     CA 私钥（生产必须由企业 CA 体系签发，不要落在此处）
#   certs/server.crt 服务端证书（SAN = 全部白名单域名）
#   certs/server.key 服务端私钥
#
# 生产环境：把企业 CA 签发的证书放入 certs/ 覆盖本脚本的产物即可。
# 用法：EGRESS_ALLOWED_HOSTS="a.com,b.com" ./generate-certs.sh
# =============================================================================
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)/certs"
HOSTS="${EGRESS_ALLOWED_HOSTS:-api.openai.com,dashscope.aliyuncs.com,api.deepseek.com,open.bigmodel.cn,agent.minimaxi.com}"
DAYS="${CERT_DAYS:-825}"

command -v openssl >/dev/null 2>&1 || {
  echo "需要 openssl，请先安装" >&2
  exit 1
}

mkdir -p "$DIR"

echo "==> 生成企业 CA"
openssl req -x509 -newkey rsa:4096 -nodes \
  -keyout "$DIR/ca.key" -out "$DIR/ca.crt" -days "$DAYS" \
  -subj "/C=CN/O=EAP Platform/OU=Egress/CN=EAP Egress Proxy CA" 2>/dev/null

SAN="DNS:localhost,IP:127.0.0.1"
IFS=',' read -ra host_list <<< "$HOSTS"
for h in "${host_list[@]}"; do
  h="$(echo "$h" | tr -d '[:space:]')"
  [ -n "$h" ] && SAN="$SAN,DNS:$h"
done

echo "==> 生成服务端证书（SAN: $SAN）"
openssl req -newkey rsa:2048 -nodes \
  -keyout "$DIR/server.key" -out "$DIR/server.csr" \
  -subj "/C=CN/O=EAP Platform/OU=Egress/CN=egress-proxy.local" 2>/dev/null

cat > "$DIR/server.ext" <<EOF
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=$SAN
EOF

openssl x509 -req -in "$DIR/server.csr" \
  -CA "$DIR/ca.crt" -CAkey "$DIR/ca.key" -CAcreateserial \
  -out "$DIR/server.crt" -days "$DAYS" -extfile "$DIR/server.ext" 2>/dev/null

rm -f "$DIR/server.csr" "$DIR/server.ext" "$DIR/ca.srl"
chmod 600 "$DIR/ca.key" "$DIR/server.key"
chmod 644 "$DIR/ca.crt" "$DIR/server.crt"

# envoy 官方镜像以 uid 101 (envoy) 运行，需要能读取私钥
if [ "$(id -u)" = "0" ]; then
  chown 101:101 "$DIR/server.key" "$DIR/ca.key" 2>/dev/null || true
else
  echo "    提示：当前用户无法 chown 到 101:101，已将私钥改为 644 以保证容器可读"
  chmod 644 "$DIR/server.key" "$DIR/ca.key"
fi

echo "==> 完成：$DIR"
echo "    注意：ca.crt 需下发到客户端信任库，客户端才会信任出网代理的解密证书。"
