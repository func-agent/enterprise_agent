# 宿主机管理员操作清单（外网访问平台）

> 面向**持有公网 IP 的宿主机**的管理员。VM 侧的工作**已全部完成**，
> 本清单只需要在**宿主机**上执行。
> 全程约 10 分钟，不需要改虚拟机里的任何配置。

> **关于地址占位与示例值**
> 本仓库为公开仓库，**不内置任何部署环境的真实公网地址**。
> 正文用 `<公网IP>` / `<办公出口IP>` 表示需要替换的值；Shell 示例使用文档保留地址
> `203.0.113.10`（宿主机公网 IP）和 `198.51.100.20/32`（办公出口），执行前必须替换。
> 本机实际取值也可查内部参数表 `docs/internal/host-params.local.md`（gitignore，不在公开仓库内）。

---

## ⚡ 速览版（只想快点能用，就照这四步）

**① 在办公电脑上查访问来源的出口 IP**，把结果写成 `/32` 后替换下面的 `OFFICE_CIDR`：

```bash
curl -fsS https://api.ipify.org
```

**② 在宿主机上执行**。先替换 `OFFICE_CIDR`，并确认 VM 地址与对外网卡：

```bash
sudo sysctl -w net.ipv4.ip_forward=1

VM=192.168.2.244
OFFICE_CIDR=198.51.100.20/32  # 文档保留示例地址，执行前必须替换
PUB_IF=$(ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if($i=="dev") {print $(i+1); exit}}')
for P in 5173 8080 8082 8095; do
  sudo iptables -t nat -I PREROUTING 1 -i "$PUB_IF" -s "$OFFICE_CIDR" \
    -p tcp --dport "$P" -j DNAT --to-destination "$VM:$P"
  sudo iptables -I FORWARD 1 -i "$PUB_IF" -s "$OFFICE_CIDR" -d "$VM" \
    -p tcp --dport "$P" -j ACCEPT
  sudo iptables -I FORWARD 1 -s "$VM" -d "$OFFICE_CIDR" \
    -p tcp --sport "$P" -m conntrack --ctstate ESTABLISHED -j ACCEPT
done
```

**③ 云控制台安全组 + 宿主机防火墙**：放行 **5173 / 8080 / 8082 / 8095** 四个 TCP 端口，
源地址都限定为 `$OFFICE_CIDR`（不要填 `0.0.0.0/0`）。DNAT 流量必须经过 FORWARD 白名单，
不能用普通 `ufw allow` 的 INPUT 规则代替，详见第 4 章。

**④ 在办公电脑上打开** `http://<宿主机公网IP>:5173`，用 `eap-admin` / `eap-demo` 登录。

> 四个端口的作用：5173 = 控制台（用户入口）· 8082 = Keycloak（登录跳转）· 8080 = 网关 API（外部系统直调，可选）·
> 8095 = RAGFlow Web 界面（组件管理面，见下方安全提示）。
> **其余端口一律不要转发**（数据库、缓存、DB-GPT 等组件管理面）。
> 本拓扑中 VM 默认网关就是宿主机，回包会经过宿主机。Linux conntrack 会对 DNAT 连接的回程
> 自动执行逆向地址转换，因此基线规则**不需要整段 MASQUERADE，也不默认添加额外 SNAT**。
> 只有抓包确认存在非对称路由或上游 NAT 的特殊要求时，才由网络管理员另行设计 SNAT；
> 不同拓扑不要直接套用。

下面是完整版：前置确认、持久化、验证、故障排除、回滚。

---

## 0.5 如果宿主机是 OpenWrt（LuCI 界面）

> 实测本项目的宿主机是 **OpenWrt + LuCI**（`http://192.168.2.1/cgi-bin/luci/`），
> 而上面「速览版」给的是**原生 Linux + iptables** 写法。OpenWrt 用 UCI 管防火墙，
> 两条路都能达到目的，**按你的系统选一条，不要两条都做**（会重复转发）。

### 路线 A：LuCI 图形界面（推荐，最不容易出错）

