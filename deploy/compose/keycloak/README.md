# Keycloak realm 配置

本目录是 **Keycloak 26 的 realm 定义**，是「一键重建企业身份源」的配置基线。

| 文件 | 说明 | 是否入库 |
|---|---|---|
| `realm-eap.json` | `enterprise` realm 全量导出（含 4 个用户、角色映射、平台身份 claim 映射、客户端） | ✅ 入库 |
| `builtin-client-scopes.json` | Keycloak 26 内置 client scope 快照（用于校验 realm 完整性） | ✅ 入库 |
| `themes/eap/` | 企业蓝登录页与管理控制台主题，继承 `keycloak.v2`，仅覆盖样式与品牌图标 | ✅ 入库 |

---

## 登录 Keycloak 管理控制台

Keycloak 26 的**管理控制台**（管理 realm、用户、客户端、策略）和平台控制台
（`http://<对外地址>:5173`）是两套完全独立的登录入口，用的也不是同一批账号。

管理控制台地址（重型栈固定 8082；`/admin/` 会自动跳到 master realm 的控制台）：

```
http://<对外地址>:8082/admin/master/console/
```

本地演示环境使用 **master realm 的系统管理员**（能管所有 realm）：

| 用户名 | 演示口令 |
|---|---|
| `kc-admin` | `kcAdmin@2026` |

> 该明文口令仅用于本地演示，生产环境必须更换。管理脚本从 `deploy/compose/.env` 的
> `KEYCLOAK_ADMIN` / `KEYCLOAK_ADMIN_PASSWORD` 读取凭据；修改管理员口令时必须同步 `.env`，
> 否则脚本会认证失败。

### 两套账号的分工（别再混用）

| 账号 | realm | 用途 | 登录页面 | 口令 |
|---|---|---|---|---|
| `kc-admin` | **master** | 管理所有 realm（系统管理员） | `http://<对外地址>:8082/admin/master/console/` | `kcAdmin@2026` |
| `eap-admin` | enterprise | 平台控制台 / RAGFlow SSO（platform-admin 角色） | `http://<对外地址>:5173` 的登录页 | `EapAdmin@2026` |
| `eap-ops` | enterprise | 同上（platform-admin） | 同上 | `EapOps@2026` |
| `eap-manager` | enterprise | 审批主管 | 同上 | `EapManager@2026` |
| `eap-demo` | enterprise | 普通员工 | 同上 | `EapDemo@2026` |

- 平台控制台的登录页走的是 **enterprise realm**（client `eap-webui`），
  它根本不是管理控制台；RAGFlow 的 SSO 同理（client `eap-ragflow`）。
- 早期 master realm 的引导管理员也叫 `eap-admin`，与 enterprise 的业务账号**同名**，
  导致浏览器密码管理器在两个站点间串填口令、登录反复失败。
  完整重型启动路径现已改为自动创建**独立的 `kc-admin` 永久管理员**并清理引导管理员，
  同名冲突不复存在。

**排查登录失败**：Keycloak 的服务端日志能直接区分原因，别猜：

```bash
docker logs eapheavy-keycloak 2>&1 | grep LOGIN_ERROR | tail -5
```

| 日志里的 `error` | 含义 |
|---|---|
| `user_not_found` | 用户名在这个 realm 不存在（用错 realm 的账号） |
| `invalid_user_credentials` | 用户存在，但**密码不对** |
| `invalid_request` | 请求参数有问题（如缺 `code_challenge_method`） |

日志里 `realmName=` 是 master 还是 enterprise，一眼就能分清是在哪个入口登的。

> 登录成功后会看到顶部的 **"Keycloak Admin"**。若看到的是
> 「You are logged in as a temporary admin user」，说明当前用的是引导管理员——
> 完整重型启动路径会初始化永久管理员 `kc-admin`，不该再出现这个提示。

### 永久管理员初始化

`start-heavy.sh start` 在 Keycloak 运行后自动执行下面的幂等命令：

```bash
python3 scripts/keycloak-admin.py ensure-admin
```

- `KEYCLOAK_ADMIN=kc-admin` 是永久管理员；`KEYCLOAK_BOOTSTRAP_ADMIN=eap-bootstrap`
  是首次启动的临时引导账号，两者必须不同名。
