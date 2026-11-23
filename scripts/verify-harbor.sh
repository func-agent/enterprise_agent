#!/usr/bin/env bash
# =============================================================================
# Harbor 2.x 验收脚本 —— 方案 3.1「镜像 / Harbor 2.x / P1 / 离线镜像仓」
#
# 镜像仓的验收不能只看「容器在跑」，必须**真实推拉一次**：
#   建项目 → docker push → 删本地 → docker pull 拉回来 → API 能查到
# 只跑通 API 健康检查不算数 —— 那种「通过」不代表真能存镜像。
#
# 用法：./scripts/verify-harbor.sh
# 退出码：0 = 全部通过，1 = 存在失败项
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

HARBOR_PORT="${HARBOR_HOST_PORT:-8098}"
# API 走回环即可；docker push/pull 必须用 Harbor 的 hostname
# （Harbor 拒绝把 127.0.0.1 当 hostname，见 docs/harbor.md 的 hosts 别名说明）
HARBOR_API="http://127.0.0.1:${HARBOR_PORT}"
HARBOR_REG="${HARBOR_REGISTRY:-harbor.eap.local:${HARBOR_PORT}}"
HARBOR_USER="${HARBOR_USER:-admin}"
HARBOR_PASS="${HARBOR_PASS:-Harbor12345}"
PROJECT="${HARBOR_PROJECT:-eap}"
# 拿平台已有的小镜像做推拉载体（无需再拉一个）
PUSH_IMAGE="${PUSH_IMAGE:-alpine:3.20}"

PASS=0
FAIL=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }
head_() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1（期望 $2，实际 $3）"; fi; }

if docker version >/dev/null 2>&1; then DOCKER=(docker); else DOCKER=(sudo docker); fi

# ─────────────────────────────────────────────
head_ "Harbor 容器状态"
for svc in core db jobservice registry registryctl portal log redis nginx; do
  st=$("${DOCKER[@]}" ps --filter "name=^eapheavy-harbor-${svc}$" --format '{{.Status}}' 2>/dev/null | head -1)
  if [ -n "$st" ]; then
    ok "eapheavy-harbor-${svc} ${st}"
  else
    bad "eapheavy-${svc} 未运行"
  fi
done

# ─────────────────────────────────────────────
head_ "Harbor API"
HEALTH=$(curl -s --max-time 15 "${HARBOR_API}/api/v2.0/health" 2>/dev/null)
HSTATUS=$(echo "$HEALTH" | python3 -c 'import sys,json;print((json.load(sys.stdin) or {}).get("status",""))' 2>/dev/null)
check "健康端点 status" "healthy" "$HSTATUS"

SYSINFO=$(curl -s --max-time 15 -u "${HARBOR_USER}:${HARBOR_PASS}" "${HARBOR_API}/api/v2.0/systeminfo" 2>/dev/null)
HVER=$(echo "$SYSINFO" | python3 -c 'import sys,json;print((json.load(sys.stdin) or {}).get("harbor_version",""))' 2>/dev/null)
if [ -n "$HVER" ]; then ok "Harbor 版本：$HVER"; else bad "读不到 Harbor 版本：$(echo "$SYSINFO" | head -c 150)"; fi

# ─────────────────────────────────────────────
head_ "管理员登录（真实口令校验）"
AUTHDATA=$(curl -s --max-time 20 -u "${HARBOR_USER}:${HARBOR_PASS}" "${HARBOR_API}/api/v2.0/users/current" 2>/dev/null)
AUTHCODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -u "${HARBOR_USER}:${HARBOR_PASS}" "${HARBOR_API}/api/v2.0/users/current" 2>/dev/null)
check "admin 登录接口" "200" "$AUTHCODE"
SYSADMIN=$(echo "$AUTHDATA" | python3 -c 'import sys,json;print((json.load(sys.stdin) or {}).get("sysadmin_flag",""))' 2>/dev/null)
check "admin 是系统管理员" "True" "$SYSADMIN"

# ─────────────────────────────────────────────
head_ "创建项目"
# 幂等：项目已存在时 Harbor 返回 409，此时复用即可
# （项目里有镜像时 Harbor 不允许删除非空项目，所以这里不强求先删干净）
CREATE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -u "${HARBOR_USER}:${HARBOR_PASS}" \
  -X POST "${HARBOR_API}/api/v2.0/projects" -H 'Content-Type: application/json' \
  -d "{\"project_name\":\"${PROJECT}\",\"public\":false,\"metadata\":{\"public\":\"false\",\"auto_scan\":\"true\"}}" 2>/dev/null)
if [ "$CREATE" = "201" ] || [ "$CREATE" = "200" ]; then
  ok "创建项目 ${PROJECT}（HTTP $CREATE）"
elif [ "$CREATE" = "409" ]; then
  ok "项目 ${PROJECT} 已存在（HTTP 409，复用）"
else
  bad "创建项目 ${PROJECT} 失败（HTTP $CREATE）"
