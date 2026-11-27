# 3.1 组件总览 → 实现映射

方案第 3.1 节列出 15 个 P0/P1 组件。本表逐项说明**在哪个代码位置实现**、**当前状态**、以及**与生产形态的差异**。

图例：
- ✅ **真实组件已在本机跑通并实测**
- 🟡 **接口等价的本地实现**（自研，功能可验证，但不是方案原版组件）
- 📦 **编排已交付、容器未在本机拉起**

---

## 〇、真实重型组件实测状态（本机 4C/31G，2026-11-18）

重型栈与平台服务完全隔离：容器前缀 `eapheavy-`、数据卷前缀 `eapheavy_`、宿主端口整体右移。

| 组件 | 版本 | 宿主端口 | 实测结论 |
|---|---|---|---|
| Infinity | v0.7.5-x64-v2 | 23818(Thrift) / 23821(HTTP) / 5434(PSQL) | ✅ 真实容器 running+healthy；HTTP API 建表/写入/混合检索/过滤下推/幂等全部实测通过 |
| Infinity（0.6.x，RAGFlow 专用） | v0.6.5 | 容器内 23817/23820 | ✅ 真实容器 healthy；RAGFlow 的 infinity-sdk 客户端只认 0.6.x 协议，单独起实例（见下） |
| Keycloak | 26.0 | 8082 | ✅ 真实容器 running+healthy；realm 导入成功（**14 个 client scope 齐备**，含全部内置 scope），4 个用户 + 1 个服务账号签发 RS256 JWT，claims 含 `sub`/`preferred_username`/`tenant_id`/`role`/`dept_id`/`sensitivity`/`realm_access` |
| Langfuse | 3.63.0 | 3001 | ✅ 真实容器 running+healthy；OTLP Trace 真实入库，token 用量与成本正确落到 observation |
| ClickHouse | 24.8-alpine | 8124(HTTP) / 9004(TCP) | ✅ 真实容器 running+healthy；Langfuse 迁移与查询均正常 |
| TEI | cpu-1.8 | 6380 | ✅ 真实容器 running；模型预置落盘后 `/embed` 返回真实 384 维向量，网关 `/v1/embeddings` 实测通过 |
| **RAGFlow** | **v0.22.1** | **9380(API) / 8095(Web)** | ✅ 真实容器 running；健康检查 db/doc_engine/redis/storage 全绿；**注册→建库→上传→解析→向量检索全链路实测通过（10/10）** |
| **DB-GPT** | **0.8.3** | **8094(API) / 8096(Web) / 8097(MCP)** | ✅ 真实容器 running；**原生四件套** controller+worker+apiserver+webserver 齐全；`/api/v1/chat/completions` 真实经 DB-GPT→网关→MiniMax 返回业务答案；**MCP Server（适配器，streamable-http）握手/工具目录/Text2SQL/只读拦截实测通过**；作为 MCP 客户端已注册平台 MCP Server（2/2 active，8 工具）；**19/19** |
| MySQL | 8.0.39 | 3307 | ✅ RAGFlow 元数据库；`rag_flow` 库 26 张表自动建齐 |
| PostgreSQL / Redis / MinIO | 16-alpine / 7-alpine / latest | 5433 / 6381 / 9002-9003 | ✅ 重型栈自带实例全部 healthy，MinIO 桶由 minio-init 创建并开启版本化 |

启动与验收：

```bash
./scripts/start-heavy.sh start      # 拉起重型栈（含 RAGFlow / DB-GPT / Harbor）
./scripts/verify-heavy.sh           # 逐项实测（容器/端口/依赖/真实功能）59 项
python3 scripts/verify-ragflow.py   # RAGFlow 端到端功能验收（10 项）
python3 scripts/verify-dbgpt.py     # DB-GPT 端到端功能验收（19 项）
bash scripts/verify-harbor.sh      # Harbor 推拉与一致性验收（21 项）
node scripts/verify-console-login.mjs  # 控制台 OIDC 登录端到端（21 项，真实浏览器）
PUB_IP=203.0.113.10                # 文档保留示例地址，执行前必须替换
node scripts/verify-secure-context-pkce.mjs "http://$PUB_IP:5173"
                             # 公网明文 HTTP 下 PKCE 回归（5 项，非安全上下文）
```

> 验收脚本现在还覆盖**平台侧真实链路**：用 Keycloak 真实令牌调网关 `/v1/embeddings`（TEI 真实向量）、
> 无令牌访问必须 401、Langfuse 必须能查到已入库的 observation。

### RAGFlow v0.22.1 的三个版本/协议坑（实测）

1. **Infinity 协议版本不匹配** —— RAGFlow v0.22.1 镜像内置 `infinity-sdk 0.6.5`，
   线上协议版本为 **0.6.7**；平台侧用的 0.7.5 服务端会直接拒绝：
   `(2004, 'Expected version index: 0.7.5, connecting version: 0.6.7')`。
   实测（用 RAGFlow 容器内的真实客户端）：连 0.6.5 服务端成功、连 0.7.5 失败。
   → 方案：RAGFlow 单独跑一个 **0.6.5 实例**（`infinity-ragflow`），平台侧继续用 0.7.5（9/9 检索语义验收通过）。
2. **`version` 字段是「线上协议版本索引」，不是发布版本号** —— v0.6.5 二进制的默认值可接受 0.6.7 客户端，
   但配置文件里显式写 `version = "0.6.5"` 会让服务端拒绝 0.6.7 客户端，
   表现为 Thrift `recv_Connect` **一直阻塞、不报错**（最难排查的一个坑，用 py-spy 抓栈才定位到）。
   → `deploy/compose/ragflow/infinity_conf_v065.toml` 里写的是 `version = "0.6.7"`。
3. **必须显式声明 TEI profile** —— 源码判定是子串匹配 `"tei-" in COMPOSE_PROFILES`
   （`common/settings.py:206`、`rag/llm/embedding_model.py:75`、`tenant_llm_service.py:116`），
   且 `TEI_MODEL` 必须与 `llm` 表中 Builtin 嵌入模型的 `llm_name` 完全一致（`BAAI/bge-m3`），
   否则 Builtin 分支不会绑定到 TEI 的 base_url。
   另外 DeepDoc / 分词器模型需经 **hf-mirror** 下载（直连 huggingface.co 本机不可达）→ `HF_ENDPOINT`。

### RAGFlow 鉴权三段式（实测踩坑）

| 接口 | 凭证 | 获取方式 |
|---|---|---|
| Web API `/v1/*` | itsdangerous 签名串 | **登录响应的 `Authorization` 响应头**（不是 body 的 `data` 字段）；`Bearer ` 前缀会导致 401 |
| SDK API `/api/v1/*` | API Key | `POST /v1/system/new_token` → `data.token`（形如 `ragflow-xxxx`），请求头 `Bearer <api_key>` |
| 注册/登录密码 | RSA 加密串 | 用服务端 `conf/public.pem` 做 PKCS1v1.5 加密（对 **base64 后的密码** 再加密）→ `api/utils/crypt.py` 的 `crypt()` |