- 数据卷为空时，两个账号的初始口令都取 `KEYCLOAK_ADMIN_PASSWORD`。脚本用临时账号创建
  永久管理员、授予 master realm 的 `admin` 角色，并验证新账号可以认证和查询角色后，
  才删除临时账号。
- 永久管理员已存在时只核验账号与角色并清理残留的临时账号，**不会重置现有口令**。
- 如果绕过 `start-heavy.sh` 直接执行 `docker compose up`，需手动运行上面的命令；
  仅启动容器不会自动完成永久管理员初始化。

> ⚠️ **初始共用口令不代表改密会同步**
>
> 两个账号的初始口令都取 `KEYCLOAK_ADMIN_PASSWORD`，且引导账号自带 `admin` 角色；
> 但它们是两个独立用户，各自保存凭据。修改 `kc-admin` 的口令不会修改残留的
> `eap-bootstrap`，同步 `.env` 也不会改写任何已有用户的口令，旧口令仍可能登录引导账号。
>
> 因此必须先执行 `ensure-admin` 删除引导账号，再按下一节修改永久管理员口令并同步
> `.env`。**删除引导账号与修改永久管理员口令是两个独立的安全动作，不能相互替代。**
>
> 另外注意：引导账号被删除后**不会在容器重建时复活** —— Keycloak 只在
> master realm **没有 admin 用户**时才创建引导账号，而 `kc-admin` 已经有该角色。
> 这一点是实测确认的（删掉引导账号 → 重启容器 → 引导账号未复现）。

### 换掉管理员口令（kc-admin）

**能换。** 改完要**同步 `.env`**，否则所有管理脚本立刻 401。

管理员口令有三个消费方，改一处必须让另外两处跟上：

| 消费方 | 位置 | 改口令后要做什么 |
|---|---|---|
| `scripts/keycloak-admin.py` | 读 `.env` 的 `KEYCLOAK_ADMIN_PASSWORD` 认证 | **同步 `.env`** |
| `scripts/keycloak-hostname.py` | 同上 | **同步 `.env`** |
| Keycloak 容器 | `KC_BOOTSTRAP_ADMIN_PASSWORD` 注入 | **不用管** —— 它只在**数据卷为空、首次启动**时用来创建引导管理员，已存在的用户不会被覆盖 |

操作步骤（用 Admin REST API 改，不要在管理控制台里手改再忘了同步）：

```bash
cd /opt/agent

# ① 用当前口令取管理令牌
TOKEN=$(sudo -n python3 scripts/keycloak-admin.py token)

# ② 取 kc-admin 的 userId（master realm）
UID_KC=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:8082/admin/realms/master/users?username=kc-admin&exact=true" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['id'])")

# ③ 改口令（改成你自己的）
curl -s -o /dev/null -w 'HTTP %{http_code}\n' -X PUT \
  "http://127.0.0.1:8082/admin/realms/master/users/$UID_KC/reset-password" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"type":"password","value":"你的新口令","temporary":false}'

# ④ 同步 .env（这一步漏了，后面所有命令都会 401）
sudo -n sed -i 's|^KEYCLOAK_ADMIN_PASSWORD=.*|KEYCLOAK_ADMIN_PASSWORD=你的新口令|' \
  deploy/compose/.env

# ⑤ 复核
sudo -n python3 scripts/keycloak-admin.py token >/dev/null && echo "管理令牌 OK"
```

> ⚠️ **改口令会让已签发的管理令牌立即失效**（实测：改完再拿改口令前取的令牌调 API 返回 401）。
> Keycloak 在凭据变更时吊销该用户的管理会话 —— 这是**正常行为**，不是故障。
> 所以「先取令牌、再改口令」这一对操作里，改完必须**重新取令牌**；
> 连续改两次口令时，第二次一定要用**新口令**重新取令牌，否则 401。

> ⚠️ **`reset-password` 端点只改凭据**，不动 email / 属性 / 启用状态，
> 也不需要知道旧口令 —— 但它**要求已认证的管理令牌**，所以还是得有口令才能改。

改完**不需要重建 Keycloak 容器**（`KC_BOOTSTRAP_ADMIN_PASSWORD` 对已有用户无效），
也不影响 enterprise realm 的 4 个业务账号（不同 realm、不同用户）。

---

