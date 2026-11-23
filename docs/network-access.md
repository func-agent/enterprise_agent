# 网络访问与端口收口

> **关于地址占位与示例值**
> 本仓库为公开仓库，**不内置任何部署环境的真实公网地址**。
> 正文用 `<公网IP>` 表示需要替换的值；Shell 示例使用文档保留地址 `203.0.113.10`，执行前必须替换。
> 本机实际取值见**内部参数表** `docs/internal/host-params.local.md`（该目录已 gitignore，
> 不在公开仓库内），可用 `./scripts/gen-host-params.sh [公网IP] [办公出口CIDR]` 生成。

本机（`/opt/agent` 所在机器）是**一台虚拟机**，公网 IP 由宿主机持有：

```
外网  ──► 宿主机 <公网IP>  ──NAT──►  虚拟机 192.168.2.244  ──►  平台服务
        （持有公网 IP + 安全组）              （docker 网桥 172.17.0.1）
```

**历史实测（宿主尚未配置端口转发时）**：外部多节点扫描与 HTTP 抓取中，
8080 / 8082 / 5173 / 5433 / 3307 均为 Connection timed out。
这只是当时的网络状态，不是实时状态；当前公网可达性以第五章验收结果为准。

---

## 一、VM 侧已完成的收口

### 1.1 容器发布端口全部绑 127.0.0.1

`deploy/compose/docker-compose.yml` + `docker-compose.heavy.yml` 共 41 处端口映射
由 `0.0.0.0:xxxx:xxxx` 改为 `127.0.0.1:xxxx:xxxx`。

**为什么必须改绑定而不是只配防火墙**：Docker 发布的端口走 `DOCKER` chain 的 nat 转发，
**绕过 ufw / firewalld 的 INPUT 链**。只加防火墙规则收不住这些端口 —— 改绑定地址才是有效的。

覆盖到的组件：PostgreSQL、MySQL、Redis、MinIO、ClickHouse、Langfuse、Keycloak、
Infinity、TEI、RAGFlow、DB-GPT、Envoy，以及平台栈自身的网关 / Agent / MCP Hub / 控制台。

容器之间通信**不受影响**（走 compose 网络内的服务名，不经过发布端口）；
宿主进程访问这些端口也**不受影响**（127.0.0.1 本来就在监听范围）。

### 1.2 宿主进程绑 127.0.0.1

`.env` 新增：

```bash
GATEWAY_HOST=127.0.0.1
AGENT_HOST=127.0.0.1
MCP_HUB_HOST=127.0.0.1
WEBUI_HOST=127.0.0.1
```

### 1.3 回环桥（容器仍能回调宿主）

容器访问宿主只能经 docker 网桥 `172.17.0.1`（`host.docker.internal`），
**访问不到宿主的 loopback**。DB-GPT 需要回调宿主的网关（8080）与 MCP Server（8091/8093）。

`scripts/loopback-bridge.ts` 在 `172.17.0.1` 上监听这些端口并转发到 `127.0.0.1` 同端口：

```bash
LOOPBACK_BRIDGE_ENABLED=true
LOOPBACK_BRIDGE_BIND=172.17.0.1
LOOPBACK_BRIDGE_PORTS=8080,8091,8092,8093
```

`172.17.0.1` 是本地网桥地址，不对外路由 —— **只有本机与本机上的容器能连上**，
局域网与公网依然访问不到。随 `scripts/start-all.sh start` 一起拉起。

---

## 二、转发进来后的一个坑：VM 内的 loopback（解法 A 已落地）

平台的宿主进程现在只监听 `127.0.0.1`，宿主机 DNAT 过来的包目标是 `192.168.2.244:5173`，
**VM 上的 192.168.2.244 上并没有监听 5173** → 连接会被拒。

> **本项目采用解法 A，且已在 VM 内落地、实测通过。** VM 侧保持零暴露：
> 宿主服务继续只绑 `127.0.0.1`，暴露面控制点仍然只有宿主机那一道。

### 2.1 VM 侧已执行的操作

```bash
cd /opt/agent
sudo ./scripts/setup-localnet-dnat.sh          # 应用 + 持久化
sudo ./scripts/setup-localnet-dnat.sh --status  # 查看现状
```

脚本做三件事：

1. `net.ipv4.conf.all.route_localnet=1`（及接口级）——
   允许内核把转发进来的包路由到 `127/8`。
   **这是必要条件而非充分条件**：真正放行哪些端口由下面精确到 `--dport` 的
   DNAT 规则决定，没有对应规则的端口即使 route_localnet=1 也进不来。
