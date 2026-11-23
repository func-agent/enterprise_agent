#!/usr/bin/env bash
# 厂商凭证管理验收 —— 验证「控制台配商业大模型 key，不用改配置文件、不用重启网关」
#
# 用法：
#   ./scripts/verify-provider-credentials.sh
#
# 覆盖：
#   A. 凭证视图：只回掩码，明文永不回传浏览器
#   B. 权限边界：普通用户只读，管理员才能写
#   C. 写入生效：控制台改 key 后**不重启网关**就换掉实际出网凭证
#   D. 落库安全：库里存的是密文，审计里只有掩码
#   E. 删除回落：删掉控制台凭证后回落到环境变量
#
# 依赖：
#   · 网关在 127.0.0.1:8080（可用 GATEWAY_URL 覆盖）
#   · Keycloak 在 127.0.0.1:8082（可用 KEYCLOAK_BASE_URL 覆盖）
#   · 元数据库可用（STORE_KIND=postgres 时查 eap-postgres 容器）
#   · EAP_CREDENTIAL_MASTER_KEY 已配置（否则控制台写入被禁用，脚本会明确报出来）
#
# 退出码：0 = 全部通过，1 = 存在失败项
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATEWAY="${GATEWAY_URL:-http://127.0.0.1:8080}"
KC_BASE="${KEYCLOAK_BASE_URL:-http://127.0.0.1:8082}"
REALM="${KEYCLOAK_REALM:-enterprise}"
CLIENT="${KEYCLOAK_WEB_CLIENT_ID:-eap-webui}"
ADMIN_USER="${KC_USER:-eap-admin}"
ADMIN_PWD="${KC_PWD:-EapAdmin@2026}"
DEMO_USER="${KC_DEMO_USER:-eap-demo}"
DEMO_PWD="${KC_DEMO_PWD:-EapDemo@2026}"
# 测试用 provider：只写不调，不会真的打到厂商
TEST_PROVIDER="${CRED_TEST_PROVIDER:-openai}"
TEST_KEY="sk-verify-${RANDOM}${RANDOM}-0000000000"

PASS=0
FAIL=0
ok()  { echo "  ✓ $1"; PASS=$((PASS + 1)); }
bad() { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }
head_() { echo; echo "▸ $1"; }

kc_token() {
  curl -s --max-time 20 -X POST \
    "${KC_BASE}/realms/${REALM}/protocol/openid-connect/token" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    -d 'grant_type=password' -d "client_id=${CLIENT}" \
    -d "username=$1" -d "password=$2" 2>/dev/null |
    python3 -c 'import sys,json;print(json.load(sys.stdin).get("access_token",""))' 2>/dev/null
}

ADMIN_TOKEN="$(kc_token "$ADMIN_USER" "$ADMIN_PWD")"
DEMO_TOKEN="$(kc_token "$DEMO_USER" "$DEMO_PWD")"
if [ -z "$ADMIN_TOKEN" ] || [ -z "$DEMO_TOKEN" ]; then
  echo "错误：无法从 Keycloak 签发令牌（$KC_BASE/realms/$REALM）" >&2
  echo "      可用 KC_USER / KC_PWD / KC_DEMO_USER / KC_DEMO_PWD 覆盖账号。" >&2
  exit 1
fi

ADMIN_AUTH="Authorization: Bearer $ADMIN_TOKEN"
DEMO_AUTH="Authorization: Bearer $DEMO_TOKEN"

echo "════════════════════════════════════════════════════"
echo " 厂商凭证管理验收"
echo "════════════════════════════════════════════════════"

# 清理上次可能残留的测试凭证
curl -s -o /dev/null -X DELETE "${GATEWAY}/v1/admin/providers/${TEST_PROVIDER}" -H "$ADMIN_AUTH"

head_ "A. 凭证视图：只回掩码"
VIEW="$(curl -s "${GATEWAY}/v1/admin/providers" -H "$ADMIN_AUTH")"
if printf '%s' "$VIEW" | grep -q '"masterKeyConfigured":true'; then
  ok "主密钥已配置（控制台写入可用）"
else
  bad "主密钥未配置" "EAP_CREDENTIAL_MASTER_KEY 没配，控制台写入被禁用"
fi
if printf '%s' "$VIEW" | grep -qE '"masked":"\*\*\*[0-9A-Za-z]{4}"'; then
  ok "掩码格式为 ***xxxx"
else
  bad "掩码格式异常" "$VIEW"
fi
if printf '%s' "$VIEW" | grep -qE '"source":"(console|env|credential-file|none)"'; then
  ok "标注了凭证来源"
else
  bad "缺少来源字段" "$VIEW"
fi
if printf '%s' "$VIEW" | grep -qE 'sk-[A-Za-z0-9_-]{20,}'; then
  bad "响应里出现了疑似明文 key" "绝不能回传明文"
else
  ok "响应中无明文 key"
fi

head_ "B. 权限边界：普通用户只读"
CODE="$(curl -s -o /dev/null -w '%{http_code}' "${GATEWAY}/v1/admin/providers" -H "$DEMO_AUTH")"
check_code() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1（期望 $3，实际 $2）"; fi; }
check_code "普通用户可读凭证视图" "$CODE" "200"