## 平台业务账号的管理（enterprise realm 的 4 个账号）

`enterprise` realm 里跑业务的是 4 个账号，定义在 `realm-eap.json`：

| 账号 | role | tenant_id | dept_id | sensitivity | 能否出网调商业模型 |
|---|---|---|---|---|---|
| `eap-admin` | platform-admin | t-default | dept-platform | confidential | ❌ 被 `deny-confidential-egress` 拦下 |
| `eap-ops` | platform-admin | t-default | dept-general | internal | ✅（网关先脱敏） |
| `eap-manager` | manager | t-default | dept-finance | internal | ✅ |
| `eap-demo` | employee | t-default | dept-finance | internal | ✅ |

> `sensitivity=confidential` 的账号**只能走本地推理（TEI）**，数据不出域 ——
> 这是方案 8.1 数据分级的预期行为，不是故障。

这 4 个属性由 `eap-context` client scope 的 protocol mapper 映射成**令牌 claim**，
网关按 claim 做租户隔离、部门隔离、密级策略。属性名写错**不会报错**，
只会让令牌缺 claim 并被降级取默认值（如 role 缺失 → 退化成 employee），
所以改属性必须用下面的命令，不要在管理控制台里手敲 key 名。

### 三条管理路径

| 路径 | 适合 | 特点 |
|---|---|---|
| **A. `scripts/keycloak-admin.py`（推荐）** | 改属性 / 改口令 / 启停 / 新建 | 有校验、有回读确认、可脚本化、可批量 |
| **B. Keycloak 管理控制台** | 临时查看、看单个用户全貌 | 手改属性容易踩「全量替换」和「必填校验」的坑 |
| **C. 改 `realm-eap.json` + `sync-users`** | 账号定义要长期固化 | 文件是事实来源；**只改文件不 sync 不生效** |

### 常用命令（全部走 Admin REST API，管理员凭据取自 `deploy/compose/.env`）

```bash
# ① 列出用户与平台属性（先看现状）
sudo -n python3 scripts/keycloak-admin.py users enterprise

# ② 改平台属性（角色 / 租户 / 部门 / 密级）
sudo -n python3 scripts/keycloak-admin.py set-attrs enterprise eap-demo \
    dept_id=dept-general role=manager

# ③ 清掉某个属性（下游按缺失降级）
sudo -n python3 scripts/keycloak-admin.py set-attrs enterprise eap-demo \
    --clear sensitivity

# ④ 重置口令（不给新口令就生成随机串并打印一次）
sudo -n python3 scripts/keycloak-admin.py reset-password enterprise eap-demo '新口令@2026'
sudo -n python3 scripts/keycloak-admin.py reset-password enterprise eap-demo
#    → 新口令（只显示这一次）：xxxxxxxx

# ⑤ 停用 / 启用（停用后该账号登录直接 400）
sudo -n python3 scripts/keycloak-admin.py disable-user enterprise eap-demo
sudo -n python3 scripts/keycloak-admin.py enable-user  enterprise eap-demo

# ⑥ 新建账号（不在 realm 文件里，重建 realm 会丢）
sudo -n python3 scripts/keycloak-admin.py create-user enterprise zhangsan \
    --email zhangsan@example.com --attr role=employee \
    --attr tenant_id=t-default --attr dept_id=dept-finance --attr sensitivity=internal

# ⑦ 删除账号（只删运行态；realm 文件里的定义仍在，重建 realm 会复活它）
sudo -n python3 scripts/keycloak-admin.py delete-user enterprise zhangsan

# ⑧ 把 realm 文件里的定义同步到运行态（文件 → 运行态，主路径）
sudo -n python3 scripts/keycloak-admin.py sync-users enterprise
#    也可只同步某一个：sync-users enterprise eap-demo

# ⑨ 给 Agent 平台「用户与权限」页面配置最小权限服务账号
#    eap-gateway 仅获得 realm-management 的 view-users / manage-users；
#    同时确保 role 等自定义属性可写。ensure-admin 启动路径也会自动执行。
sudo -n python3 scripts/keycloak-admin.py ensure-user-admin enterprise
```

完整命令清单：`python3 scripts/keycloak-admin.py --help`（不需要管理凭据）。

