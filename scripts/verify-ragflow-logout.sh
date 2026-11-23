#!/usr/bin/env bash
# RAGFlow 登出链路验收 —— 验证「登出即结束 Keycloak 单点登录会话」
#
# 用法：
#   ./scripts/verify-ragflow-logout.sh
#
# 覆盖三条链路：
#   A. 登出链路：SSO 登录 → 登出 → RAGFlow token 失效 → end_session → Keycloak 会话已死
#   B. 回归链路：未登出时再次授权直接拿到 code，确认真正的 SSO 免密
#   C. 边界链路：缺少 id_token 时走确认页；本地账号不触碰企业 SSO
#
# 地址与账号：
#   · 默认从 deploy/compose/.env 读 EAP_PUBLIC_RAGFLOW_ORIGIN / EAP_PUBLIC_KEYCLOAK_ORIGIN；
#   · 账号默认 eap-admin / EapAdmin@2026（enterprise realm 的演示管理员），
#     可用环境变量 KC_USER / KC_PWD 覆盖。
#
# 退出码：0 = 全部通过，1 = 存在失败项
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# 只读需要的键，不整份 source（避免覆盖调用方的运行环境变量）
read_env_val() {
  local key="$1" default="$2" file="$ROOT_DIR/deploy/compose/.env"
  [ -f "$file" ] || { echo "$default"; return; }
  local v
  v=$(grep -E "^${key}=" "$file" | tail -1 | cut -d= -f2-)
  echo "${v:-$default}"
}

ORIGIN="${EAP_PUBLIC_RAGFLOW_ORIGIN:-$(read_env_val EAP_PUBLIC_RAGFLOW_ORIGIN '')}"
KC_ORIGIN="${EAP_PUBLIC_KEYCLOAK_ORIGIN:-$(read_env_val EAP_PUBLIC_KEYCLOAK_ORIGIN '')}"
REALM="${KEYCLOAK_REALM:-$(read_env_val KEYCLOAK_REALM enterprise)}"
CLIENT="${RAGFLOW_OAUTH_CLIENT_ID:-$(read_env_val RAGFLOW_OAUTH_CLIENT_ID eap-ragflow)}"
USER_NAME="${KC_USER:-eap-admin}"
USER_PWD="${KC_PWD:-EapAdmin@2026}"

if [ -z "$ORIGIN" ] || [ -z "$KC_ORIGIN" ]; then
  echo "错误：缺少 EAP_PUBLIC_RAGFLOW_ORIGIN / EAP_PUBLIC_KEYCLOAK_ORIGIN，" >&2
  echo "      请在 deploy/compose/.env 里配置（或用环境变量覆盖）。" >&2
  exit 1
fi

REDIRECT="$ORIGIN/v1/user/oauth/callback/keycloak"
AUTHZ="$KC_ORIGIN/realms/$REALM/protocol/openid-connect/auth"
JAR="$(mktemp /tmp/rf-logout-jar.XXXXXX)"
TMPD="$(mktemp -d /tmp/rf-logout.XXXXXX)"
trap 'rm -f "$JAR"; rm -rf "$TMPD"' EXIT

PASS=0
FAIL=0
ok()  { echo "  ✓ $1"; PASS=$((PASS + 1)); }
bad() { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1（期望 $3，实际 $2）"; fi; }

# 从 Keycloak 登录页里取出表单 action
login_form_action() {
  python3 - "$1" <<'PY'
import re, html, sys
h = open(sys.argv[1], encoding='utf-8', errors='replace').read()
m = re.search(r'<form[^>]+action="([^"]+)"', h)
print(html.unescape(m.group(1)) if m else '')
PY
}

# 取 Keycloak 授权 URL 里的 state
extract_state() {
  python3 - "$1" <<'PY'
import sys, urllib.parse
print(urllib.parse.parse_qs(urllib.parse.urlparse(sys.argv[1]).query).get('state', [''])[0])
PY
}

echo "══ RAGFlow 登出链路验收 ══"
echo "  RAGFlow : $ORIGIN"
echo "  Keycloak: $KC_ORIGIN  realm=$REALM client=$CLIENT"
echo "  账号    : $USER_NAME"
echo

echo "▸ A. 登出链路"
AUTH_URL="$(curl -s -c "$JAR" -b "$JAR" -o /dev/null -w '%{redirect_url}' "$ORIGIN/v1/user/login/keycloak")"
STATE="$(extract_state "$AUTH_URL")"
if [ -n "$STATE" ]; then ok "取到 OAuth state"; else bad "没取到 OAuth state"; fi

ACTION="$(curl -s -c "$JAR" -b "$JAR" -o "$TMPD/login.html" \
  "$AUTHZ?client_id=$CLIENT&redirect_uri=$REDIRECT&response_type=code&scope=openid+profile+email" \
  && login_form_action "$TMPD/login.html")"
CODE="$(curl -s -c "$JAR" -b "$JAR" -o /dev/null -w '%{redirect_url}' \
  -d "username=$USER_NAME" -d "password=$USER_PWD" -d "credentialId=" "$ACTION" \
  | python3 -c "
import sys, urllib.parse
print(urllib.parse.parse_qs(urllib.parse.urlparse(sys.stdin.read().strip()).query).get('code', [''])[0])
")"
if [ -n "$CODE" ]; then ok "Keycloak 登录成功"; else bad "Keycloak 登录失败"; fi

CB_HDR="$TMPD/callback.headers"
curl -s -c "$JAR" -b "$JAR" -D "$CB_HDR" -o /dev/null "$REDIRECT?code=$CODE&state=$STATE"
if grep -qi "set-cookie: eap_kc_id_token=" "$CB_HDR"; then
  ok "回调下发 id_token Cookie（供登出时作 id_token_hint）"
else
  bad "回调没有下发 id_token Cookie"
fi

AUTH_TOKEN="$(python3 - "$CB_HDR" <<'PY'
import re, sys
from urllib.parse import urlparse, parse_qs
h = open(sys.argv[1], encoding='utf-8', errors='replace').read()
m = re.search(r'(?im)^location:\s*([^\r\n]+)', h)
print(parse_qs(urlparse(m.group(1).strip()).query).get('auth', [''])[0] if m else '')
PY
)"
if [ -n "$AUTH_TOKEN" ]; then ok "取到 RAGFlow 访问令牌"; else bad "没取到 RAGFlow 访问令牌"; fi

