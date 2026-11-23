#!/usr/bin/env bash
# =============================================================================
# Harbor 2.x 启动脚本 —— 方案 3.1「镜像 / Harbor 2.x / P1 / 离线镜像仓（内网环境必需）」
#
# 为什么用离线安装包而不是 docker pull：
#   本网络直连 registry-1.docker.io 不可达，且 daemon 配的三个镜像加速站
#   全部拒绝 goharbor 命名空间（实测 403 / not found）。
#   而官方离线安装包内含全部镜像 tar，docker load 之后完全离线运行 ——
#   这恰好就是方案里「内网环境必需」的离线镜像仓形态本身。
#
# 部署约定（与本项目重型栈一致）：
#   容器名 eapheavy-harbor-* / 网络 eapheavy_harbor / 端口 8098 / 只绑 127.0.0.1
#
# 为什么 hostname 是 harbor.eap.local 而不是 127.0.0.1：
#   Harbor 的 prepare 硬性拒绝字面量 '127.0.0.1'
#   （源码 utils/configs.py: if conf.get('hostname') == '127.0.0.1': raise）。
#   用一个指向 127.0.0.1 的别名即可绕过；且 Docker 默认 insecure registries
#   含 127.0.0.0/8，HTTP 推送无需改 daemon 配置、无需重启 dockerd。
#
# 用法：
#   ./scripts/start-harbor.sh start|stop|status|prepare
# 环境变量：
#   HARBOR_INSTALLER_TARBALL  离线包路径（默认 /tmp/harbor-offline-installer.tgz）
#   HARBOR_WORKDIR             工作目录（默认 <repo>/data/harbor）
#   HARBOR_HOST_PORT           宿主端口（默认 8098）
#   HARBOR_HOSTNAME            Harbor hostname（默认 harbor.eap.local）
#   HARBOR_VERSION             离线包版本（默认 v2.15.5）
# =============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARBALL="${HARBOR_INSTALLER_TARBALL:-/tmp/harbor-offline-installer.tgz}"
WORKDIR="${HARBOR_WORKDIR:-$ROOT/data/harbor}"
INSTALL_DIR="$WORKDIR/harbor"
HOST_PORT="${HARBOR_HOST_PORT:-8098}"
HOSTNAME_ALIAS="${HARBOR_HOSTNAME:-harbor.eap.local}"
VERSION="${HARBOR_VERSION:-v2.15.5}"
PROJECT="eapheavy-harbor"

if docker version >/dev/null 2>&1; then DOCKER=(docker); else DOCKER=(sudo docker); fi

log() { printf '\033[36m[harbor]\033[0m %s\n' "$*"; }
err() { printf '\033[31m[harbor]\033[0m %s\n' "$*" >&2; }

compose() {
  ( cd "$INSTALL_DIR" && "${DOCKER[@]}" compose -p "$PROJECT" -f docker-compose.eap.yml "$@" )
}

# ---------------------------------------------------------------- 准备阶段
prepare() {
  # 1) hostname 别名
  if ! getent hosts "$HOSTNAME_ALIAS" >/dev/null 2>&1; then
    log "写入本机别名 $HOSTNAME_ALIAS → 127.0.0.1"
    "$ROOT/scripts/setup-harbor-hosts.sh" add || {
      err "别名写入失败（需要 sudo）"; return 1; }
  else
    log "别名已就绪：$HOSTNAME_ALIAS → $(getent hosts "$HOSTNAME_ALIAS" | head -1 | awk '{print $1}')"
  fi

  # 2) 离线包
  if [ ! -f "$TARBALL" ]; then
    err "找不到离线安装包：$TARBALL"
    err "先执行：python3 $ROOT/scripts/download_harbor.py $TARBALL $VERSION"
    return 1
  fi
  if [ ! -f "$INSTALL_DIR/install.sh" ]; then
    log "解压离线安装包 → $INSTALL_DIR"
    mkdir -p "$WORKDIR"
    tar -xzf "$TARBALL" -C "$WORKDIR" || { err "解压失败"; return 1; }
  fi

  # 3) 镜像（离线包的核心价值：一次 load 全部到位）
  if ! "${DOCKER[@]}" images --format '{{.Repository}}' | grep -qx "goharbor/harbor-core"; then
    log "加载镜像（docker load，约 3–5 分钟）"
    "${DOCKER[@]}" load -i "$INSTALL_DIR"/harbor*.tar.gz >/dev/null 2>&1 \
      || { err "镜像加载失败"; return 1; }
  else
    log "镜像已就绪，跳过 load"
  fi

  # 4) 配置
  log "生成 harbor.yml（hostname=$HOSTNAME_ALIAS, http.port=$HOST_PORT）"
  python3 "$ROOT/scripts/render_harbor_yml.py" \
    "$INSTALL_DIR/harbor.yml.tmpl" "$INSTALL_DIR/harbor.yml" \
    --hostname "$HOSTNAME_ALIAS" --http-port "$HOST_PORT" \
    --data-volume "$WORKDIR/data" >/dev/null || { err "harbor.yml 生成失败"; return 1; }

  # 5) 官方 prepare（生成 compose + 各组件配置）
  log "运行官方 prepare"
  ( cd "$INSTALL_DIR" && ./prepare ) >"$WORKDIR/prepare.log" 2>&1
  if [ ! -f "$INSTALL_DIR/docker-compose.yml" ]; then
    err "prepare 未产出 docker-compose.yml，日志尾部："
    tail -20 "$WORKDIR/prepare.log" >&2
    return 1
  fi

  # 6) 权限：prepare 以 root 生成、容器以 uid 10000 / 999 运行
  log "修正配置与数据目录权限"
  sudo bash -c "
    set -e
    chmod -R o+rX '$INSTALL_DIR/common'
    mkdir -p '$WORKDIR/data/registry' '$WORKDIR/data/database' '$WORKDIR/data/redis' \
             '$WORKDIR/data/job_logs' '$WORKDIR/data/ca_download' '$WORKDIR/data/secret'
    chown -R 10000:10000 '$WORKDIR/data/registry' '$WORKDIR/data/job_logs' '$WORKDIR/data/ca_download' '$WORKDIR/data/secret'
    chown -R 999:999    '$WORKDIR/data/database' '$WORKDIR/data/redis'
    chmod 755 '$WORKDIR/data'
    mkdir -p /var/log/harbor
    chmod 755 /var/log/harbor
  " || { err "权限修正失败"; return 1; }

  # 7) 编排改造为本项目约定
  log "改造编排为重型栈约定"
  python3 "$ROOT/scripts/prepare_harbor.py" \
    "$INSTALL_DIR/docker-compose.yml" "$INSTALL_DIR/docker-compose.eap.yml" \
    --host-port "$HOST_PORT" >/dev/null || { err "编排改造失败"; return 1; }

  log "准备完成"
}

case "${1:-start}" in
  prepare)
    prepare
    ;;
  start)
    prepare || exit 1
    log "启动 Harbor（127.0.0.1:${HOST_PORT}，仅回环）"
    compose up -d
    echo
    compose ps
    ;;
  stop)
    compose stop
    ;;
  status)
    compose ps
    ;;
  *)
    echo "用法：$0 [start|stop|status|prepare]" >&2
    exit 1
    ;;
esac