`set-attrs` / `enable-user` / `disable-user` **从运行中的用户表示出发**，
不依赖 realm 文件，所以文件里没有的账号也能安全操作；
`sync-users` 反过来是**以文件为准**覆盖运行态。

### 改完什么时候生效

属性写的是**用户档案**，令牌里的 claim 是**签发时快照**：

- 已签发的 access token 仍带旧 claim，**最长 30 分钟**才过期；
- 让用户**刷新令牌或重新登录**后新值才生效；
- 改口令同理：旧令牌在有效期内仍然可用。

### 三个必须知道的坑（都是实测踩出来的）

1. **用户 PUT 是全量替换** —— `PUT /admin/realms/{realm}/users/{id}` 里
   没带的字段会被清空。只传 `{"attributes": {...}}` 会把 email 和姓名一起抹掉。
   命令行工具因此强制构造**完整表示**（email / firstName / lastName / attributes）。
2. **User Profile 必填 email / firstName / lastName** —— 缺任意一项，
   Keycloak 判定「Account is not fully set up」，**该账号直接登不上**（HTTP 400）。
   管理控制台里新建用户时也必须填这三项。
3. **`unmanagedAttributePolicy` 默认是 `DISABLED`** —— Keycloak 24+ 的声明式
   User Profile 默认丢弃所有「未申报属性」，`role` / `tenant_id` / `dept_id` /
   `sensitivity` 正好都属于未申报属性。**不打开的话属性会被静默丢弃**：
   命令不报错、看着「改成功了」，但令牌里没有 claim。
   本仓库的命令在写入前会自动把该策略置为 `ENABLED`（运行时自愈）。
   > 这个策略**没有写进 `realm-eap.json`** —— Keycloak 26 的 REST 建 realm 路径
   > 带 `components` 段会直接 500（三种写法都试过），不可靠。
   > 所以每次**重建 realm** 后，跑一次任意用户命令即可自动恢复。

### 管理控制台里手工改属性的注意事项

如果确实要在控制台里改，记住：

- 进 `Users` 列表 → 点用户 → **Attributes** 标签 → 增删属性 →
  每行 Value 填**单个值**（不要填逗号分隔的多值）；
- 属性名必须**严格**是 `role` / `tenant_id` / `dept_id` / `sensitivity`；
- `role` 取值只能是 `employee` / `manager` / `admin` / `platform-admin`；
  `sensitivity` 只能是 `public` / `internal` / `confidential`；
- 改完**必须保存**（右上角 Save），并确认 `email` / `First name` / `Last name`
  三栏非空 —— 控制台的 PUT 同样是全量替换。

---

## 公网入口用变量占位，不写死地址

`realm-eap.json` 里控制台的重定向白名单不含任何具体公网地址，统一用
`${EAP_PUBLIC_WEB_ORIGIN}` 占位（redirectUris / webOrigins / 登出跳转）：

| 位置 | 占位符 | 替换后 |
|---|---|---|
| `redirectUris` | `${EAP_PUBLIC_WEB_ORIGIN}/*` | `http://<对外地址>:5173/*` |
| `webOrigins` | `${EAP_PUBLIC_WEB_ORIGIN}` | `http://<对外地址>:5173` |
| `post.logout.redirect.uris` | 同上 | 同上 |
| `eap-ragflow` 客户端的 `redirectUris` | `${EAP_PUBLIC_RAGFLOW_ORIGIN}/v1/user/oauth/callback/keycloak` | `http://<对外地址>:8095/v1/user/oauth/callback/keycloak` |
| `eap-ragflow` 客户端的 `webOrigins` | `${EAP_PUBLIC_RAGFLOW_ORIGIN}` | `http://<对外地址>:8095` |

变量来源是 `deploy/compose/.env` 的 `EAP_PUBLIC_WEB_ORIGIN`（容器启动时注入）。
`scripts/start-heavy.sh` 在拉起 Keycloak 前会强制校验这些变量，
**未设置直接拒绝启动** —— 因为 Keycloak 在变量缺失时会把占位符原样写进
redirect URI 且不打任何警告，表现为「控制台登录后跳到无效地址」，极难排查。

校验可单独执行（不启停任何服务）：

```bash
./scripts/start-heavy.sh check
```

## 客户端清单