1. 浏览器打开 `http://192.168.2.1/cgi-bin/luci/`，用路由器管理账号登录
2. 左侧 **网络 → 防火墙 → 端口转发（Port Forwarding）**
3. 依次添加 **4 条**规则（外部区域都选 `wan`）：

   | 名称 | 外部端口 | 内部 IP | 内部端口 | 协议 |
   |---|---|---|---|---|
   | eap-console | 5173 | 192.168.2.244 | 5173 | TCP |
   | eap-gateway | 8080 | 192.168.2.244 | 8080 | TCP |
   | eap-keycloak | 8082 | 192.168.2.244 | 8082 | TCP |
   | eap-ragflow | 8095 | 192.168.2.244 | 8095 | TCP |

4. 在每条规则的「高级设置」中，把**来源 IP 地址**设为实际办公出口 IP（`198.51.100.20/32` 仅为示例），不要留空
5. **保存并应用**（OpenWrt 会自动重载防火墙）
6. 若「外部区域」下拉里没有 `wan`，先到 **网络 → 接口** 把公网接口的设备名确认出来

### 路线 B：命令行（SSH 到宿主机后执行）

端口转发要使用 `firewall redirect`；普通 `firewall rule` 只能放行，不能把公网端口 DNAT 到 VM。

```bash
VM=192.168.2.244
OFFICE_CIDR=198.51.100.20/32   # 示例，必须替换为办公出口

for P in 5173 8080 8082 8095; do
  uci add firewall redirect
  uci set firewall.@redirect[-1].name="eap-port-$P"
  uci set firewall.@redirect[-1].src='wan'
  uci set firewall.@redirect[-1].src_ip="$OFFICE_CIDR"
  uci set firewall.@redirect[-1].src_dport="$P"
  uci set firewall.@redirect[-1].dest='lan'
  uci set firewall.@redirect[-1].dest_ip="$VM"
  uci set firewall.@redirect[-1].dest_port="$P"
  uci set firewall.@redirect[-1].proto='tcp'
  uci set firewall.@redirect[-1].target='DNAT'
done

uci commit firewall
/etc/init.d/firewall restart
```

> OpenWrt 的转发是「出站」方向：`src=wan`（外部区域）+ `dest=lan`（内部区域）+
> `dest_ip/dest_port`（目标虚拟机）。`src_dport` 是**公网端口**，
> `dest_port` 是**虚拟机上的同名端口**（本项目 VM 侧端口与公网端口一一对应）。
>
> OpenWrt 默认的 `net.ipv4.ip_forward=1` 已经开着，**不需要**额外设置。

### 验证（两条路都跑一遍）

```bash
# 在 VM 上跑 —— VM 侧的 DNAT 兜底路径通了才说明后半段没问题
for P in 5173 8080 8082 8095; do
  printf '%s -> ' "$P"; curl -s -o /dev/null -m 5 -w '%{http_code}\n' "http://192.168.2.244:$P/"
done
# 期望：5173=200  8080=401（无令牌被拒，说明服务在）  8082=302  8095=200
```

---

## 0. 先看拓扑（确认前提）

```
外网用户 ──► 宿主机 <公网IP>  ──DNAT──►  虚拟机 192.168.2.244  ──►  平台服务
             （持有公网 IP + 安全组）            （ens34，已装好 route_localnet + DNAT）
```

| 角色 | 地址 | 端口 |
|---|---|---|
| 宿主机（公网） | `<公网IP>` | — |
| 宿主机（内网，即 VM 默认网关） | `192.168.2.1` | — |
| 虚拟机 | `192.168.2.244` | — |

**VM 侧已就绪，无需你处理**：
- VM 内已开 `route_localnet=1`，并有精确到端口的 DNAT 规则把外部包转到 `127.0.0.1`
- VM 内平台服务**只监听 `127.0.0.1`**，没有任何端口对局域网或公网直接暴露
- 平台的公网适配（OIDC issuer 列表、动态授权地址、控制台同源反代、Keycloak 客户端白名单）已全部落地并实测通过

**你要做的只有一件事：把公网的 4 个端口转发到虚拟机，并放行。**

| 转发端口 | 目标 | 用途 | 必须？ |
|---|---|---|---|
| 5173 | `192.168.2.244:5173` | Web 控制台（唯一用户入口） | ✅ 必须 |
| 8082 | `192.168.2.244:8082` | Keycloak（OIDC 登录跳转与换令牌） | ✅ 必须 |
| 8080 | `192.168.2.244:8080` | 网关 API（外部系统直调用） | 可选 |
| 8095 | `192.168.2.244:8095` | RAGFlow Web 界面（重型组件管理面） | 已选 |

