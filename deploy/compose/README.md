# 企业级 AI Agent 平台 —— Docker Compose 编排基线（POC 单机）

依据《企业级 AI Agent 平台建设方案》**第 9 章 部署方案与硬件配置**：

| 方案章节 | 内容 | 本目录对应物 |
|---|---|---|
| 9.1 硬件配置 | POC：1 台 16C / 32G / 500G SSD，全组件单机 | `docker-compose.yml`（全部组件共用一台宿主机） |
| 9.2 部署形态 | POC 单机 Docker Compose，生产 K8s + Helm | 本目录 + `../helm`；均仍需真实环境验收 |
| 9.3 网络要求 | 禁止业务组件直连商业 API，必须过网关 + 出网代理 | 4 层网络（support / data / app / egress） |
| 9.4 关键部署参数 | `DOC_ENGINE=infinity`、MinIO 版本化、网关多副本 | 见下文「关键参数落地」；编排声明不等于功能验收 |

> **能力边界**：当前完整实测路径是“Compose 依赖组件 + 宿主平台服务”，见
> [根 README 的快速开始](../../README.md#快速开始)。本文的基础 Compose 只用于编排检查，
> 不能直接全量启动后视为完整平台可用；已知接线缺口见第六节。
> `docker-compose.heavy.yml` 是本机实测路径使用的重型 overlay，不是基础 Compose 的可选装饰品。

---

## 一、配置检查与镜像构建

```bash
cd deploy/compose

# 1) 准备环境变量
cp .env.example .env
vim .env          # 替换 CHANGE_ME_*，并按实际部署配置模型、OIDC 与组件密钥

# 2) 生成出网代理 TLS 解密证书（缺失时 envoy 会 fail closed 直接退出）
./envoy/generate-certs.sh

# 3) 校验编排能否解析；这一步不验证容器能否启动或业务是否可用
docker compose config --quiet

# 4) 构建平台自研镜像
docker compose build agentgateway agent-core mcp-hub webui

# 5) DB-GPT 补丁镜像也需要在本机构建，compose 不会自动构建它
docker build -t eapheavy/dbgpt:0.8.3-pg -f dbgpt/Dockerfile dbgpt
```

完整实测路径还需准备 TEI 本地模型、平台根 `.env`、RAGFlow 首次账号等，必须按根 README
执行，不能仅复制本目录的 `.env.example`。在这些缺口修复前，不要以裸 `docker compose up -d`
作为部署或验收命令；单服务调试也应先阅读第六节并显式指定服务名。

`depends_on` 与健康检查只保证已声明的启动依赖，例如 `postgres / redis / minio` 达到
`healthy` 后依赖方才启动；它不能保证 OIDC、检索、ChatBI 或观测链路可用。

---

## 二、端口对照表

| 组件 | 组件名（3.1） | 容器端口 | 宿主机端口 | 说明 |
|---|---|---|---|---|
| agentgateway | agentgateway | 8080 | 8080 | OpenAI 兼容接口 `/v1`、MCP 治理、管理面 |
| agent-core（自研） | AgentScope Service 等价实现 | 8090 | 8090 | 会话管理、HITL 人工确认 |
| MCP Hub | 本地 MCP Server | 8091 / 8092 / 8093 | 同左 | 文档检索 / ChatBI / 业务工具 |
| Web 控制台（自研） | AgentScope Web UI 等价实现 | 5173 | 5173 | **唯一用户入口** |
| Keycloak | Keycloak 26 | 8080 | 8081 | SSO/OIDC（容器内 8080，对外 8081） |
| PostgreSQL | PostgreSQL 16 | 5432 | 5432 | 全平台元数据 |
| Redis | Redis 7 | 6379 | 6379 | 会话 / 队列 / 缓存 |
| MinIO | MinIO | 9000 / 9001 | 9000 / 9001 | API / 控制台；桶 `eap-audit` 开启版本化 |
| ClickHouse | ClickHouse v3 | 8123 / 9000 | 8123 / 9000 | Langfuse 依赖 |
| Langfuse | Langfuse v3 | 3000 | 3000 | Trace + 成本归因（唯一观测组件） |
| RAGFlow | RAGFlow v0.22+ | 9380 / 80 | 9380 / 80 | API / 管理后台（管理员专用） |
| Infinity | Infinity | 23817 / 23820 | 23817 / 23820 | 检索引擎（Thrift / HTTP） |
| TEI | TEI | 80 | 6380 | 本地 Embedding；模板模型为 `intfloat/multilingual-e5-small` |
| DB-GPT | DB-GPT | 8092 | 8099 | 当前基础编排的启动命令无效，不能按 MCP Server 使用 |
| 出网代理 | Envoy | 15000 / 15001 / 9901 | 同左 | HTTP 代理 / HTTPS 代理（TLS 解密审计）/ 管理口 |
| MySQL | （RAGFlow 依赖） | 3306 | 不暴露 | 仅 RAGFlow v0.22 自身元数据 |

以上是**基础 Compose 模板**的端口，不是重型实测路径的端口。基础编排预留的用户入口为
`http://localhost:5173`，OIDC 为 `http://localhost:8081`（realm `enterprise`），但仍须先修复
第六节的接线问题。重型实测路径使用 Keycloak 8082、Langfuse 3001、Infinity 23821 等端口，
两套实例不能混用，详见[访问文档](../../docs/access.md)。

---

## 三、出网白名单如何配置

### 3.1 原理

商业模型 API 的出网链路是唯一的（见 8.3 出网安全、9.3 网络要求）：

```
agentgateway ──(EGRESS_PROXY_URL)──► envoy ──► 商业大模型 API
                  持有全部 API Key      │  唯一持有外网路由的容器
                                       └─ SNI 不在白名单 → 403
```

- 只有 `envoy` 容器接入了带默认路由的 `eap_egress` 网络；support / data / app 三个网络均为 `internal: true`，容器**没有外网路由**。
- 商业模型 API Key 只注入 `agentgateway` 容器，其余组件环境变量里不存在（8.5 凭证安全）。

### 3.2 配置方式

编辑 `.env`：

```bash
# 白名单：逗号分隔的域名列表
EGRESS_ALLOWED_HOSTS=api.openai.com,dashscope.aliyuncs.com,api.deepseek.com,open.bigmodel.cn,agent.minimaxi.com
```

`envoy` 容器启动时由 `envoy/entrypoint.sh` 调用 `envoy/render-allowlist.awk`，把白名单重新渲染进 `envoy.yaml` 的三个区块：

| 区块 | 作用 |
|---|---|
| `ALLOWED HTTP VHOSTS` | 15000 监听器的白名单虚拟主机（明文 HTTP + CONNECT 隧道按 `:authority` 匹配） |
| `ALLOWED SNI CHAINS` | 15001 监听器的白名单过滤链（`filter_chain_match.server_names`，TLS inspector 取 SNI） |
| `EGRESS CLUSTERS` | 每个白名单域名对应的上游集群（http / connect / tls 三件套） |

白名单外的域名 → Envoy 直接返回 **403**，请求不会到达外网。

### 3.3 两条出网路径

| 端口 | 用途 | 语义 |
|---|---|---|
| 15000 | HTTP 正向代理 | 网关默认使用（`EGRESS_PROXY_URL=http://envoy:15000`）。CONNECT 隧道内 TLS 由客户端端到端承载，网关只做**域名**管控 |
| 15001 | HTTPS 代理 | TLS inspector 读 SNI → 解密 → 审计留痕 → 转发真实上游。适用于「把商业 API 域名解析到出网代理」的审计级部署 |

### 3.4 证书

TLS 解密需要企业 CA 签发的证书：

```bash
# 生成开发占位证书（SAN 覆盖全部白名单域名）
./envoy/generate-certs.sh

# 生产：把企业 CA 签发的证书放入 envoy/certs/ 覆盖即可
#   envoy/certs/ca.crt      企业 CA（需下发到客户端信任库）
#   envoy/certs/server.crt  服务端证书（SAN = 白名单域名）
#   envoy/certs/server.key  服务端私钥
```

证书缺失时 envoy 容器**直接退出**（fail closed），不会退化成明文放行。

---

## 四、离线环境（Harbor）

内网环境无法访问公网镜像仓库时（见 3.1「Harbor 2.x：离线镜像仓（内网环境必需）」、9.2）：

### 4.1 准备镜像

在有网环境执行：

```bash
# 示例仓库地址必须替换；镜像版本以 .env.example 和实际 overlay 为准
REGISTRY=harbor.corp.example.com/eap
IMAGES=(
  postgres:16-alpine
  redis:7-alpine
  minio/minio:latest
  minio/mc:RELEASE.2025-04-16T18-13-26Z
  clickhouse/clickhouse-server:24.8-alpine
  mysql:8.0.39
  langfuse/langfuse:3.63.0
  langfuse/langfuse-worker:3.63.0
  quay.io/keycloak/keycloak:26.0
  infiniflow/ragflow:v0.22.1
  infiniflow/infinity:v0.7.5-x64-v2
  infiniflow/infinity:v0.6.5
  ghcr.io/huggingface/text-embeddings-inference:cpu-1.8
  envoyproxy/envoy:v1.31-latest
  eosphorosai/dbgpt:latest
)

# 1) 拉取第三方镜像
for img in "${IMAGES[@]}"; do
  docker pull "$img"
done

# DB-GPT 基础层只发 latest，必须记录 digest，避免重建时发生版本漂移
docker inspect --format '{{.RepoDigests}}' eosphorosai/dbgpt:latest

# 2) 打标签并推送到 Harbor
for img in "${IMAGES[@]}"; do
  target="$REGISTRY/$(echo "$img" | tr '/:' '__')"
  docker tag "$img" "$target"
  docker push "$target"
done
```

DB-GPT 补丁镜像和四个平台自研镜像还需按第一节构建，再以同样方式推送；
不要用上游 `eosphorosai/dbgpt:latest` 代替包含 PostgreSQL 驱动的补丁镜像。

### 4.2 切换镜像源

按上面的命名规则改写 `.env` 中的镜像变量，不必修改 compose 文件：

```bash
POSTGRES_IMAGE=harbor.corp.example.com/eap/postgres_16-alpine
RAGFLOW_IMAGE=harbor.corp.example.com/eap/infiniflow_ragflow_v0.22.1
INFINITY_IMAGE=harbor.corp.example.com/eap/infiniflow_infinity_v0.7.5-x64-v2
INFINITY_RAGFLOW_IMAGE=harbor.corp.example.com/eap/infiniflow_infinity_v0.6.5
TEI_IMAGE=harbor.corp.example.com/eap/ghcr.io_huggingface_text-embeddings-inference_cpu-1.8
```

其余 `*_IMAGE` 变量按同一规则填写。DB-GPT 的 `DBGPT_IMAGE` / `DBGPT_HEAVY_IMAGE`
必须指向已推送的**补丁镜像**；`GATEWAY_IMAGE`、`AGENT_IMAGE`、`MCP_HUB_IMAGE`、
`WEBUI_IMAGE` 则指向实际构建并推送的平台镜像。

### 4.3 模型仓（TEI / RAGFlow / DB-GPT）

镜像只是第一步，模型文件同样需要内网化（见 9.2「离线环境 Harbor 镜像仓 + 内网 TEI 模型仓」）：

- **TEI**：当前平台模型为 `intfloat/multilingual-e5-small`（384 维）。基础 Compose 的启动参数读取
  `TEI_MODEL`，不会把 `TEI_MODEL_PATH` 环境变量转换成模型路径；仅修改后者不能实现离线加载。
  重型 overlay 使用 `TEI_MODEL_HOST_DIR` 挂载宿主模型目录，再以 `TEI_MODEL_PATH=/data/model`
  作为启动参数，准备命令见[根 README](../../README.md#快速开始)。基础编排若要离线运行，
  还需自行补充等价的只读挂载与模型仓配置，不能直接继承重型路径的验收结论。
- **RAGFlow**：v0.22 还需内网化 DeepDoc 解析与分词模型。重型 overlay 已配置 `HF_ENDPOINT`；
  基础 Compose 尚未注入该配置。
- **DB-GPT**：Text2SQL 依赖的模型需配置为内网模型，或经 agentgateway 与出网代理调用商业 API。
  基础编排当前没有完成这条模型调用链的适配。

### 4.4 无出网环境

完全无外网时，还需要准备本地推理 Provider；仅清空 `EGRESS_ALLOWED_HOSTS` 只会阻断出网，
不会自动提供可替代的本地大模型。`GUARDRAILS_BLOCK_CONFIDENTIAL_EGRESS` 应保持 `true`，
模型可用性与出网白名单必须分别验收。

### 4.5 RAGFlow 的 Keycloak SSO（账号打通）

重型 overlay 把 Keycloak 配成 RAGFlow 的身份源：登录页点 "Keycloak" → Keycloak 授权 →
回调 `/v1/user/oauth/callback/keycloak` → RAGFlow 按 userinfo 的 email 自动建号。

| 变量（`deploy/compose/.env`） | 作用 |
|---|---|
| `EAP_PUBLIC_KEYCLOAK_ORIGIN` | 浏览器访问 Keycloak 的地址（授权端点） |
| `EAP_PUBLIC_RAGFLOW_ORIGIN` | 浏览器访问 RAGFlow 的地址（SSO 回调地址；同时用于 realm 里 `eap-ragflow` 客户端的占位替换） |
| `RAGFLOW_OAUTH_CLIENT_ID` / `RAGFLOW_OAUTH_CLIENT_SECRET` | Keycloak 侧 `eap-ragflow` 客户端的 ID 与密钥；初始导入和 RAGFlow 共用该值，已有客户端的轮换见 [Keycloak 配置说明](keycloak/README.md) |
| `RAGFLOW_OAUTH_KEYCLOAK_BACKEND` | 后端侧（换 token / 拉 userinfo）基址，留空 = 跟随浏览器侧 |

四项都为空 → 不启用 SSO（RAGFlow 只保留本地账号）；只配一半 → 容器**启动失败**
（半配置会生成打不开的登录渠道）。配置文件由 `ragflow/eap-entrypoint.sh` 在容器启动时
渲染到 `conf/local.service_conf.yaml`，日志里会打印实际生效的地址。

**登录页拦截**：启用 SSO 时，nginx 会把 `/login` 拦到 `/login-sso.html`（中文说明页 +
兜底链接）再跳 Keycloak，`/login?local=1` 保留 RAGFlow 原生的本地账号表单。
片段由 `eap-entrypoint.sh` 生成到 `/etc/nginx/sso/ragflow-sso.conf`，
由 `ragflow/nginx/ragflow.conf` 的 `include /etc/nginx/sso/*.conf;` 引入
（server 块内；未启用 SSO 时没有该文件，通配符匹配不到，不影响 nginx 启动）。
改 `ragflow/nginx/*.conf` 后要**重启容器**才生效 —— bind-mount 的内容变化不会触发 recreate。

> **浏览器侧与后端侧必须同 Host**：Keycloak 动态 hostname 下令牌 `iss` 跟随签发时的请求
> Host，后端侧若换成容器内 `keycloak:8080`，userinfo 会因 issuer 不匹配返回 401。
> 详见 [docs/access.md 6.8](../../docs/access.md)。

---

## 五、关键参数落地对照（9.4）

| 9.4 要求 | 本目录落地位置 |
|---|---|
| RAGFlow `DOC_ENGINE=infinity` | `ragflow` 服务 `environment.DOC_ENGINE=infinity`；不部署 ES，无需 `vm.max_map_count` / IK 插件 / JVM 堆调优 |
| Infinity 数据目录持久卷 | `infinity-data` 卷挂载 `/var/infinity`；`ragflow/infinity_conf.toml` 指定 `data_dir` |
| MinIO 开启版本化 | `minio-init` 服务执行 `mc version enable`（`eap-audit` / `langfuse` / `ragflow` 三个桶） |
| agentgateway 多副本 | Compose 单机形态下为 1 副本 + `restart: unless-stopped`；**生产 2 副本 + PDB 在 Helm chart 中实现**（见 `../helm/templates/gateway-deployment.yaml`） |
| PG 3 副本 + 流复制 | 尚未交付；当前 Helm 的 PostgreSQL StatefulSet 也是单副本，生产需外部高可用与流复制方案 |
| 网关 API Key 集中托管 | 仅 `agentgateway` 容器持有 `*_API_KEY` |

---

## 六、已知限制与注意事项

以下是**基础 Compose 尚未修复的部署缺口**，不能只靠文档或 `docker compose config` 视为已经解决：

1. **平台存储与缓存未接通**：模板把 `STORE_KIND` 写成代码不支持的 `sqlite`（代码支持
   `metadata | postgres`），agent-core 与 MCP Hub 也没有接收 `STORE_KIND` / `POSTGRES_URL`；
   网关没有接收 `CACHE_KIND` / `REDIS_URL`。因此启动 PostgreSQL、Redis 不等于平台正在使用它们，
   需要修正 compose 的环境注入，而不是只改 `.env`。
2. **OIDC 服务账号未对齐**：MCP Hub 的默认 `KEYCLOAK_SERVICE_CLIENT_SECRET` 是
   `CHANGE_ME_service_client_secret`，与导入 realm 的服务账号密钥不一致；模板也未显式列出
   该配置。`AUTH_DEV_MODE=false` 时内部回调会因此失败。
3. **混合检索未启用**：按模板部署时 `INFINITY_BASE_URL`、`TEI_BASE_URL` 为空，会退回
   本地 BM25；而本机 `deploy/compose/.env` 填的是宿主侧 `http://127.0.0.1:23821` /
   `http://127.0.0.1:6380`，在容器内指向容器自身，同样连不上。两种情况都退回 BM25，
   容器健康不能作为 Infinity 混合检索已启用的证据。
4. **Langfuse 鉴权未接线**：平台容器没有获得 `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY`；
   基础 Compose 的 Langfuse 端口为 3000，而模板末尾的 `NEXTAUTH_URL` 是重型路径的 3001，
   使用基础编排时必须按实际入口修改。
5. **RAGFlow 不能继承重型路径的验收结论**：基础编排仍让 RAGFlow 连接平台 Infinity 0.7.5，
   未使用重型 overlay 的专用 Infinity 0.6.5、Nginx 配置、连接池补丁、TEI profile 与模型仓配置。
   RAGFlow v0.22 自身的元数据仍需要 MySQL；`DOC_ENGINE=infinity` 只替换文档索引引擎。
   Keycloak SSO 渠道也只在重型 overlay 里配置（见 4.5），基础编排的 RAGFlow 没有登录渠道。
6. **DB-GPT 启动方式无效**：DB-GPT 0.8.3 不提供 `dbgpt mcp server`，webserver 形态也不等于
   MCP Server，不能按旧注释用 `DBGPT_MCP_COMMAND` 简单替换。完整实测路径使用
   `dbgpt/mcp_adapter.py` 的 FastMCP 适配器，基础 Compose 与 Helm 尚待统一。
7. **镜像需要本机构建**：`DBGPT_IMAGE=eapheavy/dbgpt:0.8.3-pg` 的构建见第一节；平台四个镜像
   也由 compose 从源码构建。Web UI Dockerfile 会构建真实前端，构建失败即终止，不生成占位页。
   DB-GPT 上游基础层使用 `:latest`，重建时应记录实际 digest，避免把漂移版本误标为 0.8.3。
8. **端口与 CPU 约束**：基础 DB-GPT 宿主端口为 8099，避开本地 ChatBI 8092 和重型
   DB-GPT 8094/8096/8097。Infinity 需按目标 CPU 选择镜像和启动方式；本机重型 overlay 的
   QEMU 路径不能直接假设在所有机器存在。
9. **出网代理证书**：见 3.4，开发占位证书只用于本机验证，生产应使用企业 CA 签发的证书。
10. **单机资源与监听地址**：POC 建议 16C/32G/500G SSD；RAGFlow、Infinity、TEI 是主要内存
    占用方。`GATEWAY_HOST` / `AGENT_HOST` / `MCP_HUB_HOST` / `WEBUI_HOST` 在宿主进程模式保持
    `127.0.0.1`，容器内才由 compose 显式改为 `0.0.0.0`。

---

## 七、常用运维命令

```bash
docker compose ps                                   # 状态
docker compose logs -f agentgateway envoy           # 跟踪网关与出网代理
docker compose exec agentgateway node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>console.log(r.status))"
docker compose exec envoy /etc/envoy/healthcheck.sh      # 出网代理健康检查
docker compose exec minio mc alias set eap http://localhost:9000 && \
  docker compose exec minio mc version info eap/eap-audit   # 审计桶版本化状态
docker compose restart envoy                        # 改完白名单后重启生效
docker compose down                                 # 停止（保留数据卷）
```

`docker compose down -v` 会删除命名数据卷，可能同时删除 PostgreSQL、MinIO、Langfuse 等全部
本地数据；没有确认备份和卷清单前不要执行。
