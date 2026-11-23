#!/usr/bin/env bash
# 重型组件栈验收脚本 —— 逐项实测方案原版重型组件是否真的可用
#
# 用法：
#   ./scripts/verify-heavy.sh
#
# 前置：重型栈已启动（见 scripts/start-heavy.sh）
# 退出码：0 = 全部通过，1 = 存在失败项
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ClickHouse 凭据只从 compose env 读取（不整份 source，避免覆盖调用方的运行环境变量）
read_env_val() {
  local key="$1" default="$2" file="$ROOT_DIR/deploy/compose/.env"
  [ -f "$file" ] || { echo "$default"; return; }
  local v
  v=$(grep -E "^${key}=" "$file" | tail -1 | cut -d= -f2-)
  echo "${v:-$default}"
}
CH_USER="$(read_env_val CLICKHOUSE_USER eap)"
CH_PASS="$(read_env_val CLICKHOUSE_PASSWORD '')"
# Langfuse 凭据从调用方环境或 compose env 读取；缺失时明确记为验收失败。
LANGFUSE_PUBLIC_KEY="${LANGFUSE_PUBLIC_KEY:-$(read_env_val LANGFUSE_PUBLIC_KEY '')}"
LANGFUSE_SECRET_KEY="${LANGFUSE_SECRET_KEY:-$(read_env_val LANGFUSE_SECRET_KEY '')}"

HEAVY_PORT="${HEAVY_PORT:-8082}"
KEYCLOAK_BASE="http://127.0.0.1:${HEAVY_PORT}"
REALM="enterprise"
TEI_URL="http://127.0.0.1:6380"
INFINITY_HTTP="http://127.0.0.1:23821"
INFINITY_PSQL_PORT="5434"
LANGFUSE_URL="http://127.0.0.1:3001"
CLICKHOUSE_HTTP="http://127.0.0.1:8124"

# docker 调用前缀：当前用户已加入 docker 组时直接调用，否则回退 sudo
if docker version >/dev/null 2>&1; then
  DOCKER=(docker)
else
  DOCKER=(sudo docker)
fi

PASS=0
FAIL=0

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
head_() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }

check() { # check <描述> <期望状态> <实际状态>
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1（期望 $2，实际 $3）"; fi
}

# ─────────────────────────────────────────────
head_ "容器状态"
for c in eapheavy-keycloak eapheavy-langfuse-web eapheavy-langfuse-worker \
         eapheavy-clickhouse eapheavy-infinity eapheavy-tei \
         eapheavy-postgres eapheavy-redis eapheavy-minio; do
  st=$("${DOCKER[@]}" inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo "absent")
  if [ "$st" = "running" ]; then ok "$c running"; else bad "$c 状态=$st"; fi
done

# ─────────────────────────────────────────────
head_ "Keycloak 26（身份组件）"
KC_READY=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${KEYCLOAK_BASE}/realms/${REALM}/.well-known/openid-configuration" 2>/dev/null)
check "OIDC discovery 可达" "200" "$KC_READY"

