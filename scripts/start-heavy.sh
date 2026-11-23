#!/usr/bin/env bash
# 重型组件栈启动脚本 —— 拉起方案原版重型组件（见 3.1 组件总览）
#
# 与平台本地已跑通的服务完全隔离：
#   - 容器名前缀 eapheavy-（对比 eap-）
#   - 宿主端口整体右移（对比 5173/8080/8090-8093）
#   - 数据卷前缀 eapheavy_
#
# 用法：
#   ./scripts/start-heavy.sh start   [服务...]
#   ./scripts/start-heavy.sh start --force-recreate [服务...]
#   ./scripts/start-heavy.sh stop
#   ./scripts/start-heavy.sh status
#
# --force-recreate：强制重建容器。默认的 `compose up -d` 只在**配置或 env 变化**时
#   才重建；有些操作必须重建才能生效，例如「删掉 realm 后重新触发 --import-realm」
#   —— 此时 env 没变，不加这个开关容器不会重建，realm 就再也回不来了。
#
# 默认服务集：keycloak langfuse-web langfuse-worker clickhouse infinity tei
#                        mysql infinity-ragflow ragflow db-gpt
# 说明：RAGFlow / DB-GPT 镜像已在本机落盘，故纳入默认集；
#       RAGFlow 依赖专用的 Infinity 0.6.x 实例（infinity-ragflow）。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_DIR="$ROOT/deploy/compose"
PROJECT="eapheavy"

DEFAULT_SERVICES="keycloak langfuse-web langfuse-worker clickhouse infinity tei mysql infinity-ragflow ragflow db-gpt"

# docker 调用前缀：当前用户已加入 docker 组时直接调用，否则回退 sudo
if docker version >/dev/null 2>&1; then
  DOCKER=(docker)
else
  DOCKER=(sudo docker)
fi

compose() {
  ( cd "$COMPOSE_DIR" && VOLUME_PREFIX=eapheavy NETWORK_PREFIX=eapheavy "${DOCKER[@]}" compose -p "$PROJECT" \
      -f docker-compose.yml -f docker-compose.heavy.yml "$@" )
}

ensure_keycloak_admin() {
  local output="" attempt
  # 重试预算要覆盖 Keycloak 的**冷启动**：全新部署（空数据卷）实测要 70 秒以上
  # 才能取到管理令牌，再叠加 --import-realm 的 realm 导入（实测约 11 秒），
  # 机器负载高时还会更慢。24 次 × 5 秒 = 120 秒的预算余量太薄，
  # 超了就会让整个 start 失败。放到 300 秒，作为容器运行等待结束后的独立初始化预算。
  for attempt in $(seq 1 60); do
    if output="$(python3 "$ROOT/scripts/keycloak-admin.py" ensure-admin 2>&1)"; then
      printf '%s\n' "$output"
      return 0
    fi
    sleep 5
  done
  printf '%s\n' "$output" >&2
  echo "错误：Keycloak 永久管理员初始化失败（已重试 60 次 / 300 秒）。" >&2
  return 1
}

# ─────────────────────────────────────────────────────────────────────────────
# realm 占位符校验
#
# deploy/compose/keycloak/realm-eap.json 里的 ${...} 分两类：
#   · Keycloak 内置 client scope 的**消息占位符**（${profileScopeConsentText} 等）
#     —— 由 Keycloak 自己的消息包在运行时解析，不是环境变量，导入时保持原样即可；
#   · **环境变量占位符**（${EAP_PUBLIC_*}、${RAGFLOW_OAUTH_CLIENT_SECRET} 等）
#     —— 由 Keycloak 在导入时用**容器环境变量**替换。
# 关键坑：变量缺失时 Keycloak 会把占位符**原样**写进配置且不告警 ——
#   redirect URI 变成 "${EAP_PUBLIC_WEB_ORIGIN}/..." → 登录后跳到无效地址；
#   客户端密钥变成字面量 "${RAGFLOW_OAUTH_CLIENT_SECRET}" → SSO 静默失效。
# 故启动 Keycloak 前强制校验：
#   ① 变量必须能取到值；
#   ② 变量必须真的传进了 keycloak 容器（容器环境变量才是导入时的替换源）。
# ─────────────────────────────────────────────────────────────────────────────

# Keycloak 消息包占位符白名单（这些不是环境变量，不参与校验）
KEYCLOAK_MESSAGE_PLACEHOLDERS=" \
  emailScopeConsentText \
  offlineAccessScopeConsentText \
  phoneScopeConsentText \
  samlRoleListScopeConsentText \
  profileScopeConsentText \
  addressScopeConsentText \
  rolesScopeConsentText \
  organizationScopeConsentText \
  client_id"

# 从 .env 取值（支持行尾注释与引号）
env_value() {
  local key="$1" line value
  [ -f "$COMPOSE_DIR/.env" ] || return 0
  line="$(grep -E "^${key}=" "$COMPOSE_DIR/.env" 2>/dev/null | tail -1)"
  [ -n "$line" ] || return 0
  value="${line#*=}"
  # 去掉首尾空白
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  case "$value" in
    \"*)
      # 双引号包裹：取引号内的内容，引号外的行尾注释自然被截断
      value="${value#\"}"; value="${value%%\"*}"
      ;;
    \'*)
      value="${value#\'}"; value="${value%%\'*}"
      ;;
    *)
      # 未加引号：第一个 # 起是行尾注释
      value="${value%%#*}"
      value="${value%"${value##*[![:space:]]}"}"
      ;;
  esac
  printf '%s' "$value"
}