知识库接口是 **SDK API**（`/api/v1/datasets`），模型标识必须是 `<llm_name>@<factory>` 形式，
内置嵌入模型为 `BAAI/bge-m3@Builtin`；`chunk_method` 枚举为 `naive/book/email/laws/manual/one/paper/picture/presentation/qa/table/tag`。

**RAGFlow 侧的 LLM 也走网关**：模型提供商用 `OpenAI-API-Compatible` 指向
`http://172.17.0.1:8080/v1`（宿主回环桥），模型名填网关的虚拟模型名
（`smart-model` / `reasoning-model` / `fast-model` / `minimax`），底层落到 MiniMax-M3.1-Flash。
**不要用 RAGFlow 内置的「MiniMax」provider** —— 那是容器直连 `api.minimax.chat`，
既绕过唯一出口，凭证与本平台的 Mavis 侧也不是同一个服务。
完整填法与四个实测坑见 `docs/operations.md` 9.1.11 (7)。

### DB-GPT 0.8.3 的能力边界与本项目的落地形态（实测）

**上游事实：DB-GPT 没有任何 MCP Server 形态。** 已实测核实：

- Docker Hub `eosphorosai/dbgpt` 共 56 个标签，最高 `v0.8.3`；PyPI `dbgpt` / `dbgpt-serve` /
  `dbgpt-app` / `dbgpt-client` 最高均为 0.8.2；GitHub `eosphoros-ai/DB-GPT` 共 56 个 tag，
  最高 `v0.8.3`，且 **main 分支 pyproject 版本号仍是 0.8.3**、CLI（`cli_scripts.py`）注册的命令
  （start/stop/db/new/app/repo/run/net/tool/setup/profile）中**无 `mcp`**，`dbgpt_serve/` 下亦无
  `mcp` 子模块。
- **0.9.x 从未发布** —— 升级不是解法。
- DB-GPT 的 MCP 方向是**客户端**（`connector` / `ConnectorManager`，支持 `sse` / `streamable_http` 传输），
  不是服务端。

**本项目的落地形态（补齐方案 3.1 的「DB-GPT 以 MCP Server 暴露」）**：

| 层 | 形态 | 说明 |
|---|---|---|
| 组件本体 | **原生四件套** | `controller` + `worker` + `apiserver` + `webserver` 同容器；webserver 提供 datasource / Text2SQL / awesomes / 知识库 |
| MCP Server | **平台侧薄适配器** | `deploy/compose/dbgpt/mcp_adapter.py` —— 容器内用官方 MCP Python SDK（镜像已装 `mcp 1.27.2`，`FastMCP.run(transport="streamable-http")` 可用）把 DB-GPT 的 ChatBI 能力按 MCP 协议暴露；工具名与平台原有 `chatbi.*` 一致 |
| MCP 客户端 | **上游原生能力** | `deploy/compose/dbgpt/register_platform_mcp.py` 用 DB-GPT 原生 `ConnectorManager.create_connector()`（`custom_mcp` + `streamable_http`）把平台 MCP Server 注册进 webserver 进程 —— 实测 2/2 连接器 `active`，拉到 8 个平台工具 |

> 性质如实标注：MCP Server 适配器是**平台侧集成适配**，不是上游原生功能；
> MCP 客户端方向则是**上游原生能力**，未改 DB-GPT 源码。

**双向 MCP 拓扑（实测跑通）**：

```
平台 Agent ──► 网关（鉴权/策略/预算/护栏/审计）──► DB-GPT MCP Server（适配器，宿主 8097）
                                                        │  ├─ chatbi.* → DB-GPT apiserver → 网关 → MiniMax
                                                        │  │                → DB-GPT 数据源只读执行
                                                        │  └─ （webserver 进程内）DB-GPT ConnectorManager
                                                        │        └──► 平台 knowledge / business MCP Server
```

**其他实测踩坑**：

- **配置前缀有两套** —— apiserver 是 `service.model.api`（写错会静默忽略、端口退回 8100，
  `dbgpt/model/cluster/apiserver/api.py:1003`），webserver 是 `service.web`（默认端口 5670）。
- **`[service.web.database] type` 必须是 `postgresql`**，不是 `postgres` —— 写错直接抛
  `Unknown type value: postgres, known types: [... 'postgresql' ...]` 启动失败。
- **非 SQLite 元数据库要显式建表** —— DB-GPT 只对 SQLite 走 `db.create_all()`；postgres 分支只打印
  一条 warning 要求手工执行 `assets/schema/dbgpt.sql`，而那份脚本是 **MySQL 方言**，镜像里的
  alembic `versions/` 目录也是空的（`alembic upgrade head` 什么都不做）→ 表建不出来，
  webserver 启动报 `relation "dbgpt_serve_flow" does not exist`。
  本项目用 `deploy/compose/dbgpt/init_db.py` 以 SQLAlchemy `metadata.create_all()` 建表（方言无关，
  幂等），并做**全量模型模块扫描导入**（DB-GPT 自带的 `_MODELS` 清单不完整，漏了
  `dbgpt_serve.rag.models.wiki_db` → `knowledge_wiki_task` 表）。实测建出 **63 张表**。
- **PG 不接受 TEXT 的长度修饰符** —— DB-GPT 模型用 `Text(length=2**31-1)`（MySQL/SQLite 写法），
  PG 方言会渲染成 `TEXT(2147483647)` → `psycopg2.errors.SyntaxError: type modifier is not allowed
  for type "text"`。用 SQLAlchemy 编译钩子（`@compiles(Text, "postgresql")`）渲染成 `TEXT` 解决。
- **官方镜像缺 PostgreSQL 驱动** —— 内置 SQLAlchemy 但无 `psycopg2`，webserver 连 PG 直接
  `ModuleNotFoundError`。用 `deploy/compose/dbgpt/Dockerfile` 打补丁层装 `psycopg2-binary`
  （基础层复用，不重下 21GB）。
- **`app.on_event("startup")` 在 DB-GPT 里是无效的** —— DB-GPT 的 app 设了 `lifespan_context`，
  FastAPI 会**静默忽略** on_event 处理器（只打一条 DeprecationWarning）。
  正确做法是用 `dbgpt.util.fastapi.register_event_handler(app, "startup", handler)`
  （走 DB-GPT 的 `_GLOBAL_STARTUP_HANDLERS`）。
- **FastMCP 默认绑 127.0.0.1:8000** —— 与 DB-GPT 的 controller 端口冲突；必须显式设置
  `mcp.settings.host` / `mcp.settings.port`。
- **cluster 模式 worker 只允许托管 1 个模型** —— LLM 与 Embedding 不能同时声明
  （`Only one model config is supported when running worker in cluster mode`）。
  本项目只声明 LLM（`proxy/openai` → agentgateway），嵌入能力由网关 `/v1/embeddings`（→ TEI）统一提供。
- **TOML 里数值不能写插值** —— `port = ${env:...}` 会解析失败，必须写成带引号的字符串。
- DB-GPT 容器访问宿主上的 agentgateway 需 `extra_hosts: host.docker.internal:host-gateway`。