| clientId | 用途 | 类型 | 密钥 |
|---|---|---|---|
| `eap-webui` | Web 控制台（公开客户端，PKCE） | public | — |
| `eap-agent` | 平台服务端账号（client_credentials） | confidential | `eap-agent-local-secret-2026` |
| `eap-gateway` | 网关管理面 | confidential | `eap-gateway-local-secret-2026` |
| `eap-ragflow` | **RAGFlow 单点登录**（授权码流程，RAGFlow 用 userinfo 的 email 自动建号） | confidential | `${RAGFLOW_OAUTH_CLIENT_SECRET}`（开发默认值 `eap-ragflow-local-secret-2026`） |

> `eap-ragflow` 的 `redirect_uri` 必须与 RAGFlow 侧配置的 `redirect_uri` **完全一致**，
> 否则 Keycloak 直接返回 `invalid_redirect_uri`。
> 另外 Keycloak 动态 hostname 下令牌 `iss` 跟随签发时的请求 Host，
> 所以 RAGFlow 的浏览器侧与后端侧必须用**同一个 Host**（见 `docs/access.md` 6.8）。

### 把客户端应用到运行中的 realm

realm 文件是客户端定义的事实来源，但**已有 realm 不会因为改了文件就生效**，
而且 Keycloak 的文件导入会丢弃 client 的 `attributes`（见本文末尾的说明）。
管理 API 是增量的，用下面的命令把指定客户端建/改到运行中的 realm：

```bash
python3 scripts/keycloak-admin.py apply-client enterprise eap-ragflow
```

命令会读取 `deploy/compose/keycloak/realm-eap.json`，把 `${EAP_PUBLIC_*}` 和
`${RAGFLOW_OAUTH_CLIENT_SECRET}` 按 `deploy/compose/.env` + 进程环境替换后写入运行中的 realm，
并按名字挂载默认 scope。解析不到的占位符会**直接报错**，不会让占位符原样落库。

管理脚本默认读取 `deploy/compose/.env` 的 `KEYCLOAK_ADMIN` / `KEYCLOAK_ADMIN_PASSWORD`，
与 Compose 创建 master realm 引导管理员的配置一致。需要临时使用其他管理员时，用
`KC_ADMIN_USER` / `KC_ADMIN_PASSWORD` 覆盖，优先级高于 `.env`。

> **别和 `ragflow-sso.py` 的变量混用**：这里的 `KC_ADMIN_USER` / `KC_ADMIN_PASSWORD`
> 指的是 **master realm 的系统管理员 `kc-admin`**；`ragflow-sso.py` 里的
> `RAGFLOW_SSO_ADMIN_USER` / `RAGFLOW_SSO_ADMIN_PWD` 指的是 **enterprise realm**
> 的演示管理员 `eap-admin`。两者属于不同 realm，混用会直接认证失败。
> `scripts/keycloak-hostname.py` 已改为与本脚本同源（都读 `.env`）。

已有 confidential 客户端会先通过 `/client-secret` 接口核对密钥。若与 `.env` 不一致，
命令在更新属性前退出，不会继续写入其它配置。

### 轮换 RAGFlow 客户端密钥

Keycloak 的客户端更新接口不接受指定的新密钥，必须调用专用接口生成。执行：

```bash
python3 scripts/keycloak-admin.py rotate-secret enterprise eap-ragflow
```

命令只在终端打印一次新密钥，不会自动修改 `.env` 或重启组件。**Keycloak 生成成功后，
旧密钥立即失效，RAGFlow SSO 会暂时不可用。** 随即把输出值写入 `deploy/compose/.env`
的 `RAGFLOW_OAUTH_CLIENT_SECRET`，再重建用到它的组件：

```bash
./scripts/start-heavy.sh start ragflow keycloak
```

> **Keycloak 容器也要重建**（不只是 RAGFlow）：realm 文件里的
> `${RAGFLOW_OAUTH_CLIENT_SECRET}` 是由 **Keycloak 容器自己的环境变量**在导入时
> 替换的。`.env` 改了但只 `docker restart`，容器仍带着旧环境变量，
> 将来 realm 被重新导入时会写回**旧密钥**，与 `.env`、与 RAGFlow 侧对不上。
> `docker compose up -d` 检测到 env 变化会自动重建。

不要把新密钥追加到 shell 命令参数或提交到 Git。轮换后 realm 文件仍保留变量占位，
无需把生成值写回 `realm-eap.json`。

