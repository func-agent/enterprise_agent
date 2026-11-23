#!/usr/bin/env bash
# RAGFlow 启动前补丁层：收敛 Infinity Thrift 连接池大小。
#
# ── 为什么需要这个补丁 ─────────────────────────────────────────────
# RAGFlow v0.22.1 的 rag/utils/infinity_conn.py 里：
#     connPool = ConnectionPool(infinity_uri, max_size=32)
# 而 infinity-sdk 的 ConnectionPool.__init__ 会**预建** max_size 条 Thrift 连接：
#     for i in range(max_size):
#         self._create_conn()
#
# RAGFlow 容器内同时跑三个会调用 init_settings() 的进程，各自持有一个
# @singleton 的 InfinityConnection（各自一个独立进程 = 各自一个连接池）：
#   1. api/ragflow_server.py     （HTTP API）
#   2. rag/svr/sync_data_source.py（数据同步）
#   3. rag/svr/task_executor.py   （**唯一注册 Redis 消费组的消费者**）
#
# 3 × 32 = 96 条预建连接，而 Infinity 的 client_port 连接上限默认 64
# （见 infinity_conf_v065.toml 的 connection_pool_size）。
# 于是：前两个进程各占满 32 条（合计 64 = 上限），第 3 个进程
# task_executor 的首条连接会被 accept 但服务端不再分配处理线程 →
# thrift recv_Connect **永久阻塞**（不报错、不返回）→ task_executor 卡死在
# init_settings()，永远不加入消费组 → 文档解析任务全部堆积在队列里，
# 表现为 run=RUNNING / progress 冻结在 0.009 / "N tasks are ahead in the queue"。
#
# ── 修复 ───────────────────────────────────────────────────────────
# 把 max_size 降到 8：3 × 8 = 24 条，安全落在 64 上限之下。
# 同时 infinity_conf_v065.toml 把 connection_pool_size 提到 256 作为纵深防御。
#
# ── 幂等与失效保护 ─────────────────────────────────────────────────
# 替换后必须能 grep 到目标值；若既不是 32 也不是目标值，说明上游结构变了，
# 直接退出 1，不允许「补丁没生效但服务照常启动」的静默失败。
set -euo pipefail

TARGET="${RAGFLOW_INFINITY_CONN_FILE:-/ragflow/rag/utils/infinity_conn.py}"
WANT="${RAGFLOW_INFINITY_MAX_SIZE:-8}"
SSO_CONFIG_FILE="${RAGFLOW_SSO_CONFIG_FILE:-/ragflow/conf/local.service_conf.yaml}"

