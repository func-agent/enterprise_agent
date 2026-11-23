#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# VM 内「解法 A」：让宿主机转发进来的包能落到 loopback 上的平台服务
#
# ── 为什么需要 ───────────────────────────────────────────────────────
# 平台服务（控制台 5173 / 网关 8080 / Keycloak 8082）已按「全部绑 127.0.0.1」
# 收口。宿主机做端口转发后，包的目标地址是 VM 的 ens34 地址
# （默认 192.168.2.244），而内核默认**拒绝**把非本机发起的包路由到 127/8，
# 于是包在进到应用之前就被丢掉 —— 表现就是「转发配好了但访问不通」。
#
# 解法 A 的做法（两件事）：
#   1. net.ipv4.conf.all.route_localnet=1
#      允许内核把转发进来的包路由到 127/8（这是**必要条件**，不是充分条件）。
#   2. nat/PREROUTING 精确 DNAT：只对目标为 VM_IP 且端口在白名单里的
#      TCP 包做 DNAT → 127.0.0.1:同端口。
#      暴露面仍然只有这三个端口。
#
# ── 安全性 ───────────────────────────────────────────────────────────
# route_localnet=1 只提供「允许路由到 loopback」的能力，真正放行哪些端口
# 由下面精确到 --dport 的 DNAT 规则决定。没有对应 DNAT 规则的端口，
# 即使 route_localnet=1 也进不来。
#
# ── 幂等 ─────────────────────────────────────────────────────────────
# 重复执行只会覆盖同名规则，不会叠加。带 --remove-all 可清空本脚本的规则。
#
# 用法：
#   sudo ./scripts/setup-localnet-dnat.sh          # 应用 + 持久化
#   sudo ./scripts/setup-localnet-dnat.sh --status # 只看现状
#   sudo ./scripts/setup-localnet-dnat.sh --remove-all
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

VM_IP="${VM_IP:-192.168.2.244}"
IN_IF="${IN_IF:-ens34}"
# 放行四个：控制台 / agentgateway / Keycloak / RAGFlow Web 界面
#   5173 → Web 控制台（用户入口）
#   8080 → 网关 API（外部系统直调，可选）
#   8082 → Keycloak（OIDC 登录跳转）
#   8095 → RAGFlow Web 界面（经 nginx 代理到容器内 9380）
# 用 PORTS=... 可临时覆盖，例如只留 5173 8082：
#   PORTS="5173 8082" sudo ./scripts/setup-localnet-dnat.sh
PORTS="${PORTS:-5173 8080 8082 8095}"
# 宿主机在 VM 网段里的地址（默认网关即宿主机）。宿主机做 MASQUERADE 时，
# 转进来的包源地址就是它 —— 用它精确放行。
HOST_IP="${HOST_IP:-192.168.2.1}"
# VM 所在的局域网段（ens34 是 192.168.2.244/22 → 网段 192.168.0.0/22）。
# 源地址落在这个段里的包 = 局域网内其它机器直连，不是「宿主机转发进来的
# 外部流量」，必须挡住。
LAN_CIDR="${LAN_CIDR:-192.168.0.0/22}"
COMMENT="eap-localnet"

if [ "$(id -u)" -ne 0 ]; then
  echo "需要 root：sudo $0 ${1:-}" >&2
  exit 1
fi

command -v iptables >/dev/null || { echo "未找到 iptables" >&2; exit 1; }

rule_exists() { # rule_exists <table> <chain> <args...>
  local table="$1" chain="$2"; shift 2
  iptables -t "$table" -C "$chain" "$@" -m comment --comment "$COMMENT" 2>/dev/null
}

apply_rule() { # apply_rule <table> <chain> <args...>
  local table="$1" chain="$2"; shift 2
  if rule_exists "$table" "$chain" "$@"; then
    echo "  已存在，跳过：$table/$chain $*"
  else
    iptables -t "$table" -A "$chain" "$@" -m comment --comment "$COMMENT"
    echo "  已添加：$table/$chain $*"
  fi
}

del_rule() { # del_rule <table> <chain> <args...>
  local table="$1" chain="$2"; shift 2
  if rule_exists "$table" "$chain" "$@"; then
    iptables -t "$table" -D "$chain" "$@" -m comment --comment "$COMMENT"
    echo "  已删除：$table/$chain $*"
  fi
}

# 清掉本脚本此前写下的全部规则（按 comment 匹配），用于「先删后加」保证幂等。
# 规则参数可能随版本变化（例如新增了源地址限定），只做 -C 检查会留下旧规则。
purge_rules() {
  local table chain line args
  for table in nat; do
    for chain in PREROUTING OUTPUT; do
      while IFS= read -r line; do
        [ -n "$line" ] || continue
        # -S 输出的行首是 "-A <chain> "，去掉后即为规则参数
        args="${line#-A ${chain} }"
        # 去掉末尾的 "-m comment --comment eap-localnet"
        args="${args% -m comment --comment ${COMMENT}}"
        # shellcheck disable=SC2086
        iptables -t "$table" -D "$chain" $args 2>/dev/null && echo "  已清除旧规则：$table/$chain $args"
      done < <(iptables -t "$table" -S "$chain" 2>/dev/null | grep -- "--comment ${COMMENT}" || true)
    done
  done
}