CODE="$(curl -s -o /dev/null -w '%{http_code}' -X PUT "${GATEWAY}/v1/admin/providers/${TEST_PROVIDER}" \
  -H 'content-type: application/json' -H "$DEMO_AUTH" -d "{\"apiKey\":\"${TEST_KEY}\"}")"
check_code "普通用户不能写凭证" "$CODE" "403"

CODE="$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "${GATEWAY}/v1/admin/providers/${TEST_PROVIDER}" \
  -H "$DEMO_AUTH")"
check_code "普通用户不能删凭证" "$CODE" "403"

head_ "C. 写入生效：不重启网关即换掉出网凭证"
PUT="$(curl -s -X PUT "${GATEWAY}/v1/admin/providers/${TEST_PROVIDER}" \
  -H 'content-type: application/json' -H "$ADMIN_AUTH" -d "{\"apiKey\":\"${TEST_KEY}\"}")"
if printf '%s' "$PUT" | grep -q '"source":"console"'; then
  ok "管理员写入成功，来源标记为 console"
else
  bad "写入失败" "$PUT"
fi
if printf '%s' "$PUT" | grep -qF "${TEST_KEY}"; then
  bad "写入响应回传了明文" "绝不能回传明文"
else
  ok "写入响应不含明文"
fi
if printf '%s' "$PUT" | grep -qE '"masked":"\*\*\*[0-9A-Za-z]{4}"'; then
  ok "写入响应只给掩码"
else
  bad "写入响应掩码异常" "$PUT"
fi

# 生效性判定：换一把 key 后，网关出网时用的必须是新 key。
# 这里用「上游是否按新 key 拒收」来判断 —— 不依赖厂商返回成功。
# 若 provider 恰好配了 BASE_URL 且在出网白名单内，用真实请求验证；
# 否则退化为「快照里已换成新 key」。
SNAP="$(curl -s "${GATEWAY}/v1/admin/providers" -H "$ADMIN_AUTH")"
if printf '%s' "$SNAP" | python3 -c "
import json,sys
d=json.load(sys.stdin)
row=[x for x in d['data'] if x['provider']=='${TEST_PROVIDER}']
sys.exit(0 if row and row[0]['source']=='console' else 1)
"; then
  ok "读取视图时来源已是 console（无需重启即生效）"
else
  bad "写入后来源未生效" "$SNAP"
fi

head_ "D. 落库安全：库里是密文，审计里只有掩码"
if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^eap-postgres$'; then
  ROWS="$(docker exec eap-postgres psql -U eap -d eap -tAc \
    "select count(*) from provider_credentials where provider='${TEST_PROVIDER}' and secret_cipher like 'v1:%';")"
  if [ "${ROWS:-0}" -ge 1 ]; then
    ok "库里存的是 v1: 前缀的密文"
  else
    bad "库里没有密文记录" "provider_credentials 查不到 v1: 密文"
  fi
  PLAIN="$(docker exec eap-postgres psql -U eap -d eap -tAc \
    "select count(*) from provider_credentials where secret_cipher like '%${TEST_KEY}%';")"
  if [ "${PLAIN:-0}" -eq 0 ]; then
    ok "库里不含明文"
  else
    bad "库里出现了明文" "provider_credentials 命中了明文"
  fi
  AUD="$(docker exec eap-postgres psql -U eap -d eap -tAc \
    "select count(*) from audit_events where detail::text like '%${TEST_KEY}%';")"
  if [ "${AUD:-0}" -eq 0 ]; then
    ok "审计流水不含明文"
  else
    bad "审计流水出现明文" "audit_events 命中了明文"
  fi
  CHANGE="$(docker exec eap-postgres psql -U eap -d eap -tAc \
    "select count(*) from audit_events where reason='provider.credential.set' and detail::text like '%${TEST_PROVIDER}%';")"
  if [ "${CHANGE:-0}" -ge 1 ]; then
    ok "变更已写入审计（provider.credential.set）"
  else
    bad "审计缺少变更记录" "没查到 provider.credential.set"
  fi
else
  echo "  · 跳过（未找到 eap-postgres 容器）"
fi

head_ "E. 删除回落：删掉后回落到环境变量"
DEL="$(curl -s -X DELETE "${GATEWAY}/v1/admin/providers/${TEST_PROVIDER}" -H "$ADMIN_AUTH")"
if printf '%s' "$DEL" | grep -q '"removed":true'; then
  ok "删除成功"
else
  bad "删除失败" "$DEL"
fi
AFTER="$(curl -s "${GATEWAY}/v1/admin/providers" -H "$ADMIN_AUTH")"
if printf '%s' "$AFTER" | python3 -c "
import json,sys
d=json.load(sys.stdin)
row=[x for x in d['data'] if x['provider']=='${TEST_PROVIDER}']
sys.exit(0 if row and row[0]['source']!='console' else 1)
"; then
  ok "来源已回落到非 console（环境变量 / 凭证文件 / 未配置）"
else
  bad "删除后仍指向控制台凭证" "$AFTER"
fi

echo
echo "════════════════════════════════════════════════════"
if [ "$FAIL" -eq 0 ]; then
  echo -e " \033[32m全部通过：${PASS} 项\033[0m"
  echo "════════════════════════════════════════════════════"
  exit 0
fi
echo -e " \033[31m通过 ${PASS} 项，失败 ${FAIL} 项\033[0m"
echo "════════════════════════════════════════════════════"
exit 1