check_realm_placeholders() {
  local realm_file="$COMPOSE_DIR/keycloak/realm-eap.json"
  [ -f "$realm_file" ] || return 0

  # 渲染后的 compose 才能反映最终真正进容器的环境变量
  local rendered="" kc_block=""
  rendered="$(compose config 2>/dev/null || true)"
  if [ -n "$rendered" ]; then
    kc_block="$(printf '%s\n' "$rendered" | awk '
      /^  keycloak:/{inside=1}
      inside && /^  [A-Za-z0-9_-]+:/ && !/^  keycloak:/{inside=0}
      inside')"
  fi

  local rc=0
  local var value hint
  local vars
  vars="$(grep -o '\${[A-Za-z_][A-Za-z0-9_]*}' "$realm_file" | tr -d '${}' | sort -u)"
  for var in $vars; do
    # Keycloak 消息包占位符：跳过
    case " $KEYCLOAK_MESSAGE_PLACEHOLDERS " in
      *" $var "*) continue ;;
    esac

    value="$(env_value "$var")"
    # 进程环境变量优先于 .env 文件
    if [ -n "${!var:-}" ]; then
      value="${!var}"
    fi

    if [ -z "$value" ]; then
      case "$var" in
        EAP_PUBLIC_WEB_ORIGIN)     hint="http://<对外地址>:5173（Web 控制台）" ;;
        EAP_PUBLIC_RAGFLOW_ORIGIN) hint="http://<对外地址>:8095（RAGFlow 界面，SSO 回调地址）" ;;
        RAGFLOW_OAUTH_CLIENT_SECRET) hint="<与 RAGFlow 侧一致的客户端密钥>" ;;
        *)                         hint="http://<对外地址>:<端口>" ;;
      esac
      echo "错误：realm-eap.json 使用了 \${${var}} 占位，但该变量未设置。" >&2
      echo "      Keycloak 在变量缺失时会把占位符原样写进配置且不告警，" >&2
      echo "      结果是登录跳转到无效地址，或客户端密钥失效。" >&2
      echo "      请在 deploy/compose/.env 中设置后重试，例如：" >&2
      echo "        ${var}=${hint}" >&2
      rc=1
      continue
    fi

    # 该变量必须真的传进 keycloak 容器 —— 导入时的替换源是容器环境变量，
    # 不是宿主 .env 文件本身
    if [ -n "$kc_block" ] && ! printf '%s\n' "$kc_block" | grep -qE "^[[:space:]]+${var}:"; then
      echo "错误：\${${var}} 有值，但没传进 keycloak 容器。" >&2
      echo "      Keycloak 导入时用的是**容器**的环境变量，宿主 .env 里设了也没用。" >&2
      echo "      请在 deploy/compose/docker-compose.yml 的 keycloak.environment 里加上：" >&2
      echo "        ${var}: \${${var}:-<默认值>}" >&2
      rc=1
      continue
    fi

    # 密钥类变量不在日志里回显
    case "$var" in
      *SECRET*|*PASSWORD*) echo "  realm 占位符已解析：${var}=<已设置，值不回显>" ;;
      *)                   echo "  realm 占位符已解析：${var}=${value}" ;;
    esac
  done
  return $rc
}

case "${1:-start}" in
  start)
    shift || true
    # 解析 --force-recreate（可放在服务名之前或之后）
    FORCE_RECREATE=0
    ARGS=()
    for a in "$@"; do
      case "$a" in
        --force-recreate) FORCE_RECREATE=1 ;;
        *) ARGS+=("$a") ;;
      esac
    done
    SERVICES="${ARGS[*]:-$DEFAULT_SERVICES}"
    echo "启动重型组件栈：$SERVICES"
    case " $SERVICES " in
      *" keycloak "*)
        check_realm_placeholders || exit 1
        ;;
    esac
    if [ "$FORCE_RECREATE" = "1" ]; then
      echo "（--force-recreate：强制重建容器）"
      compose up -d --force-recreate $SERVICES
    else
      compose up -d $SERVICES
    fi
    echo
    echo "等待容器运行（最多 8 分钟；Keycloak 管理员初始化另计最多 5 分钟）…"
    for i in $(seq 1 96); do
      READY=0
      for s in $SERVICES; do
        st=$("${DOCKER[@]}" inspect -f '{{.State.Status}}' "${PROJECT}-${s}" 2>/dev/null || echo absent)
        [ "$st" = "running" ] && READY=$((READY+1))
      done
      printf '\r  运行中 %d/%d  ' "$READY" "$(echo $SERVICES | wc -w)"
      [ "$READY" -eq "$(echo $SERVICES | wc -w)" ] && break
      sleep 5
    done
    echo
    case " $SERVICES " in
      *" keycloak "*)
        ensure_keycloak_admin || exit 1
        ;;
    esac
    compose ps
    ;;
  stop)
    compose stop
    ;;
  down)
    compose down
    ;;
  status)
    compose ps
    ;;
  check)
    # 只做配置校验，不启动/停止任何服务
    check_realm_placeholders
    ;;
  logs)
    shift || true
    compose logs -f --tail 100 "$@"
    ;;
  *)
    echo "用法: $0 {start|stop|down|status|check|logs} [服务...]" >&2
    exit 1
    ;;
esac