2. `nat/PREROUTING` 精确 DNAT —— 目标必须是 VM 自己的地址，且端口在白名单里：

   ```bash
   # 规则 A：源 = 宿主机地址（宿主做了 MASQUERADE 时的源地址）
   iptables -t nat -A PREROUTING -i ens34 -s 192.168.2.1/32 -d 192.168.2.244/32 \
     -p tcp --dport 5173 -j DNAT --to-destination 127.0.0.1:5173
   # 规则 B：源 ∉ 局域网段（宿主没做 MASQUERADE 时，源是真实客户端公网 IP）
   iptables -t nat -A PREROUTING -i ens34 ! -s 192.168.0.0/22 -d 192.168.2.244/32 \
     -p tcp --dport 5173 -j DNAT --to-destination 127.0.0.1:5173
   # 8080 / 8082 同理
   ```

   **源地址限定不是可选项**：DNAT 规则一旦命中，**局域网内任何机器**直连
   `192.168.2.244:5173` 也会被转进 loopback —— 「只允许本机访问」的收口就失效了。
   两条规则把「宿主机转发进来的包」和「局域网直连的包」分开：
   宿主机做了 MASQUERADE 时源是 `192.168.2.1`（规则 A 命中），
   没做时源是真实客户端公网 IP（规则 B 命中），
   而局域网内其它机器两条都不命中，会被直接丢弃。
   **两条规则并存 = 不依赖宿主是否配了 MASQUERADE。**
3. `nat/OUTPUT` 同规则：只在 **VM 本机**自测时用（`curl http://192.168.2.244:5173`
   验证外网路径是否打通），不放宽任何外部来源。

参数可覆盖：`VM_IP` / `IN_IF` / `PORTS` / `HOST_IP` / `LAN_CIDR`。

持久化：写 `/etc/sysctl.d/99-eap-localnet.conf` + `/etc/iptables/rules.v4`
（未安装 netfilter-persistent 时重启后需执行 `/etc/iptables/restore-eap-localnet.sh`）。

### 2.2 实测证据

**证据一：route_localnet 的必要性（对比实验）**

用 network namespace 造一个「真正的外部入口」打进 VM：

| route_localnet | 外部 → 5173 | 外部 → 8082 |
|---|---|---|
| `0`（未开启） | ✗ 被内核丢弃 | — |
| `1`（解法 A 生效态） | ✓ HTTP 200 | ✓ HTTP 302 |

> 只做 DNAT 不开 route_localnet，外部包会在进到应用前就被内核丢掉，
> 表现就是「转发配好了但访问不通」。

**证据二：源地址限定的正确性**

同一个 netns 造三种源地址，分别验证放行/拒绝：

| 来源 | 期望 | 实测 |
|---|---|---|
| 局域网内机器（源 `192.168.2.50`） | 拒绝 | ✓ 连接失败 |
| 宿主机 MASQUERADE（源 `192.168.2.1`） | 放行 | ✓ HTTP 200 |
| 公网客户端（源 `203.0.113.10`） | 放行 | ✓ HTTP 200 |

> 测试时入站接口换成了测试用 veth（物理上外部流量确实从 `ens34` 进来），
> 其余规则参数与生产完全一致。

### 2.3 备选解法 B（未采用）

把 `.env` 的 `GATEWAY_HOST` / `MCP_HUB_HOST` / `WEBUI_HOST` 改回 `0.0.0.0`，
靠宿主机侧规则 + 云安全组控制暴露面。**同一办公网段的其它机器将能直连这些端口**，
所以本项目没有采用。

---

## 三、平台侧为公网入口做的适配

端口能通之后，OIDC 登录还会在三个地方踩坑。**这三处已全部改好**：

### 3.1 Keycloak 的 issuer 按请求 Host 生成

Keycloak 默认把 `iss` 按**请求的 Host 头**生成，同一 realm 在不同入口签出的令牌 `iss` 不同：

| 入口 | token 的 `iss` |
|---|---|
| 本机浏览器 | `http://127.0.0.1:8082/realms/enterprise` |
| 公网浏览器 | `http://<公网IP>:8082/realms/enterprise` |
| 容器网络内服务 | `http://keycloak:8080/realms/enterprise` |

漏掉任何一个，对应入口的令牌都会被判为「issuer 不匹配」而 401。
因此 `KEYCLOAK_ISSUER` 改成**逗号分隔的列表**，鉴权中间件用 jose 的
`issuer: string[]` 一次性接受全部（`packages/platform-core/src/config.ts`、
`packages/auth-middleware/src/index.ts`）。