status() {
  echo "── sysctl ──"
  sysctl net.ipv4.conf.all.route_localnet net.ipv4.conf."${IN_IF}".route_localnet 2>/dev/null || true
  echo "── nat/PREROUTING（本脚本规则）──"
  iptables -t nat -S PREROUTING | grep -- "--comment ${COMMENT}" || echo "  （无）"
  echo "── nat/OUTPUT（本脚本规则）──"
  iptables -t nat -S OUTPUT | grep -- "--comment ${COMMENT}" || echo "  （无）"
}

case "${1:-}" in
  --status)
    status
    exit 0
    ;;
  --remove-all)
    purge_rules
    echo "已清空本脚本的 DNAT 规则（sysctl 未回滚，如需回滚见文件末尾）"
    exit 0
    ;;
esac

echo "══ 应用 route_localnet + DNAT ══"
echo "   VM_IP=${VM_IP}  IN_IF=${IN_IF}  PORTS=${PORTS}"
echo "   HOST_IP=${HOST_IP:-未设}  LAN_CIDR=${LAN_CIDR:-未设}"

# ── 1. route_localnet ─────────────────────────────────────────────────
echo "[1/4] 开启 route_localnet"
# 接口级也要设：all 不会覆盖已存在接口的个别设置
sysctl -w "net.ipv4.conf.all.route_localnet=1" >/dev/null
sysctl -w "net.ipv4.conf.${IN_IF}.route_localnet=1" >/dev/null
echo "  all=1, ${IN_IF}=1"

# ── 2. 先清旧规则，再写新规则（保证参数变更后不残留）──────────────────
echo "[2/4] 清理旧的 eap-localnet 规则"
purge_rules

# ── 3. PREROUTING：宿主机转发进来的包 ─────────────────────────────────
#
# ⚠ 源地址限定是这里的关键。
# DNAT 规则一旦命中，**局域网内任何机器**直连 VM_IP:端口 也会被转进 loopback，
# 于是「只允许本机访问」的收口就失效了。所以必须区分两类来源：
#
#   规则 A：源 = 宿主机地址（宿主做了 MASQUERADE 时的源地址）
#   规则 B：源 ∉ 局域网段（宿主没做 MASQUERADE 时，源是真实客户端公网 IP）
#
# 两条规则都命中「外部入口」，而局域网内其它机器（源在 LAN_CIDR 内）两条都不命中，
# 会被直接丢弃 —— 收口不被绕过，且**不依赖宿主是否配了 MASQUERADE**。
echo "[3/4] 写入 nat/PREROUTING DNAT 规则（外部入站路径）"
if [ -n "${HOST_IP:-}" ] || [ -n "${LAN_CIDR:-}" ]; then
  for P in $PORTS; do
    if [ -n "${HOST_IP:-}" ]; then
      apply_rule nat PREROUTING -i "$IN_IF" -s "$HOST_IP/32" -d "$VM_IP/32" \
        -p tcp --dport "$P" -j DNAT --to-destination "127.0.0.1:$P"
    fi
    if [ -n "${LAN_CIDR:-}" ]; then
      apply_rule nat PREROUTING -i "$IN_IF" ! -s "$LAN_CIDR" -d "$VM_IP/32" \
        -p tcp --dport "$P" -j DNAT --to-destination "127.0.0.1:$P"
    fi
  done
else
  echo "  ⚠ 未设 HOST_IP / LAN_CIDR —— 将放行所有来源（含局域网直连），不符合收口要求"
  for P in $PORTS; do
    apply_rule nat PREROUTING -i "$IN_IF" -d "$VM_IP/32" -p tcp --dport "$P" \
      -j DNAT --to-destination "127.0.0.1:$P"
  done
fi

# ── 4. OUTPUT：VM 本机自测（curl VM_IP）─────────────────────────────
# 这一条只为「在 VM 内就能验证外网路径是否打通」，不放宽任何外部来源。
echo "[4/4] 写入 nat/OUTPUT DNAT 规则（本机自测用）"
for P in $PORTS; do
  apply_rule nat OUTPUT -d "$VM_IP/32" -p tcp --dport "$P" \
    -j DNAT --to-destination "127.0.0.1:$P"
done

# ── 持久化 ─────────────────────────────────────────────────────────────
echo "── 持久化 ──"
cat > /etc/sysctl.d/99-eap-localnet.conf <<EOF
# 由 scripts/setup-localnet-dnat.sh 生成
# 允许宿主机端口转发进来的包路由到 127/8（配合 nat/PREROUTING 的精确 DNAT 使用）
net.ipv4.conf.all.route_localnet=1
net.ipv4.conf.${IN_IF}.route_localnet=1
EOF
echo "  已写 /etc/sysctl.d/99-eap-localnet.conf"

# iptables 规则持久化：优先用 netfilter-persistent，没有则落盘一份可直接 restore 的文件
if command -v netfilter-persistent >/dev/null 2>&1; then
  netfilter-persistent save >/dev/null 2>&1 && echo "  netfilter-persistent save 完成" \
    || echo "  警告：netfilter-persistent save 失败"
else
  mkdir -p /etc/iptables
  iptables-save > /etc/iptables/rules.v4
  cat > /etc/iptables/restore-eap-localnet.sh <<EOF
#!/usr/bin/env bash
# 重启后恢复本地网 DNAT 规则（若系统装了 netfilter-persistent 可改用它）
iptables-restore < /etc/iptables/rules.v4
EOF
  chmod +x /etc/iptables/restore-eap-localnet.sh
  echo "  已落盘 /etc/iptables/rules.v4 + restore-eap-localnet.sh"
  echo "  提示：未安装 netfilter-persistent，重启后需执行 restore-eap-localnet.sh"
fi

echo
echo "══ 完成，当前规则 ══"
status