# ── Keycloak SSO 渠道 ───────────────────────────────────────────────
#
# RAGFlow 0.22 的登录渠道来自 common/settings.py 的
#     OAUTH_CONFIG = get_base_config("oauth", {})
# 即 conf/service_conf.yaml 的 oauth 段；common/config_utils.py 的 read_config()
# 会用 conf/local.service_conf.yaml 覆盖同名顶层键，因此这里只写 oauth 一段，
# 不动镜像自带的其余配置（数据库、对象存储、模型等）。
#
# 为什么用 oauth2 而不是 oidc 模式：
#   OIDCClient._load_oidc_metadata() 会用 discovery 文档**强制覆盖**全部端点。
#   本机 Keycloak 是动态 hostname（KC_HOSTNAME_STRICT=false，未固定 KC_HOSTNAME），
#   discovery 里的端点会跟随请求的 Host 变 —— 容器用 keycloak:8080 去发现，
#   拿回来的 authorization_endpoint 就是 http://keycloak:8080/...，
#   用户的浏览器根本打不开。oauth2 模式允许显式指定端点，于是可以拆开：
#     · 浏览器侧（authorization_url / redirect_uri）→ 公网地址
#     · 后端侧（token_url / userinfo_url）→ 默认同样是公网地址
#
# 为什么后端侧默认也用公网地址（而不是容器内的 keycloak:8080）：
#   Keycloak 动态 hostname 下，**令牌里的 iss 跟随签发时的请求 Host**，
#   而 userinfo 端点会校验「令牌 iss == 本次请求 Host 算出的地址」。
#   浏览器从公网地址授权 → 令牌 iss = 公网地址；若 RAGFlow 拿这个令牌去
#   容器内的 keycloak:8080 换 userinfo，Host 变成 keycloak:8080 → iss 不匹配 →
#   userinfo 直接 401（实测踩过，空响应体）。
#   所以两端必须同 Host：浏览器侧和后端侧都用公网地址，
#   容器经宿主 hairpin（VM 的 route_localnet DNAT + 宿主端口转发）回连 Keycloak。
#
#   如果把 Keycloak 改成固定 hostname（KC_HOSTNAME + KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true），
#   令牌 iss 与请求 Host 无关，届时可把后端侧改回容器内地址：
#     RAGFLOW_OAUTH_KEYCLOAK_BACKEND=http://keycloak:8080
#   （变量留空 = 跟随浏览器侧公网地址）
#
# 变量语义（deploy/compose/.env 配置）：
#   EAP_PUBLIC_KEYCLOAK_ORIGIN     浏览器访问 Keycloak 的地址（公网）
#   EAP_PUBLIC_RAGFLOW_ORIGIN       浏览器访问 RAGFlow 的地址（公网）
#   RAGFLOW_OAUTH_CLIENT_ID         Keycloak 侧客户端 ID（eap-ragflow）
#   RAGFLOW_OAUTH_CLIENT_SECRET     Keycloak 侧客户端密钥
#   RAGFLOW_OAUTH_KEYCLOAK_BACKEND  后端侧 Keycloak 基址（留空 = 用公网地址）
#   RAGFLOW_OAUTH_REALM             realm 名（enterprise）
#
# 全部为空 → 不启用 SSO（RAGFlow 只保留本地账号登录，容器正常启动）；
# 只配一半 → 视为配置错误，直接退出 1（半配置会生成打不开的登录渠道）。
#
# 统计 SSO 四个必要变量里已设置的数量（0 = 未启用，4 = 已启用，1~3 = 半配置）
sso_provided_count() {
  local n=0 v
  for v in "${EAP_PUBLIC_KEYCLOAK_ORIGIN:-}" "${EAP_PUBLIC_RAGFLOW_ORIGIN:-}" \
           "${RAGFLOW_OAUTH_CLIENT_ID:-}" "${RAGFLOW_OAUTH_CLIENT_SECRET:-}"; do
    [ -n "$v" ] && n=$((n + 1))
  done
  echo "$n"
}