> 8090（Agent Core）**不需要转发** —— 控制台已改成走同源反代。
> 数据库 / 缓存 / 对象存储 / 向量引擎 / Langfuse / DB-GPT / TEI / MCP
> **一律不要转发**。
>
> ⚠ **8095（RAGFlow Web 界面）是唯一被放开的重型组件管理面** —— 这是本项目的显式决策，
> 不是遗漏。它对外是**明文 HTTP**，且 RAGFlow 自带账号体系（与平台 Keycloak 不互通）。
> 因此 **RAGFlow 侧已关闭自注册**（`REGISTER_ENABLED=0`），只保留固定账号可登录。

> **若你在宿主机上另建了一层反向代理**（Nginx / Caddy 等），必须一并转发这三条路径，
> 否则控制台的流式对话会失败：
>
> | 路径 | 目标 | 用途 |
> |---|---|---|
> | `/v1/*` | `127.0.0.1:8080` | 网关 API（模型 / 工具 / 鉴权配置） |
> | `/api/*` | `127.0.0.1:8090` | Agent Core（会话 / 消息） |
> | `/ag-ui` | `127.0.0.1:8090` | **AG-UI 标准事件流（SSE）** —— 控制台的流式对话 |
>
> `/ag-ui` 是长连接 SSE，反代**必须关闭响应缓冲**（Nginx：`proxy_buffering off;`、
> `proxy_read_timeout 600s;`），否则前端会一直等不到帧。

---

## 1. 前置确认（在宿主机执行）

```bash
# ① 确认公网 IP 的归属（示例值必须替换）
PUB_IP=203.0.113.10
printf '宿主机公网 IP：%s\n' "$PUB_IP"
ip -4 addr show
# 公网 IP 直接绑定网卡时，应能在上面的输出中看到它。
# 如果云平台通过 NAT 映射公网 IP，网卡上没有该地址是正常的，以云控制台为准。

# ② 确认宿主在虚拟机网段里的内网地址
#    —— 虚拟机侧的 DNAT 规则按这个地址放行「宿主机转发过来的包」。
#    默认值是 192.168.2.1（虚拟机的默认网关）。若你这里的内网地址不同，
#    需要同步修改虚拟机侧的参数并重跑 scripts/setup-localnet-dnat.sh：
#       sudo HOST_IP=<你的内网IP> ./scripts/setup-localnet-dnat.sh
echo "宿主内网地址："
ip -4 addr show | grep -oP 'inet \K[\d.]+' | grep -v '^127\.'

# ③ 确认能 ping 通虚拟机
ping -c 2 192.168.2.244

# ④ 确认虚拟机的 4 个目标端口在 VM 侧是通的（应该都通，因为 VM 内部有 DNAT 兜底）
for P in 5173 8080 8082 8095; do
  printf "  %-6s " "$P"
  curl -s -o /dev/null -w 'HTTP %{http_code}\n' --max-time 5 "http://192.168.2.244:$P/" || echo "不通"
done
```

第 ④ 步的期望：`5173`→200、`8080`→401（缺令牌，正常）、`8082`→302（重定向，正常）、`8095`→200。
**若这里就不通，先别往下做**，把输出发回给平台管理员。

---

## 2. 开启 IP 转发

```bash
sudo sysctl -w net.ipv4.ip_forward=1
echo 'net.ipv4.ip_forward=1' | sudo tee /etc/sysctl.d/99-ip-forward.conf
```

---

## 3. 端口转发（DNAT + FORWARD 来源白名单）

先自动探测对外网卡，并设置访问来源。`OFFICE_CIDR` 的示例值必须替换；
DNAT 与 FORWARD 都带同一个来源条件，避免只转发却没有真正过滤。

```bash
PUB_IF=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev") {print $(i+1); exit}}')
VM=192.168.2.244
OFFICE_CIDR=198.51.100.20/32
printf '对外网卡：%s；允许来源：%s\n' "$PUB_IF" "$OFFICE_CIDR"
```

写入规则：

