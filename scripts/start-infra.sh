#!/usr/bin/env bash
# 启动支撑层容器（PostgreSQL 16 / Redis 7 / MinIO）—— 对应 3.1 存储组件与 9.2 部署形态。
# 生产与完整 POC 请使用 deploy/compose/docker-compose.yml。
#
# 端口一律绑 127.0.0.1：数据层不对局域网/公网暴露（详见 docs/network-access.md）。
set -euo pipefail

cd "$(dirname "$0")/.."

PG_CONTAINER=eap-postgres
REDIS_CONTAINER=eap-redis
MINIO_CONTAINER=eap-minio
PG_PASSWORD="${POSTGRES_PASSWORD:-eap-local-password}"
MINIO_ROOT_USER="${MINIO_ROOT_USER:-eapadmin}"
MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:-eap-local-password}"

need_sudo() {
  if ! docker info >/dev/null 2>&1; then
    echo "需要 root 执行 docker，请用 sudo 运行本脚本"
    exit 1
  fi
}

start_postgres() {
  if docker ps -a --format '{{.Names}}' | grep -qx "$PG_CONTAINER"; then
    docker start "$PG_CONTAINER" >/dev/null
  else
    docker run -d --name "$PG_CONTAINER" --restart unless-stopped \
      -e POSTGRES_USER=eap -e POSTGRES_PASSWORD="$PG_PASSWORD" -e POSTGRES_DB=eap \
      -p 127.0.0.1:5432:5432 -v eap-pg-data:/var/lib/postgresql/data \
      --health-cmd='pg_isready -U eap -d eap' --health-interval=10s --health-retries=10 \
      postgres:16-alpine >/dev/null
  fi
  echo "PostgreSQL 16 已启动（端口 5432，库 eap，用户 eap）"
}

start_redis() {
  if docker ps -a --format '{{.Names}}' | grep -qx "$REDIS_CONTAINER"; then
    docker start "$REDIS_CONTAINER" >/dev/null
  else
    docker run -d --name "$REDIS_CONTAINER" --restart unless-stopped \
      -p 127.0.0.1:6379:6379 -v eap-redis-data:/data \
      --health-cmd='redis-cli ping' --health-interval=10s --health-retries=5 \
      redis:7-alpine >/dev/null
  fi
  echo "Redis 7 已启动（端口 6379）"
}

start_minio() {
  if docker ps -a --format '{{.Names}}' | grep -qx "$MINIO_CONTAINER"; then
    docker start "$MINIO_CONTAINER" >/dev/null
  else
    docker run -d --name "$MINIO_CONTAINER" --restart unless-stopped \
      -e MINIO_ROOT_USER="$MINIO_ROOT_USER" -e MINIO_ROOT_PASSWORD="$MINIO_ROOT_PASSWORD" \
      -p 127.0.0.1:9000:9000 -p 127.0.0.1:9001:9001 -v eap-minio-data:/data \
      minio/minio:latest server /data --console-address ":9001" >/dev/null
  fi
  echo "MinIO 已启动（API 9000，控制台 9001）"
}

ENVOY_CONTAINER=eap-envoy

start_envoy() {
  # 出网代理（Envoy）—— 方案 8.3 / 9.3 要求的**唯一出网出口**。
  # 必须用 compose 启动：容器要 bind mount envoy.yaml 模板、白名单渲染脚本
  # （render-allowlist.awk）与 TLS 解密证书目录，裸 docker run 表达不了。
  #
  # 证书目录不入版本控制（含私钥，见 .gitignore），全新克隆后这里是空的。
  # envoy 的 entrypoint 缺证书会 fail closed（直接退出，不会退化成明文放行），
  # 所以这里缺证书就先生成 —— SAN 自动取当前白名单域名。
  local cert_dir="deploy/compose/envoy/certs"
  if [ ! -s "$cert_dir/server.crt" ] || [ ! -s "$cert_dir/server.key" ]; then
    echo "Envoy TLS 解密证书缺失，正在生成…"
    if ! ( cd deploy/compose && ./envoy/generate-certs.sh ) >/dev/null 2>&1; then
      echo "证书生成失败 —— Envoy 启动会 fail closed（详见 deploy/compose/envoy/certs/README.md）" >&2
      return 1
    fi
  fi
  if ! ( cd deploy/compose && docker compose --env-file .env -f docker-compose.yml up -d envoy >/dev/null 2>&1 ); then
    echo "Envoy 出网代理启动失败 —— 商业大模型 API 将无法出网（详见 docs/egress-proxy.md）" >&2
    return 1
  fi
  echo "Envoy 出网代理已启动（HTTP 代理 15000 / TLS 解密 15001 / 管理 9901）"
}

case "${1:-start}" in
  stop)
    for c in "$PG_CONTAINER" "$REDIS_CONTAINER" "$MINIO_CONTAINER" "$ENVOY_CONTAINER"; do
      docker stop "$c" >/dev/null 2>&1 || true
    done
    echo "支撑层已停止"
    ;;
  status)
    docker ps --filter "name=eap-" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
    ;;
  *)
    need_sudo
    start_postgres
    start_redis
    start_minio
    start_envoy
    echo
    echo "──────────────────────────────────────────────"
    echo " PostgreSQL  postgres://eap:${PG_PASSWORD}@127.0.0.1:5432/eap"
    echo " Redis       redis://127.0.0.1:6379"
    echo " MinIO       http://127.0.0.1:9001  (${MINIO_ROOT_USER} / ${MINIO_ROOT_PASSWORD})"
    echo " Envoy       http://127.0.0.1:15000  (出网唯一出口 / SNI 白名单)"
    echo "──────────────────────────────────────────────"
    echo " 切换到 PG：export STORE_KIND=postgres"
    echo "           export POSTGRES_URL=postgres://eap:${PG_PASSWORD}@127.0.0.1:5432/eap"
    ;;
esac