render_sso_config() {
  local kc_public="${EAP_PUBLIC_KEYCLOAK_ORIGIN:-}"
  local rag_public="${EAP_PUBLIC_RAGFLOW_ORIGIN:-}"
  local client_id="${RAGFLOW_OAUTH_CLIENT_ID:-}"
  local client_secret="${RAGFLOW_OAUTH_CLIENT_SECRET:-}"
  local kc_backend="${RAGFLOW_OAUTH_KEYCLOAK_BACKEND:-$kc_public}"
  local realm="${RAGFLOW_OAUTH_REALM:-enterprise}"

  local provided
  provided="$(sso_provided_count)"

  if [ "$provided" -eq 0 ]; then
    echo "[eap-sso] 未配置 Keycloak SSO（4 个变量均为空），RAGFlow 仅启用本地账号登录"
    return 0
  fi
  if [ "$provided" -ne 4 ]; then
    echo "[eap-sso] 错误：SSO 变量只配了 $provided/4，半配置会生成打不开的登录渠道" >&2
    echo "          需要同时设置 EAP_PUBLIC_KEYCLOAK_ORIGIN / EAP_PUBLIC_RAGFLOW_ORIGIN /" >&2
    echo "          RAGFLOW_OAUTH_CLIENT_ID / RAGFLOW_OAUTH_CLIENT_SECRET" >&2
    return 1
  fi

  # 配置值会原样写进 YAML，禁止引号/反斜杠/换行，避免写坏配置文件
  for v in "$kc_public" "$rag_public" "$client_id" "$client_secret" "$kc_backend" "$realm"; do
    case "$v" in
      *'"'*|*'\'*|*$'\n'*|*$'\r'*)
        echo "[eap-sso] 错误：SSO 配置值包含不允许的字符（引号/反斜杠/换行）" >&2
        return 1
        ;;
    esac
  done

  cat > "$SSO_CONFIG_FILE" <<EOF
# 由 eap-entrypoint.sh 生成，容器每次启动都会重写，请勿手工编辑。
#
# RAGFlow 0.22 的第三方登录渠道配置（common/settings.py: OAUTH_CONFIG）。
# 渠道名 keycloak → 登录页显示 "Keycloak" 按钮，
# 回调路径 /v1/user/oauth/callback/keycloak。
#
# 浏览器侧用公网地址，后端侧用容器网络地址，原因见脚本内注释。
oauth:
  keycloak:
    type: oauth2
    display_name: Keycloak
    client_id: "$client_id"
    client_secret: "$client_secret"
    authorization_url: "$kc_public/realms/$realm/protocol/openid-connect/auth"
    token_url: "$kc_backend/realms/$realm/protocol/openid-connect/token"
    userinfo_url: "$kc_backend/realms/$realm/protocol/openid-connect/userinfo"
    redirect_uri: "$rag_public/v1/user/oauth/callback/keycloak"
    scope: "openid profile email"
EOF

  echo "[eap-sso] 已启用 Keycloak SSO 渠道：授权 -> $kc_public，回调 -> $rag_public/v1/user/oauth/callback/keycloak"
  echo "[eap-sso] 后端侧 Keycloak 基址：$kc_backend（必须与浏览器侧同 Host，否则令牌 iss 不匹配，userinfo 会 401）"
}

# ── 登录页拦截（nginx 层）──────────────────────────────────────────
#
# 目的：访问 RAGFlow 的 /login 时，不要把用户停在「邮箱 + 口令」的本地表单上，
# 而是直接走 Keycloak 单点登录 —— 与平台控制台（5173）一致的登录体验。
#
# 实现：生成 nginx 的 location 片段到 /etc/nginx/sso/ragflow-sso.conf，
# 由 ragflow.conf 的 `include /etc/nginx/sso/*.conf;` 引入（server 块内）。
#   · /login           → 302 到拦截页 /login-sso.html（中文说明 + 兜底链接），再由它跳 Keycloak
#   · /login?local=1   → 渲染 RAGFlow 原本的本地账号表单（应急入口）
#   · 未启用 SSO 时不生成该文件 → include 的通配符匹配不到，登录页保持原样
#
# 登出语义：企业 SSO 登录在 RAGFlow 登出时一并结束 Keycloak 会话；
# 本地账号只结束自己的 RAGFlow 会话，不影响企业 SSO。
#   · 后端（eap-patch-sso-logout.py）在 OAuth 回调时写
#     `eap_kc_id_token`（Keycloak id_token，HttpOnly），
#     在登出时写一次性标记 `eap_sso_logout=keycloak|password`；
#   · 企业 SSO：/login → /logout-sso → Keycloak end_session → 已退出页；
#   · 本地账号：/login → /logout-local → 已退出页，不触碰企业 SSO；
#   · 有 id_token_hint 时静默结束；缺失时进入 Keycloak 确认页，
#     用户确认后才跳成功页，不能提前宣称 SSO 已结束。
#
# 为什么不改前端 bundle：RAGFlow 的登录页是压缩后的单页应用产物，
# 改 bundle 会在镜像升级时静默失效；nginx 层是请求路径上的稳定切点。
SSO_NGINX_DIR="${RAGFLOW_SSO_NGINX_DIR:-/etc/nginx/sso}"
SSO_NGINX_CONF="$SSO_NGINX_DIR/ragflow-sso.conf"