### 本机环境的三处硬约束（实测踩坑，已写进部署文档）

1. **Infinity 需要 AVX2** —— 本机 Xeon E5-2697 v2（Ivy Bridge）只有 AVX，默认镜像启动即 `SIGILL (invalid opcode)`。
   用官方 `-x64-v2` 变体 + **QEMU 用户态模拟** 跑通（`deploy/compose/docker-compose.heavy.yml`）。
2. **Docker 不会为只挂 `internal: true` 网络的容器发布端口** —— 编排里所有层网络都是 internal，
   导致**全部**服务的端口映射静默失效（`NetworkSettings.Ports` 全为 null）。
   已补一张可路由的 `eap_ops` 网络给需要暴露宿主端口的服务，分层隔离保持不变。
3. **TEI 只认 safetensors** —— `BAAI/bge-m3` 在 hf-mirror 上只有 `pytorch_model.bin`（TEI 无法加载），
   改用同为多语言、同样有 safetensors 的 `intfloat/multilingual-e5-small`（384 维）。

---

## 一、Agent 引擎

| 组件 | 版本建议 | 优先级 | 方案要求 | 本项目实现 | 状态 |
|---|---|---|---|---|---|
| AgentScope Core | 2.x | P0 | ReAct + Toolkit + Middleware | `packages/agent-core/src/runtime.ts`（ReAct 循环）、`toolkit.ts`（工具集）、`middleware.ts`（中间件链） | ✅ ReAct/Toolkit 等价实现；Middleware 为子集实现（3 hook vs 官方 Python 7 hook） |
| AgentScope Service | 官方最新 | P0 | 多租户注册 / 会话管理 / 分布式协调 | `packages/agent-core/src/main.ts`（会话与消息 API）、`packages/platform-core/src/store/metadata.ts`（会话/消息/租户/应用元数据） | ✅ |
| AgentScope Web UI | 官方示例改造 | P0 | 唯一用户入口 | `apps/webui/`（React 19 + Vite 6 + Tailwind 4 + shadcn；可折叠全局导航、最近任务、任务式对话与审批侧栏；知识 / 工具 / 模型 / 预算 / 审计复用管理工作区；对话使用 assistant-ui + AG-UI 标准事件流） | ✅ |

**与官方 AgentScope 的关系**：本仓库以 TypeScript 实现了 AgentScope Core 的三项核心契约（ReAct 推理循环、Toolkit 工具抽象、Middleware 横切链），
使「Agent 内核」这一层可独立运行与验证。生产替换为官方 Python 版 AgentScope 时，只需保证两点契约不变：

1. `ChatModel` 指向网关的 OpenAI 兼容端口 `/v1/chat/completions`，模型名用虚拟模型名（`smart-model` 等），不感知真实 Provider；
2. `Toolkit` 的 MCP Server 地址全部指向网关的 `/v1/mcp/tools` 与 `/v1/mcp/call`，不直连任何 MCP Server。

对应方案 4.1「关键配置」。