LO_HDR="$TMPD/logout.headers"
curl -s -c "$JAR" -b "$JAR" -D "$LO_HDR" -o "$TMPD/logout.json" \
  "$ORIGIN/v1/user/logout" -H "Authorization: $AUTH_TOKEN"
if grep -qi "set-cookie: eap_sso_logout=keycloak" "$LO_HDR"; then
  ok "登出响应写了 eap_sso_logout=keycloak 标记"
else
  bad "登出响应没写企业 SSO 登出标记"
fi

OLD_INFO_HTTP="$(curl -s -c "$JAR" -b "$JAR" -o "$TMPD/old-info.json" -w '%{http_code}' \
  "$ORIGIN/v1/user/info" -H "Authorization: $AUTH_TOKEN")"
OLD_INFO_STATE="$(python3 - "$OLD_INFO_HTTP" "$TMPD/old-info.json" <<'PY'
import json, sys
status = int(sys.argv[1])
try:
    code = json.load(open(sys.argv[2], encoding='utf-8')).get('code')
except Exception:
    code = None
if status in (401, 403) or (status == 200 and code == 401):
    print('rejected')
else:
    print(f'HTTP-{status}-code-{code}')
PY
)"
check "登出后旧 RAGFlow 访问令牌已失效" "$OLD_INFO_STATE" "rejected"

LOGIN_LOC="$(curl -s -c "$JAR" -b "$JAR" -o /dev/null -w '%{redirect_url}' "$ORIGIN/login")"
case "$LOGIN_LOC" in
  */logout-sso) ok "登出后 /login 跳到 /logout-sso（不再走免密入口）" ;;
  *) bad "登出后 /login 行为异常：$LOGIN_LOC" ;;
esac

LS_LOC="$(curl -s -c "$JAR" -b "$JAR" -o /dev/null -w '%{redirect_url}' "$ORIGIN/logout-sso")"
case "$LS_LOC" in
  *"openid-connect/logout"*) ok "/logout-sso 跳 Keycloak end_session" ;;
  *) bad "/logout-sso 没有跳 end_session：$LS_LOC" ;;
esac
case "$LS_LOC" in
  *"id_token_hint="*) ok "end_session 带了 id_token_hint（否则 Keycloak 只弹确认页）" ;;
  *) bad "end_session 缺少 id_token_hint" ;;
esac

KC_LO_HDR="$TMPD/kc-logout.headers"
curl -s -c "$JAR" -b "$JAR" -D "$KC_LO_HDR" -o "$TMPD/kc-logout.html" "$LS_LOC"
KC_LOC="$(grep -i '^location:' "$KC_LO_HDR" | head -1 | tr -d '\r' | sed 's/^[Ll]ocation: //')"
case "$KC_LOC" in
  *logout-done.html) ok "Keycloak 静默结束会话并回跳已退出页" ;;
  *) bad "Keycloak 没有回跳已退出页：$KC_LOC" ;;
esac
if grep -qi "do you want to log out" "$TMPD/kc-logout.html"; then
  bad "出现了 Keycloak 登出确认页（会话多半没被结束）"
else
  ok "没有出现 Keycloak 确认页"
fi

curl -s -c "$JAR" -b "$JAR" -o "$TMPD/done.html" "$ORIGIN/logout-done.html"
if grep -q "已退出登录" "$TMPD/done.html"; then ok "已退出页可访问且内容正确"; else bad "已退出页内容不对"; fi

curl -s -c "$JAR" -b "$JAR" -o "$TMPD/kc-auth.html" \
  "$AUTHZ?client_id=$CLIENT&redirect_uri=$REDIRECT&response_type=code&scope=openid+profile+email"
if grep -q 'name="password"' "$TMPD/kc-auth.html"; then
  ok "Keycloak 会话已终止 → 下次登录需要输口令"