fi
LIST=$(curl -s --max-time 20 -u "${HARBOR_USER}:${HARBOR_PASS}" "${HARBOR_API}/api/v2.0/projects?name=${PROJECT}" 2>/dev/null)
HASPROJ=$(echo "$LIST" | python3 -c "
import sys,json
try:
    print(any(p.get('name')=='$PROJECT' for p in (json.load(sys.stdin) or [])))
except Exception:
    print(False)" 2>/dev/null)
check "项目列表中可见 ${PROJECT}" "True" "$HASPROJ"

# ─────────────────────────────────────────────
head_ "真实推送镜像（docker push → Harbor）"
REPO="${HARBOR_REG}/${PROJECT}/$(echo "$PUSH_IMAGE" | tr ':/' '__')"
# 项目默认私有 —— 推送前必须先登录，否则必然 "no basic auth credentials"
if printf '%s' "${HARBOR_PASS}" | "${DOCKER[@]}" login "${HARBOR_REG}" -u "${HARBOR_USER}" --password-stdin >/dev/null 2>&1; then
  ok "docker login ${HARBOR_REG} 成功"
else
  bad "docker login ${HARBOR_REG} 失败"
fi
"${DOCKER[@]}" tag "$PUSH_IMAGE" "${REPO}" >/dev/null 2>&1
# 用 mktemp 生成唯一名 —— 固定路径会撞 /tmp 的 sticky 位（换用户后无法 truncate）
PUSH_LOG="$(mktemp /tmp/harbor-push.XXXXXX.log)"
PULL_LOG="$(mktemp /tmp/harbor-pull.XXXXXX.log)"
if "${DOCKER[@]}" push "$REPO" >"$PUSH_LOG" 2>&1; then
  ok "docker push ${REPO} 成功"
else
  bad "docker push 失败：$(tail -3 /tmp/harbor-push.log | tr '\n' ' ')"
fi

# ─────────────────────────────────────────────
head_ "真实拉回镜像（删本地 → docker pull → 校验内容）"
# 注意：不能比 image ID。
# 本机 Docker 启用了 containerd 镜像存储（driver-type: io.containerd.snapshotter.v1），
# `docker images` 的 ID 是 **manifest digest**；而 Harbor 的 registry v2 会把
# 推上来的 OCI manifest 转成 Docker v2 schema2，manifest digest 必然变化 ——
# 但镜像内容（层）是一模一样的。所以这里比对 **RootFS 层指纹**。
layer_fingerprint() {
  docker image inspect "$1" --format '{{range .RootFS.Layers}}{{.}}{{"\n"}}{{end}}' 2>/dev/null \
    | sha256sum | cut -c1-32
}
FP_BEFORE=$(layer_fingerprint "$PUSH_IMAGE")
"${DOCKER[@]}" rmi "$REPO" >/dev/null 2>&1
if "${DOCKER[@]}" images --format '{{.Repository}}' 2>/dev/null | grep -qx "$REPO"; then
  bad "本地镜像未删掉，推回测试不成立"
else
  ok "本地镜像已删除"
  if "${DOCKER[@]}" pull "$REPO" >"$PULL_LOG" 2>&1; then
    ok "docker pull ${REPO} 成功（从 Harbor 拉回）"
  else
    bad "docker pull 失败：$(tail -3 /tmp/harbor-pull.log | tr '\n' ' ')"
  fi
fi
FP_AFTER=$(layer_fingerprint "$REPO")
if [ -n "$FP_AFTER" ] && [ "$FP_AFTER" = "$FP_BEFORE" ]; then
  ok "拉回的镜像与原镜像内容一致（层指纹 $FP_AFTER）"
else
  bad "拉回的镜像与原镜像内容不一致（原 ${FP_BEFORE:-无} / 拉回 ${FP_AFTER:-无}）"
fi

# ─────────────────────────────────────────────
head_ "镜像仓库清单"
REPOS=$(curl -s --max-time 20 -u "${HARBOR_USER}:${HARBOR_PASS}" \
  "${HARBOR_API}/api/v2.0/projects/${PROJECT}/repositories" 2>/dev/null)
RNUM=$(echo "$REPOS" | python3 -c "
import sys,json
try:
    print(len(json.load(sys.stdin) or []))
except Exception:
    print(0)" 2>/dev/null)
if [ "${RNUM:-0}" -ge 1 ]; then
  ok "项目 ${PROJECT} 下有 ${RNUM} 个仓库"
else
  bad "项目 ${PROJECT} 下没有仓库"
fi

# ─────────────────────────────────────────────
printf '\n════════════════════════════════════════════════════\n'
if [ "$FAIL" -eq 0 ]; then
  printf ' \033[32mHarbor 全部通过：%d 项\033[0m\n' "$PASS"
else
  printf ' \033[31m通过 %d 项，失败 %d 项\033[0m\n' "$PASS" "$FAIL"
fi
printf '════════════════════════════════════════════════════\n'
[ "$FAIL" -eq 0 ]