> 试过用 realm 的 `attributes.frontendUrl` / `backendUrl` 固定 issuer，
> 确实能让 issuer 固定，但**前端地址会跟着一起固定** —— 公网浏览器跳到
> 127.0.0.1 就废了。改用「issuer 列表 + 动态前端地址」两头都活。

### 3.2 授权地址必须跟随用户实际访问的入口

`KEYCLOAK_PUBLIC_URL` 支持 `{host}` 占位，运行时按**用户浏览器真正访问的地址**
替换主机名：

```bash
KEYCLOAK_PUBLIC_URL=http://{host}:8082
```

- 本机访问 → `http://127.0.0.1:8082/realms/.../auth`
- 公网访问 → `http://<公网IP>:8082/realms/.../auth`

同一份配置同时适配两种入口，不需要为公网单独维护一套地址。
取值来源是 `x-forwarded-host`（反代透传的原始 Host），回退到 `host`
（`packages/gateway/src/routes/auth.ts`）。

### 3.3 控制台改走同源相对路径

控制台前端原先把后端地址**构建时写死**成 `http://127.0.0.1:8080` / `:8090`。
公网用户访问时，浏览器会去连**用户自己电脑的** 127.0.0.1 —— 必然失败。

现在前端一律用**同源相对路径**（`apps/webui/src/api.ts`），
由 vite preview 的 proxy 反代到网关与 Agent 内核（`apps/webui/vite.config.ts`
的 `preview.proxy`）。

好处是外网**不必额外开放 8080 / 8090**：浏览器只与 5173 通信。
`proxy` 必须保留 `xfwd: true` —— 否则反代会改写 Host 头，
第 3.2 条的动态地址就会错指到 127.0.0.1。

### 3.4 Keycloak 客户端白名单

`deploy/compose/keycloak/realm-eap.json` 里 `eap-webui` 客户端已加：

```json
"redirectUris": ["http://localhost:5173/*", "http://127.0.0.1:5173/*", "${EAP_PUBLIC_WEB_ORIGIN}/*"],
"webOrigins":  ["http://localhost:5173", "http://127.0.0.1:5173", "${EAP_PUBLIC_WEB_ORIGIN}"]
```

公网入口**不写死具体地址**，统一用 `${EAP_PUBLIC_WEB_ORIGIN}` 占位，由
`deploy/compose/.env` 的同名变量在 Keycloak 导入 realm 时替换：

```bash
# deploy/compose/.env
EAP_PUBLIC_WEB_ORIGIN=http://203.0.113.10:5173   # 示例，必须替换为实际控制台来源
```

变量缺失时 Keycloak 会把占位符**原样**写进 redirect URI 且不告警，
因此 `scripts/start-heavy.sh` 会在启动前强制校验，未设置直接拒绝启动。

`webOrigins` 决定跨域换令牌能否过 CORS —— 控制台在 5173、Keycloak 在 8082，
是不同 origin，必须显式放行。

> 改完 realm 需要**删 realm 再重启 Keycloak** 重新导入（Keycloak 26 文件导入
> 路径不种内置 client scope，详见 `docs/operations.md` 的 Keycloak 踩坑）。

---

## 四、宿主机侧需要做的操作

> 以下命令在**宿主机**（持公网 IP 的那台机器）上执行，不是在虚拟机里。
>
> **完整的可交接清单见 [host-handoff.md](host-handoff.md)** —— 含前置确认、
> ufw/firewalld/云安全组三道闸、持久化、验证步骤与故障排除对照表。
> 本章是它的浓缩版。

### 4.1 开启 IP 转发

```bash
sudo sysctl -w net.ipv4.ip_forward=1
echo 'net.ipv4.ip_forward=1' | sudo tee /etc/sysctl.d/99-ip-forward.conf
```

### 4.2 端口转发（DNAT + FORWARD 来源白名单）

**只转发必需的 4 个端口**，其余一律不转：

| 转发端口 | 目标 | 为什么需要 |
|---|---|---|
| 5173 | 192.168.2.244:5173 | Web 控制台（用户入口，含到网关/内核的反代） |
| 8080 | 192.168.2.244:8080 | 网关 API（外部系统直调时需要；仅用控制台可不转） |
| 8082 | 192.168.2.244:8082 | Keycloak（OIDC 授权跳转与换令牌必须可达） |
| 8095 | 192.168.2.244:8095 | RAGFlow Web 界面（重型组件管理面；已关闭自注册，仍是明文 HTTP） |