KC_TOKEN=$(curl -s --max-time 20 -X POST \
  "${KEYCLOAK_BASE}/realms/${REALM}/protocol/openid-connect/token" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=password' -d 'client_id=eap-webui' \
  -d 'username=eap-admin' -d 'password=EapAdmin@2026' 2>/dev/null)

if echo "$KC_TOKEN" | grep -q '"access_token"'; then
  ok "password grant 签发令牌成功"
  ACCESS=$(echo "$KC_TOKEN" | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])' 2>/dev/null)
  CLAIMS=$(echo "$ACCESS" | python3 -c '
import sys,base64,json
p=sys.stdin.read().strip().split(".")[1]
p+="="*(-len(p)%4)
c=json.loads(base64.urlsafe_b64decode(p))
print(json.dumps({k:c.get(k) for k in ["tenant_id","role","dept_id","sensitivity","sub"]},ensure_ascii=False))
' 2>/dev/null)
  echo "      claims: $CLAIMS"
  for k in tenant_id role dept_id sensitivity; do
    if echo "$CLAIMS" | grep -q "\"$k\": *\"[^\"]*\""; then ok "claim $k 已注入"; else bad "claim $k 缺失"; fi
  done
  if echo "$CLAIMS" | grep -q '"role": *"platform-admin"'; then ok "realm 角色映射到平台角色"; else bad "role 未正确映射"; fi
else
  bad "password grant 失败：$(echo "$KC_TOKEN" | head -c 160)"
fi

JWKS=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${KEYCLOAK_BASE}/realms/${REALM}/protocol/openid-connect/certs")
check "JWKS 端点可达" "200" "$JWKS"

# ─────────────────────────────────────────────
head_ "TEI（本地嵌入）"
TEI_HEALTH=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${TEI_URL}/health" 2>/dev/null)
check "TEI health" "200" "$TEI_HEALTH"

TEI_RESP=$(curl -s --max-time 120 -X POST "${TEI_URL}/embed" \
  -H 'Content-Type: application/json' \
  -d '{"inputs":["企业级 AI Agent 平台的检索层","差旅住宿标准"]}' 2>/dev/null)
# TEI 返回裸数组 [[v1],[v2]]（非 {"embeddings":[...]}），两种形态都兼容解析
TEI_DIMS=$(echo "$TEI_RESP" | python3 -c '
import sys,json
try:
    d=json.load(sys.stdin)
    e=d.get("embeddings") if isinstance(d,dict) else d
    if not isinstance(e,list): e=[]
    print(f"{len(e)}x{len(e[0]) if e and isinstance(e[0],list) else 0}")
except Exception:
    print("0x0")
' 2>/dev/null)
if [ "${TEI_DIMS%%x*}" != "0" ]; then ok "TEI 返回向量 ${TEI_DIMS}"; else bad "TEI 未返回向量：$(echo "$TEI_RESP"|head -c 160)"; fi

# 真实模型标识（不能是随机名）
TEI_INFO=$(curl -s --max-time 15 "${TEI_URL}/info" 2>/dev/null)
if echo "$TEI_INFO" | grep -q '"model_id"'; then
  ok "TEI 模型标识：$(echo "$TEI_INFO" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("model_id",""))' 2>/dev/null)"
else
  bad "TEI /info 无模型标识"
fi

# ─────────────────────────────────────────────
head_ "Infinity（检索引擎）"
INF_ROOT=$(curl -s --max-time 15 "${INFINITY_HTTP}/admin/node/current" 2>/dev/null)
if echo "$INF_ROOT" | grep -q '"status":"started"'; then
  ok "HTTP 管理端点正常：$(echo "$INF_ROOT" | head -c 80)"
else
  bad "HTTP 管理端点无响应"
fi

INF_PSQL=$(python3 - "$INFINITY_PSQL_PORT" <<'PY' 2>/dev/null
import socket, sys
s = socket.socket(); s.settimeout(5)
try:
    s.connect(("127.0.0.1", int(sys.argv[1])))
    print("open")
except Exception:
    print("closed")
finally:
    s.close()
PY
)
check "PSQL 端口 $INFINITY_PSQL_PORT 可连接" "open" "$INF_PSQL"

# 检索语义验收（过滤下推 / 混合召回 / 幂等）—— 走平台适配器
if [ -f "$SCRIPT_DIR/verify-infinity.ts" ]; then
  INF_OUT=$(cd "$SCRIPT_DIR/.." && npx tsx scripts/verify-infinity.ts 2>&1)
  INF_RC=$?
  echo "$INF_OUT" | grep -E "✓|✗" | sed 's/^/  /'
  if [ $INF_RC -eq 0 ]; then ok "Infinity 检索语义验收通过"; else bad "Infinity 检索语义验收失败"; fi
fi

# ─────────────────────────────────────────────
head_ "Langfuse v3 + ClickHouse（观测）"
LF_HEALTH=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${LANGFUSE_URL}/api/public/health" 2>/dev/null)
check "Langfuse health" "200" "$LF_HEALTH"

CH=$(curl -s --max-time 10 "${CLICKHOUSE_HTTP}/?query=SELECT%201" -u "${CH_USER}:${CH_PASS}" 2>/dev/null)
if echo "$CH" | grep -q "^1"; then ok "ClickHouse 查询正常"; else bad "ClickHouse 响应：$(echo "$CH"|head -c 100)"; fi

if [ -n "${LANGFUSE_PUBLIC_KEY:-}" ] && [ -n "${LANGFUSE_SECRET_KEY:-}" ]; then
  LF_API=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
    -u "${LANGFUSE_PUBLIC_KEY}:${LANGFUSE_SECRET_KEY}" \
    "${LANGFUSE_URL}/api/public/traces?limit=1&page=1")
  check "Langfuse API 可查询 trace" "200" "$LF_API"
else
  bad "Langfuse API/observation 检查缺少 LANGFUSE_PUBLIC_KEY 或 LANGFUSE_SECRET_KEY"
fi
# ─────────────────────────────────────────────
head_ "RAGFlow v0.22.1（文档引擎，容器未起则跳过）"
RAGFLOW_HTTP="${RAGFLOW_HTTP:-http://127.0.0.1:9380}"
RAGFLOW_WEB="${RAGFLOW_WEB:-http://127.0.0.1:8095}"
if "${DOCKER[@]}" inspect eapheavy-ragflow >/dev/null 2>&1; then
  RF_STATE=$("${DOCKER[@]}" inspect -f '{{.State.Status}}' eapheavy-ragflow 2>/dev/null || echo absent)
  if [ "$RF_STATE" = "running" ]; then ok "eapheavy-ragflow running"; else bad "eapheavy-ragflow 状态=$RF_STATE"; fi

  RF_HEALTH=$(curl -s --max-time 15 "${RAGFLOW_HTTP}/v1/system/healthz" 2>/dev/null)
  if echo "$RF_HEALTH" | grep -q '"status":"ok"'; then
    ok "RAGFlow 健康检查全绿（db/doc_engine/redis/storage）"
  else
    bad "RAGFlow 健康检查异常：$(echo "$RF_HEALTH" | head -c 150)"
  fi

  RF_WEB=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${RAGFLOW_WEB}/" 2>/dev/null)
  if [ "$RF_WEB" = "200" ]; then ok "RAGFlow Web 界面可达"; else bad "RAGFlow Web 界面 HTTP $RF_WEB"; fi

  # 容器内必须能连到三个依赖：MySQL / Infinity(Thrift) / TEI
  if [ "$RF_STATE" = "running" ]; then
    RF_MYSQL=$("${DOCKER[@]}" exec eapheavy-ragflow sh -c \
      'python3 -c "
import socket,sys
for name,port in ((\"mysql\",3306),(\"infinity-ragflow\",23817),(\"tei\",80)):
    s=socket.socket(); s.settimeout(4)
    try:
        s.connect((name,port)); print(name+\":ok\", end=\" \")
    except Exception as e:
        print(name+\":FAIL\", end=\" \")
    finally:
        s.close()
" 2>/dev/null' 2>/dev/null)
    if echo "$RF_MYSQL" | grep -q "mysql:ok"; then ok "RAGFlow 容器内可连 MySQL"; else bad "RAGFlow 容器内连不上 MySQL：$RF_MYSQL"; fi
    if echo "$RF_MYSQL" | grep -q "infinity-ragflow:ok"; then ok "RAGFlow 容器内可连 Infinity(Thrift)"; else bad "RAGFlow 容器内连不上 Infinity：$RF_MYSQL"; fi
    if echo "$RF_MYSQL" | grep -q "tei:ok"; then ok "RAGFlow 容器内可连 TEI"; else bad "RAGFlow 容器内连不上 TEI：$RF_MYSQL"; fi
  fi

  # 回归防护：解析消费者必须真的注册上（见下方「RAGFlow 解析卡死」根因）。
  # task_executor 卡在 init_settings() 的 Infinity Thrift 握手时，
  # 进程在、HTTP 也在、TCP 也能连，但消费者从未加入 Redis 消费组 →
  # 任务全部堆积、progress 冻结。三条一起查才抓得住。
  if [ "$RF_STATE" = "running" ]; then
    RF_EXEC_PID=$("${DOCKER[@]}" exec eapheavy-ragflow sh -c \
      'ps -eo pid,args | grep "[t]ask_executor.py" | head -1 | awk "{print \$1}"' 2>/dev/null | tr -d '\r')
    if [ -n "$RF_EXEC_PID" ]; then
      ok "RAGFlow 解析执行器进程在（pid=${RF_EXEC_PID}）"

      # init_settings 完成才会打印这行；卡在握手时永远打不出来
      RF_EXEC_HEALTHY=$("${DOCKER[@]}" exec eapheavy-ragflow sh -c \
        "grep -l 'Port: 23817 is healthy' /ragflow/logs/task_executor_*.log 2>/dev/null | tail -1" 2>/dev/null | tr -d '\r')
      if [ -n "$RF_EXEC_HEALTHY" ]; then
        ok "RAGFlow 执行器已完成 Infinity 握手（消费者已具备注册条件）"
      else
        bad "RAGFlow 执行器未完成 Infinity 握手 —— 消费者可能未注册，解析任务会堆积"
      fi
    else
      bad "RAGFlow 解析执行器进程不存在 —— 任务不会有人消费"
    fi

    # RAGFlow→Infinity 的 Thrift 连接数必须远离服务端上限（当前 256）。
    # 三个进程各预建 max_size 条（补丁后 max_size=8，合计 24）。
    RF_INF_CONN=$("${DOCKER[@]}" exec eapheavy-ragflow sh -c \
      'cat /proc/net/tcp | awk "NR>1 && \$4==\"01\" && \$3 ~ /:5D09$/ {c++} END{print c+0}"' 2>/dev/null | tr -d '\r')
    if [ -n "$RF_INF_CONN" ] && [ "$RF_INF_CONN" -lt 128 ] 2>/dev/null; then
      ok "RAGFlow→Infinity Thrift 连接数 ${RF_INF_CONN}（远低于上限 256）"
    else
      bad "RAGFlow→Infinity Thrift 连接数异常：${RF_INF_CONN:-未知}（上限 256，接近上限会再次卡死）"
    fi
  fi

  # 真实功能：注册 → 建库 → 上传 → 解析 → 向量检索
  if [ -f "$SCRIPT_DIR/verify-ragflow.py" ]; then
    RF_OUT=$(cd "$SCRIPT_DIR/.." && python3 scripts/verify-ragflow.py 2>&1)
    RF_RC=$?
    echo "$RF_OUT" | grep -E "✓|✗" | sed 's/^/  /'
    if [ $RF_RC -eq 0 ]; then ok "RAGFlow 端到端功能验收通过"; else bad "RAGFlow 端到端功能验收失败"; fi
  fi

  # 账号打通：Keycloak SSO 渠道 → 首次登录自动建号 → 管理员映射
  # （本地账号 eap-admin@eap.local 仍保留为兜底，见 verify-ragflow.py）
  if [ -f "$SCRIPT_DIR/ragflow-sso.py" ]; then
    RF_SSO_OUT=$(cd "$SCRIPT_DIR/.." && python3 scripts/ragflow-sso.py verify 2>&1)
    RF_SSO_RC=$?
    echo "$RF_SSO_OUT" | grep -E "渠道：|→|已提权|验收" | sed 's/^/  /'
    if [ $RF_SSO_RC -eq 0 ]; then
      ok "RAGFlow ↔ Keycloak 账号打通验收通过（SSO 渠道 / 自动建号 / 管理员映射）"
    else
      bad "RAGFlow ↔ Keycloak 账号打通验收失败"
    fi

    # 登录页必须被 Keycloak 拦截：/login → 302 /login-sso.html，
    # 且 ?local=1 仍能拿到本地账号表单（应急入口不能被拦死）
    RF_LOGIN_LOC=$(curl -s -o /dev/null -D - --max-time 10 "${RAGFLOW_WEB}/login" 2>/dev/null \
      | tr -d '\r' | awk 'tolower($1)=="location:"{print $2}' | head -1)
    if [ "${RF_LOGIN_LOC:-}" = "/login-sso.html" ]; then
      ok "RAGFlow 登录页已被 Keycloak 拦截（/login → /login-sso.html）"
    else
      bad "RAGFlow 登录页未拦截：Location=${RF_LOGIN_LOC:-（无）}"
    fi
    RF_LOCAL_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${RAGFLOW_WEB}/login?local=1" 2>/dev/null)
    check "RAGFlow 本地账号兜底入口可用（/login?local=1）" "200" "$RF_LOCAL_CODE"
    # 只看 200 不够：拦截页同样是 200。兜底入口必须返回 RAGFlow 自己的
    # SPA 骨架（<div id="root">），本地账号表单由前端渲染。
    RF_LOCAL_BODY=$(curl -s --max-time 10 "${RAGFLOW_WEB}/login?local=1" 2>/dev/null | head -c 2000)
    if printf '%s' "$RF_LOCAL_BODY" | grep -q 'id="root"'; then
      ok "RAGFlow 本地账号兜底入口返回的是 RAGFlow 页面（不是 SSO 拦截页）"
    else
      bad "RAGFlow 本地账号兜底入口返回的不是 RAGFlow 页面（应急入口可能被拦死）"
    fi
  fi
else
  echo "      （跳过：eapheavy-ragflow 尚未创建，用 start-heavy.sh start ragflow 拉起）"
fi

# ─────────────────────────────────────────────
head_ "DB-GPT（ChatBI 引擎，模型 API Server 形态）"
DBGPT_HTTP="${DBGPT_HTTP:-http://127.0.0.1:8094}"
DBGPT_WEB="${DBGPT_WEB:-http://127.0.0.1:8096}"
DBGPT_MCP="${DBGPT_MCP:-http://127.0.0.1:8097}"
if "${DOCKER[@]}" inspect eapheavy-dbgpt >/dev/null 2>&1; then
  DB_STATE=$("${DOCKER[@]}" inspect -f '{{.State.Status}}' eapheavy-dbgpt 2>/dev/null || echo absent)
  if [ "$DB_STATE" = "running" ]; then ok "eapheavy-dbgpt running"; else bad "eapheavy-dbgpt 状态=$DB_STATE"; fi

  # 四件套进程：controller / worker / apiserver + webserver（原生形态）
  DB_PROCS=$("${DOCKER[@]}" exec eapheavy-dbgpt sh -c 'ps aux | grep "dbgpt start" | grep -v grep | wc -l' 2>/dev/null | tr -d ' \r')
  if [ "${DB_PROCS:-0}" -ge 3 ]; then
    ok "DB-GPT 模型三件套进程齐全（controller/worker/apiserver）"
  else
    bad "DB-GPT 模型进程数=${DB_PROCS:-0}（期望 ≥3）"
  fi

  DB_WEB_PROC=$("${DOCKER[@]}" exec eapheavy-dbgpt sh -c 'ps aux | grep webserver_boot | grep -v grep | wc -l' 2>/dev/null | tr -d ' \r')
  if [ "${DB_WEB_PROC:-0}" -ge 1 ]; then
    ok "DB-GPT Web Server 进程在运行（datasource/Text2SQL/awesomes）"
  else
    bad "DB-GPT Web Server 进程未运行"
  fi

  # Web Server 对外可达（宿主 8096 → 容器 8093）
  DB_WEB_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "${DBGPT_WEB}/" 2>/dev/null)
  check "DB-GPT Web Server 可达" "200" "$DB_WEB_CODE"

  # MCP Server 适配器对外可达（宿主 8097 → 容器 8094）
  DB_MCP_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
    -X POST "${DBGPT_MCP}/mcp" -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' 2>/dev/null)
  check "DB-GPT MCP Server 可握手（streamable-http）" "200" "$DB_MCP_CODE"

  # DB-GPT 元数据库可连
  DB_PG=$("${DOCKER[@]}" exec eapheavy-postgres psql -U eap -d dbgpt -tAc "SELECT 1" 2>/dev/null | tr -d ' ')
  check "DB-GPT 元数据库 dbgpt 可连" "1" "$DB_PG"

  # DB-GPT 作为 MCP 客户端已注册平台 MCP Server（反向互联）
  DB_REG=$("${DOCKER[@]}" exec eapheavy-dbgpt sh -c \
    "grep -o '\"ok\": *[0-9]*' /app/logs/platform_mcp.json | head -1 | grep -o '[0-9]*'" 2>/dev/null | tr -d ' \r')
  DB_REG_TOTAL=$("${DOCKER[@]}" exec eapheavy-dbgpt sh -c \
    "grep -o '\"total\": *[0-9]*' /app/logs/platform_mcp.json | head -1 | grep -o '[0-9]*'" 2>/dev/null | tr -d ' \r')
  DB_REG_OK="${DB_REG:-0}"
  if [ "${DB_REG_OK:-0}" -ge 1 ] 2>/dev/null; then
    ok "DB-GPT 已注册平台 MCP Server（客户端方向）  ${DB_REG_OK}/${DB_REG_TOTAL:-?} 个连接器可用"
  else
    bad "DB-GPT 平台 MCP 客户端未注册（可用连接器数：${DB_REG_OK:-0}）"
  fi

  # 真实功能：模型列表 + 真实模型调用
  if [ -f "$SCRIPT_DIR/verify-dbgpt.py" ]; then
    DB_OUT=$(cd "$SCRIPT_DIR/.." && python3 scripts/verify-dbgpt.py 2>&1)
    DB_RC=$?
    echo "$DB_OUT" | grep -E "✓|✗" | sed 's/^/  /'
    if [ $DB_RC -eq 0 ]; then ok "DB-GPT 端到端功能验收通过"; else bad "DB-GPT 端到端功能验收失败"; fi
  fi
else
  echo "      （跳过：eapheavy-dbgpt 尚未创建，用 start-heavy.sh start db-gpt 拉起）"
fi

# ─────────────────────────────────────────────
head_ "平台侧真实链路（网关 ← Keycloak 令牌 ← TEI）"
GATEWAY="${GATEWAY_BASE:-http://127.0.0.1:8080}"

# 1) 网关用真实 Keycloak 令牌调通 /v1/embeddings（TEI 真实向量）
if [ -n "${ACCESS:-}" ]; then
  EMB_RESP=$(curl -s --max-time 120 -X POST "${GATEWAY}/v1/embeddings" \
    -H "Authorization: Bearer ${ACCESS}" \
    -H 'Content-Type: application/json' \
    -d '{"model":"embedding-model","input":"差旅住宿标准"}' 2>/dev/null)
  EMB_DIMS=$(echo "$EMB_RESP" | python3 -c '
import sys,json
try:
    d=json.load(sys.stdin); e=d.get("data") or []
    v=e[0].get("embedding") if e else None
    print(len(v) if isinstance(v,list) else 0)
except Exception:
    print(0)
' 2>/dev/null)
  if [ "${EMB_DIMS:-0}" -gt 0 ]; then
    ok "网关 /v1/embeddings 返回 ${EMB_DIMS} 维真实向量"
  else
    bad "网关 /v1/embeddings 失败：$(echo "$EMB_RESP"|head -c 200)"
  fi

  # 2) 无令牌必须 401（鉴权未旁路）
  NOAUTH=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
    -X POST "${GATEWAY}/v1/embeddings" -H 'Content-Type: application/json' \
    -d '{"model":"embedding-model","input":"x"}' 2>/dev/null)
  check "网关无令牌访问被拒" "401" "$NOAUTH"
else
  bad "跳过网关链路检查：未取到 Keycloak 令牌"
fi

# 3) Langfuse 中确有真实入库的 observation（用量/成本已落地）
#
# ⚠ OTel 上报 → Langfuse → ClickHouse 是**异步**链路，模型请求返回后 observation
# 未必已落库。立即查一次会偶发判负（实测出现过「通过 58 项 / 失败 2 项」）。
# 这里改为轮询等待，最多 20s。
if [ -n "${LANGFUSE_PUBLIC_KEY:-}" ] && [ -n "${LANGFUSE_SECRET_KEY:-}" ]; then
  OBS_TYPE=""
  for _i in $(seq 1 10); do
    OBS=$(curl -s --max-time 20 -u "${LANGFUSE_PUBLIC_KEY}:${LANGFUSE_SECRET_KEY}" \
      "${LANGFUSE_URL}/api/public/observations?limit=1&page=1" 2>/dev/null)
    OBS_TYPE=$(echo "$OBS" | python3 -c '
import sys,json
try:
    d=json.load(sys.stdin); l=d.get("data") or []
    print((l[0].get("type") or "") if l else "")
except Exception:
    print("")
' 2>/dev/null)
    [ -n "$OBS_TYPE" ] && break
    sleep 2
  done
  if [ -n "$OBS_TYPE" ]; then ok "Langfuse observation 已入库（type=$OBS_TYPE）"; else bad "Langfuse 无 observation 数据"; fi
else
  echo "      （跳过 observation 查询：凭据缺失已在上方记为失败）"
fi

# ─────────────────────────────────────────────
head_ "Envoy 出网代理（唯一出口 + SNI 域名白名单）"
# 依据 8.3 出网安全 / 9.3 网络要求：所有出网流量必须经网关 + 出网代理，
# 业务组件禁止直连商业 API。这里验证 Envoy 真的在跑、真的在拦、
# 且网关的模型流量确实是从它出去的。
EGRESS_ADMIN="http://127.0.0.1:9901"
EGRESS_PROXY="http://127.0.0.1:15000"

ENV_STATUS=$("${DOCKER[@]}" ps --filter 'name=eap-envoy' --format '{{.Status}}' 2>/dev/null | head -1)
if [ -n "$ENV_STATUS" ]; then
  ok "eap-envoy running（$ENV_STATUS）"
else
  bad "eap-envoy 未运行 —— 商业 API 将绕过唯一出口"
fi

EGRESS_READY=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${EGRESS_ADMIN}/ready" 2>/dev/null)
check "Envoy /ready 可达" "200" "$EGRESS_READY"

# —— loopback-bridge 存活 ——
# 容器内的重型组件（DB-GPT 等）通过 host.docker.internal:8080 访问宿主上
# **绑回环**的平台服务，靠的就是这个桥在 docker0 地址(172.17.0.1)上做代理。
# 桥一死，DB-GPT 会报「LLMServer Generate Error: Connection error」（HTTP 400），
# 而网关侧日志一切正常 —— 极难定位，所以在这里直接查监听状态。
BRIDGE_ADDR=$("${DOCKER[@]}" network inspect bridge --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}' 2>/dev/null)
[ -z "$BRIDGE_ADDR" ] && BRIDGE_ADDR="172.17.0.1"
BRIDGE_LISTEN=$(ss -ltn 2>/dev/null | grep -c "${BRIDGE_ADDR}:8080" || true)
check "loopback-bridge 在 ${BRIDGE_ADDR}:8080 监听（容器访问宿主服务的通道）" "1" "$BRIDGE_LISTEN"

# 白名单内域名：CONNECT 隧道必须建立（响应来自真实上游，而非 Envoy 的 403）
EGRESS_ALLOW=$(curl -s -i --max-time 30 -x "${EGRESS_PROXY}" https://agent.minimaxi.com/ 2>/dev/null | head -1)
if echo "$EGRESS_ALLOW" | grep -q "HTTP/1.1" && ! echo "$EGRESS_ALLOW" | grep -q "403"; then
  ok "白名单域名经出网代理放行（$EGRESS_ALLOW）"
else
  bad "白名单域名经出网代理异常：$EGRESS_ALLOW"
fi

# 非白名单域名：必须被 Envoy 拒绝（403 Forbidden）
EGRESS_DENY=$(curl -s -i --max-time 20 -x "${EGRESS_PROXY}" https://evil.example.com/ 2>/dev/null | head -1)
if echo "$EGRESS_DENY" | grep -q "403"; then
  ok "非白名单域名被出网代理拒绝（$EGRESS_DENY）"
else
  bad "非白名单域名未被出网代理拒绝：$EGRESS_DENY"
fi

# 网关的真实模型流量必须打在出网代理上（读 Envoy 集群计数器的前后增量）
#
# ⚠ 主体选择：不能用上面那个 ACCESS（eap-admin / sensitivity=confidential）。
# 涉密主体按 8.1 数据分级会在**出网之前**被 deny-confidential-egress 策略拦下，
# 请求根本到不了出网代理，计数自然不涨 —— 那是策略生效，不是代理失效。
# 这里另取一个 internal 密级的账号（eap-ops / platform-admin）。
#
# ⚠ 指标选择：不能用 upstream_rq_2xx（它只在**新建 CONNECT 隧道**时 +1）。
# undici ProxyAgent 会复用已建立的隧道，复用期间该计数不动，
# 会造成「代理没生效」的误判。这里用**上游字节数**
# （cluster.<name>.upstream_cx_tx_bytes_total）—— 隧道内每次请求都会推高它。
EGRESS_TOKEN=$(curl -s --max-time 20 -X POST \
  "${KEYCLOAK_BASE}/realms/${REALM}/protocol/openid-connect/token" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=password' -d 'client_id=eap-webui' \
  -d 'username=eap-ops' -d 'password=EapOps@2026' 2>/dev/null \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("access_token",""))' 2>/dev/null)

egress_bytes() {
  curl -s --max-time 5 "${EGRESS_ADMIN}/stats" 2>/dev/null \
    | grep -E '^cluster\.egress_connect_agent_minimaxi_com\.upstream_cx_tx_bytes_total:' \
    | awk '{print $2}' | tr -d '\r'
}

if [ -n "${EGRESS_TOKEN:-}" ]; then
  BYTES_BEFORE=$(egress_bytes); BYTES_BEFORE=${BYTES_BEFORE:-0}
  EGRESS_MODEL_RESP=$(curl -s --max-time 90 -X POST "${GATEWAY}/v1/chat/completions" \
    -H "Authorization: Bearer ${EGRESS_TOKEN}" -H 'Content-Type: application/json' \
    -d '{"model":"smart-model","messages":[{"role":"user","content":"回复一个字：好"}],"max_tokens":32}' 2>/dev/null)
  # ⚠ Envoy 的 stats 是**定期推送**到 admin 端点的（flush 间隔默认数秒），
  # 模型响应返回时计数可能还没刷新。立即比对会偶发判负
  # （实测出现过「模型调用成功但字节未增长」的误报）。这里轮询等待，最多 15s。
  BYTES_AFTER="$BYTES_BEFORE"
  for _i in $(seq 1 5); do
    BYTES_AFTER=$(egress_bytes); BYTES_AFTER=${BYTES_AFTER:-0}
    [ "${BYTES_AFTER:-0}" -gt "${BYTES_BEFORE:-0}" ] && break
    sleep 3
  done
  if [ "${BYTES_AFTER:-0}" -gt "${BYTES_BEFORE:-0}" ]; then
    ok "网关模型流量确实经出网代理（Envoy 上游字节 ${BYTES_BEFORE} → ${BYTES_AFTER}）"
  elif echo "$EGRESS_MODEL_RESP" | grep -q '"choices"'; then
    bad "模型调用成功但未经过出网代理（Envoy 字节未增长：${BYTES_BEFORE} → ${BYTES_AFTER}）—— 出网代理未生效"
  else
    bad "网关模型调用失败：$(echo "$EGRESS_MODEL_RESP" | head -c 200)"
  fi

  # 唯一出口未被绕过：网关进程不得直连任何非回环地址的 443
  GW_PIDS_RE=$(pgrep -f 'packages/gateway/(src/main\.ts|dist/main\.js)' 2>/dev/null | paste -sd'|' -)
  if [ -n "${GW_PIDS_RE:-}" ]; then
    GW_DIRECT_443=$(ss -tanp 2>/dev/null \
      | awk '$5 ~ /:443$/ && $5 !~ /^(127\.0\.0\.1|::1|172\.17\.)/ {print}' \
      | grep -cE "pid=(${GW_PIDS_RE})," || true)
    if [ "${GW_DIRECT_443:-0}" -eq 0 ]; then
      ok "网关进程无商业 API 直连（唯一出口未被绕过）"
    else
      bad "网关进程存在 ${GW_DIRECT_443} 条商业 API 直连 —— 绕过了出网代理"
    fi
  else
    bad "无法执行宿主机直连检查：未找到源码/构建产物网关进程；容器化部署需单独检查容器网络命名空间"
  fi
else
  bad "跳过出网代理链路检查：未取到 eap-ops 令牌"
fi

# ─────────────────────────────────────────────
head_ "Harbor 2.x（离线镜像仓）"
# Harbor 是方案 3.1 的 P1 组件。这里做**轻量**检查（容器/健康/版本/登录/仓库清单）；
# 完整的「真实推送 + 删除 + 拉回」往返验收在 scripts/verify-harbor.sh。
HARBOR_API="http://127.0.0.1:${HARBOR_HOST_PORT:-8098}"
HARBOR_REG="${HARBOR_REGISTRY:-harbor.eap.local:${HARBOR_HOST_PORT:-8098}}"
HARBOR_ADMIN="${HARBOR_USER:-admin}"
HARBOR_PWD="${HARBOR_PASS:-Harbor12345}"

HARBOR_RUNNING=0
for svc in core db jobservice registry registryctl portal log redis nginx; do
  st=$("${DOCKER[@]}" ps --filter "name=^eapheavy-harbor-${svc}$" --format '{{.Status}}' 2>/dev/null | head -1)
  [ -n "$st" ] && HARBOR_RUNNING=$((HARBOR_RUNNING+1))
done
if [ "$HARBOR_RUNNING" -eq 9 ]; then
  ok "Harbor 9 个组件全部运行（core/db/jobservice/registry/registryctl/portal/log/redis/nginx）"
else
  bad "Harbor 组件只起了 $HARBOR_RUNNING/9 个"
fi

HARBOR_HEALTH=$(curl -s --max-time 15 "${HARBOR_API}/api/v2.0/health" 2>/dev/null)
HSTAT=$(echo "$HARBOR_HEALTH" | python3 -c '
import sys,json
try:
    print((json.load(sys.stdin) or {}).get("status",""))
except Exception:
    print("")' 2>/dev/null)
check "Harbor 健康端点" "healthy" "$HSTAT"

HVER=$(curl -s --max-time 15 -u "${HARBOR_ADMIN}:${HARBOR_PWD}" "${HARBOR_API}/api/v2.0/systeminfo" 2>/dev/null | python3 -c '
import sys,json
try:
    print((json.load(sys.stdin) or {}).get("harbor_version",""))
except Exception:
    print("")' 2>/dev/null)
if [ -n "$HVER" ]; then ok "Harbor 版本：$HVER"; else bad "读不到 Harbor 版本"; fi

HCODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -u "${HARBOR_ADMIN}:${HARBOR_PWD}" "${HARBOR_API}/api/v2.0/users/current" 2>/dev/null)
check "Harbor 管理员登录" "200" "$HCODE"

# 镜像确实进了 Harbor（不是只看容器在跑）
HREPOS=$(curl -s --max-time 15 -u "${HARBOR_ADMIN}:${HARBOR_PWD}" "${HARBOR_API}/api/v2.0/projects/eap/repositories" 2>/dev/null | python3 -c '
import sys,json
try:
    print(len(json.load(sys.stdin) or []))
except Exception:
    print(0)' 2>/dev/null)
if [ "${HREPOS:-0}" -ge 1 ]; then
  ok "Harbor 中存在镜像仓库（eap 项目下 ${HREPOS} 个）"
else
  bad "Harbor 中没有镜像仓库（跑 scripts/verify-harbor.sh 做真实推送+拉回）"
fi

# 端口必须只绑回环
HARBOR_PORT_LEAK=$("${DOCKER[@]}" port eapheavy-harbor-nginx 8080 2>/dev/null | grep -cv "^127\.0\.0\.1:" || true)
if [ "${HARBOR_PORT_LEAK:-0}" -eq 0 ]; then
  ok "Harbor UI 端口只绑回环"
else
  bad "Harbor UI 端口暴露到非回环地址"
fi


# ─────────────────────────────────────────────
printf '\n════════════════════════════════════════════════════\n'
if [ "$FAIL" -eq 0 ]; then
  printf ' \033[32m重型组件全部通过：%d 项\033[0m\n' "$PASS"
else
  printf ' \033[31m通过 %d 项，失败 %d 项\033[0m\n' "$PASS" "$FAIL"
fi
printf '════════════════════════════════════════════════════\n'
[ "$FAIL" -eq 0 ]