else
  bad "Keycloak 会话仍在 → 仍会被秒登回来"
fi

RL="$(curl -s -c "$JAR" -b "$JAR" -o /dev/null -w '%{redirect_url}' "$ORIGIN/login")"
case "$RL" in
  */login-sso.html) ok "一次性标记已消费，/login 回到正常 SSO 入口" ;;
  *) bad "重新访问 /login 行为异常：$RL" ;;
esac
KC_AUTH2="$(curl -s -c "$JAR" -b "$JAR" -o /dev/null -w '%{redirect_url}' "$ORIGIN/v1/user/login/keycloak")"
curl -s -c "$JAR" -b "$JAR" -o "$TMPD/kc-auth2.html" "$KC_AUTH2"
if grep -q 'name="password"' "$TMPD/kc-auth2.html"; then
  ok "点「重新登录」确实弹口令框（不再秒登）"
else
  bad "点「重新登录」没有弹口令框"
fi

echo
echo "▸ B. 回归链路：未登出时仍是 SSO 免密"
JAR2="$(mktemp /tmp/rf-sso-jar.XXXXXX)"
AUTH_URL2="$(curl -s -c "$JAR2" -b "$JAR2" -o /dev/null -w '%{redirect_url}' "$ORIGIN/v1/user/login/keycloak")"
STATE2="$(extract_state "$AUTH_URL2")"
ACTION2="$(curl -s -c "$JAR2" -b "$JAR2" -o "$TMPD/login2.html" \
  "$AUTHZ?client_id=$CLIENT&redirect_uri=$REDIRECT&response_type=code&scope=openid+profile+email" \
  && login_form_action "$TMPD/login2.html")"
CODE2="$(curl -s -c "$JAR2" -b "$JAR2" -o /dev/null -w '%{redirect_url}' \
  -d "username=$USER_NAME" -d "password=$USER_PWD" -d "credentialId=" "$ACTION2" \
  | python3 -c "
import sys, urllib.parse
print(urllib.parse.parse_qs(urllib.parse.urlparse(sys.stdin.read().strip()).query).get('code', [''])[0])
")"
curl -s -c "$JAR2" -b "$JAR2" -o /dev/null "$REDIRECT?code=$CODE2&state=$STATE2"
LOGIN2="$(curl -s -c "$JAR2" -b "$JAR2" -o /dev/null -w '%{redirect_url}' "$ORIGIN/login")"
case "$LOGIN2" in
  */login-sso.html) ok "未登出时 /login 仍跳 /login-sso.html（免密体验保留）" ;;
  *) bad "未登出时 /login 行为变了：$LOGIN2" ;;
esac
SILENT_AUTH_URL="$(curl -s -c "$JAR2" -b "$JAR2" -o /dev/null -w '%{redirect_url}' "$ORIGIN/v1/user/login/keycloak")"
SILENT_LOC="$(curl -s -c "$JAR2" -b "$JAR2" -o "$TMPD/silent-auth.html" -w '%{redirect_url}' "$SILENT_AUTH_URL")"
case "$SILENT_LOC" in
  *"/v1/user/oauth/callback/keycloak"*"code="*) ok "未登出时再次授权直接返回 code（真实 SSO 免密）" ;;
  *) bad "免密授权没有静默返回 code：$SILENT_LOC" ;;
esac
rm -f "$JAR2"

echo
echo "▸ C. 边界链路：缺失 id_token 与本地账号"
MISSING_LOC="$(curl -s -o /dev/null -w '%{redirect_url}' \
  --cookie 'eap_sso_logout=keycloak' "$ORIGIN/logout-sso")"
case "$MISSING_LOC" in
  *"openid-connect/logout"*"post_logout_redirect_uri="*)
    case "$MISSING_LOC" in
      *"id_token_hint="*) bad "缺少 id_token 时仍带了空 id_token_hint" ;;
      *) ok "缺少 id_token 时进入 Keycloak 确认登出，不提前显示成功页" ;;
    esac
    ;;
  *) bad "缺少 id_token 时没有进入 Keycloak 确认登出：$MISSING_LOC" ;;
esac
LOCAL_ENTRY_LOC="$(curl -s -o /dev/null -w '%{redirect_url}' \
  --cookie 'eap_sso_logout=password' "$ORIGIN/login")"
LOCAL_LOC=""
case "$LOCAL_ENTRY_LOC" in
  */logout-local)
    LOCAL_LOC="$(curl -s -o /dev/null -w '%{redirect_url}' \
      --cookie 'eap_sso_logout=password' "$ORIGIN/logout-local")"
    ;;
esac
case "$LOCAL_LOC" in
  *"/logout-done.html?local=1") ok "本地账号只走本地完成页，不触碰企业 SSO" ;;
  *) bad "本地账号登出分支异常：入口=$LOCAL_ENTRY_LOC 落点=$LOCAL_LOC" ;;
esac

echo
echo "══ 验收：通过 $PASS 项，失败 $FAIL 项 ══"
[ "$FAIL" -eq 0 ]