下面两个示例地址必须替换。DNAT 和 FORWARD 都限制办公来源，避免把普通 INPUT
放行误当成转发白名单：

```bash
VM=192.168.2.244
OFFICE_CIDR=198.51.100.20/32  # 文档保留示例地址，执行前必须替换
PUB_IF=$(ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if($i=="dev") {print $(i+1); exit}}')

for PORT in 5173 8080 8082 8095; do
  sudo iptables -t nat -I PREROUTING 1 -i "$PUB_IF" -s "$OFFICE_CIDR" \
    -p tcp --dport "$PORT" -j DNAT --to-destination "$VM:$PORT"
  sudo iptables -I FORWARD 1 -i "$PUB_IF" -s "$OFFICE_CIDR" -d "$VM" \
    -p tcp --dport "$PORT" -j ACCEPT
  sudo iptables -I FORWARD 1 -s "$VM" -d "$OFFICE_CIDR" \
    -p tcp --sport "$PORT" -m conntrack --ctstate ESTABLISHED -j ACCEPT
done
```

本拓扑中 VM 默认网关就是宿主机，回包会经过宿主机。Linux conntrack 会根据 DNAT 连接状态
自动完成回程的逆向地址转换，因此基线**不需要整段 MASQUERADE，也不默认添加额外 SNAT**。
去程到达 VM 时仍保留真实客户端来源；回程的源地址由 conntrack 还原为客户端最初请求的目标。

只有抓包和 conntrack 状态证明存在非对称路由、额外源地址改写或上游 NAT 特殊要求时，
才应由网络管理员针对实际原因设计 SNAT，并同步调整 VM 侧规则。旧版文档中的手工回程
SNAT 不应未经核实直接叠加；需要清理时按[宿主机交接清单](host-handoff.md)的回滚章节执行。

> **不要转发** 5432/5433(PostgreSQL)、3307(MySQL)、6379/6381(Redis)、9000-9003(MinIO)、
> 8124/9004(ClickHouse)、3001(Langfuse)、**9380(RAGFlow API 端口，界面走 8095)**、8094/8096/8097(DB-GPT)、
> 6380(TEI)、23818/23821/5434(Infinity)、**8090(Agent Core —— 控制台已改走同源反代)**、
> 8091-8093(MCP)。
> 这些是数据层与组件管理面，暴露出去等于把数据库与控制台开到公网。

持久化（Debian/Ubuntu）：

```bash
sudo apt install -y iptables-persistent   # 首次
sudo netfilter-persistent save
```

### 4.3 宿主机防火墙放行

上面的 FORWARD 规则就是本示例的转发白名单。普通 `ufw allow` 主要管理 INPUT，
不能替代它；使用 UFW 管理转发时应采用 `ufw route allow`，firewalld 则应配置适用于
转发流量的 policy，且不要与手工 FORWARD 规则重复或扩大来源范围。

```bash
sudo iptables -t nat -S PREROUTING
sudo iptables -S FORWARD
sudo nft list ruleset
```

确认四个端口都具有 `$OFFICE_CIDR` 来源限制，且前面没有全来源 ACCEPT。
平台的网关接口虽然有 JWT 鉴权，但把入口暴露在公网仍会引来扫描与暴力破解。

### 4.4 云安全组

在云控制台的安全组里，放行 5173 / 8080 / 8082 / 8095 四个 TCP 端口，
源地址都限定为 `$OFFICE_CIDR`。安全组是第一道闸，FORWARD 白名单是第二道，两道都要配。

---

## 五、转发后的验证

在**白名单内的办公机器**上验证四个入口确实可用（示例 IP 必须替换）：

```bash
PUB_IP=203.0.113.10
curl -s "http://$PUB_IP:5173/" | head -c 120
curl -s "http://$PUB_IP:8080/healthz"
curl -s "http://$PUB_IP:8082/realms/enterprise/.well-known/openid-configuration" | head -c 120
curl -s -o /dev/null -w 'RAGFlow HTTP %{http_code}\n' "http://$PUB_IP:8095/"
```

再从 VM 调用外部公共扫描节点，验证**非白名单来源全部被拦截**：

```bash
cd /opt/agent
export EAP_PUBLIC_IP=203.0.113.10   # 示例，必须替换
rm -f /tmp/scan-map.txt
for PORT in 5173 8080 8082 8095 5433 3307 6381 9002 8124 3001 9380; do
  RID=$(curl -fsS -H 'Accept: application/json' \
    "https://check-host.net/check-tcp?host=$EAP_PUBLIC_IP:$PORT&max_nodes=3" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin).get("request_id",""))')
  echo "$PORT $RID" >> /tmp/scan-map.txt
  sleep 2
done
sleep 25
python3 scripts/parse-portscan.py /tmp/scan-map.txt --summary
```

