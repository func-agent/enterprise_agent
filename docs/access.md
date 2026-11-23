# 平台访问方式

本文是平台**所有对外入口的实测清单**：入口地址、鉴权方式、拿到凭据的路径，
以及每个入口对应的用途。所有状态码与响应均为本机实测结果。

> **关于 `<公网IP>` 占位**
> 本仓库为公开仓库，**不内置真实公网地址** —— 那等于对外公布目标地址。
> 全文 `<公网IP>` 为占位符；本机实际取值见内部参数表
> `docs/internal/host-params.local.md`（gitignore，不在公开仓库内），
> 也可用 `./scripts/gen-host-params.sh [公网IPv4] [办公出口CIDR]` 生成。

---

## 一、总览

> **所有地址均为 `127.0.0.1` 绑定** —— 平台服务与容器端口都已收口到回环，
> 只允许本机访问（局域网与公网都连不通）。
> 本机在虚拟机的宿主 NAT 后面，公网 IP 由宿主机持有，
> **外网访问需要宿主机做端口转发**，详见 [network-access.md](network-access.md)。
>
> **VM 侧已具备公网接入条件**：route_localnet DNAT 与平台侧适配
> （多 issuer / 动态授权地址 / 控制台同源反代 / 客户端白名单）已完成历史实测。
> 实际公网可达性取决于宿主机转发、FORWARD 与云安全组的办公来源白名单，
> 更换地址或规则后必须重新做正、负向验收：
>
> | 公网地址 | 服务 | 是否必须转发 |
> |---|---|---|
> | `http://<公网IP>:5173` | Web 控制台（唯一用户入口） | ✅ 必须 |
> | `http://<公网IP>:8082` | Keycloak（OIDC 跳转与换令牌） | ✅ 必须 |
> | `http://<公网IP>:8080` | 网关 API（外部系统直调） | 可选（仅用控制台时不需要） |
> | `http://<公网IP>:8095` | RAGFlow Web 界面（重型组件管理面） | 已选（RAGFlow 侧已关闭自注册） |
>
> 其余端口**一律不转发**（数据库、中间件、其余重型组件管理面）。
>
> > 8095 是唯一被放开的重型组件管理面，且是**明文 HTTP**。
> > RAGFlow 已接入 **Keycloak 单点登录**：访问即被拦截到 Keycloak 认证，
> > 首次登录按 Keycloak 的 email 自动建号，不再需要在 RAGFlow 侧单独记口令。
> > 本地账号 `eap-admin@eap.local` / `EapAdmin@2026` 保留为应急入口
> > （`http://<公网IP>:8095/login?local=1`，普通权限）；
> > `REGISTER_ENABLED=0` 已关闭自注册（实测注册接口返回 `code=103 User registration is disabled!`）。
> > 账号口径与提权方式见[重型组件账号](#重型组件账号keycloak--ragflow)，
> > 登录拦截见[登录页被 Keycloak 接管](#52-ragflow-的登录页被-keycloak-接管)。

| # | 入口 | 地址 | 鉴权 | 用途 |
|---|------|------|------|------|
| 1 | **Web 控制台** | http://127.0.0.1:5173 | Keycloak 授权码 + PKCE | 对话、审批、**知识库**、工具目录、模型、预算、审计（对话走 AG-UI 流式，`POST /ag-ui`） |
| 2 | **agentgateway** | http://127.0.0.1:8080 | Bearer JWT / 服务静态凭证 | 平台唯一 API 入口（LLM 路由、MCP 治理、护栏、预算、审计） |
| 3 | **agent-core** | http://127.0.0.1:8090 | Bearer JWT | Agent 内核（会话、对话、工具执行、AG-UI 事件流 `/ag-ui`） |
| 4 | **MCP Server**（knowledge） | http://127.0.0.1:8091/mcp | MCP 协议（streamable-http） | 知识库工具 |
| 5 | **MCP Server**（chatbi） | 8092（本地实现）/ 8097（DB-GPT 适配器）的 `/mcp` | MCP 协议（streamable-http） | Text2SQL / 指标字典 |
| 6 | **MCP Server**（business） | http://127.0.0.1:8093/mcp | MCP 协议（streamable-http） | 业务工具 |
| 7 | Keycloak | http://127.0.0.1:8082 | — | 身份提供方（SSO） |
| 7b | Keycloak **管理控制台** | http://127.0.0.1:8082/admin/master/console/ | master realm 系统管理员 `kc-admin` | 管理 realm / 用户 / 客户端 / 策略；**与平台控制台不是同一套账号**，见 [Keycloak 管理控制台登录](../deploy/compose/keycloak/README.md#登录-keycloak-管理控制台)；**业务账号怎么管**见 [平台业务账号的管理](#七平台业务账号的管理) |
| 8 | Langfuse | http://127.0.0.1:3001 | 项目 API Key | 观测（Trace / 成本 / 评估） |
| 9 | ClickHouse | http://127.0.0.1:8124（HTTP）/ 9004（原生） | 用户名密码 | Langfuse 底层存储 |
| 10 | TEI | http://127.0.0.1:6380 | 无（内网） | 本地嵌入模型（384 维） |
| 11 | RAGFlow API | http://127.0.0.1:9380 | **Keycloak SSO**（`eap-ragflow` 客户端）；本地账号 `eap-admin@eap.local` / `EapAdmin@2026` 兜底 | 文档解析 / 切分 / 检索（**独立组件，与平台知识库不互通**） |
| 11b | RAGFlow Web 界面 | http://127.0.0.1:8095（公网 `http://<公网IP>:8095`） | **Keycloak 单点登录**（登录页被拦截，浏览器直达 Keycloak）；`?local=1` 走本地账号 `eap-admin@eap.local` / `EapAdmin@2026` | RAGFlow 自带的 Web UI（静态资源 + API 代理） |
| 12 | DB-GPT apiserver | http://127.0.0.1:8094 | — | DB-GPT 模型 API |
| 13 | DB-GPT webserver | http://127.0.0.1:8096 | — | DB-GPT 控制台 |
| 14 | Infinity | http://127.0.0.1:23821（HTTP）/ 5434（PSQL） | — | 向量检索引擎 |
| 15 | PostgreSQL（平台支撑层） | 127.0.0.1:5432 | 用户名密码 | 平台主库，库名 `eap` |
| 15b | PostgreSQL（重型依赖层） | 127.0.0.1:5433 | 用户名密码 | 仅 Langfuse / DB-GPT，不是平台主库 |
| 16 | MySQL | 127.0.0.1:3307 | 用户名密码 | RAGFlow 元数据库；DB-GPT 使用重型栈 PostgreSQL |
| 17 | MinIO（平台支撑层） | http://127.0.0.1:9000（API）/ 9001（Console） | AccessKey | 平台审计归档 |
| 17b | MinIO（重型依赖层） | http://127.0.0.1:9002（API）/ 9003（Console） | AccessKey | Langfuse / RAGFlow 等重型组件 |
| 18 | Redis（平台支撑层） | 127.0.0.1:6379 | 本机脚本默认未启用密码 | 平台缓存 |
| 18b | Redis（重型依赖层） | 127.0.0.1:6381 | 密码 | Langfuse / RAGFlow 等重型组件 |

> **只有 1–3 是「平台自己的」入口**，4–6 是平台托管的 MCP 服务，其余是支撑层或重型组件入口，
> 不直接对终端用户开放。15/17/18 与 15b/17b/18b 是不同容器、数据卷和凭据，不能混用。

---

## 二、Web 控制台（推荐入口）

### 2.1 打开

```
http://127.0.0.1:5173
```

生产部署时为控制台的对外域名（如 `https://console.example.com`）。

### 2.2 登录流程（授权码 + PKCE）

控制台是 **公开客户端**（`client_id=eap-webui`，无客户端密钥），完整流程：

```
浏览器                                        Keycloak                网关
  │  GET /v1/auth/config ──────────────────────►│                       │  ① 读鉴权模式
  │  ◄──────────────────── {mode:"oidc", ...}   │                       │
  │                                               │                       │
  │  跳转 /protocol/openid-connect/auth           │                       │  ② 携带
  │  ?code_challenge=S256(verifier)&state&nonce ─►│                       │
  │  ◄────────────── 登录页（用户名/口令）        │                       │
  │  POST 登录表单 ─────────────────────────────►│                       │
  │  ◄────────────── 302 /auth/callback?code=.. │                       │  ③ 授权码
  │                                               │                       │
  │  POST /protocol/openid-connect/token ───────────────────────────────► │  ④ 换令牌
  │  （code + code_verifier）                     │                       │
  │  ◄────────────── {access_token, id_token, refresh_token}            │
  │                                               │                       │
  │  存 localStorage，调用 /v1/* 时带 Authorization: Bearer <token>      │  ⑤ 业务调用
  │                                               │                       │
  │                                        网关用 JWKS 校验 JWT，取 tenant_id/role/dept_id/sensitivity
```

要点：

- **令牌交换全在浏览器侧完成**，网关与前端都不持有长期密钥；PKCE 的 `code_challenge_method=S256`。
- `state` 在 `sessionStorage` 中校验，防止 CSRF；`code_verifier` 有效期 10 分钟。
- 令牌有效期 1800 秒（Keycloak realm 配置），过期后网关返回 401，控制台自动回到登录页。
- 身份由 JWT claim 推导：`tenant_id` / `role` / `dept_id` / `sensitivity`（realm 的 `eap-context`
  client scope 映射器下发），`user_id` 取 OIDC 标准 `sub`。
  **权限判定以网关侧为准**，前端展示的身份只是回显。

### 2.3 退出

点右上角「退出登录」：清本地令牌 + 调用 Keycloak `end_session_endpoint` 结束 SSO 会话。

---

## 三、API 调用（脚本 / 集成）

### 3.1 取令牌

三种方式，按场景选：

```bash
# ① 密码模式（人/脚本直连，最常用；realm 允许 direct access grants）
TOKEN=$(curl -s -X POST http://127.0.0.1:8082/realms/enterprise/protocol/openid-connect/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=password' -d 'client_id=eap-webui' \
  -d 'username=eap-demo' -d 'password=EapDemo@2026' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')

# ② 服务账号（client_credentials）—— 组件间调用
TOKEN=$(curl -s -X POST http://127.0.0.1:8082/realms/enterprise/protocol/openid-connect/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=client_credentials' -d 'client_id=eap-agent' \
  -d 'client_secret=eap-agent-local-secret-2026' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')

# ③ 服务间静态凭证 —— 给无法走 OIDC 流程的组件（如 DB-GPT 的 OpenAI 兼容客户端）
#    格式：<token>[:<role>[:<tenantId>[:<deptId>[:<sensitivity>]]]]
#    例：eap-dbgpt-local-key:employee:t-default:dept-general:internal
```

> 静态凭证身份**不旁路任何治理** —— 策略、预算、护栏、审计照常生效，
> 只是角色被限制在平台内置角色内（默认 `employee`）。

### 3.2 调平台 API

```bash
curl -s http://127.0.0.1:8080/v1/models -H "Authorization: Bearer $TOKEN"
curl -s http://127.0.0.1:8090/api/sessions -H "Authorization: Bearer $TOKEN"

# OpenAI 兼容入口（AgentScope 等框架直连）
curl -s http://127.0.0.1:8080/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"model":"eap-chat","messages":[{"role":"user","content":"员工年假怎么请？"}]}'
```

### 3.3 免鉴权端点

| 端点 | 说明 |
|------|------|
| `GET /healthz` | 健康检查，附 `authMode`（`dev` / `oidc`）与 issuer |
| `GET /v1/auth/config` | 鉴权模式 + OIDC 授权参数（clientId / authorizationUrl / tokenUrl / scope / redirectPath） |

`/v1/auth/config` 是控制台登录的唯一配置来源，前端不自行猜测鉴权模式。

---

## 四、MCP Server 接入

三个 MCP Server 都是 **streamable-http** 协议，路径 `/mcp`：

```bash
curl -s -X POST http://127.0.0.1:8091/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
       "protocolVersion":"2024-11-05","capabilities":{},
       "clientInfo":{"name":"probe","version":"1"}}}'
```

完整重型栈的实测握手结果：`eap-knowledge`（8091）、`eap-chatbi`（8097，DB-GPT 适配器）、`eap-business`（8093）。轻量模式的 ChatBI 本地实现使用 8092。

> 直接 `GET /mcp` 会返回 404/406 —— 这是正常的，MCP 只接受带 MCP 协议的 POST。

**业务方不要直连 MCP Server**，一律经网关 `/v1/mcp/tools` 与 `/v1/mcp/call`
（见 `docs/api.md`），由网关统一施加策略、预算、护栏与审计。

---

## 五、重型组件各自的登录方式

| 组件 | 凭据 | 位置 |
|------|------|------|
| Keycloak | 4 个本地账号：`eap-admin` / `eap-ops` / `eap-manager` / `eap-demo` | `deploy/compose/keycloak/realm-eap.json` |
| Langfuse | 项目 API Key `pk-lf-…` / `sk-lf-…` | `deploy/compose/.env` |
| ClickHouse | `eap` / `CLICKHOUSE_PASSWORD` | `deploy/compose/.env` |
| PostgreSQL | `eap` / `POSTGRES_PASSWORD` | `deploy/compose/.env` |
| MySQL | `root` / `MYSQL_ROOT_PASSWORD` | `deploy/compose/.env` |
| MinIO | `eapadmin` / `MINIO_ROOT_PASSWORD` | `deploy/compose/.env` |
| RAGFlow | **Keycloak 单点登录**（点 "Keycloak" 按钮）；本地账号 `eap-admin@eap.local` 作应急入口 | `deploy/compose/keycloak/realm-eap.json`（`eap-ragflow` 客户端） |
| DB-GPT | `DBGPT_API_KEY`（指向网关 `/v1`） | `deploy/compose/.env` |
| TEI / Infinity / Redis | 无鉴权或弱口令，仅限内网 | `deploy/compose/.env` |

> **上线前必须替换全部本地开发口令**（见 `docs/operations.md` 的「上线检查清单」）。

### 5.1 RAGFlow 的 Keycloak 单点登录（账号打通）

RAGFlow 0.22 自带第三方登录渠道（`common/settings.py` 的 `OAUTH_CONFIG`），
本项目把 **Keycloak 配成 RAGFlow 的身份源**：

```
浏览器 → RAGFlow 登录页的 "Keycloak" 按钮
       → Keycloak 授权（realm enterprise，客户端 eap-ragflow）
       → 回调 http://<公网IP>:8095/v1/user/oauth/callback/keycloak
       → RAGFlow 取 userinfo 的 email 自动建号并登录
```

- 用户在 RAGFlow 侧**不必再记第二套口令**，账号口径以 Keycloak 为准；
- RAGFlow 里的账号以 `login_channel=keycloak` 标识，可与本地账号区分；
- Keycloak 的角色（platform-admin / manager / employee）**不会**自动映射到 RAGFlow，
  RAGFlow 的管理员由提权单独指定。

| Keycloak 账号 | RAGFlow 侧账号 | 权限 |
|---|---|---|
| `eap-admin` | `eap-admin@example.com` | **RAGFlow 管理员**（`is_superuser=1`，由脚本提权） |
| `eap-ops` / `eap-manager` / `eap-demo` | 同名 `@example.com` 账号 | 普通用户（首次登录自动建号） |
| —（本地） | `eap-admin@eap.local` | 普通用户，应急入口（`REGISTER_ENABLED=0` 已关闭自注册） |

常用命令：

```bash
python3 scripts/ragflow-sso.py channels            # 核对 SSO 渠道是否生效
python3 scripts/ragflow-sso.py login --user eap-demo # 模拟浏览器走完 SSO
python3 scripts/ragflow-sso.py verify               # 组合验收（幂等，缺管理员自动补提权）
```

> **在 RAGFlow 界面里加模型**：模型提供商 → 添加模型 → 选 `OpenAI-API-Compatible`，
> **Base URL 填 `http://172.17.0.1:8080/v1`（网关，不是厂商地址）**，
> API Key 填 `eap-dbgpt-local-key`，**模型名称填网关的虚拟模型名**
> （`smart-model` / `reasoning-model` / `fast-model` / `minimax`）。
> 填成厂商真实型号或把 Base URL 指向 MiniMax 公有云，都会失败 ——
> 排查与批量配置见 [docs/operations.md 的 (7) RAGFlow 接入 MiniMax](operations.md#7-ragflow-接入-minimax走-agentgateway不直连商业-api)。

> **跨应用会话的行为（实测）**：控制台（5173）与 RAGFlow（8095）是两个独立应用，
> 登录态**不共享**（RAGFlow 用自己的 Flask 会话 + 签名令牌）。
> 但 Keycloak 的会话 Cookie 是**按域名共享、不区分端口**的，
> 因此在控制台登录过 Keycloak 之后，8095 会被直接送进 Keycloak 并**静默换回令牌**，
> 全程不需要再输口令。
>
> 实测（headless Chromium，同一浏览器上下文，走公网地址）：
> 5173 用 `eap-admin` 登录 → 直接访问 8095 → URL 依次变为
> `/login` → `/login-sso.html` → Keycloak 授权端点 → 回到
> `http://<公网IP>:8095/` 的 RAGFlow 主界面，**全程无口令输入框**。
> 只有 Keycloak 会话过期或换浏览器/隐私窗口时才会再问一次。

### 5.2 RAGFlow 的登录页被 Keycloak 接管

RAGFlow 原生登录页是「邮箱 + 口令」表单（本部署的本地账号只作应急）。
启用 SSO 后，**访问 RAGFlow 会被直接拦到 Keycloak**，不再停在本地表单：

```
访问 http://<公网IP>:8095
  → nginx 拦截 /login → 302 /login-sso.html（中文说明页 + 兜底链接）
  → 该页自动跳 /v1/user/login/keycloak → Keycloak 授权
  → 回调 /v1/user/oauth/callback/keycloak → RAGFlow 建号/登录 → 回到主界面
```

| 入口 | 行为 |
|---|---|
| `http://<公网IP>:8095/` | 被拦截 → Keycloak 登录（已登录则静默通过） |
| `http://<公网IP>:8095/login` | 同上 |
| `http://<公网IP>:8095/login?local=1` | **保留 RAGFlow 原生本地账号表单**（应急入口，不会被拦死） |

拦截由 nginx 完成（`deploy/compose/ragflow/nginx/ragflow.conf` 引入
`/etc/nginx/sso/*.conf`，片段由 `eap-entrypoint.sh` 在容器启动时生成），
不改 RAGFlow 的前端产物 —— 镜像升级时不会静默失效。
未启用 SSO 时不生成该片段，登录页保持 RAGFlow 原样。

### 5.3 RAGFlow 企业账号登出：同时结束单点登录会话

企业 SSO 账号在 RAGFlow 点「退出登录」→ **Keycloak 单点登录会话同时结束**，
下次重新认证需要输入口令，不会被 SSO 自动登回来。本地账号只结束 RAGFlow 自己的会话，
不会修改企业 SSO 或平台控制台的登录态。

```
企业 SSO：退出 → RAGFlow 清会话，写 eap_sso_logout=keycloak
        → /login → /logout-sso → Keycloak end_session
        → 有 id_token_hint：静默结束；没有：先在 Keycloak 确认
        → /logout-done.html → 下次登录需要口令

本地账号：退出 → RAGFlow 清会话，写 eap_sso_logout=password
        → /login → /logout-local → /logout-done.html?local=1
        → 不触碰企业 SSO
```

| 落点 | 文件 | 作用 |
|---|---|---|
| 后端补丁 | `deploy/compose/ragflow/eap-patch-sso-logout.py` | 固定 ORM 用户对象，确保旧 token 真正失效；OAuth 回调写 HttpOnly Cookie `eap_kc_id_token`；登出时按渠道写 `eap_sso_logout=keycloak|password` |
| nginx 拦截 | `deploy/compose/ragflow/eap-entrypoint.sh` → `/etc/nginx/sso/ragflow-sso.conf` | 区分企业 SSO 与本地账号；缺少 `id_token_hint` 时进入 Keycloak 确认页，不提前显示成功 |
| 已退出页 | `deploy/compose/ragflow/nginx/logout-done.html` | 分别展示企业 SSO / 本地账号的退出结果与重新登录入口 |
| 回调登记 | `deploy/compose/keycloak/realm-eap.json` 的 `eap-ragflow` 客户端 | `post.logout.redirect.uris` 必须登记登出回落地址，否则 Keycloak 返回 400 |

> **对控制台的真实影响**：结束 Keycloak SSO 不等于立即清除控制台本地会话。
> 已打开的控制台可能继续使用现有 access token 直到过期；下一次重新进行 OIDC 认证时才需要口令。
> 如需即时全局登出，还需 backchannel logout、令牌撤销或前端会话失效机制。

> **未登出时仍然是免密的**：只有企业 SSO 的「刚登出」链路会走 `end_session`；
> 普通访问 `/login` 依旧直接进 Keycloak 静默换令牌。

> `id_token_hint` 会短暂出现在浏览器地址栏的 Keycloak URL 里，这是 RP-initiated logout 的标准做法。
> Cookie 为 HttpOnly + SameSite=Lax；对外地址为 HTTPS 时自动增加 `Secure`。

关键实现约束（均已实测，见 `docs/operations.md` 的踩坑章节）：

- 要**静默**结束会话必须带 `id_token_hint`；缺少时 Keycloak 26.0.8 会显示确认页，
  只有用户确认后才结束会话，因此不能把确认页之前的状态当成成功；
- `id_token_hint` **过期也没关系** —— `end_session` 只要 token 里的 `sid`，不校验 `exp`；
- `post.logout.redirect.uris` 的**多值分隔符是 `##`**（不是逗号），且支持 `*` 通配；
- 改完后端补丁、HTML 或入口脚本后要强制重建容器：
  `./scripts/start-heavy.sh start --force-recreate ragflow`。

复核方式：

```bash
# SSO 登出、令牌失效、真实免密、缺失 id_token 与本地账号分支（19 项）
bash scripts/verify-ragflow-logout.sh
```

---

## 六、实测踩过的坑（复现与规避）

这一节记录的都是本机实测定位的真实缺陷，避免重复踩。

### 6.1 realm 文件导入会丢内置 client scope

**现象**：控制台能登录，但 access_token 里没有 `sub` / `preferred_username` / `realm_access`，
所有用户的 `user_id` 塌缩成同一个值，审计日志无法区分操作者。

**根因**：Keycloak 26 的 `--import-realm` **文件导入路径不会种下内置 client scope**
（`profile` / `email` / `roles` / `web-origins` / `acr` / `basic` …），
而用管理 API 创建 realm 时才会。realm JSON 里一旦显式声明了 `clientScopes` 数组，
导入就只会得到数组里列出的那几个。

**表现**：realm 里所有客户端的 `defaultClientScopes` 都被静默裁剪，
请求 `scope=openid profile` 会报 `Invalid scopes`。

**修复**：`deploy/compose/keycloak/realm-eap.json` 已显式内联全部内置 scope 定义
（定义副本见 `deploy/compose/keycloak/builtin-client-scopes.json`），
导入后 14 个 client scope 齐备，token claim 完整。

**复核**：`python3 scripts/keycloak-admin.py scopes enterprise`

（内置 scope 定义副本可用 `python3 scripts/extract-keycloak-builtin-scopes.py <健康realm>` 重新抽取。）

### 6.2 Keycloak 的 Secure cookie 在明文 HTTP 下的行为

**现象**：用 Python 脚本模拟浏览器登录时，表单提交返回 400，日志里是
`error="cookie_not_found"`。

**根因**：Keycloak 26 固定给 `AUTH_SESSION_ID` / `KC_RESTART` 打上 `Secure; SameSite=None`
（跨站跳转流程需要），而 Python 的 `http.cookiejar` 只在 https 下回传 Secure cookie。

**结论**：真实浏览器不受影响 —— Chrome / Firefox 把 `http://127.0.0.1` 与
`http://localhost` 视为「潜在可信源」，会正常回传 Secure cookie。
**已用真实 Chromium 端到端验证通过**（`scripts/verify-console-login.mjs`，21 项）。

**规避**：脚本模拟浏览器时需放宽 cookie 策略（见 `scripts/oidc-flow-probe.py` 的
`LoopbackSecurePolicy`）。生产环境 Keycloak 走 HTTPS 则无此问题。

### 6.3 失效的 DISPLAY 会让无头浏览器卡死

**现象**：Playwright 启动 Chromium 后，`page.screenshot()` 一直卡在
`waiting for fonts to load... fonts loaded`，`locator.click()` 等不到 stable。

**根因**：本机残留了一个失效的 X server（`DISPLAY=localhost:13.0`），
Chromium 会去连它，导致合成器不出帧。Headless 本就不需要 X。

**规避**：启动浏览器时清掉 `DISPLAY`（见 `scripts/verify-console-login.mjs` 的 `BROWSER_ENV`）。

### 6.4 Chromium 缺系统库

**现象**：`chrome-headless-shell: error while loading shared libraries: libatk-1.0.so.0`。

**规避**：所需库放在 `.cache/chromium-libs`（从 RAGFlow 容器借出），
脚本启动时挂 `LD_LIBRARY_PATH`，无需 sudo 安装系统依赖。

### 6.5 Keycloak 26 的 `post.logout.redirect.uris` 不支持多值

**现象**：退出登录时 Keycloak 返回 **400**（日志 `error="invalid_redirect_uri"`）。

**根因**：控制台要带 `post_logout_redirect_uri` 做 RP-initiated 登出，
但 `http://127.0.0.1:5173` 没在客户端登记；补登记后发现
**Keycloak 26.0.8 把该属性按整串匹配** —— `+` 分隔、换行分隔、逗号分隔全部无效
（实测三种格式都返回 400，单值才 302）。

**修复**：登出请求**不带** `post_logout_redirect_uri`，只带 `client_id` + `id_token_hint`
（已实测返回 200，且 SSO 会话确实结束 —— 登出后再次授权会重新要求输口令）。
控制台留在自己的页面展示登录框，不会闪一下 Keycloak 登录页。

### 6.6 MCP Server 重启后工具目录整体不可用

**现象**：只重启 DB-GPT 容器（网关不动），网关调 `chatbi.list_metrics` 直接失败。

**根因**：MCP 有状态会话下，服务端重启会让旧 session 失效，而客户端缓存了连接不会重连。

**修复**：`chatbi` 适配器改为 `stateless_http=True`；网关客户端检测到会话失效会自动重连一次
（`packages/mcp-hub/src/client.ts`，单测见 `tests/mcp-client.test.ts`）。

### 6.7 公网明文 HTTP 访问控制台「页面报错」，本机却完全正常

**现象**：从公网 `http://<公网IP>:5173` 打开控制台，**页面能正常渲染**，
但点「使用企业账号登录」**没反应 / 报错**；同一套代码在本机
`http://127.0.0.1:5173` 却一切正常。最具迷惑性的是：
**外部 HTTP 探测全部 200**（`check-host` 实测 5/5），看起来不像服务问题。

**根因**：浏览器只在**安全上下文**（secure context）里提供 `crypto.subtle`：

| 来源 | isSecureContext | `crypto.subtle` |
|---|---|---|
| `https://…` | true | ✅ 可用 |
| `http://localhost:5173` / `http://127.0.0.1:5173` | true | ✅ 可用（浏览器视为可信源） |
| `http://<公网IP>:5173`（公网明文 HTTP） | **false** | ❌ **undefined** |

PKCE 的 S256 挑战需要 SHA-256。原实现直接调
`crypto.subtle.digest('SHA-256', …)`，在公网明文 HTTP 下 `crypto.subtle` 是 `undefined` →
抛 `TypeError: Cannot read properties of undefined (reading 'digest')` →
`startOidcLogin()` 在 `window.location.assign()` 之前就中断 → **浏览器根本不跳转**，
控制台只留下一个未捕获异常。本机是安全上下文，所以完全正常 —— 这就是「本机通、公网不通」的原因。

**修复**：新增 `apps/webui/src/sha256.ts`（纯 JS SHA-256，FIPS 180-4，无外部依赖），
`oidc.ts` 的 `sha256Base64Url()` 改为**优先用 `crypto.subtle`，没有则退回纯 JS 实现**，
任何来源都能算出 S256（`crypto.getRandomValues` 不受安全上下文限制，state / nonce 不受影响）。

**历史验收记录**（以下 `203.0.113.10` 是文档保留示例地址，实际运行时需替换）：
- `node scripts/verify-secure-context-pkce.mjs http://203.0.113.10:5173` —— 5 项，
  其中「点击登录能跳转 Keycloak」在 `isSecureContext=false` 下断言通过；
- `EAP_CONSOLE_URL=http://203.0.113.10:5173 node scripts/verify-console-login.mjs` —— 21/21；
- 单测 `tests/sha256.test.ts` —— 与 Node 原生 `crypto.createHash('sha256')` 逐字节比对。

**延伸建议**：生产环境若条件允许，控制台应走 **HTTPS**（在宿主机终止 TLS 再转发到 5173）。
即便不配 HTTPS，本兜底也已保证明文 HTTP 下功能完整 —— 但明文 HTTP 下令牌与 Cookie
在链路上是明文，这是**传输层**的问题，与本次修复无关，仍建议上 HTTPS。

### 6.8 RAGFlow SSO：令牌签发方与校验方必须同 Host，否则 userinfo 401

**现象**：RAGFlow 的 SSO 渠道已出现（`/v1/user/login/channels` 返回 `keycloak`），
浏览器跳 Keycloak 也正常，回调能拿到 code —— 但回调里 RAGFlow 拉 userinfo 时报：

```
401 Client Error: Unauthorized for url: http://keycloak:8080/realms/enterprise/protocol/openid-connect/userinfo
```

**根因**：本机 Keycloak 是**动态 hostname**（`KC_HOSTNAME_STRICT=false`，未固定 `KC_HOSTNAME`），
令牌里的 `iss` **跟随签发时的请求 Host**：

- 浏览器从 `http://<公网IP>:8082` 授权 → 令牌 `iss = http://<公网IP>:8082/realms/enterprise`；
- 若 RAGFlow 拿这个令牌去**容器内的** `http://keycloak:8080` 拉 userinfo，
  该端点按自己的 Host（`keycloak:8080`）算出期望的 issuer → **不匹配 → 401**（空响应体）。

也就是说，"浏览器走公网、后端走内网"这种直觉上的拆分在动态 hostname 下是**错的**。

**修复**：RAGFlow 的 oauth 配置里**浏览器侧与后端侧用同一个 Host**（都用公网地址），
容器经宿主 hairpin 回连 Keycloak。`deploy/compose/ragflow/eap-entrypoint.sh` 会把
`RAGFLOW_OAUTH_KEYCLOAK_BACKEND` 留空时默认跟随浏览器侧地址，并在启动日志里打印实际值。

若将来把 Keycloak 改成**固定 hostname**（`KC_HOSTNAME` + `KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true`），
令牌 `iss` 与请求 Host 无关，后端侧才可以改回容器内地址：
`RAGFLOW_OAUTH_KEYCLOAK_BACKEND=http://keycloak:8080`。

**附带坑**：RAGFlow 的 API 鉴权**不走会话 Cookie**，而是 `Authorization` 头里的
itsdangerous 签名令牌（回调 `?auth=` 参数带的那个，见 `api/apps/__init__.py` 的 `_load_user`）。
只带 Cookie 调 `/v1/user/info` 会拿到 `{"code":401}`。

---

## 七、平台业务账号的管理

平台跑业务的是 **enterprise realm** 里的 4 个账号，定义在
`deploy/compose/keycloak/realm-eap.json`：

| 账号 | role | tenant_id | dept_id | sensitivity | 能否出网调商业模型 |
|---|---|---|---|---|---|
| `eap-admin` | platform-admin | t-default | dept-platform | confidential | ❌ 被 `deny-confidential-egress` 拦下，只能走本地推理 |
| `eap-ops` | platform-admin | t-default | dept-general | internal | ✅（网关先脱敏） |
| `eap-manager` | manager | t-default | dept-finance | internal | ✅ |
| `eap-demo` | employee | t-default | dept-finance | internal | ✅ |

这 4 个属性由 `eap-context` client scope 的 protocol mapper 映射成**令牌 claim**，
网关据此做租户隔离、部门隔离、密级出网策略。

### 命令行（推荐）

管理员凭据取 `deploy/compose/.env` 的 `KEYCLOAK_ADMIN` / `KEYCLOAK_ADMIN_PASSWORD`
（即 master realm 的 `kc-admin`），脚本已内置回读校验：

```bash
# 列出用户与平台属性
sudo -n python3 scripts/keycloak-admin.py users enterprise

# 改属性（角色 / 租户 / 部门 / 密级）
sudo -n python3 scripts/keycloak-admin.py set-attrs enterprise eap-demo \
    dept_id=dept-general role=manager

# 重置口令（不给则生成随机串并打印一次）
sudo -n python3 scripts/keycloak-admin.py reset-password enterprise eap-demo '新口令@2026'

# 停用 / 启用
sudo -n python3 scripts/keycloak-admin.py disable-user enterprise eap-demo
sudo -n python3 scripts/keycloak-admin.py enable-user  enterprise eap-demo

# 新建 / 删除
sudo -n python3 scripts/keycloak-admin.py create-user enterprise zhangsan \
    --email zhangsan@example.com --attr role=employee --attr tenant_id=t-default \
    --attr dept_id=dept-finance --attr sensitivity=internal
sudo -n python3 scripts/keycloak-admin.py delete-user enterprise zhangsan

# 把 realm 文件的定义同步到运行态（文件 → 运行态，主路径）
sudo -n python3 scripts/keycloak-admin.py sync-users enterprise
```

完整说明、参数表与踩坑记录见
[deploy/compose/keycloak/README.md](../deploy/compose/keycloak/README.md#平台业务账号的管理enterprise-realm-的-4-个账号)。

### 关键约束

- **属性名写错不报错** —— `role` / `tenant_id` / `dept_id` / `sensitivity`
  拼错只是让令牌缺 claim 并被降级取默认值（role 缺失 → 退化成 employee）。
  命令行工具对属性名和取值都做了白名单校验。
- **改完不立即生效** —— claim 是令牌签发时的快照，access token 有效期 30 分钟；
  用户刷新令牌或重新登录后新值才生效。
- **`unmanagedAttributePolicy` 必须为 `ENABLED`** —— Keycloak 24+ 默认丢弃
  未申报属性，不打开的话属性**静默丢失**；工具在写入前自动打开（运行时自愈）。
  该策略没写进 realm 文件（Keycloak 26 建 realm 带 `components` 段会 500），
  **重建 realm 后跑一次任意用户命令即可恢复**。
- **用户 PUT 是全量替换** —— 漏传 `email` / `firstName` / `lastName` 会被清空，
  而 User Profile 把这三项设为必填，缺了账号直接登不上。
  命令行工具因此强制构造完整表示；管理控制台里手工改也要注意同样的坑。

### 管理控制台

`http://127.0.0.1:8082/admin/master/console/` → `enterprise` → `Users`，
用 master realm 的 `kc-admin` 登录（口令在 `.env`）。

---

## 八、相关文档

- [docs/network-access.md](network-access.md) —— **网络暴露与端口收口**（VM/宿主机拓扑、端口转发、收口清单）
- `docs/api.md` —— 平台 API 契约
- `docs/operations.md` —— 启停、验收、排障、上线检查清单
- `docs/component-mapping.md` —— 方案 3.1 组件对齐表
- `docs/security.md` —— 身份、密钥、审计与脱敏
- `scripts/verify-console-login.mjs` —— 控制台登录端到端验收（21 项）
- `scripts/verify-secure-context-pkce.mjs` —— 非安全上下文 PKCE 回归验收（5 项，公网明文 HTTP 专用）
- `scripts/keycloak-admin.py` —— realm 管理工具（scope / 用户 / 客户端）
