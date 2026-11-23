#!/usr/bin/env bash
#
# 孤儿卷清理 —— 删除平台历史遗留、已不被任何容器引用的 docker 卷。
#
# ⚠ 为什么需要人工执行：产品安全策略会拦截 AI 侧直接调用 `docker volume rm`
#   （不可逆销毁类命令）。本脚本把「删除前该做的所有核对」固化下来，
#   由人在终端确认后执行，避免误删正在使用的卷。
#
# 用法：
#   bash scripts/cleanup-orphan-volumes.sh          # 预检 + 打印将删除清单（不动数据）
#   bash scripts/cleanup-orphan-volumes.sh --yes    # 预检通过后真正删除
#
# 三重安全校验（任一不通过即中止该卷）：
#   1. 卷名在硬编码白名单里 —— 绝不靠通配符匹配，避免误伤形近的卷
#   2. 该卷未被任何容器引用（含已停止的容器）
#   3. 该卷不在「当前在用卷」名单里
#
set -uo pipefail

# —— 硬编码白名单：历史遗留卷（全部为**未被引用**的旧卷）
ORPHAN_VOLUMES=(
  # 早期 compose 用的匿名卷
  a787f08b5f5406e56821ab02eacc97bf75b75286a89023b7b91d729973ce284d
  # 旧命名体系（**下划线**）——已被 eapheavy_* / eap-* 取代
  eap_clickhouse-data
  eap_dbgpt-data
  eap_infinity-data
  eap_infinity-ragflow-data
  eap_keycloak-data
  eap_minio-data
  eap_mysql-data
  eap_pg-data
  eap_ragflow-data
  eap_ragflow-logs
  eap_redis-data
  eap_tei-cache
  eapheavy_mysql_data
  eapheavy_platform-data
)

# —— 当前在用卷：**绝不删除**（平台栈用连字符，重型栈用下划线 + eapheavy_ 前缀）
PROTECTED_VOLUMES=(
  eap-pg-data eap-redis-data eap-minio-data
  eapheavy_clickhouse-data eapheavy_dbgpt-data eapheavy_infinity-data
  eapheavy_infinity-ragflow-data eapheavy_keycloak-data eapheavy_minio-data
  eapheavy_mysql-data eapheavy_pg-data eapheavy_ragflow-data eapheavy_ragflow-logs
  eapheavy_redis-data eapheavy_tei-cache
)

ASSUME_YES=0
[ "${1:-}" = "--yes" ] && ASSUME_YES=1

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; RESET=$'\033[0m'
printf '\n\x1b[1m▸ 孤儿卷清理\x1b[0m\n\n'

# —— 1. 在用卷反查（以 docker 实际状态为准，而不是硬编码信任）
mapfile -t IN_USE < <(
  docker volume ls --format '{{.Name}}' | while read -r v; do
    if docker ps -a --filter "volume=$v" --format '{{.Names}}' | grep -q .; then
      echo "$v"
    fi
  done
)

printf '  当前被容器引用的卷：%d 个\n' "${#IN_USE[@]}"
for v in "${IN_USE[@]}"; do printf "    %s ← 在用，保留%s\n" "$v" "$RESET"; done
printf '\n'

is_in_use() {
  local target="$1" v
  for v in "${IN_USE[@]}"; do
    [ "$v" = "$target" ] && return 0
  done
  return 1
}

is_protected() {
  local target="$1" v
  for v in "${PROTECTED_VOLUMES[@]}"; do
    [ "$v" = "$target" ] && return 0
  done
  return 1
}

# —— 2. 逐卷校验，生成待删清单
TO_DELETE=()
SKIPPED=0
for v in "${ORPHAN_VOLUMES[@]}"; do
  if ! docker volume inspect "$v" >/dev/null 2>&1; then
    printf '  %s- %s（卷已不存在，跳过）%s\n' "$DIM" "$v" "$RESET"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi
  if is_in_use "$v"; then
    printf '  %s! %s 仍被容器引用 —— 保留%s\n' "$RED" "$v" "$RESET"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi
  if is_protected "$v"; then
    printf '  %s! %s 命中在用卷保护名单 —— 保留%s\n' "$RED" "$v" "$RESET"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi
  size=$(du -sh "$(docker volume inspect -f '{{.Mountpoint}}' "$v" 2>/dev/null)" 2>/dev/null | cut -f1)
  printf '  %s✓ %s  %s（未引用，可删）%s\n' "$GREEN" "$v" "${size:-?}" "$RESET"
  TO_DELETE+=("$v")
done

printf '\n  待删除 %d 个，跳过 %d 个\n' "${#TO_DELETE[@]}" "$SKIPPED"

if [ "${#TO_DELETE[@]}" -eq 0 ]; then
  printf '\n%s没有需要清理的卷。%s\n\n' "$GREEN" "$RESET"
  exit 0
fi

# —— 3. 确认
if [ "$ASSUME_YES" -ne 1 ]; then
  printf '\n%s这是预检模式，未删除任何卷。%s\n' "$YELLOW" "$RESET"
  printf '确认无误后执行：%sbash scripts/cleanup-orphan-volumes.sh --yes%s\n\n' "$DIM" "$RESET"
  exit 0
fi

printf '\n  开始删除…\n'
FAILED=0
for v in "${TO_DELETE[@]}"; do
  if docker volume rm "$v" >/dev/null 2>&1; then
    printf '  %s✓ 已删除 %s%s\n' "$GREEN" "$v" "$RESET"
  else
    printf '  %s✗ 删除失败 %s%s\n' "$RED" "$v" "$RESET"
    FAILED=$((FAILED + 1))
  fi
done

# —— 4. 删除后校验：在用卷必须完好
printf '\n  删除后校验在用卷：\n'
BROKEN=0
for v in "${PROTECTED_VOLUMES[@]}"; do
  if docker volume inspect "$v" >/dev/null 2>&1; then
    printf '    %s✓ %s%s\n' "$GREEN" "$v" "$RESET"
  else
    printf '    %s✗ %s 丢失！%s\n' "$RED" "$v" "$RESET"
    BROKEN=$((BROKEN + 1))
  fi
done

printf '\n'
if [ "$FAILED" -eq 0 ] && [ "$BROKEN" -eq 0 ]; then
  printf '%s清理完成：删除 %d 个，失败 0 个，在用卷全部完好。%s\n\n' "$GREEN" "${#TO_DELETE[@]}" "$RESET"
  exit 0
fi
printf '%s删除失败 %d 个，在用卷异常 %d 个 —— 请检查。%s\n\n' "$RED" "$FAILED" "$BROKEN" "$RESET"
exit 1