render_sso_nginx() {
  local channel="${RAGFLOW_SSO_CHANNEL:-keycloak}"
  local html="${RAGFLOW_SSO_HTML:-$SSO_NGINX_DIR/login-sso.html}"
  local kc_public="${EAP_PUBLIC_KEYCLOAK_ORIGIN:-}"
  local rag_public="${EAP_PUBLIC_RAGFLOW_ORIGIN:-}"
  local client_id="${RAGFLOW_OAUTH_CLIENT_ID:-}"
  local realm="${RAGFLOW_OAUTH_REALM:-enterprise}"

  mkdir -p "$SSO_NGINX_DIR"

  if [ "$(sso_provided_count)" -ne 4 ]; then
    rm -f "$SSO_NGINX_CONF"
    echo "[eap-sso] 未启用 SSO，不生成登录拦截配置（RAGFlow 保持原生登录页）"
    return 0
  fi

  # 拦截页里的渠道名必须与实际渠道一致，否则点「立即继续」会跳到不存在的渠道
  if [ ! -f "$html" ]; then
    echo "[eap-sso] 错误：拦截页 $html 不存在（compose 里没挂载 login-sso.html）" >&2
    return 1
  fi
  if ! grep -q "/v1/user/login/${channel}" "$html"; then
    echo "[eap-sso] 错误：拦截页 $html 里没有渠道 ${channel} 的跳转地址" >&2
    echo "          请同步 login-sso.html 中的 /v1/user/login/<channel>，或改 RAGFLOW_SSO_CHANNEL" >&2
    return 1
  fi

  # ── 登出链路的三个地址 ──────────────────────────────────────────────
  # end_session 端点：Keycloak 的 RP-initiated logout 入口
  local kc_logout_url="${kc_public}/realms/${realm}/protocol/openid-connect/logout"
  # 登出后回落的地址：必须是客户端 post.logout.redirect.uris 里登记过的值，
  # 否则 Keycloak 返回 400（invalid_redirect_uri）。
  # 登记值形如 http://<host>:8095/* —— Keycloak 26 的多值分隔符是 ##（不是逗号）。
  local logout_redirect="${rag_public}/logout-done.html"
  local logout_redirect_encoded client_id_encoded
  logout_redirect_encoded="$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$logout_redirect")"
  client_id_encoded="$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$client_id")"
  local cookie_secure=""
  case "$rag_public" in
    https://*) cookie_secure="; Secure" ;;
  esac

  cat > "$SSO_NGINX_CONF" <<EOF
# 由 eap-entrypoint.sh 生成，容器每次启动都会重写，请勿手工编辑。
#
# Keycloak 单点登录拦截：/login 不再直接渲染本地账号表单，
# 而是先到中文拦截页（说明 + 兜底链接），再由它跳 Keycloak 授权。
# ?local=1 保留 RAGFlow 原本的本地账号表单，供应急使用。
#
# —— 登出语义 ——
# 企业 SSO：eap_sso_logout=keycloak，结束 Keycloak 会话。
# 本地账号：eap_sso_logout=password，只结束 RAGFlow 会话。
# eap_kc_id_token 由 OAuth 回调写入；缺失时走 Keycloak 确认页，不能提前显示成功。
location = /login {
    error_page 418 = @ragflow_local_login;
    if (\$arg_local = "1") { return 418; }
    if (\$cookie_eap_sso_logout = "password") { return 302 /logout-local; }
    if (\$cookie_eap_sso_logout != "") { return 302 /logout-sso; }
    return 302 /login-sso.html;
}

location = /login-sso.html {
    root $SSO_NGINX_DIR;
    add_header Cache-Control "no-store";
}

location = /logout-local {
    add_header Set-Cookie "eap_sso_logout=; Path=/; Max-Age=0${cookie_secure}; HttpOnly; SameSite=Lax" always;
    return 302 /logout-done.html?local=1;
}

# 有 id_token_hint 时静默结束；缺失时由 Keycloak 显示确认页。
location = /logout-sso {
    add_header Set-Cookie "eap_sso_logout=; Path=/; Max-Age=0${cookie_secure}; HttpOnly; SameSite=Lax" always;
    if (\$cookie_eap_kc_id_token = "") {
        return 302 ${kc_logout_url}?client_id=${client_id_encoded}&post_logout_redirect_uri=${logout_redirect_encoded};
    }
    return 302 ${kc_logout_url}?client_id=${client_id_encoded}&id_token_hint=\$cookie_eap_kc_id_token&post_logout_redirect_uri=${logout_redirect_encoded};
}