白名单生效时，公共扫描节点对**所有列出的端口都不可达**。`parse-portscan.py` 的通用退出码
以“全部可达”为 0，因此这个负向验收场景看到退出码 1 不代表测试失败，应以输出为准：
任何端口显示“可达”或“部分可达”都说明白名单可能被绕过；“无法判定”则需要重跑。
四个业务端口的正向可达性必须由上面的办公机器验收，不能用公共扫描节点代替。

VM 内自检（应全部连不通）：

```bash
for PORT in 5433 3307 6381 9002 8124 3001 9380 8094 8096 8097 23821; do
  printf "  %-6s " "$PORT"
  timeout 3 bash -c "</dev/tcp/192.168.2.244/$PORT" 2>/dev/null && echo "可连（异常）" || echo "已收口"
done
```

VM 内**验证「外部入口路径」本身是否通**（不依赖宿主机转发，用 netns 模拟外部）：

```bash
cd /opt/agent
sudo ./scripts/setup-localnet-dnat.sh --status   # 确认规则在位
# 规则里的几个端口在 VM 上应能经 VM_IP 访问（OUTPUT DNAT 路径）
for PORT in 5173 8080 8082 8095; do
  printf "  %-6s " "$PORT"
  curl -s -o /dev/null -w 'HTTP %{http_code}\n' "http://192.168.2.244:$PORT/"
done
```

VM 内验证**公网入口拿到的授权地址**是否正确（这是外网登录成败的关键）：

```bash
# 模拟公网 Host 头 → 网关应返回公网的 Keycloak 地址
PUB_IP=203.0.113.10   # 示例，必须替换为宿主机公网 IP
curl -s -H "Host: $PUB_IP:5173" http://127.0.0.1:5173/v1/auth/config \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["authorizationUrl"])'
# 期望：http://$PUB_IP:8082/realms/enterprise/protocol/openid-connect/auth

# 本机 Host 头 → 应返回 127.0.0.1
curl -s http://127.0.0.1:5173/v1/auth/config \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["authorizationUrl"])'
# 期望：http://127.0.0.1:8082/realms/enterprise/protocol/openid-connect/auth
```

---

## 六、暴露面与可达条件速查

| 组件 | 绑定 | 局域网可达 | 公网可达条件 |
|---|---|---|---|
| Web 控制台 5173 | 127.0.0.1 | ❌ | 仅办公出口经宿主转发与两道白名单后可达 |
| 网关 8080 | 127.0.0.1 | ❌ | 仅办公出口经宿主转发与两道白名单后可达 |
| Agent Core 8090 | 127.0.0.1 | ❌ | 不转发；控制台走同源反代 |
| MCP Server 8091-8093 | 127.0.0.1 | ❌ | 不转发 |
| Keycloak 8082 | 127.0.0.1 | ❌ | 仅办公出口经宿主转发与两道白名单后可达 |
| PostgreSQL / MySQL / Redis / MinIO / ClickHouse | 127.0.0.1 | ❌ | 不转发 |
| Langfuse / RAGFlow / DB-GPT / TEI / Infinity | 127.0.0.1 | ❌ | 仅 RAGFlow Web 8095 按本章显式转发，其余不转发 |
| 回环桥 172.17.0.1:{8080,8091,8092,8093} | 172.17.0.1 | 仅本机容器 | 不转发 |
| **VM 内 route_localnet DNAT** | `ens34` → `127.0.0.1:{5173,8080,8082,8095}` | ❌ | 只接收符合 VM 侧 DNAT 来源条件的转发流量 |

VM 侧已具备上述接入条件；公网是否可达取决于宿主机的 IP 转发、带来源限制的 DNAT、
FORWARD 白名单和云安全组。本文不维护实时状态，以第五章正、负向验收为准。

宿主机配好后，公网访问入口为：

```
http://<公网IP>:5173   ← Web 控制台（唯一用户入口）
http://<公网IP>:8082   ← Keycloak（OIDC，浏览器跳转用）
http://<公网IP>:8080   ← 网关 API（外部系统直调用；仅用控制台可不转）
```

平台侧对公网入口的适配（issuer 列表 / `{host}` 动态授权地址 / 控制台同源反代 /
客户端白名单）已完成历史实测；更换地址或网络规则后必须重新验收。