---

## ⚠ realm-eap.json 里的口令是**开发用明文口令**

这是**有意为之**：realm 导出必须包含凭据才能被 Keycloak 导入并完成用户初始化，
否则 `scripts/keycloak-admin.py` 的账号准备流程无法自动化，验收脚本
（`verify-heavy.sh` / `verify-console-login.mjs`）也无法跑。

但它**不是生产安全的**。上线前必须处理：

| 账号 | 口令 | 角色 | 密级 |
|---|---|---|---|
| `eap-admin` | `EapAdmin@2026` | platform-admin | **confidential** |
| `eap-ops` | `EapOps@2026` | platform-admin | internal |
| `eap-manager` | `EapManager@2026` | manager | internal |
| `eap-demo` | `EapDemo@2026` | employee | internal |

Keycloak 系统管理员 `kc-admin` 的本地演示口令为 `kcAdmin@2026`，同样只用于开发环境。
初始化配置与管理脚本使用 `deploy/compose/.env` 的 `KEYCLOAK_ADMIN` / `KEYCLOAK_ADMIN_PASSWORD`；
改密后必须同步该配置，生产环境不得继续使用上述演示口令。

**生产落地方式**（二选一）：

1. **导入后立即改密** —— 用管理控制台逐个改，或用命令批量改：
   ```bash
   sudo -n python3 scripts/keycloak-admin.py reset-password enterprise eap-admin '新口令'
   ```
   （不给新口令就生成随机串并打印一次；命令只动凭据，不碰 email / 属性 / 启用状态。）
2. **不入库明文口令** —— 把 `realm-eap.json` 里的 `credentials` 段删掉，
   改成部署后用管理 API 创建用户（口令从 K8s Secret 注入）。
   代价是账号准备流程要重写，验收脚本要用变量注入口令。

> 与 `deploy/helm/values.yaml` 的做法保持一致 —— 那边全部是 `CHANGE_ME_*`
> 占位符，Helm Secret 模板在生产指向 `secrets.existingSecret`。
> realm 这边目前是「明文但显式标注」，两者尚未统一，是已知待收敛项。

---

## 密级与平台策略的关系

realm 里每个用户的 `attributes.sensitivity` 决定**能不能出网**（见方案 8.1 数据分级）：

- `internal` → 可经网关调用商业模型（网关内置脱敏后出网）
- `confidential` → **禁止出网**（`deny-confidential-egress` 策略），
  只能走本地推理（TEI），数据不出域

所以 `eap-admin`（confidential）调商业模型会被策略拦下，
`eap-ops` / `eap-demo`（internal）不会 —— 这是策略生效，不是故障。

---

## Keycloak 页面主题

`themes/eap/` 继承 Keycloak 26 的 `keycloak.v2`，保留官方模板、React 管理控制台和认证逻辑，只覆盖样式与品牌资源：

- `login/`：统一登录、找回密码、OTP 等页面的企业蓝配色、卡片宽度、字体、表单控件和窄屏布局。
- `admin/`：统一管理控制台的顶栏、侧栏、导航选中态、标题、表格、卡片和表单样式；品牌图为 `admin/resources/logo.svg`。

Compose 将整个主题目录挂载到 `/opt/keycloak/themes`。`realm-eap.json` 通过 `loginTheme=eap` 默认启用 enterprise 登录主题，并设置“企业级 AI Agent 平台 用户 Keycloak 登录”品牌文案；`scripts/keycloak-admin.py ensure-admin` 会在永久管理员核验后幂等设置 `master.loginTheme=eap`、`master.adminTheme=eap` 和 master 的“管理员 keycloak 登录”品牌文案，同时同步 enterprise 的品牌文案，使新建及已有环境应用统一的登录页与管理控制台外观。

已有 realm 不会自动重新导入 JSON。首次为运行中的环境启用时：

1. 确保新主题已挂载；当前 `start-dev` 环境也可执行 `docker cp deploy/compose/keycloak/themes/eap eapheavy-keycloak:/opt/keycloak/themes/`，无需重建容器。
2. 在 **Enterprise realm → Realm settings → Themes** 将 **Login theme** 设为 `eap`；在 **Master realm → Realm settings → Themes** 将 **Login theme** 和 **Admin theme** 都设为 `eap`。也可执行 `python3 scripts/keycloak-admin.py ensure-admin` 自动设置 master 的两项主题。