```bash
for PORT in 5173 8080 8082 8095; do
  # DNAT：仅把白名单来源的公网请求转到虚拟机
  sudo iptables -t nat -I PREROUTING 1 -i "$PUB_IF" -s "$OFFICE_CIDR" \
    -p tcp --dport "$PORT" -j DNAT --to-destination "$VM:$PORT"
  # FORWARD：请求与回程都限制办公出口；回程必须是已建立的连接
  sudo iptables -I FORWARD 1 -i "$PUB_IF" -s "$OFFICE_CIDR" -d "$VM" \
    -p tcp --dport "$PORT" -j ACCEPT
  sudo iptables -I FORWARD 1 -s "$VM" -d "$OFFICE_CIDR" \
    -p tcp --sport "$PORT" -m conntrack --ctstate ESTABLISHED -j ACCEPT
done
```

> **DNAT 的回程由 conntrack 自动还原**
>
> DNAT 只改去程的**目的**地址，虚拟机看到的来源仍是客户端真实公网 IP。
> 回包经过执行 DNAT 的宿主机时，conntrack 会根据同一条连接的 NAT 状态，
> 自动把回包源地址还原为客户端最初请求的目标地址。正常 DNAT 转发并不依赖
> 再手写一条“把回包改为公网 IP”的 SNAT；没有这条自动还原，普通 DNAT 本身也无法工作。
>
> 因此本基线不默认添加 POSTROUTING SNAT。只有 tcpdump / conntrack 证据证明存在
> 非对称路由、额外的源地址改写或上游 NAT 特殊要求时，才应针对该原因设计规则。
> 不要仅因“页面打不开”就叠加 SNAT，也不能把 VM 侧看到 ESTABLISHED 当作额外 SNAT
> 必需或已由 OpenWrt 自动创建的证据。OpenWrt 路线同样应通过 `nft list ruleset` 与
> 真实外部访问确认实际行为。

> **为什么用 `-I`（插到最前）而不是 `-A`（追加）**：宿主机如果也跑 Docker，
> Docker 会在 `nat/PREROUTING` 链首插入 jump 到 `DOCKER` 链。追加的规则排在
> Docker 之后，若宿主恰好有容器占用这几个端口，会被 Docker 的规则先命中。
> 插到链首可以避免这个坑。

> **本拓扑不需要整段 MASQUERADE**：VM 的默认网关是宿主机 `192.168.2.1`，回包必经宿主机，
> DNAT 回程由 conntrack 自动处理。如果 VM 默认网关不是宿主机，需要按实际路由另行设计
> SNAT/MASQUERADE，并同步调整 VM 侧规则，不能直接套用本章。

---

## 4. 宿主机防火墙

### 4.1 先看现状

```bash
sudo ufw status verbose 2>/dev/null || echo "（没有 ufw）"
sudo firewall-cmd --state 2>/dev/null || echo "（没有 firewalld）"
sudo iptables -S INPUT | head -20
```

### 4.2 确认转发白名单（不能用 INPUT 规则代替）

第 3 章已经在 DNAT 和 FORWARD 两处限定 `$OFFICE_CIDR`，这是本清单实际生效的白名单。
普通 `ufw allow from ... to any port ...` 管的是进入宿主本机的 INPUT 流量，**不能替代
DNAT 后的 FORWARD 规则**。如果改用 UFW 管理转发，对应命令应是 `ufw route allow`；
firewalld 则需要配置适用于转发流量的 policy。它们都是第 3 章手工规则的替代方案，
不要叠加出更宽的放行规则。

检查实际生效的规则，确认四个端口都带办公来源条件，且没有更早的全来源 ACCEPT：

```bash
sudo iptables -t nat -S PREROUTING
sudo iptables -S FORWARD
# 使用 nftables 后端时再核对：
sudo nft list ruleset
```

**只放行这几个端口，其余一律不动。** 不要添加全来源的 `ufw allow 5173/tcp` 或
`iptables -I FORWARD -j ACCEPT`。平台的网关接口虽然有 JWT 鉴权，但裸露在公网仍会引来扫描与暴力破解。

### 4.3 确认 INPUT 链没有拦截

```bash
sudo iptables -S INPUT | grep -E "5173|8080|8082" || echo "（INPUT 链无相关规则，若 ufw/firewalld 已放行则正常）"
```

---

## 5. 云安全组（云平台控制台，不在机器上）

在云控制台的安全组入方向规则里添加：