location = /logout-done.html {
    root $SSO_NGINX_DIR;
    add_header Cache-Control "no-store";
    add_header Set-Cookie "eap_sso_logout=; Path=/; Max-Age=0${cookie_secure}; HttpOnly; SameSite=Lax" always;
    add_header Set-Cookie "eap_kc_id_token=; Path=/; Max-Age=0${cookie_secure}; HttpOnly; SameSite=Lax" always;
}

location @ragflow_local_login {
    root /ragflow/web/dist;
    try_files /index.html =404;
}
EOF

  echo "[eap-sso] 已启用登录拦截：/login → /login-sso.html → /v1/user/login/${channel}（?local=1 走本地账号表单）"
  echo "[eap-sso] 已启用登出拦截：企业 SSO 经 ${kc_logout_url}，本地账号只退出 RAGFlow"
}

# ── RAGFlow 登出补丁（按渠道处理 SSO / 本地账号）────────────────────────
#
# 目的：企业 SSO 登录在 RAGFlow 登出时同步结束 Keycloak 会话；本地账号不触碰 SSO。
# 补丁给 OAuth 回调写入 id_token Cookie、给登出写入渠道标记 Cookie，
# nginx 据此选择静默 end_session、Keycloak 确认页或本地账号完成页。
#
# 只在启用 SSO 时打：未启用 SSO 时这两个 Cookie 没有意义，
# 也不必改动上游文件（升级镜像后不必重新适配）。
#
# 补丁脚本自带幂等判断与锚点校验，上游结构变了会直接退出 1，
# 不允许「补丁没生效但服务照常启动」的静默失败。
SSO_PATCH_SCRIPT="${RAGFLOW_SSO_PATCH_SCRIPT:-/ragflow/eap-patch-sso-logout.py}"
SSO_PATCH_TARGET="${RAGFLOW_SSO_PATCH_TARGET:-/ragflow/api/apps/user_app.py}"

patch_sso_logout() {
  if [ "$(sso_provided_count)" -ne 4 ]; then
    echo "[eap-patch] 未启用 SSO，跳过登出补丁"
    return 0
  fi

  if [ ! -f "$SSO_PATCH_SCRIPT" ]; then
    echo "[eap-patch] 错误：登出补丁脚本 $SSO_PATCH_SCRIPT 不存在（compose 里没挂载）" >&2
    return 1
  fi

  python3 "$SSO_PATCH_SCRIPT" "$SSO_PATCH_TARGET"
}

patch_infinity_pool_size() {
  if [[ ! -f "$TARGET" ]]; then
    echo "[eap-patch] 警告：${TARGET} 不存在，跳过补丁" >&2
    return 0
  fi

  if grep -q "max_size=${WANT}" "$TARGET"; then
    echo "[eap-patch] Infinity ConnectionPool max_size 已是 ${WANT}，无需修改"
    return 0
  fi

  if grep -q "max_size=32" "$TARGET"; then
    sed -i "s/max_size=32/max_size=${WANT}/" "$TARGET"
    if grep -q "max_size=${WANT}" "$TARGET"; then
      echo "[eap-patch] Infinity ConnectionPool max_size: 32 -> ${WANT}"
      return 0
    fi
    echo "[eap-patch] 错误：替换后未找到 max_size=${WANT}" >&2
    return 1
  fi

  echo "[eap-patch] 错误：${TARGET} 中既无 max_size=32 也无 max_size=${WANT}，" >&2
  echo "[eap-patch]        上游结构可能已变更，拒绝静默启动。" >&2
  return 1
}

patch_infinity_pool_size
render_sso_config
render_sso_nginx
patch_sso_logout

# 交回官方入口（保持 WORKDIR=/ragflow，env 原样继承）
exec /ragflow/entrypoint.sh