**控制台与 AG-UI 的关系**：控制台前端不再自造私有协议，而是采用
[AG-UI 协议](https://github.com/ag-ui-protocol/ag-ui)（`@ag-ui/client` + `@ag-ui/core` 0.0.54）——
前端用官方 `HttpAgent` 直连 `POST /ag-ui`，后端把同一套 ReAct 循环的运行事件映射成 AG-UI 标准事件
（实现见 `packages/agent-core/src/agui.ts`）。带来三点：

1. **不引入第二套运行时**：治理链（预算 / 护栏 / 脱敏 / 审计 / HITL）仍全部在网关与中间件里，
   没有 Python 侧 AgentScope 与 TS 内核并存的问题；
2. **前端可替换**：任何实现 AG-UI 的前端都能直接对接本平台的后端；
3. **HITL 保持跨用户审批**：沿用本平台的 DB 审批单（官方 scaffold 的同请求 interrupt→resume 模型不适用），
   映射为 `CUSTOM` 事件 `eap.approval_pending` / `eap.approval_decided`，SSE 连接在等待期间保持打开。

前端设计系统（Tailwind 4 + shadcn + lucide）移植自
[Ken-LK/agentscope-agui-scaffold](https://github.com/Ken-LK/agentscope-agui-scaffold)（Apache-2.0），
本地改造点：主色由上游青绿改为企业深蓝 `oklch(0.48 0.16 255)`，并去掉对上游 Python 后端 `/manifest` 接口的依赖。

> **对照核实结论（2026-11-19，见 [agentscope-comparison.md](./agentscope-comparison.md)）**：已实际下载并解包官方
> AgentScope Python **2.0.12**、官方 TypeScript **`@agentscope-ai/agentscope` 0.0.15**（15,281 行）、
> `agentscope-studio`、`agentscope-runtime`（72,488 行）做逐项对照，修正三处表述：
>
> 1. **ReAct 与 Toolkit 是等价实现**；**Middleware 是子集实现**（自研 3 hook 线性链 `before`/`after`/`onError`，
>    官方 Python 版为 7 hook 洋葱模型：`on_reply`/`on_reasoning`/`on_acting`/`on_check_permission`/`on_model_call`/
>    `on_compress_context`/`on_system_prompt`）。
> 2. **官方 TypeScript 版根本没有 Middleware 系统** —— 其 `agent.ts` 三处注释明写核心逻辑「without middlewares」，
>    仓内无 `middleware/` 目录。因此 PDF 3.1 的「Middleware」维度只有 Python 版可参照，TS 版替换会直接丢掉该维度。
> 3. **官方在多租户、RBAC、三级预算、合规审计、脱敏、HITL 审批单、网关强制路由、出网代理这 8 项企业治理能力上全部为空**，
>    这正是本平台相对通用框架的核心增量，也是「不能整体替换官方」的核心理由。
>
> 另：官方 Web UI 是 `agentscope-studio` 仓（client/server/app/shared 四包，tRPC 协议），
> 不是 AgentScope 主仓的 `console/`/`tui/`（终端形态）；Studio 缺多租户/预算/审批/审计四页，与本平台 REST 协议不兼容，不可整体替换。
>
> 替换路线评估：全量换官方 Python 约 115–170 人日；渐进换官方 TS 约 65–100 人日；
> **推荐「保留自研内核 + 对齐官方消息/事件/权限契约」约 29–46 人日**。

---

## 二、RAG 知识库

| 组件 | 版本建议 | 优先级 | 方案要求 | 本项目实现 | 状态 |
|---|---|---|---|---|---|
| RAGFlow | v0.22+ | P0 | 文档解析 / 切块 / 检索，`DOC_ENGINE=infinity` | `packages/mcp-hub/src/servers/knowledge.ts`（等价工具集：`knowledge.search` / `list_documents` / `upsert_document` / `delete_document`）+ `packages/mcp-hub/src/retrieval/infinity.ts`（对接真实 Infinity HTTP API） | 🟡 工具层等价 / 检索引擎 ✅ 真实 |
| Infinity | 最新稳定版 | P0 | 检索引擎：BM25 + 稠密/稀疏向量内核级融合，替代 ES | **真实容器 v0.7.5**；`retrieval/infinity.ts` 走官方 HTTP API：建表 `vector,{dim},float` 列 + fulltext 索引、dense/text 双路召回 + RRF 融合、过滤条件下推 | ✅ 真实实测 |
| TEI | 最新 | P0 | 本地 Embedding：BGE-M3 / Qwen3-Embedding-0.6B | `packages/gateway/src/llm/providers.ts` 的 `TeiAdapter` + 网关 `/v1/embeddings`；真实容器 `ghcr.io/huggingface/text-embeddings-inference:cpu-1.8` | ✅ 真实实测 |

**Infinity 接入方式**：官方 HTTP API（`example/http/*.sh` 的契约），不是 PSQL —— Infinity 自带的 PSQL 端口
启动日志里明确标注「SQL is only for test」，生产路径是 Thrift/SDK；HTTP API 行为一致且无需额外 SDK。

| 能力 | 实现 | 实测结论 |
|---|---|---|
| 建库/建表 | `POST /databases/{db}`、`POST /databases/{db}/tables/{tbl}` | ✅ `vector,384,float` 列 + fulltext 索引均建成 |
| 写入 | `POST /…/docs`（先按 doc_id 删除再插入） | ✅ 幂等，重复同步不产生副本 |
| 混合召回 | `search` 数组同时给 `dense`（cosine）与 `text`（BM25），配 `fusion_method: rrf` | ✅ 融合排序生效；多路 MATCH 必须配 FUSION，否则引擎报错 |
| 过滤下推 | `filter` 表达式在引擎内裁剪候选集 | ✅ 密级/部门/租户三类过滤均生效，**不可见文档不参与排序** |
| 降级 | 能力探测（向量列/全文索引）逐项降级，异常时回退本地 BM25 | ✅ 引擎不可用时 knowledge 自动回退 |

**权限过滤位置（方案 5.2 最高优先级）**：过滤在**检索阶段**完成 —— Infinity 侧由 `filter` 表达式下推到引擎，
本地 BM25 侧由打分前的候选集裁剪完成，两条路径都不是「全库召回后再过滤」。
测试见 `tests/knowledge.test.ts`，真实引擎实测见 `scripts/verify-heavy.sh`。

### 2.1 平台知识库 与 RAGFlow 的关系（重要，别混淆）

两者**职责重叠但数据互不相通**，控制台与文档里都要讲清楚：

| | 平台知识库 | RAGFlow |
|---|---|---|
| 位置 | 主库 `knowledge_docs` 表 | RAGFlow 自己的 MySQL `rag_flow` 库 |
| 谁在用 | **平台 Agent 的检索链路**（`knowledge` MCP → Infinity 0.7.5 + TEI） | RAGFlow 自己的解析/检索链路（`DOC_ENGINE=infinity` 0.6.x 专用实例） |
| 界面 | 控制台「**知识库**」页（`/v1/knowledge/*`） | RAGFlow 自带 Web UI（`http://127.0.0.1:8095`） |
| 账号 | 平台 Keycloak（统一登录） | RAGFlow 自己的账号体系（固定账号 `eap-admin@eap.local`，自注册已关闭） |
| 数据 | 平台业务知识（制度 / 合同 / 指标口径），带部门与密级 | 独立数据集，与平台互不可见 |

> 平台的 `knowledge` MCP 工具层与 RAGFlow 的 API 是**等价实现**（同一套工具语义），
> 但运行时连的是**平台的 Infinity 0.7.5 + TEI**，不是 RAGFlow 的 0.6.x 实例。
> 因此「在 RAGFlow 里建的知识库，Agent 检索不到」是预期行为，不是故障。

### 2.2 控制台「知识库」页（新增）

网关侧 REST 接口（见 `docs/api.md` 1.8 节）+ 控制台页签，能力：
文档列表（按部门/密级/关键字过滤）、文档详情（全文）、**检索测试**（走与 Agent 完全相同的
检索链路，用于验证文档是否真能被召回）、新增 / 删除（**审批制**）。

写操作不直接落库：只生成审批单，由另一位有审批权限的人在「审批中心」通过后，
网关回放 `knowledge.upsert_document` / `knowledge.delete_document` 真正执行。
这与 Agent 调用需确认工具走的是同一条 HITL 链路（4.1），治理模型保持一致。

浏览器端到端验收：`node scripts/verify-console-knowledge.mjs`（20 项），
单测：`tests/knowledge-api.test.ts`（16 项）。

---

## 三、数据自助分析

| 组件 | 版本建议 | 优先级 | 方案要求 | 本项目实现 | 状态 |
|---|---|---|---|---|---|
| DB-GPT | 最新社区版 | P0 | ChatBI：Text2SQL / 图表 / 报告，以 MCP Server 暴露 | **组件本体**：真实容器 `eapheavy/dbgpt:0.8.3-pg`（基础层 `eosphorosai/dbgpt` + `psycopg2-binary`，构建见 `deploy/compose/dbgpt/Dockerfile`）原生四件套（controller / worker / apiserver / **webserver**），webserver 提供 datasource / Text2SQL / awesomes；**MCP Server**：`deploy/compose/dbgpt/mcp_adapter.py`（FastMCP + streamable-http，宿主 8097）把 `chatbi.query` / `chatbi.list_metrics` / `chatbi.run_sql` 按 MCP 协议暴露；**MCP 客户端**：webserver 进程内用上游原生 `ConnectorManager` 注册平台 MCP Server；平台侧 `packages/mcp-hub/src/servers/chatbi.ts` 降级为 fallback | ✅ 真实实测 |

**已实现的能力**：

- **Text2SQL**：经网关调用 LLM 生成 SQL，prompt 中注入 schema 与指标口径字典（`METRIC_DICTIONARY`）
- **沙箱执行**：`packages/mcp-hub/src/sandbox.ts` —— 三重限制
  1. 语句级：仅允许 `SELECT` / `WITH`，正则拦截 INSERT/UPDATE/DELETE/DDL/PRAGMA/VACUUM，多语句拒绝
  2. 资源级：只读连接（`readonly: true` + `query_only = ON`）、结果行数上限、worker 线程内存隔离（128MB）
  3. 时间级：worker 超时强制终止（默认 5s）
- **图表**：依据查询结果与问题类型（趋势/占比/其他）输出图表规格 `{type, x, y, data}`
- **指标口径字典**：同名指标多口径问题（销售额：下单/开票/回款）的统一出口，同时写入工具描述

对应方案 6.1 调用链路第 4 步、6.2 关键配置。

---

## 四、网关

| 组件 | 版本建议 | 优先级 | 方案要求 | 本项目实现 | 状态 |
|---|---|---|---|---|---|
| agentgateway | v1.x GA | P0 | LLM 路由 + MCP 治理 + Guardrails + 预算 | `packages/gateway/` 整个包 | ✅ |

### 网关能力逐项对照（方案 4.3 核心能力使用清单）

| 能力 | 实现位置 | 说明 |
|---|---|---|
| Virtual Models | `gateway/src/llm/router.ts` + `llm/model-config.ts` + `routes/admin.ts` | 内置默认模型；控制台可新增、编辑、启停和删除，SQLite/PostgreSQL 持久化并记录审计 |
| Multi-Provider | `gateway/src/llm/providers.ts` + `llm/provider-config.ts` | OpenAI / Anthropic 双协议适配；内置厂商走环境变量，自定义厂商在控制台配置并持久化热加载，支持账号池与连接测试 |
| Spend Cap | `gateway/src/llm/budget.ts` | 平台级 / 租户级 / 应用级 三级预算，语义完全对齐方案表 |
| MCP Federation | `gateway/src/mcp/registry.ts` → `catalog()` | 按租户工具白名单下发目录 |
| Cedar/CEL 策略 | `gateway/src/policy/cel.ts` + `policy/engine.ts` | 自研 CEL 子集求值器；deny 优先于 allow；主体/动作/资源三元组 + 条件表达式 |
| Guardrails（内置） | `gateway/src/guardrails/index.ts` | Prompt 注入检测 + 内置正则 PII 脱敏（身份证/手机号/银行卡/工号/密钥/邮箱） |
| OTel 埋点 | `gateway/src/observability/tracing.ts` | Trace → 本地元数据库 + OTLP/HTTP JSON → Langfuse |

### 出网分级：本地推理 vs 商业出网（方案 8.1 数据分级与路由）

平台把每一次推理/调用按**是否出网**分成两级，这个维度同时进入**策略引擎**和**护栏**：

| 级别 | 含义 | 典型目标 | 涉密主体（sensitivity=confidential） |
|---|---|---|---|
| `local` | 推理在内网/本机完成，数据不出域 | TEI 本地嵌入、MCP Server（域内） | **允许**（这正是方案要求的合规闭环） |
| `external` | 推理在商业 API 完成，数据出网 | MiniMax / OpenAI / DeepSeek 等 | **拒绝**（`deny-confidential-egress`） |

- 级别由目标 provider 推导：`packages/gateway/src/llm/providers.ts` → `isLocalProvider()` / `egressClassOf()`
- 策略侧：`packages/gateway/src/policy/engine.ts` → `PolicyContext.egress`，进入 CEL 上下文 `request.egress` / `resource.egress`
  - `deny-confidential-egress` 条件：`principal.sensitivity == 'confidential' && request.egress == 'external'`
  - `allow-default-llm` 条件：`principal.sensitivity != 'confidential' || request.egress == 'local'`
- 护栏侧：`packages/gateway/src/guardrails/index.ts` → `GuardrailInput.egress`
  - 出网：涉密直接阻断；PII 一律脱敏后放行
  - 本地：涉密**不阻断**；PII 只统计不替换（占位符会破坏向量语义），命中情况仍进审计
- Failover 侧：涉密主体的 Failover 链会过滤掉所有商业目标，只走本地目标
- 兜底：未声明 egress 时按 `external` 保守处理（宁可误拒，不可误放）

> **实测发现的真实缺陷**：最初这两层都只判断「密级 == confidential」而没有区分目标，
> 导致涉密用户连**本地 TEI 嵌入**都被拦死 —— 平台的本地合规路径反而不可用。
> 出网分级就是为此补的，修复后涉密用户走 `/v1/embeddings` 正常返回 384 维真实向量。

### Failover 链（方案 4.4）

`smart-model` 的实际链条：

```
minimax/MiniMax-M3.1-Flash (primary, weight 80)
minimax/MiniMax-M3.1-Flash (acct-2, primary, weight 20)
minimax/MiniMax-M3              (fallback)
deepseek/DeepSeek-chat          (fallback)
openai/gpt-4o                   (fallback)
```

失败自动降级并记录 `failover` 明细到 Trace 与审计。主用目标配置了权重时，先按相对权重选取一个目标，未填按 1 计算；其余主用目标仍保留为故障转移候选，全部未配置权重时保持固定顺序。额外账号使用 `acct-2` 等别名，必须在网关环境变量中配置对应的 `<PROVIDER>_API_KEY_2`，不会静默回落到默认账号。

管理员可在控制台「模型与路由」或 `/v1/admin/models` 管理模型和链路，存储读取即生效，无需重启。方案原表以通义为主，本项目默认以已配置的 MiniMax 为主；`EAP_VIRTUAL_MODELS_JSON` 是启动时显式覆盖源，每次启动都会覆盖同名模型。

`minimax` 是**厂商专属**虚拟模型，只落 MiniMax，不跨厂商 failover：

```
minimax/MiniMax-M3.1-Flash (primary, weight 100)
minimax/MiniMax-M3              (fallback)
```

选型口径：`smart-model` 是主力对话入口（M3.1-Flash → M3 → DeepSeek → gpt-4o，跨厂商兜底）；
`minimax` 用于需要把后端锁定在 MiniMax 的场景（RAGFlow 等第三方组件、要求单一厂商可审计）。
两者指向同一批 MiniMax 账号，区别只在**降级时是否允许换厂商**。

### 预算与配额三级体系（方案 4.3）

| 级别 | 控制项 | 超限行为 | 实现 |
|---|---|---|---|
| 平台级 | 全平台月度 Token / 金额上限 | 告警，不熔断 | `BudgetService.check` 第一段 |
| 租户级 | 每租户月度预算硬上限 | 熔断，次月恢复 | 第二段 |
| 应用级 | 单应用 QPS / 单请求 Token 上限 | 限流 | 第三段（QPS 滑窗 + Token 预检） |

---

## 五、身份

| 组件 | 版本建议 | 优先级 | 方案要求 | 本项目实现 | 状态 |
|---|---|---|---|---|---|
| Keycloak | 26+ | P0 | SSO / OIDC / LDAP 对接 | **真实容器 Keycloak 26.0**（realm `enterprise`，3 客户端 / 4 用户 / 1 服务账号 / 14 个 client scope）；`packages/auth-middleware/src/index.ts` 通过 JWKS 校验 RS256 令牌；控制台走**授权码 + PKCE S256** 统一登录（`apps/webui/src/oidc.ts`，真实浏览器端到端 21/21）；RAGFlow 侧登录页由 nginx 拦到 Keycloak，**登出走 RP-initiated logout 一并结束单点登录会话**（`deploy/compose/ragflow/eap-patch-sso-logout.py` + `eap-entrypoint.sh`，端到端 19/19） | ✅ 真实实测 |
| 鉴权中间件（自研） | — | P0 | JWT 校验，替换 AgentScope 占位身份 | `packages/auth-middleware/src/index.ts` | ✅ |

**身份链路三段**（方案 7.1）全部落地并实测：

1. **Keycloak** → 签发含 `tenant_id / user_id / role / dept_id / sensitivity` 的 JWT
   （realm 内的 client scope `eap-context` 用 user-attribute 协议映射器注入这些 claim；
   `sub` / `preferred_username` / `realm_access` 来自 Keycloak 内置 scope）
2. **agentgateway** → 校验 JWT（`AuthService.verify`），执行 Cedar 策略与模型/工具白名单
3. **AgentScope / MCP / 业务系统** → 按透传的 `role` 做行级 / 文档级数据过滤

第 3 段由网关在调用 MCP 时注入 `__ctx = { tenant_id, user_id, role, dept_id, sensitivity }` 实现
（`gateway/src/mcp/registry.ts`），MCP Server 据此过滤。

**控制台统一登录（授权码 + PKCE）**：控制台是公开客户端（`eap-webui`，无客户端密钥），
从 `GET /v1/auth/config` 取授权参数后跳 Keycloak，令牌交换在浏览器侧完成，
网关与前端都不持有长期密钥。身份由 JWT claim 推导，与中间件口径一致
（单测 `tests/oidc-identity.test.ts`）；**权限判定仍以网关侧为准**。

> **实测发现的真实缺陷（已修）**：Keycloak 26 的 `--import-realm` **文件导入路径不会种下内置
> client scope**，导致 access_token 缺 `sub` / `preferred_username` / `realm_access`，
> 所有用户 `user_id` 塌缩成同一个值、审计无法区分操作者。已通过在 realm JSON 中显式内联
> 全部内置 scope 定义修复（`deploy/compose/keycloak/builtin-client-scopes.json`）。

**服务账号（组件间内部调用）**：MCP Hub 的 Text2SQL 需要回调网关，这属于**机器对机器**调用，
不能用终端用户的令牌，也不该用本地自签的 dev token。实现是 Keycloak `client_credentials`：

| 项 | 值 |
|---|---|
| 客户端 | `eap-agent`（confidential，启用 service account，secret 只在环境变量/Secret） |
| 服务账号身份 | `service-account-eap-agent`，显式声明 `tenant_id=t-default` / `dept_id=dept-general` / `sensitivity=internal` / `role=employee` |
| 取令牌 | `packages/platform-core/src/auth/service-token.ts` → `serviceToken()`，按到期时间缓存（提前 30 秒续期），并发调用只打一次 Keycloak |
| 配置 | `KEYCLOAK_SERVICE_CLIENT_ID` / `KEYCLOAK_SERVICE_CLIENT_SECRET` |
| 开发模式 | `AUTH_DEV_MODE=true` 时自动退回本地自签 token，不打 Keycloak |

> **实测发现的真实缺陷**：原先 `callGateway()` 固定用 `devTokenFor()` 自签 HS256 token，
> 在 `AUTH_DEV_MODE=false`（生产化配置）下网关直接 401，导致 ChatBI 的 Text2SQL 全链路失效。
> 改为服务账号 client_credentials 后，Text2SQL 恢复真实可用。

**实测结果**（`AUTH_DEV_MODE=false`）：

| 场景 | 结果 |
|---|---|
| Keycloak 签发的 RS256 令牌 → 网关 | ✅ 放行，完整跑通模型调用 |
| 本地 dev token（HS256） → 网关 | ✅ 401 拒绝（开发态关闭后不再旁路） |
| 无 Authorization 头 → 网关 | ✅ 401 |
| 服务账号 client_credentials 令牌 → 网关 | ✅ 放行，Text2SQL 真实跑通 |
| realm 角色 → 平台角色映射 | `platform-admin` / `admin` / `manager` / `employee` 一一对应；Keycloak 内置角色（`offline_access` 等）**不会**被当作业务角色 |
| 空串属性（Keycloak 属性映射器无属性时下发） | ✅ 按「缺失」处理，回落到默认租户/部门/`internal` 密级，不产生畸形身份 |

Keycloak 26 的三个实测细节：健康端点在**管理端口 9000**（不是主端口 8080）；
realm 导入是**严格反序列化**，任何未知字段（如 `description`、自定义注释键）都会导致导入整体失败；
`--import-realm` 对已存在的 realm 是 **IGNORE_EXISTING**，改完 realm 文件需先删 realm 再重启容器才会生效。

---

## 六、模型

| 组件 | 优先级 | 方案要求 | 本项目实现 | 状态 |
|---|---|---|---|---|
| 商业大模型 API | 外购 | 通义/DeepSeek/智谱/OpenAI；Key 全部托管在 agentgateway | `gateway/src/llm/providers.ts`；凭证仅在网关进程内，支持多账号池与轮换 | ✅ |
| 厂商凭证管理界面 | 外购平台 | 厂商接入、Key 与账号池不散落在各业务组件；接入和轮换无需改代码或重启 | 控制台独立「厂商接入与凭证」页面；`/v1/admin/provider-definitions` 管理连接，`/v1/admin/providers` 按账号管理密钥；加密落库 + 30s 多副本兜底刷新，只回掩码 + 全审计 | ✅ |

**Key 治理四条**（方案 4.4）：

1. 每个 Provider 开 2+ 个子账号 → `ProviderRegistry` 支持 `MINIMAX_API_KEY_2/3/4` 组成账号池
2. Key 只配在环境变量 / K8s Secret → 业务组件一律不可见，代码内不落盘
3. 季度人工轮换 → 凭证文件形态 `LLM_CREDENTIAL_FILE` 支持运行时动态读取，令牌轮换无需改配置重启
4. 网关日志 Authorization Header 脱敏 → `platform-core/src/logger.ts` 对 `authorization/apiKey/token/secret` 等键统一打码

**来源优先级**：控制台(DB) > 环境变量 > OAuth 凭证文件。
控制台优先是因为它是运维显式表达的「这把 key 现在作数」；删控制台凭证自动回落到下一级来源。

**出网白名单**：所有 Provider 请求发出前校验目标域名是否在 `EGRESS_ALLOWED_HOSTS` 内，不在则拒绝（`assertEgressAllowed`）。

---

## 七、存储

| 组件 | 优先级 | 方案要求 | 本项目实现 | 状态 |
|---|---|---|---|---|
| PostgreSQL 16 | P0 | 全平台元数据 | `platform-core/src/store/metadata.ts` 定义 `MetadataStore` 接口；生产用 PG（`store/pg.ts`），开发用 SQLite（`better-sqlite3`），接口一致，`STORE_KIND` 切换 | ✅ 实测 |
| Redis 7 | P0 | 会话 / 队列 / 缓存 | `platform-core/src/cache.ts`：`Cache` 接口 + `MemoryCache` / `RedisCache`；网关用其缓存 MCP 工具目录（多副本共享，`CACHE_KIND=redis`） | ✅ 实测 |
| MinIO | P0 | 原始文档 / 审计归档（开启版本化） | `platform-core/src/store/object.ts`：`ObjectStore` 接口 + `FsObjectStore`（开发）/ `MinioObjectStore`（生产，自动开启版本化） | ✅ 实测 |

**已实测的存储路径**：

| 后端 | 容器 | 验证结果 |
|---|---|---|
| PostgreSQL | `postgres:16-alpine`（16.16） | 38 项端到端验收全通过；`audit_events` / `traces` / `usage` / `sessions` / `messages` / `knowledge_docs` 均实际落库 |
| Redis | `redis:7-alpine` | 工具目录缓存键 `eap:mcp:catalog:{knowledge,chatbi,business}` 实际写入并命中 |
| MinIO | `minio/minio:latest` | 审计归档写入 `eap-audit/audit/{tenant}/{date}/{id}.json`，桶自动创建并开启版本化 |

---

## 八、安全

| 组件 | 优先级 | 方案要求 | 本项目实现 | 状态 |
|---|---|---|---|---|
| 出网代理（Envoy/Nginx） | P0 | SNI 白名单 + TLS 解密审计 | **真实 Envoy 1.31 容器**（`eap-envoy`）+ 网关内置域名白名单（`isEgressAllowed`）双层校验；`deploy/compose/envoy/envoy.yaml` 按 `EGRESS_ALLOWED_HOSTS` 渲染 SNI 白名单，白名单外返回 403；网关经 `packages/gateway/src/llm/egress.ts` 用 undici `ProxyAgent` 强制走代理（失败关闭） | ✅ 真实实测 |

**出网代理实测结果**：

| 项 | 结果 |
|---|---|
| 容器 | `eap-envoy`（envoyproxy/envoy:v1.31-latest），健康探针 `healthy` |
| 白名单内域名 | ✅ `CONNECT agent.minimaxi.com:443 → upstream=218.91.170.223:443 response=200`（真实建隧道） |
| 非白名单域名 | ✅ `CONNECT evil.example.com:443 → upstream=- response=403` |
| TLS 解密链路（15001） | ✅ 客户端信任企业 CA 后可走通，`egress-https` 访问日志记录 SNI |
| 网关模型流量 | ✅ Envoy 集群字节计数 `egress_connect_agent_minimaxi_com.upstream_cx_tx_bytes_total` 随每次模型调用递增（**不能用** `upstream_rq_2xx` —— 它只在新建 CONNECT 隧道时 +1，undici 复用隧道期间不动，会误判为「代理没生效」） |
| 唯一出口 | ✅ 网关进程对非回环地址的 443 直连数为 0；商业 API 请求全部经 Envoy；生产环境漏配 `EGRESS_PROXY_URL` 时网关**拒绝启动** |

**两个实测坑**：

1. **出网代理曾是死代码** —— `providers.ts` 里定义了 `proxyDispatcher()`，但
   ① 本项目是 ESM（`module: NodeNext`），`require('undici')` 在 ESM 下抛
   `ReferenceError`，被 `catch` 静默吞掉；② 就算不抛，**全项目没有任何调用点**。
   结果是模型请求一直直连，Envoy 从未参与。现已改为 `await import('undici')`，
   并把 `egressFetch()` 接进 Anthropic / OpenAI 两个适配器（TEI 等内网调用不走代理）。
2. **Envoy 镜像里没有 curl 也没有 wget** —— 官方镜像刻意做小。
   原健康探针 `curl -fsS .../ready` 永远失败（`curl: not found`）。
   现改用 `deploy/compose/envoy/healthcheck.sh`，以 bash 内建 `/dev/tcp` 发原始 HTTP 请求。
   注意必须显式用 bash 执行 —— `/bin/sh` 在 Ubuntu 上是 dash，不支持 `/dev/tcp`。


---

## 九、观测

| 组件 | 优先级 | 方案要求 | 本项目实现 | 状态 |
|---|---|---|---|---|
| Langfuse（自托管）+ ClickHouse | P1 | Trace / 成本归因 | **真实容器 Langfuse 3.63.0 + ClickHouse 24.8**；`gateway/src/observability/tracing.ts`：Trace 本地落库 + OTLP/HTTP JSON 导出到 Langfuse；`/metrics` 暴露网关内置指标（方案 11.1 要求「临时抓取排查，不建常驻监控栈」） | ✅ 真实实测 |

**实测结果**：

| 项 | 结果 |
|---|---|
| OTLP 端点 | `POST http://127.0.0.1:3001/api/public/otel/v1/traces` → 200 |
| Trace 入库 | ✅ `chat:smart-model` 真实出现在 Langfuse，traceId 与网关返回的一致 |
| Observation 类型 | ✅ `GENERATION`，model = 虚拟模型名 |
| input / output | ✅ 完整落地（角色/内容、模型回答） |
| token 用量 | ✅ `usageDetails = {input, output, total}` |
| 成本归因 | ✅ `costDetails.total` = 本次调用的真实美元成本 |
| 平台元数据 | ✅ `provider` / `realModel` / `latencyMs` / `deptId` / `role` / `tenant_id` 落在 metadata 顶层，可过滤 |

**两个实测坑**：

1. `exportSpan` 原本是**死代码** —— `TracingService.record()` 只落本地库，从不调用导出。
   现已接通：每次 `record()` 都会同步发一份 OTLP span（导出失败不影响主链路）。
2. Langfuse v3 只解析 **GenAI 语义约定**那套用量/成本属性（`gen_ai.usage.input_tokens` 等），
   纯 `langfuse.observation.usage_details` JSON 串会被存进 metadata 但**不会**填进类型化字段。
   现两套同时下发，实测 `usageDetails` / `costDetails` 正确解析。

---

## 十、镜像

| 组件 | 优先级 | 方案要求 | 本项目实现 | 状态 |
|---|---|---|---|---|
| Harbor 2.x | P1 | 离线镜像仓（内网环境必需） | **真实 Harbor v2.15.5（9 个容器）**，通过**官方离线安装包** `harbor-offline-installer-v2.15.5.tgz` 部署（goharbor 镜像在三个加速站全被拒、无法 pull）；编排经 `scripts/prepare_harbor.py` 改造为重型栈约定（`eapheavy-harbor-*` / `eapheavy_harbor` 网络 / 127.0.0.1:8098）；`deploy/helm/` 另提供 K8s 形态 | ✅ 真实实测 |

**Harbor 实测结果**：

| 项 | 结果 |
|---|---|
| 版本 | v2.15.5-8c17ef6e（9 个组件：core / db / jobservice / registry / registryctl / portal / log / redis / nginx，全部 healthy） |
| 健康端点 | `GET /api/v2.0/health` → `status: healthy`（7 个组件逐项 healthy） |
| 管理员登录 | `admin` 登录接口 200，`sysadmin_flag=True` |
| 建项目 | `POST /api/v2.0/projects` → 201，项目 `eap` 可见 |
| **真实推送** | `docker push harbor.eap.local:8098/eap/alpine_3.20` → 成功 |
| **真实拉回** | 删本地 → `docker pull` 从 Harbor 拉回成功，**层指纹与原镜像完全一致**（`63719798f4e63d479aafe46551f806ae`） |
| 仓库清单 | 项目 `eap` 下有镜像仓库 |
| 暴露面 | UI 端口只绑 `127.0.0.1:8098`，独立网络 `eapheavy-harbor_eapheavy_harbor` |

**三个实测坑**：

1. **Harbor 拒绝把 `127.0.0.1` 当 hostname** —— prepare 的校验是字面量比较
   （`if conf.get('hostname') == '127.0.0.1': raise`）。解法是本机别名
   `harbor.eap.local → 127.0.0.1`（`scripts/setup-harbor-hosts.sh`），
   别名解析到 127.0.0.1 落在 Docker 默认 insecure registries 段，
   所以 HTTP 推送**不用改 daemon 配置、不用重启 dockerd**。
2. **prepare 以 root 生成配置、容器以 uid 10000/999 运行** —— 直接跑会
   `permission denied`（`common/config/core/env` 是 `-rw-r----- root root`）。
   必须 `chmod -R o+rX common` + 按容器 uid 授权数据目录 + 建 `/var/log/harbor`。
3. **不能用 image ID 判断镜像一致性** —— 本机 Docker 启用了 containerd 镜像存储
   （`driver-type: io.containerd.snapshotter.v1`），`docker images` 的 ID 是
   **manifest digest**；Harbor 的 registry v2 会把 OCI manifest 转成 Docker v2 schema2，
   manifest digest 必然变化，但镜像内容（层）一模一样。所以要比 **RootFS 层指纹**。


## 十一、AI 工作流编排（V1，规划中）

> **方案书没有这个组件。** 方案 3.1 的 17 个组件里没有工作流编排引擎，
> 3.2 明确排除 **Dify**（原话：「首期用 AgentScope ReAct，确有需求再外挂」）。
> 本仓库选择**自研等价实现**接管 Dify 的位置，理由与 AgentScope Core/Service 的处理一致
> （见第一节「与官方 AgentScope 的关系」）：自研可保证**所有 LLM 与 MCP 调用都经 agentgateway**，
> 而外挂 Dify 会引入它自己的模型调用通道与数据库，成为治理旁路。
> 详细设计与契约见 [AI 工作流 V1 分析与设计](workflow-v1-design.md)。

| 组件 | 优先级 | 方案要求 | 本项目实现 | 状态 |
|---|---|---|---|---|
| 工作流编排（自研，对应方案书 Dify 的位置） | V1 规划 | 方案 3.1/3.2 未列该组件 | `packages/workflow-core/`（领域逻辑：类型 / DAG 校验 / 条件求值 / Schema 子集 / 引用解析，**A1 已实现**）+ `packages/agent-core/src/workflow/`（路由与端口适配，A2 起）+ `apps/webui/`（React Flow 编辑器，阶段 C） | 🟡 阶段 A1 已实现（37 例单测），A2 起未开始 |

**与被排除的 Dify 的差异**：

- Dify 自带 DB、自带模型调用路径；自研实现**不引入第二个执行底座**，工作流节点只经
  `agentgateway` 的 `/v1/chat/completions` 与 `/v1/mcp/call`，
  因此预算、策略、Guardrails、HITL 审批闸门、审计**一步都不旁路**。
- 审批链不另造：工作流复用平台既有的 `approvals` 表与网关侧的原子消费校验，
  **不接受工作流级长期审批背书**。
- 身份不借用：工作流以**实际运行者**身份调用模型、知识和工具，创建者与审批者身份只进审计。
- V1 不承诺多副本、跨天无人值守与定时调度；这些需求出现时再评估 Temporal 作为持久化执行底座，
  React Flow 画布与 DAG 契约可保留。

---

## 汇总

| 状态 | 组件 | 组件清单 |
|---|---|---|
| ✅ 真实组件实测 | 9 | Infinity（0.7.5 平台侧 + 0.6.5 RAGFlow 专用）、Keycloak、Langfuse、ClickHouse、TEI、**RAGFlow v0.22.1**、**DB-GPT 0.8.3**、**Envoy 1.31（出网代理）**、**Harbor 2.15.5（离线镜像仓）**（+ 重型栈自带的 PostgreSQL / Redis / MinIO / MySQL） |
| ✅ 自研实现并有测试 | 7 | AgentScope Core/Service、Web UI、agentgateway、鉴权中间件、商业模型接入、存储抽象层、**DB-GPT 的 MCP Server 适配器**（平台侧集成） |
| 🟡 接口等价的本地实现 | 1 | 平台侧 RAGFlow 工具层（平台侧 DB-GPT ChatBI 工具层已下沉到 DB-GPT 本体，仅保留为 fallback） |
| 📦 仅编排交付 | 1 | AI 工作流编排（自研 `packages/workflow-core`，对应方案书被排除的 Dify 位置；**阶段 A1 已实现**，A2 起未开始） |

> 🟡 指的是**平台 MCP Hub 侧的等价工具层**（`knowledge.search` 等），并非组件本身是模拟的 ——
> RAGFlow 与 DB-GPT 组件本体均已用**真实容器**拉起并跑通端到端功能。
> DB-GPT 的 ChatBI 工具层已下沉到 DB-GPT 本体（经 MCP Server 适配器暴露），
> 平台侧 `chatbi.ts` 仅保留为 fallback（本地等价实现，未注册进 `MCP_SERVERS`）。

**关键结论**：

1. 方案第 3.1 节的**平台核心能力（网关治理 + Agent 内核 + 身份 + 审计 + 预算 + 策略 + 护栏）已 100% 落地并通过测试**；
   方案点名的 P0/P1 重型组件（Keycloak、Infinity、RAGFlow、DB-GPT、Langfuse、ClickHouse、TEI）
   **全部以真实容器跑通并逐项实测**。
2. 三大能力的业务链路全部可跑：
   - 制度问答 → 真实 Infinity 向量+BM25 混合检索（过滤下推）；RAGFlow 侧独立验证了
     注册→建库→上传→解析→向量检索全链路（10/10）
   - ChatBI → Text2SQL + 只读沙箱 + 口径字典（平台侧等价实现）；
     DB-GPT 侧独立验证了真实模型调用链路（7/7，DB-GPT→网关→MiniMax）
   - HITL 审批 → 审批单 → 人工批准 → 工具真实执行
   - 出网 → 商业模型调用全程经 Envoy 唯一出口（白名单内放行 / 白名单外 403，已实测）
3. **本机环境的 3 处硬约束已定位并绕过**（AVX2 / internal 网络端口 / safetensors），
   见本文档第〇节与 `docs/operations.md` 9.1 —— 换一台合规机器时按文档改回原版配置即可。
4. **方案 3.1「DB-GPT 以 MCP Server 暴露」已在平台边界上真实成立**：
   DB-GPT 以原生四件套运行（controller/worker/apiserver/webserver），
   其 ChatBI 能力经容器内的 MCP Server 适配器（FastMCP + streamable-http，宿主 8097）
   暴露给网关，工具名与平台原有 `chatbi.*` 一致；
   同时 DB-GPT 又作为 MCP 客户端注册了平台的 knowledge / business MCP Server
   （上游原生 `ConnectorManager`，2/2 连接器 active，8 个工具）。
   实测端到端：平台 Agent → 网关 → DB-GPT MCP Server → DB-GPT apiserver → 网关 → MiniMax
   → DB-GPT 数据源只读执行 → 表格 + 图表规格，全链路跑通（19/19 验收）。
   唯一需如实标注的是：MCP Server 适配器属于**平台侧集成**（上游无此形态），
   而 MCP 客户端方向是**上游原生能力**。