| 方向 | 协议 | 端口 | 源地址 |
|---|---|---|---|
| 入 | TCP | 5173 | `<办公出口IP>/32` |
| 入 | TCP | 8080 | `<办公出口IP>/32` |
| 入 | TCP | 8082 | `<办公出口IP>/32` |
| 入 | TCP | 8095 | `<办公出口IP>/32` |

**安全组是第一道闸，iptables/ufw 是第二道，两道都要配。**
源地址同样建议限定为办公出口 IP，不要 `0.0.0.0/0`。

> 如果这台机器是公有云主机，别忘了检查「主机防火墙」与「安全组」是否
> **同时**存在且都生效 —— 云平台有时会在宿主机之外还有一层网络 ACL。

---

## 6. 持久化

```bash
# Debian/Ubuntu
sudo apt install -y iptables-persistent   # 首次
sudo netfilter-persistent save

# RHEL/CentOS/Rocky
sudo iptables-save > /etc/sysctl.d/iptables.rules
# 或
sudo systemctl enable iptables-save

# IP 转发的持久化（第 2 步已写入 /etc/sysctl.d/99-ip-forward.conf）
sudo sysctl --system
```

---

## 7. 验证

### 7.1 在宿主机上（验证转发链路通）

```bash
for P in 5173 8080 8082 8095; do
  printf "  %-6s " "$P"
  curl -s -o /dev/null -w 'HTTP %{http_code}\n' --max-time 8 "http://192.168.2.244:$P/"
done
```
期望：`5173`→200、`8080`→401、`8082`→302、`8095`→200。

> ⚠ **不要用 `curl http://<公网IP>:5173` 在宿主机上做验证。**
> 本机发起的流量走 OUTPUT 链，**不经过 `nat/PREROUTING`**，DNAT 规则对它不生效；
> 而且公网 IP 就绑在本机网卡上，连接会落到宿主自己的 5173 端口（没有服务）→ 连接失败，
> 这**不代表转发配错了**。宿主机侧验证请用虚拟机内网地址；外网是否真通，
> 用 7.2 / 7.3 / 7.4。

### 7.2 从**外部**机器（真正的公网视角，最关键）

在你的办公电脑上：

```bash
PUB_IP=203.0.113.10   # 示例，必须替换为宿主机公网 IP
curl -s -o /dev/null -w '控制台 HTTP %{http_code}\n' http://$PUB_IP:5173/
```

然后浏览器打开 `http://$PUB_IP:5173`，用 `eap-admin` / `eap-demo` 登录。

> 浏览器里如果跳转到了 `http://127.0.0.1:8082`，说明平台侧的动态授权地址
> 没生效 —— **不要改宿主机的任何配置**，这是平台侧问题，把现象反馈回去。

### 7.3 确认其它端口**仍然**不可达

在外部机器上：

```bash
PUB_IP=203.0.113.10   # 示例，必须替换为宿主机公网 IP
for P in 5433 3307 6381 9002 8124 3001 9380 8094 23821; do
  printf "  %-6s " "$P"
  timeout 4 bash -c "</dev/tcp/$PUB_IP/$P" 2>/dev/null && echo "可连 ⚠ 异常" || echo "不可达 ✓"
done
```

### 7.4 从非白名单节点验证白名单未被绕过（可选）

在**虚拟机**里执行，通过公共扫描节点模拟非白名单来源：

```bash
cd /opt/agent
export EAP_PUBLIC_IP=203.0.113.10   # 示例，必须替换为宿主机公网 IP
rm -f /tmp/scan-map.txt
for PORT in 5173 8080 8082 8095 5433 3307 6381 9002 8124 3001 9380; do
  RID=$(curl -s -H 'Accept: application/json' \
    "https://check-host.net/check-tcp?host=$EAP_PUBLIC_IP:$PORT&max_nodes=3" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin).get("request_id",""))')
  echo "$PORT $RID" >> /tmp/scan-map.txt
  sleep 2
done
sleep 25
python3 scripts/parse-portscan.py /tmp/scan-map.txt --summary
```

期望：**公共扫描节点对所有端口都不可达**，包括 5173 / 8080 / 8082 / 8095；
任何“可达”或“部分可达”都说明白名单可能被绕过，“无法判定”则需要重跑。
`parse-portscan.py` 的通用退出码以“全部可达”为 0，因此这个负向验收场景看到退出码 1
不代表测试失败，应以输出为准。四个业务端口的正向可达性由 7.2 的白名单内办公机器验证。

