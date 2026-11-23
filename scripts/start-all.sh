#!/usr/bin/env bash
# 本地一键启动：MCP Hub + agentgateway + agent-core
# 生产形态见 deploy/compose/docker-compose.yml（见 9.2 部署形态）
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

mkdir -p data/logs data/objects data/traces

start() {
  local name="$1"; shift
  echo "启动 $name ..."
  # setsid 建立独立进程组，便于整组回收，避免 npx 派生的 node 进程成为孤儿
  ( setsid "$@" > "data/logs/${name}.log" 2>&1 & echo $! > "data/logs/${name}.pid" )
}

stop_all() {
  for f in data/logs/*.pid; do
    [ -f "$f" ] || continue
    local pid; pid=$(cat "$f")
    if kill -0 "$pid" 2>/dev/null; then
      kill -- -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
      echo "已停止 $(basename "$f" .pid) (pid=$pid)"
    fi
    rm -f "$f"
  done
  # 兜底：清理遗留的 tsx/node 进程
  # 注意：模式必须足够精确 —— 过宽的 pkill -f 会匹配到调用方自身的 shell。
  # 回环桥由上面的 pid 文件机制回收，无需额外的 pkill。
  pkill -f "tsx packages/" 2>/dev/null || true
  sleep 1
}

case "${1:-start}" in
  stop)
    stop_all
    ;;
  start)
    stop_all
    sleep 1
    start mcp-hub   npx tsx packages/mcp-hub/src/main.ts
    sleep 2
    start gateway   npx tsx packages/gateway/src/main.ts
    start agent-core npx tsx packages/agent-core/src/main.ts
    # 单一前端 —— 仅在已构建产物存在时启动
    if [ -f dist/webui/index.html ]; then
      start webui npx vite preview --config apps/webui/vite.config.ts --port "${WEBUI_PORT:-5173}" --host "${WEBUI_HOST:-127.0.0.1}"
    fi
    # 回环桥 —— 让容器（DB-GPT）能回调已收口到 127.0.0.1 的宿主服务，
    # 同时保持对外不可达（172.17.0.1 是本地 docker 网桥地址）。
    if [ "${LOOPBACK_BRIDGE_ENABLED:-true}" = "true" ]; then
      start loopback-bridge npx tsx scripts/loopback-bridge.ts
    fi
    sleep 4
    echo
    echo "──────────────────────────────────────────────"
    echo " agentgateway  http://127.0.0.1:${GATEWAY_PORT:-8080}"
    echo " agent-core    http://127.0.0.1:${AGENT_PORT:-8090}"
    echo " Web 控制台    http://127.0.0.1:${WEBUI_PORT:-5173}"
    echo " MCP knowledge http://127.0.0.1:8091/mcp"
    echo " MCP chatbi    http://127.0.0.1:8092/mcp"
    echo " MCP business  http://127.0.0.1:8093/mcp"
    echo " 日志: data/logs/*.log"
    echo "──────────────────────────────────────────────"
    ;;
  *)
    echo "用法: $0 [start|stop]" >&2
    exit 1
    ;;
esac