`start-dev` 默认关闭主题缓存，刷新授权登录页或管理控制台即可看到变化；使用 `start` 且启用主题缓存的部署需重启 Keycloak。**不需要为了切换主题删除或重新导入 realm**，只修改对应主题字段，不要重导其他配置。

---

## 重新导入 realm

Keycloak 的 `--import-realm` 对**已存在**的 realm 是 `IGNORE_EXISTING` ——
改了 `realm-eap.json` 直接重启容器**不会生效**。
正确做法是「删掉运行中的 realm → 重建容器，让 `--import-realm` 重新导入」。

> **这是破坏性操作**：未写回 realm 文件的用户、角色映射和客户端变更都会丢失，
> 该 realm 的 SSO 会话也会失效。执行前必须备份 Keycloak 数据库或数据卷并确认可以重建；
> 生产环境优先使用 `sync-users` / `apply-client` 做增量变更，不要直接删除 realm。

```bash
# 1. 删掉运行中的 realm（用 master realm 管理员令牌）
cd /opt/agent
AT=$(sudo -n python3 scripts/keycloak-admin.py token)
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE \
  http://127.0.0.1:8082/admin/realms/enterprise -H "Authorization: Bearer $AT"

# 2. 强制重建 Keycloak 容器，触发 --import-realm（约 60s）
./scripts/start-heavy.sh start --force-recreate keycloak
```

> ⚠️ **第 2 步必须带 `--force-recreate`**（实测踩过）。
> 默认的 `compose up -d` **只在 env / 配置变化时**才重建容器；
> 删掉 realm 之后 env 没变，不强制重建 → 容器不重建 → `--import-realm` 不重跑
> → **realm 就再也回不来了**（容器日志里只有 `IGNORE_EXISTING`，没有任何导入动作）。
> `scripts/start-heavy.sh start --force-recreate keycloak` 会强制重建。
>
> 同样地，**`docker restart` 也不行**：`docker restart` 复用旧容器的
> 环境变量快照，`.env` 改了也不会生效 —— 重新导入出来的 realm 会带着**旧值**
> （极端情况是字面量占位符，表现为「登录后跳到无效地址」或「客户端密钥失效」）。
> `docker compose up -d` 会检测到 env 变化并重建容器；`--force-recreate` 是保险。
>
> 启动前 `start-heavy.sh` 会校验占位符：变量没设、或者有值但**没传进 keycloak 容器**，
> 都会直接拒绝启动。

改 realm 后**必须重启网关与 Web 控制台**（issuer 列表、客户端 redirectUris 都在配置里）。

> **重新导入后 realm 不一定是「完全原样」**，有两处要自己补：
> 1. **User Profile 的 `unmanagedAttributePolicy`** —— realm 文件里固化不了
>    （Keycloak 26 建 realm 带 `components` 段会 500），导入后回到未启用状态，
>    此时**任何管理 API 写平台属性都会被静默丢弃**。
>    跑一次任意用户命令即自动恢复（脚本内置运行时自愈）：
>    ```bash
>    sudo -n python3 scripts/keycloak-admin.py set-attrs enterprise eap-demo \
>        dept_id=dept-finance
>    ```
> 2. **客户端的 `attributes`** —— 按 Keycloak 版本不同，可能被导入丢弃。
>    至少恢复控制台的 PKCE 属性和 RAGFlow 的 SSO 属性（机密客户端会核对密钥，不一致直接退出）：
>    ```bash
>    sudo -n python3 scripts/keycloak-admin.py apply-client enterprise eap-webui
>    sudo -n python3 scripts/keycloak-admin.py apply-client enterprise eap-ragflow
>    ```