---

## 8. 故障排除对照表

| 现象 | 最可能的原因 | 怎么查 |
|---|---|---|
| 白名单内办公机访问 `<公网IP>:5173` 不通 | ip_forward、安全组或 DNAT 配置问题 | `cat /proc/sys/net/ipv4/ip_forward`（应为 1），再按第 3、5 章核对 |
| 外部不通，但宿主机 `curl 192.168.2.244:5173` 通 | FORWARD 链被 DROP 或来源条件不匹配 | `sudo iptables -S FORWARD \| head`，核对办公出口 CIDR |
| 宿主机本地 `curl <公网IP>:5173` 不通，但白名单内办公机能通 | 本机流量走 OUTPUT，不经过 nat/PREROUTING；这不代表转发失败 | 不要为宿主机自测扩大白名单，按 7.1、7.2 分别验证 |
| 外部能连上 TCP 但页面打不开 | 平台侧路由/反代问题 | 在 VM 内 `curl -s http://192.168.2.244:5173/` 确认平台本身正常 |
| 浏览器跳转到 `127.0.0.1:8082` | 平台侧动态授权地址未生效 | 反馈平台管理员，不是宿主问题 |
| Keycloak 页面能开但登录报 401 | 令牌 issuer 不匹配 | 反馈平台管理员（需检查 `KEYCLOAK_ISSUER` 列表） |
| 端口转发不生效且日志无流量 | 安全组未放行 | 云控制台安全组入方向规则 |
| 页面能正常打开，但点「使用企业账号登录」**没反应/报错**（且外部 HTTP 探测 200） | 浏览器只在安全上下文提供 `crypto.subtle`，公网明文 HTTP 的非本机来源不是安全上下文，PKCE 算不出 S256 | **不是宿主问题** —— 平台侧已在 `apps/webui/src/sha256.ts` 加纯 JS 兜底；若仍是旧版本，请平台管理员重新构建前端。详见 [docs/access.md](access.md) 6.7 |
| 浏览器报 `ERR_SSL_PROTOCOL_ERROR` / `ERR_CLEARTEXT_NOT_PERMITTED` | 用了 `https://` 访问明文端口（5173 未配 TLS） | 改用 `http://`；或在宿主机为控制台配置 HTTPS 终止 |

---

## 9. 回滚

```bash
# 使用与添加时完全相同的参数；以下示例值必须替换
VM=192.168.2.244
PUB_IP=203.0.113.10           # 仅用于清理旧版手工 SNAT
OFFICE_CIDR=198.51.100.20/32  # 文档保留示例地址，执行前必须替换
PUB_IF=$(ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if($i=="dev") {print $(i+1); exit}}')

for PORT in 5173 8080 8082 8095; do
  sudo iptables -t nat -D PREROUTING -i "$PUB_IF" -s "$OFFICE_CIDR" \
    -p tcp --dport "$PORT" -j DNAT --to-destination "$VM:$PORT"
  sudo iptables -D FORWARD -i "$PUB_IF" -s "$OFFICE_CIDR" -d "$VM" \
    -p tcp --dport "$PORT" -j ACCEPT
  sudo iptables -D FORWARD -s "$VM" -d "$OFFICE_CIDR" \
    -p tcp --sport "$PORT" -m conntrack --ctstate ESTABLISHED -j ACCEPT

  # 仅清理旧版文档或专项排障中明确添加过的 SNAT；新版基线没有此规则
  SNAT_RULE=(-s "$VM" -d "$OFFICE_CIDR" -p tcp --sport "$PORT"
    -m conntrack --ctstate ESTABLISHED -j SNAT --to-source "$PUB_IP")
  if sudo iptables -t nat -C POSTROUTING "${SNAT_RULE[@]}" 2>/dev/null; then
    sudo iptables -t nat -D POSTROUTING "${SNAT_RULE[@]}"
  fi
done
# 若过去重复添加过规则，检查 iptables/nftables 并删除所有重复项。
# 仅在转发原本就是关闭状态、且没有其他业务依赖时执行：
sudo sysctl -w net.ipv4.ip_forward=0
```