> ⚠️ **Keycloak 26 没有 `kcadm.sh import`**
>
> 本仓库早期版本的文档写的是「`kcadm.sh import realms/enterprise ... --import-realm`」，
> 这条命令在 Keycloak 26 **根本不存在** —— `kcadm.sh` 的子命令只有
> `config` / `create` / `get` / `update` / `delete` / `get-roles` / `add-roles` /
> `remove-roles` / `set-password` / `help`。
>
> 实测踩过的另外两个坑（同一处）：
> - `kcadm.sh` **不在容器的 PATH 里**，绝对路径是 `/opt/keycloak/bin/kcadm.sh`；
> - **认证 realm 和目标 realm 是两个不同的选项**，容易搞混：
>   `--realm` 决定「拿哪个 realm 的凭据去认证」（`config credentials` 那一组
>   **只有长选项** `--server` / `--realm` / `--user` / `--password`，
>   没有 `-s` / `-u` / `-p` 这类短形式）；
>   `-r` / `--target-realm` 是「去哪个 realm 操作」的**目标 realm**。
>   原来那条命令写 `-r master` 本意是「在 master realm 认证」，实际含义却是
>   「去 master realm 操作」—— 认证 realm 缺失，于是报
>   `No realm or token specified`，非常难查。
>
> 所以**不要**用 kcadm.sh 做 realm 导入 —— 走上面的「REST 删除 + 重建容器」，
> 这条路径还会顺带完成**变量占位符替换**（只有启动时的 `--import-realm` 路径会替换）。
>
> 需要抽取内置 client scope 时，直接使用仓库脚本：
>
> ```bash
> python3 scripts/extract-keycloak-builtin-scopes.py enterprise > scopes.json
> ```
>
> 脚本会从进程环境或 `deploy/compose/.env` 读取当前管理员凭据，并通过
> `docker exec -e KC_BOOTSTRAP_ADMIN_PASSWORD` 只把变量名传入 `docker exec`、由 Docker
> 从宿主环境取值，口令本身不出现在命令参数中。管理员改密后无需为执行该脚本重建容器。

> ⚠️ **REST `PUT /admin/realms/{realm}` 不做变量替换**
>
> 变量替换只在 Keycloak **启动时的 `--import-realm`** 路径生效（实测 Keycloak 26.0：
> `${EAP_PUBLIC_WEB_ORIGIN}` 会被替换成实际地址）。
> 走 REST 整体覆盖 realm 的路径**不经过**这条链，占位符会原样进入 URI 校验 ——
> Keycloak 会直接**拒绝导入**（`validateClient` 报错），属于 fail-fast，
> 不会静默写入字面量。
>
> 若确实要用 REST 覆盖 realm，先把占位符替换掉：
>
> ```bash
> WEB_ORIGIN="${EAP_PUBLIC_WEB_ORIGIN:-http://127.0.0.1:5173}"
> RAGFLOW_ORIGIN="${EAP_PUBLIC_RAGFLOW_ORIGIN:-http://127.0.0.1:8095}"
> # 必须与 RAGFlow 侧一致；留空直接报错，不要让它被替换成空串
> CLIENT_SECRET="${RAGFLOW_OAUTH_CLIENT_SECRET:?未设置 RAGFLOW_OAUTH_CLIENT_SECRET}"
> sed -e "s|\${EAP_PUBLIC_WEB_ORIGIN}|${WEB_ORIGIN}|g" \
>     -e "s|\${EAP_PUBLIC_RAGFLOW_ORIGIN}|${RAGFLOW_ORIGIN}|g" \
>     -e "s|\${RAGFLOW_OAUTH_CLIENT_SECRET}|${CLIENT_SECRET}|g" \
>     deploy/compose/keycloak/realm-eap.json > /tmp/realm-eap.resolved.json
> ```
>
> ⚠️ **两类占位符的失败方式不同，别只看导入有没有报错**：
> - `redirectUris` / `webOrigins` 里的占位符 → Keycloak **拒绝导入**（fail-fast）；
> - `secret` 里的 `${RAGFLOW_OAUTH_CLIENT_SECRET}` → **不会报错**，
>   字面量会被原样存成客户端密钥，表现为「导入成功但 SSO 登录一直失败」。
>   导入后用 `python3 scripts/keycloak-admin.py apply-client enterprise eap-ragflow`
>   复核（有密钥核对，不一致会直接退出）。
>
> 另注：Keycloak 26 的 realm 文件导入会**丢弃 client 的 `attributes`**（两条导入路径都是），
> 所以 `post.logout.redirect.uris`、`pkce.code.challenge.method` 不会随文件导入生效。
> 生产环境这两项由 `scripts/keycloak-admin.py` 的补齐流程经管理 API 写入。
