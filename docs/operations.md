# 部署、运维与实施

> 对应方案第 9 章「部署方案与硬件配置」、第 10 章「实施计划」、第 11 章「运维保障」。

> **关于 `<公网IP>` 占位**
> 本仓库为公开仓库，**不内置真实公网地址**。全文 `<公网IP>` 为占位符；
> 本机实际取值见内部参数表 `docs/internal/host-params.local.md`（gitignore）。

## 9.1 硬件配置

| 阶段 | 规格 | 说明 | 本项目实测环境 |
|---|---|---|---|
| POC | 1 台 16C 32G 500G SSD | 全组件单机 Docker Compose | 4C / 31G / 455G 可用 —— 内存达标，CPU 低于建议（受限） |
| 生产 | 3 台 16C 48–64G 500G SSD | Infinity/PG/Redis 副本分布，网关多副本 | — |
| GPU | 无 | 商业 API + CPU Embedding | 无 GPU，TEI 走 CPU 镜像 |

方案 9.1 对比：Infinity 为 C++ 原生实现，无 JVM 开销，同等文档量下内存占用低 4–8GB，POC 期 32G 即可从容运行。
完整栈使用 Infinity 混合检索；轻量模式未配置 Infinity/TEI 时会降级为 Node 进程内 BM25，
两种模式的资源占用与检索能力不能混为同一口径。

### 9.1.1 CPU 指令集硬约束（实测踩坑）

**Infinity 对 CPU 有硬性要求**：官方 Quickstart 明确写出「CPU: x86_64 with **AVX2** support」。
官方 `infiniflow/infinity:v0.6.5` 默认镜像的二进制带 AVX2/AVX-512 优化，
在**仅有 AVX（无 AVX2）**的机器上启动会直接 `SIGILL`：

```
traps: infinity[514607] trap invalid opcode ip:55e3e638ac33 ...
```

本项目实测机器为 **Intel Xeon E5-2697 v2 (Ivy Bridge, 2013)**，`/proc/cpuinfo` 中只有
`sse4_2 avx f16c`，**无 avx2** → 默认镜像无法启动。

本机解决方案是使用官方 **x64 微架构分级镜像** `-x64-v2`，并在重型 overlay 中通过
`/usr/bin/qemu-x86_64-static` 做用户态模拟；RAGFlow 专用 Infinity 也采用同样方式。
该方案吞吐较低，只适合本机 POC。换到其他机器时，必须先确认 QEMU 路径存在；
支持 AVX2 的机器可选择合适的原生分级镜像，并移除 overlay 中对应的 QEMU entrypoint 和挂载。
`start-heavy.sh` 不会自动安装 QEMU 或按 CPU 改写编排。

```yaml
image: ${INFINITY_IMAGE:-infiniflow/infinity:v0.7.5-x64-v2}
# 本机 overlay 另含：
entrypoint: ["/usr/bin/qemu-x86_64-static", "/usr/bin/infinity"]
```

分级说明：

| 标签 | 基线指令集 | 要求 |
|---|---|---|
| `-x64-v2` | x86-64-v2（SSE4.2 / POPCNT） | 绝大多数 2009 年后的 x86 服务器可用 |
| `-x64-v3` | x86-64-v3（AVX2 / BMI2 / FMA） | Haswell(2013) 及以后 |
| `-x64-v4` | x86-64-v4（AVX-512） | Skylake-SP(2017) 及以后 |

生产选型建议：先按目标 CPU 选择分级标签并验证原生启动；无 AVX2 时才评估 QEMU 兼容路径。
不要只以 `docker run --rm <image> --help` 作为验收，仍需通过实际的 Infinity 健康检查与检索测试。

### 9.1.2 存储与带宽

镜像体积参考（决定拉取耗时）：

| 镜像 | 量级 | 备注 |
|---|---|---|
| `infiniflow/infinity` | 0.3–0.5 GB | C++ 单二进制，体积小 |
| `quay.io/keycloak/keycloak:26.0` | ~0.5 GB | 只在 quay.io，Docker Hub 无官方镜像 |
| `ghcr.io/huggingface/text-embeddings-inference:cpu-1.8` | ~1.5 GB | CPU 镜像，比 GPU 版小很多 |
| `langfuse/langfuse` + worker | 各 ~1 GB | |
| `clickhouse/clickhouse-server:24.8-alpine` | ~0.3 GB | alpine 版比常规版小 |
| `infiniflow/ragflow:v0.22.1` | ~10 GB | 含内置推理依赖，最大 |
| `eosphorosai/dbgpt:latest` | ~3–5 GB | |

**实测：单条 docker pull 流在本网络约 300 KB/s；并发 8 条拉取可达 13 MB/s。**
镜像就位时间与并发数强相关，排期时按并发拉取估算，不要按单流速度线性推算。

### 9.1.3 TEI 模型下载

平台 TEI 当前使用 `intfloat/multilingual-e5-small`（384 维、含 safetensors），不是 BGE-M3。
重型 overlay 只读挂载 `data/models/multilingual-e5-small` 到容器 `/data/model`，该目录不入库，
全新克隆必须按根 README 先下载模型。基础 Compose 则使用命名卷 `tei-cache:/data` 和
`TEI_MODEL`，两者不是同一种加载方式。

**本网络直连 `huggingface.co` 曾实测超时**，模型下载和 RAGFlow 的 DeepDoc/分词器下载使用：

```yaml
environment:
  HF_ENDPOINT: https://hf-mirror.com   # 本机历史实测可达，新环境仍需重新验证
```

基础 Compose 尚未给 TEI/RAGFlow 完整注入上述模型仓配置；不能把重型 overlay 的实测结果
直接套到基础编排。

### 9.1.4 镜像从哪里来（registry 镜像加速）

**本网络直连 Docker Hub 不可达**（实测 `registry-1.docker.io` 的 `/v2/` 返回 HTTP 000 = 连接失败），
但 `docker pull` 依然可用 —— 因为 Docker daemon 配了 **registry 镜像加速**，
daemon 会自动改从镜像加速站拉取，**pull 命令里不用改任何东西**：

```jsonc
// /etc/docker/daemon.json
{
  "registry-mirrors": [
    "https://docker.m.daocloud.io",
    "https://docker.1panel.live",
    "https://hub.rat.dev"
  ]
}
```

镜像源按顺序回退，实测三者都可达（`/v2/` 返回 401/200/302 均为正常应答，
401 是「需要 token」的正常响应，不是不可达）。

**但有两个组件本来就不在 Docker Hub**，走的是各自的官方仓库，**直连可达、不受镜像加速影响**：

| 组件 | 镜像 | 仓库 | 实测 |
|---|---|---|---|
| TEI | `ghcr.io/huggingface/text-embeddings-inference:cpu-1.8` | GitHub Container Registry | 直连拉取成功 |
| Keycloak | `quay.io/keycloak/keycloak:26.0` | Quay | 直连拉取成功（Docker Hub 无官方镜像） |

**本地构建的镜像**（不重下基础层）：

| 镜像 | 构建方式 |
|---|---|
| `eapheavy/dbgpt:0.8.3-pg` | `FROM eosphorosai/dbgpt:latest` + 装 `psycopg2-binary`，见 `deploy/compose/dbgpt/Dockerfile`；基础层复用，不重下 21GB |
| `eap/agentgateway:1.0.0` 等 | `deploy/docker/*.Dockerfile` |

**结论**：本机 17 个镜像 = Docker Hub 系（走镜像加速）+ ghcr.io/quay.io（直连）+ 2 个本地构建。
换机器时只需确认 `/etc/docker/daemon.json` 的 `registry-mirrors` 一致，其余命令不变。

> Harbor 镜像获取问题已通过官方离线安装包解决，完整安装与验收流程见 [docs/harbor.md](harbor.md)。
> Helm 中的 Harbor 清单仍可按需启用，默认关闭。

### 9.1.5 Harbor 离线镜像仓的落地路径

上面说的「镜像拉不到」，已经用**官方离线安装包**解决了 ——
它内含全部镜像 tar，`docker load` 之后完全离线运行，恰好就是方案里
「内网环境必需 / 离线镜像仓」的形态本身。完整说明见 **[docs/harbor.md](harbor.md)**。

```bash
# 1) 下载并校验（748 MB，分块+断点续传，sha256 取自 GitHub API）
python3 scripts/download_harbor.py /tmp/harbor-offline-installer.tgz v2.15.5 \
  --workers 8 --chunk-mib 8

# 2) 部署（自动完成：hosts 别名 → 解包 → docker load → prepare → 编排改造 → 权限 → up）
./scripts/start-harbor.sh start

# 3) 验收（21 项，含真实 push + 删除 + pull 拉回）
./scripts/verify-harbor.sh
```

关键点：

- **hostname 不能是 `127.0.0.1`** —— Harbor 的 prepare 硬性拒绝（字面量校验）。
  用本机别名 `harbor.eap.local → 127.0.0.1`（`scripts/setup-harbor-hosts.sh`），
  因为 Docker 默认 insecure registries 含 `127.0.0.0/8`，
  HTTP 推送**不需要改 daemon 配置、不需要重启 dockerd**。
- **prepare 以 root 生成配置、容器以 uid 10000/999 运行** —— 必须修权限，否则
  `permission denied`。
- **校验镜像一致性要比 RootFS 层指纹，不能比 image ID** ——
  本机 Docker 用 containerd 镜像存储，ID 是 manifest digest，
  而 Harbor 会把 OCI manifest 转成 Docker v2 schema2，digest 必变但内容不变。

### 9.1.6 数据库实例盘点（别被「装了三个 PG」吓到）

本机一共 3 个 PostgreSQL + 1 个 MySQL + 3 个 Redis，各有明确归属：

| 实例 | 内存 | 服务的库 | 能删吗 |
|---|---|---|---|
| `eap-postgres` | 22 MiB | `eap`（平台元数据，10 张表） | ❌ 平台自己要用 |
| `eapheavy-postgres` | 57 MiB | `langfuse`（49 表）+ `dbgpt`（63 表） | 🟡 可并入平台 PG（同实例分库） |
| `eapheavy-harbor-db` | ~50 MiB | `registry`（Harbor 自己的库） | ❌ 建议独立 |
| `eapheavy-mysql` | **402 MiB** | `rag_flow`（RAGFlow 元数据） | ❌ **RAGFlow 上游只支持 MySQL** |
| `eap-redis` / `eapheavy-redis` / `eapheavy-harbor-redis` | 3.5 / 6 / 3.9 MiB | 平台缓存 / Langfuse+DB-GPT / Harbor | 🟡 可并 |

两点容易踩的：

- **Keycloak 不占 PG** —— 它没配 `KC_DB`，用的是内置 H2 文件库
  （`/opt/keycloak/data/h2`）。别把它算进 PG 的账上。
- **重型栈 PG 的 `POSTGRES_DB` 必须设成 `postgres`** —— 基础 compose 的默认值是 `eap`，
  重型 overlay 只覆盖了容器名和端口，会继承这个默认值，于是初始化时白建一个
  **0 张表**的 `eap` 库（实测 7.6 MB，纯属误导，已 DROP）。
  postgres 官方 entrypoint 遇 `POSTGRES_DB=postgres` 会**跳过建库**，所以直接用它。

### 9.1.7 残留清理清单

| 残留 | 性质 | 处理 |
|---|---|---|
| `eapheavy-postgres` 里的 `eap` 空库 | 初始化误建，0 张表 | 已 DROP，并把 `POSTGRES_DB` 改成 `postgres` 防复发 |
| `eapheavy_platform-data` 孤儿卷 | **完全为空**，无容器引用 | `docker volume rm eapheavy_platform-data`（受权限门限制需人工执行） |
| `eapheavy-envoy` 容器 | 从未启动，且**端口会与 `eap-envoy` 冲突** | 已移除容器；编排里把它的端口右移到 15010/15011/9911 |
| `eapheavy-minio-init` | 一次性 init 任务，退出码 0 | 正常保留（compose 每次 up 会重跑） |

### 9.1.8 版本控制策略（什么进库、什么不进）

**入库（191 个文件）**：

| 类别 | 位置 | 说明 |
|---|---|---|
| 平台源码 | `packages/*/src/**`、`apps/webui/src/**` | TypeScript / React 源码 |
| 构建与测试配置 | `package.json`、`tsconfig*.json`、`vitest.config.ts` | 含 `package-lock.json`（锁依赖版本） |
| 编排 | `deploy/compose/*.yml`、`deploy/helm/**`、`deploy/docker/*.Dockerfile` | 唯一的部署事实源 |
| 脚本 | `scripts/**` | 启停 / 验收 / 补丁 / 运维工具 |
| 验收用例 | `tests/**` | Vitest 单元/接口回归 + 各验收脚本（数量以当前测试输出为准） |
| 文档 | `docs/**`、`README.md` | 设计与运维文档 |
| 需求源文档 | `企业级 AI Agent 平台建设方案.pdf` | **建议入库** —— 代码里大量引用「方案 8.3 / 9.3」等条目，缺了它注释就断链 |
| 配置模板 | `.env.example`、`deploy/compose/.env.example` | 无真实值的模板 |
| Keycloak realm | `deploy/compose/keycloak/realm-eap.json` | 配置基线；**含开发用明文口令**，见该目录 README |

**不入库**：

| 类别 | 忽略规则 | 原因 |
|---|---|---|
| 运行时数据 | `data/` | 含 748 MB Harbor 离线包、449 MB 模型权重、SQLite 库、Harbor 的 blob 存储 |
| 依赖与产物 | `node_modules/`、`dist/`、`*.tsbuildinfo` | 可再生 |
| **TLS 私钥** | `deploy/compose/envoy/certs/*.{key,crt}` | **私钥严禁入库**；`generate-certs.sh` 可再生，`start-infra.sh` 会在缺失时自动生成 |
| 真实配置 | `.env`、`deploy/compose/.env` | 含真实口令与 issuer 列表 |
| Python 字节码 | `__pycache__/`、`*.py[cod]` | 编译产物 |
| 浏览器共享库 | `.cache/` | 从容器借出的 Chromium 运行库 |
| 日志 | `*.log` | — |

**全新克隆后的初始化顺序**：

以[根 README 的快速开始](../README.md#快速开始)为唯一操作入口。除了复制两份 `.env`，
还必须完成平台配置切换、支撑层密码注入、DB-GPT 镜像构建、TEI 模型下载和 RAGFlow
首次账号初始化；不能只执行三个启动脚本。`start-infra.sh` 缺证书时会自动生成开发证书，
`start-heavy.sh check` 则只检查 realm 的 Web Origin，不是完整部署预检。

> `deploy/helm/values.yaml` 与 `secret.yaml` 里全部是 `CHANGE_ME_*` 占位符 ——
> 这部分与 Keycloak realm 的处理方式**尚未统一**（realm 是明文但已标注），
> 是已知待收敛项。

### 9.1.9 公网访问控制台「页面报错」的根因（安全上下文与 PKCE）

**症状**：公网 `http://<公网IP>:5173` 打开控制台，页面能渲染，但点「使用企业账号登录」
没反应；**本机 `http://127.0.0.1:5173` 一切正常**。外部 HTTP 探测却全部 200 —— 极易误判成宿主转发问题。

**根因**：`crypto.subtle` 只在**安全上下文**可用。浏览器把 `localhost` / `127.0.0.1` 视为可信源，
所以本机有 `crypto.subtle`；公网明文 HTTP 的非本机来源 `isSecureContext=false`，
`crypto.subtle` 是 `undefined`。PKCE 的 S256 挑战需要 SHA-256，原实现直接调
`crypto.subtle.digest` → `TypeError` → 授权跳转根本没发生。

**修复**：`apps/webui/src/sha256.ts` 提供纯 JS SHA-256（FIPS 180-4，无外部依赖），
`oidc.ts` 改为「优先原生、没有则兜底」。

**改动文件**：`apps/webui/src/sha256.ts`（新增）、`apps/webui/src/oidc.ts`、
`packages/gateway/src/routes/auth.ts`、`tests/sha256.test.ts`（新增）、
`scripts/verify-secure-context-pkce.mjs`（新增）。

**顺带修正**：网关 `/v1/auth/config` 的 `issuer` 原先取白名单第一项（`127.0.0.1`），
现改为按请求 Host 解析 —— 公网访问返回公网 issuer，本机返回本机 issuer，
与 Keycloak 按 Host 生成 `iss` 的行为一致（此前控制台登录页对外网用户显示
「当前身份源：http://127.0.0.1:8082/...」，属显示错误，不影响验签）。

**历史验收**：单测 142/142（含 4 项 SHA-256 与 Node 原生逐字节比对；该轮之后又增加 AG-UI 端点测试，最新总数以 `npm test` 输出为准）· e2e 40/40 ·
verify-heavy 59/59 · verify-harbor 21/21 · 控制台登录 21/21（本机与公网各一轮）·
非安全上下文 PKCE 回归 5/5。

> 遗留建议：明文 HTTP 下令牌与 Cookie 在链路上是明文，这是**传输层**问题。
> 生产环境应在宿主机为控制台配置 HTTPS 终止（本次修复只保证功能可用，不解决传输安全）。

### 9.1.10 控制台改版：AG-UI 标准事件流

**背景**：控制台原先用私有协议（`POST /api/chat` 一次性返回），无法做流式输出；
本轮改版引入 [AG-UI 协议](https://github.com/ag-ui-protocol/ag-ui)，前后端都按标准事件流对接。

**改了什么**：

| 层 | 改动 | 文件 |
|---|---|---|
| Provider | `OpenAIAdapter` / `AnthropicAdapter` 增加**可选**的 `chatStream()`，真实 SSE 解析 | `packages/gateway/src/llm/providers.ts` |
| 路由 | `router.chat()` 增加**可选**第三参 `onContentDelta`；传回调走流式，不传行为完全不变 | `packages/gateway/src/llm/router.ts` |
| 网关路由 | `stream:true` 分支改为**延迟发 SSE 头**（首个增量才发），预算 / 护栏 / 出网拒绝等前置错误仍返回正确 HTTP 状态码 | `packages/gateway/src/routes/chat.ts` |
| Agent 内核 | `GatewayClient.streamChat()`、`AgentRuntime.runStream()`（与 `run()` 共用同一套 ReAct 循环） | `packages/agent-core/src/gateway-client.ts`、`runtime.ts` |
| AG-UI 端点 | `POST /ag-ui` —— 运行事件映射成 AG-UI 标准事件 | `packages/agent-core/src/agui.ts`（新增） |
| 前端 | assistant-ui 线程 UI + 标准 `HttpAgent` 直连 `/ag-ui` | `apps/webui/src/api/agui.ts`、`runtime/AgentRuntimeProvider.tsx`、`pages/ChatPage.tsx` |

**为什么流式改造是低风险的**：provider 与 router 的新能力都是**可选**的，
不传回调时行为与改造前逐字节一致 —— 既有 161 项单测、40 项 e2e、21 项登录验收零影响。

**关键设计决策**：

1. **不引入 Python 后端**：不并存两套运行时，治理链（预算 / 护栏 / 脱敏 / 审计 / HITL）全部保留。
2. **HITL 沿用跨用户 DB 审批单**：官方 scaffold 的「同请求 interrupt→resume」模型不适用于
   跨用户审批场景；改为 `CUSTOM` 事件 `eap.approval_pending` / `eap.approval_decided`，
   SSE 连接在等待审批期间保持打开（上限 `AGENT_APPROVAL_TIMEOUT_MS`，默认 300 秒）。
3. **会话 id 由客户端生成**：`threadId` 即平台 `sessionId`，服务端按需创建；
   已存在则沿用，跨租户访问返回 403。

**踩过的坑**：

- **工具被否决后必须回结果事件**：HITL 驳回/超时后若不发 `TOOL_CALL_RESULT`，
  前端会一直挂在「等待工具返回」态（`react-ag-ui` 在 `RUN_FINISHED` 时按未收口工具判定 `requires-action`）。
  现已在 `runtime.ts` 的驳回分支补发 `tool_result`（`ok: false`）。
- **每个工具调用都要有结果**：否则整轮消息状态不完整。

**验收**：单测 19/19（`tests/agui.test.ts`）· 浏览器端到端 17/17（`scripts/verify-console-stream.mjs`，
含公网地址一轮）· 登录 21/21（本机与公网）· e2e 40/40。

### 9.1.11 控制台「知识库」页 + RAGFlow 访问路径

**背景**：此前平台真正的业务知识（主库 `knowledge_docs` 表）**只有 MCP 工具能访问**，
控制台上完全看不到；RAGFlow 组件的 Web 界面又是坏的（返回 nginx 默认欢迎页），
于是「知识数据怎么看」在两个方向上都是盲区。

#### (1) RAGFlow Web 界面修复

`infiniflow/ragflow:v0.22.1` 镜像里的 `/etc/nginx/` 是 Debian 默认站点
（`conf.d/` 为空、`sites-enabled/default` 的 root 指向 `/var/www/html`），
前端产物却完整躺在 `/ragflow/web/dist` 里 —— 于是容器内 80 端口返回的是
"Welcome to nginx!" 而不是 RAGFlow 界面。

修法：以只读挂载补齐官方 `docker/nginx/{nginx.conf,ragflow.conf,proxy.conf}` 三份配置
（`deploy/compose/ragflow/nginx/`），覆盖掉 Debian 默认站点。8080/9380/9901 等端口
仍只绑 127.0.0.1，对外只开 8095。

#### (2) 公网开放 8095 的配套收口

Web 界面放到公网意味着任何人都能调 `POST /v1/user/register` 建号占用解析与模型资源。
因此：

- `REGISTER_ENABLED=0`（compose 环境变量）—— 关闭自注册，只保留固定账号
  `eap-admin@eap.local` / `EapAdmin@2026`；
- VM 侧加了 8095 的 `nat/PREROUTING` DNAT 规则（与 5173/8080/8082 同款，
  由 `scripts/setup-localnet-dnat.sh` 生成并持久化到 `/etc/iptables/rules.v4`）；
- **宿主机侧仍需管理员加一条转发**（宿主机是 OpenWrt，只有 LuCI/telnet 入口，
  没有 SSH，VM 侧改不了）—— 操作清单见 `docs/host-handoff.md` 的「0.5 如果宿主机是 OpenWrt」。

#### (3) RAGFlow 里的垃圾数据清理与「不再产生垃圾」

历史遗留：旧版验收脚本每跑一次就注册一个随机用户 + 建一个同名知识库，
库里堆了 **60 个测试用户 / 49 个同名知识库**，在 RAGFlow 界面上完全没法看。

- 清理脚本 `scripts/cleanup-ragflow-testdata.py` —— 走 SDK API 删知识库
  （让 RAGFlow 自己清 MinIO 对象与 Infinity 向量，不留孤儿），再用 SQL 清 user/tenant 残留；
- 验收脚本 `scripts/verify-ragflow.py` 改为**固定账号 + 复用知识库**（每次先清空旧文档再上传），
  不再产生新用户与新知识库。

> 顺带修掉一个长期 bug：SDK 的 `GET /api/v1/datasets` 返回的 `data` 是**数组**，
> 旧脚本按对象解析（`data.datasets`），因空数组恰好为 falsy 而一直没报错，
> 结果「复用知识库」从未真正生效过。

#### (4) 控制台「知识库」页

网关新增 `/v1/knowledge/*`（见 `docs/api.md` 1.8 节），控制台新增页签：
列表 + 详情 + **检索测试** + 增删改。

- 可见性口径：**密级优先**（密级高于本人密级的文档，管理员也不可见）+ 部门隔离 + 跨租户隔离；
- 写操作**审批制**：POST / DELETE 只返回 `202 + approvalId`，由另一位有审批权限的人
  在「审批中心」通过后，网关才回放 `knowledge.upsert_document` / `knowledge.delete_document` 真正落库；
- 检索测试走与 Agent **完全相同**的检索链路，并显示实际引擎（`infinity` / `local-bm25`），
  用来验证文档是否真能被 Agent 召回。

**验收**：单测 16/16（`tests/knowledge-api.test.ts`）+ 2/2（`tests/mcp-ctx-passthrough.test.ts`）
· 浏览器端到端 20/20（`scripts/verify-console-knowledge.mjs`）。

#### (5) 顺带修掉的三处真实缺陷

排查知识库可见性时暴露出来的、与知识库直接相关的三个问题：

| 缺陷 | 现象 | 根因 | 修法 |
|---|---|---|---|
| **Infinity 向量维度错配** | 检索一直退化为本地 BM25，向量召回从未真正工作，但界面无任何异常 | 表是旧维度（4）建出来的；Infinity 的 `create_option: ignore_if_exists` 对**已存在表**不纠正列类型（实测：先以 `vector,4,float` 建表、再以 `vector,384,float` 同名建表，列类型仍停在 `Embedding(float,4)`），而 `init()` 从不校验维度 | `init()` 主动读表的实际列维度，不一致就 `recreateTable()` 重建；`upsert()` 补上「表存在但无向量列」的自愈分支 |
| **写入不带向量** | 新写入的文档永远召不回来（全文能命中，掩盖了问题） | `knowledge.upsert_document` 调 `infinity.upsert()` 时没传 embedding | 写入前用 TEI 计算向量并带 `passage:` 前缀（查询侧是 `query:`） |
| **MCP schema 剥掉 `__ctx`** | 「召回前过滤」实际按**固定默认身份**（t-default / dept-general / internal / anonymous）执行，部门与密级隔离形同虚设 | MCP SDK 调用前按 `inputSchema` 做 zod 校验，而 zod 对未声明的键默认 **strip**；网关注入的 `__ctx` 被删掉了 | `registerTools` 统一把入参 schema 包成 `z.object(...).passthrough()`；`ctxFrom` 拿不到 `__ctx` 时按**最小权限**兜底（查不到任何文档）并打 warn |

第三条尤其值得记：它让「过滤看起来生效、实际按固定身份过滤」，
任何基于部门/密级的越权判断都会被架空。回归守卫见 `tests/mcp-ctx-passthrough.test.ts`
（该测试在关闭 passthrough 后确实会失败）。

#### (6) 验收脚本污染生产检索表（第四处真实缺陷）

上面第 (5) 条把「维度自愈」修好后，自愈本身又暴露出第二个问题：
`recreateTable()` 走的是 **DELETE + CREATE**，表内数据会被整体清空。
而 `scripts/verify-infinity.ts` 当时直接在**生产库表**上跑，还用 `dimensions: 4`
（为了写 4 维测试向量）。于是：

1. 脚本 `init()` 读到生产表是 384 维，与配置的 4 不一致 → 触发自愈重建；
2. 生产表被 DELETE + CREATE 成 **4 维**；
3. 原有 4 条知识库向量**全部清空**。

后果：后续 dense 检索报 `Query embedding with dimension: 384 which doesn't not
matched with 4`，而 `search()` 会吞掉异常返回 []，平台**静默降级**成本地 BM25。
界面无任何报错，唯一的线索是控制台「检索测试」里的引擎从 `infinity` 变成了
`local-bm25` —— 而检索**照样能出结果**（BM25 全文命中），看起来一切正常。

修法（三层，缺一层都可能再次静默丢数据）：

| 层次 | 改动 | 作用 |
|---|---|---|
| 根因 | `scripts/verify-infinity.ts` 改用独立库表（`eap_kb_verify` / `verify_infinity_chunks`），库表与生产值相同时**拒绝执行**；结束时删除整个验收库 | 验收脚本不再可能碰到生产表 |
| 防御 | `InfinityClient` 新增 `onRebuild` 回调：重建成功后必须回调，让调用方重新灌数据；并加**重建重入保护**（重建 → 灌数据 → 又触发重建 会死循环） | 重建不再静默丢数据 |
| 接线 | mcp-hub 把全量同步（TEI 重算向量 + 全量 upsert）挂到 `onRebuild`，并把 `init()` 挪到同步函数定义之后 | init 期间的自愈重建也会立刻回灌 |

顺带修掉一个真实 URL 拼接缺陷：`InfinityClient.url()` 用 `parts.join('/')`，
而库名/表名是不带前导斜杠的变量，拼出来是 `/databases/db//tables/tbl`。
Infinity（oatpp）对此宽容才一直没暴露，严格路由的服务会直接 404。

**回归守卫**：`tests/infinity-rebuild.test.ts` 覆盖维度不符时重建并回灌、
维度一致时不重建、重建重入保护，以及回灌失败后的降级恢复；具体用例数以测试输出为准。

**实测**：跑完验收脚本后生产表维度仍是 `Embedding(float,384)`，
平台检索接口返回 `"engine":"infinity"`，验收库已被自动删除。

#### (7) RAGFlow 接入 MiniMax：走 agentgateway，不直连商业 API

RAGFlow 的「模型提供商」页（`http://<对外地址>:8095/user-setting/model`）默认是
**每个厂商直连自己的 API** —— 那会绕过平台的唯一出口与出网代理（方案 9.3 / 4.4）。
本平台的接法与 DB-GPT 保持一致：**RAGFlow → agentgateway 的 OpenAI 兼容端口 → Envoy → MiniMax**。

> **不要用 RAGFlow 内置的「MiniMax」provider**。三个原因：
> ① 它的 `base_url` 在代码里写死 `https://api.minimax.chat/v1/text/chatcompletion_v2`，
>    UI 不提供改写入口，走它是**容器直连商业 API**；
> ② 它直连的是 MiniMax 开放平台，而本平台的凭证是 Mavis 侧
>    （`agent.minimaxi.com/mavis/api/v1/llm/v1`，Anthropic 协议），**两者不是同一个服务**；
> ③ 它的模型清单只有 `abab5.5s/abab6.5s` 这批旧型号，没有本平台在用的
>    `MiniMax-M3.1-Flash` / `MiniMax-M3` / `MiniMax-M2.7-highspeed`。

**界面填法**（模型提供商 → 添加模型 → 选 `OpenAI-API-Compatible`）：

| 字段 | 值 |
|---|---|
| API Key | `eap-dbgpt-local-key`（根 `.env` 的 `AUTH_SERVICE_TOKENS` 里的服务间静态凭证） |
| Base URL | `http://172.17.0.1:8080/v1` |
| 模型名称 | `smart-model`（或 `reasoning-model` / `fast-model` / `minimax`） |

- **模型名必须是网关的虚拟模型名**。网关按 `smart-model` 解析出
  `MiniMax-M3.1-Flash`（primary）→ `MiniMax-M3` → `DeepSeek-chat` → `gpt-4o` 的 failover 链，
  填真实模型名网关会认不出来。
- **`smart-model` 与 `minimax` 是两个不同的虚拟模型名**，不是同一个模型的两个写法：
  - `smart-model`：主力对话入口，跨厂商 failover（M3.1-Flash → M3 → DeepSeek → gpt-4o）。
  - `minimax`：MiniMax 专属，只降级到 `MiniMax-M3`，不换厂商。
  - 填了网关未注册的模型名 → 网关直接返回 **404「虚拟模型 'X' 不存在或已禁用」**，
    这是模型名拼写/未下发的问题，不是连通性问题。排查先 `GET /v1/models` 看网关当前认哪些名字。
- **Base URL 必须用 `172.17.0.1`，不能用 `host.docker.internal`** ——
  RAGFlow 服务的 compose 里**没有** `extra_hosts: host.docker.internal:host-gateway`
  （只有 DB-GPT 有），用主机名会直接 DNS 失败。`172.17.0.1:8080` 是宿主上的
  回环桥（`scripts/loopback-bridge.ts`），是容器访问宿主服务的既定通道。
- 配好后在「设置默认模型」里把 **LLM 选成 `smart-model`、Embedding 选成 `BAAI/bge-m3`**，
  知识库解析与聊天才会走这条链路。

**接入 MiniMax 公有云（开放平台 `api.minimax.cn`）**

平台默认的 `minimax` 虚拟模型走的是 **Mavis 端点**（`agent.minimaxi.com`，Anthropic 协议，
凭证不在环境变量里）。如果你手上是**开放平台账号**（`api.minimax.cn`，OpenAI 兼容协议），
那是**另一套服务、另一把 key**。按下面三步把它接进网关 —— 仍然走 Envoy 唯一出口，
审计、预算、密级护栏照常生效：

1. **域名白名单**（应用层 + 网络层各一份，缺一不可）：

   ```bash
   # 根 .env —— 网关应用层 assertEgressAllowed()
   EGRESS_ALLOWED_HOSTS=agent.minimaxi.com,api.minimax.cn,api.openai.com,dashscope.aliyuncs.com,api.deepseek.com,open.bigmodel.cn
   # deploy/compose/.env —— Envoy 容器侧 SNI 白名单（同一个域名列表）
   EGRESS_ALLOWED_HOSTS=api.openai.com,dashscope.aliyuncs.com,api.deepseek.com,open.bigmodel.cn,agent.minimaxi.com,api.minimax.cn
   # 白名单是**容器启动时渲染**的，两个 Envoy 都要重建
   cd deploy/compose && docker compose --env-file .env -f docker-compose.yml up -d --force-recreate envoy
   ```

   > 只改一层会被另一层拦掉：网络层没放行时 Envoy 对 CONNECT 直接回 **403**，
   > 网关侧表现为 `fetch failed`（不是 401/403，容易误判成网络故障）。

2. **填公有云 key 并重启网关**（key 只进根 `.env`，不入库）：

   ```bash
   # 根 .env 追加：
   MINIMAX_PUBLIC_BASE_URL=https://api.minimax.cn/v1
   MINIMAX_PUBLIC_API_KEY=<你的开放平台 API Key>

   # 重启网关（读新的环境变量）
   cd /opt/agent && set -a && . ./.env && set +a
   ( setsid npx tsx packages/gateway/src/main.ts >> data/logs/gateway.log 2>&1 < /dev/null & echo $! > data/logs/gateway.pid )
   grep -a "provider minimax-public" data/logs/gateway.log | tail -1
   # 期望：provider 已注册 name=minimax-public protocol=openai
   # 没填 key 时是「provider minimax-public 未配置凭证来源，已跳过」（网关跳过该 provider）
   ```

3. **RAGFlow 侧仍然指网关**，模型名用新的虚拟模型名 `minimax-public`：

   | 字段 | 值 |
   |---|---|
   | API Key | `eap-dbgpt-local-key` |
   | Base URL | `http://172.17.0.1:8080/v1` |
   | 模型名称 | `minimax-public`（真实型号由网关决定：`MiniMax-M3.1-Flash` → `MiniMax-M3`） |

   批量给所有账号配上：`sudo -n python3 scripts/config-ragflow-models.py`
   （脚本检测到根 `.env` 里有 `MINIMAX_PUBLIC_API_KEY` 才会追加这个模型，
   没有 key 时不配，避免把「模型不可用」写进租户配置）。

   > `minimax-public` 可能**已经出现在各租户的模型列表里**（预置条目，
   > `api_base` 仍指网关）—— 预置时没做连通性校验（那时还没有 key），
   > 所以填完 key 后用 `sudo -n python3 scripts/config-ragflow-models.py --refresh-models`
   > 强制重新探测一次，把「配置一致，跳过模型探测」变成真实校验。

> **为什么不能在 RAGFlow 里直填 `https://api.minimax.cn/v1`**：
> ① **公有云不认识 `minimax` 这个名字** —— 它是**网关的虚拟模型别名**，
>    公有云只认真实型号（`MiniMax-M3.1-Flash` / `MiniMax-M3` / `MiniMax-M2.7-highspeed`），
>    直连时必报 `unknown model 'minimax' (2013)`；
> ② 直连会**绕过网关与 Envoy 唯一出口**，丢掉审计、预算计费、密级护栏与 failover，
>    违反方案 9.3 / 4.4 与本节「RAGFlow 接入 MiniMax：走 agentgateway」的既定设计。
>
> 实测（假 key 打真链路）：网关 → Envoy → `api.minimax.cn` 全通，
> Envoy 访问日志留有 `CONNECT authority=api.minimax.cn:443 ... response=200`，
> 网关侧拿到公有云原样返回的 `401 authorized_error` —— 只差真 key。
> 涉密数据调用该模型仍被 `deny-confidential-egress` 拒绝（已实测）。

**接口等价物**（脚本化配置时用；`Authorization` 头带 RAGFlow 的签名令牌，不带 `Bearer `）：

```bash
# ① 取 RAGFlow 令牌（Keycloak SSO；只打印令牌本身，可直接 $(...) 捕获）
TOKEN=$(sudo -n python3 scripts/ragflow-sso.py token --user eap-admin --password EapAdmin@2026)

# ② 添加模型（字段名是 api_base，不是 base_url）
curl -s -X POST http://127.0.0.1:8095/v1/llm/add_llm \
  -H "Authorization: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"llm_factory":"OpenAI-API-Compatible","api_key":"eap-dbgpt-local-key",
       "llm_name":"smart-model","model_type":"chat","max_tokens":32768,
       "api_base":"http://172.17.0.1:8080/v1"}'
# {"code":0,"data":true,"message":"success"}
```

> 令牌**不带 `Bearer ` 前缀**（RAGFlow 用 itsdangerous 直接解 Authorization 头）；
> `body` 里也不能放 `data` 字段。

**四个实测踩过的坑**：

1. `api_base` 写成 `base_url` → 报 `ValueError('url cannot be None')`。
   `add_llm` 读的是 `api_base`（`llm_app.py`），而 `set_api_key` 那些接口读 `base_url`，两边不统一。
2. 漏 `max_tokens` → 报 `Column 'max_tokens' cannot be null`（`tenant_llm.max_tokens` 非空）。
3. `llm_name` 会被自动追加 `___OpenAI-API` 后缀存库（发请求时再剥掉），
   所以库里是 `smart-model___OpenAI-API`，引用时写
   `smart-model___OpenAI-API@OpenAI-API-Compatible`。
4. `add_llm` **会先发一次真实对话**再落库（"Hello! How are you doing!"），
   所以它同时是连通性校验 —— 返回 `code:0` 就说明网关 → Envoy → MiniMax 全通。

**租户隔离提醒**：RAGFlow 每个用户一个租户。演示知识库（`EAP知识库`）在
`eap-admin@eap.local` 的租户下，而 SSO 账号（`eap-admin@example.com` 等）各有自己的租户，
**跨租户绑不了知识库** —— 要让 SSO 用户用自己的知识库问答，得先在该用户租户下建库。

**验收**：RAGFlow 侧 provider 代码直连实测返回真实回答（差旅住宿标准）；
浏览器在「聊天」页点开助理 → 输入提问 → 拿到 MiniMax 的真实回答，全程无 4xx。

> **只在提问时换模型的办法**（不改助理默认配置，也不新建助理）：
> `POST /v1/conversation/completion` 的请求体里带 `llm_id` 字段即可覆盖本次会话的模型，
> 形如 `{"conversation_id": "...", "llm_id": "minimax___OpenAI-API@OpenAI-API-Compatible",
> "messages": [...]}`。后端会校验该 `llm_id` 属于助理所在租户，校验不过报
> `Cannot use specified model <id>`。这比新建一个助理去试模型轻量得多。
>
> 建会话要用 Web 令牌（`Authorization` 响应头里那串签名），**不能**用 SDK 的
> `Bearer ragflow-xxx`：SDK 的 `POST /api/v1/chats` 建的会话在 `/v1/conversation/completion`
> 里查不到（报 `Conversation not found!`），因为后者要的是绑了 `dialog_id` 的会话。

#### (8) 批量给所有账号配模型：`scripts/config-ragflow-models.py`

RAGFlow 每个用户一个租户，模型是**按租户**配置的，所以每个账号都要配一遍。
脚本一次配齐 5 个账号（4 个 Keycloak SSO 账号 + 1 个本地账号）：

```bash
sudo -n python3 scripts/config-ragflow-models.py                 # 全部账号
sudo -n python3 scripts/config-ragflow-models.py --only eap-ops  # 只配一个；未匹配会报错
sudo -n python3 scripts/config-ragflow-models.py --seed-kb       # 给无库的租户建演示知识库
sudo -n python3 scripts/config-ragflow-models.py --refresh-models # 强制重新探测并更新模型凭证
sudo -n python3 scripts/config-ragflow-models.py --update-assistant # 显式更新已有助理
sudo -n python3 scripts/config-ragflow-models.py --clean-drafts  # 顺手删空草稿助理
```

> 知识库是**按租户**的：SSO 账号各有自己的租户，看不到本地账号的库。
> `--seed-kb` 会给没有知识库的租户建一份 `EAP知识库` 并灌入同一份演示文档
> （所以每个账号都能问出「差旅住宿标准」）。

脚本配置 4 个虚拟模型（`smart-model` / `reasoning-model` / `fast-model` / `minimax`）、补齐默认
LLM 与 Embedding，并创建缺失的「企业知识助手」。具体约束：

- 已存在且 Base URL、类型、上限一致的模型会跳过，不再重复发起真实模型探测；
  修改连接或凭证后才使用 `--refresh-models`，该选项会产生真实商业模型调用。
- LLM 与 Embedding **分别只补空缺**，所有非空的人工选择都会保留；助理也使用实际保留的 LLM。
- 任一模型配置失败会跳过该账号的默认模型与助理配置，最终以非零状态退出。
- 已有同名助理默认完全保留。`--update-assistant` 只更新模板与模型，仍保留原知识库；
  新建助理默认只绑定 `EAP知识库`，没有该库则先建成无库助理。
- 只有显式指定 `--update-assistant --bind-all-kbs` 才会把已有助理改为绑定全部知识库；
  新建时也可单用 `--bind-all-kbs`。使用前须确认这些库都允许经商业模型处理，且 Embedding 一致。

两类登录方式各走各的：SSO 账号走 `/v1/user/login/keycloak` → Keycloak 授权页 →
RAGFlow 回调 `?auth=` 令牌；本地账号 `eap-admin@eap.local` 走 `/v1/user/login`，
口令要用服务端公钥做 RSA PKCS1v1.5 加密（对 base64 后的密码再加密）。

**平台身份边界**：默认共用 `RAGFLOW_GATEWAY_KEY` 只适合本地 POC。RAGFlow 自身的租户隔离
不受影响，但网关会把所有模型调用归为同一个服务身份，无法按真实 RAGFlow 用户区分预算、
策略与审计。需要用户级治理时，在根 `.env` 给各账号配置独立凭证，并在 `AUTH_SERVICE_TOKENS`
中为每个凭证配置对应的角色、租户、部门和密级：

```bash
RAGFLOW_GATEWAY_KEY_EAP_ADMIN=<独立凭证>
RAGFLOW_GATEWAY_KEY_EAP_OPS=<独立凭证>
RAGFLOW_GATEWAY_KEY_EAP_MANAGER=<独立凭证>
RAGFLOW_GATEWAY_KEY_EAP_DEMO=<独立凭证>
RAGFLOW_GATEWAY_KEY_EAP_ADMIN_LOCAL=<独立凭证>
```

脚本同时支持进程环境变量与根 `.env`，因此经 `sudo` 执行也能读取这些配置。变更凭证后
显式执行 `--refresh-models`；否则一致的模型记录会按预期跳过，不会静默轮换密钥。

#### (9) 助理模板的两个硬约束（实测踩坑）

配好模型还不够 —— 助理的 prompt 模板决定**能不能检索到知识库**、**界面能不能提问**。

| 约束 | 现象 | 根因 |
|---|---|---|
| 参数里**只有 `knowledge` 一个** | 界面每条消息都是 `ERROR: Miss parameter: user question` | 用户问题是从 `messages` 里取的，不是参数。RAGFlow 自己的默认模板就是 `parameters:[{key:"knowledge",optional:false}]`。若把问题也声明成参数（key=`user question`），**前端不会在请求体里填这个字段**，后端校验（`dialog_service.py:395`）直接报错 |
| 没绑知识库时不能留 `{knowledge}` | 更新助理被拒：`Please remove {knowledge} in system prompt since no knowledge base / Tavily used here.` | 更新校验：没有 kb_ids 且提示里含 `{knowledge}` 直接拒绝；而非 optional 的参数又必须出现在提示里，于是无库时参数要置空 |

另外两个连带事实：

- **参数里有 `knowledge` 才会走检索**（`dialog_service.chat`：`if "knowledge" in [p["key"] ...]` 才调 retriever），
  少了它就是「绑了库但永远 0 引用」；
- **助理没绑知识库时会走 `chat_solo`**（`chat()` 开头的分支），那条路径**完全不校验参数** ——
  所以「无库助理能聊、有库助理报 Miss parameter」正是这个分叉造成的。

所以脚本按「助理实际绑定的 `kb_ids`」给两套模板：有绑定库 → 参数 `[{knowledge}]`、提示里写
`{knowledge}`；无绑定库 → 参数置空、提示里无任何占位符。

#### (10) 走 API 提问时的请求体

`POST /v1/conversation/completion` 的请求体只需要 `conversation_id` + `messages`，
问题放在 `messages` 的最后一条 user 消息里即可（与官方模板一致）：

```bash
curl -s -X POST http://127.0.0.1:8095/v1/conversation/completion \
  -H "Authorization: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"conversation_id":"<conv_id>",
       "messages":[{"role":"user","content":"差旅住宿标准是多少钱一晚？"}],
       "temperature":0.2,"max_tokens":400}'
```

只有当模板里**自定义了 knowledge 以外的参数**时，才需要在请求体顶层补一个同名字段
（值放顶层，不是放进 messages）—— 否则报 `Miss parameter: <参数名>`。

#### (11) 知识库问答被网关护栏拦下（**这是设计行为，不是配置错**）

本地账号的演示知识库 `EAP知识库` 里那份 `travel_policy.txt` 原本含一句话：

> 保密协议：**涉密**项目的文档仅限项目组内部传阅，不得通过外部邮件或公共网盘传输。

RAGFlow 检索到这段 chunk 后会把它拼进 system 提示，于是整条提示被网关的护栏
判成**涉密**（`guardrails/index.ts` 的 `CONFIDENTIAL_MARKERS` 含 `/涉密/`），
而涉密数据禁止出网调商业模型：

```
**ERROR**: Error code: 400 - {'error': {'message':
 '涉密数据强制本地闭环，禁止出网调用商业模型（见 8.1 数据分级与路由）'}}
```

这正是方案 8.1 的要求（涉密数据强制本地闭环），护栏工作正常。**问题是示例文案踩了自己的雷**
—— 那份演示制度本来是普通的差旅/年假制度，只是末尾带了一句保密条款，整段 chunk 就被判成涉密，
于是「明明绑了知识库，回答却是『知识库中未找到依据』、引用 0 条」。

**已处置**：改掉演示文档的措辞（`scripts/verify-ragflow.py` 的种子与
`scripts/config-ragflow-models.py` 的 `DEMO_DOC` 同步），不再出现机密标记：

> 保密提醒：项目类文档仅限项目组内部传阅，不得通过外部邮件或公共网盘传输。

护栏对**真正的涉密内容仍然生效**（回归实测：提示里含「涉密」二字 → 依旧被拦）。

如果将来接入确实涉密的知识，正确的做法有三条：

1. **知识确实涉密** → 该助理必须用**本地**模型（网关的 `local` / `vllm` / `ollama`
   provider）。当前部署里本地只有 TEI（**仅嵌入，无对话**），所以本地对话闭环
   还差一个可用的本地推理服务 —— 平台目前对涉密对话是「安全但不可用」。
2. **知识并不涉密**（只是示例文案里带了「涉密」二字）→ 调整该文档措辞，
   护栏仍然对真正的涉密内容生效。
3. 知识库按密级拆分：普通制度放可出网的库，涉密制度走本地模型 + 涉密库。

> ⚠️ 写演示/测试数据时避开 `绝密 / 机密 / 涉密 / TOP SECRET / CONFIDENTIAL / 内部 秘密`
> 这几个标记，否则检索链路会被护栏整段拦下，而且现象极具迷惑性
> —— 表现是「检索 0 条、回答『未找到依据』」，而不是一个明确的报错。

#### (12) 模型、厂商与账号 Key 在控制台管理

「模型与路由」仅对 `admin` / `platform-admin` 显示。列表中的「系统缺省」徽标对应
`AGENT_DEFAULT_MODEL`（默认 `smart-model`）；未显式传模型名时，Agent 与网关都使用该虚拟模型。
默认模型不能禁用或删除。更换默认模型时，在根 `.env` 或 Compose 的同名变量中设置目标虚拟模型名；
Helm 使用 `appLayer.agentCore.defaultModel`，模板会同步注入 Agent 与网关。配置变更后重启相关服务。

非默认模型可在列表右侧点「删除」，二次确认后生效并写入审计；仍被租户白名单引用时返回 409，
不会被误删。新增、编辑和启停模型不修改默认模型设置。

独立的「厂商接入与凭证」页面支持两类来源：内置 Provider 沿用环境变量；
自定义 Provider 直接点「新增厂商」，选择 OpenAI / Anthropic 兼容协议，填写 BASE_URL、
认证方式和账号池。保存后适配器热生效，再按账号粘贴 Key；「测试连接」仅请求 `/models`，
不生成内容。公网地址必须 HTTPS，域名还需同步加入部署侧 `EGRESS_ALLOWED_HOSTS` / Envoy
白名单；其他私有协议仍需开发适配器。

##### ① 一次性准备：配主密钥

控制台写入的凭证是**加密落库**的（AES-256-GCM），只有网关进程持有主密钥才能还原：

```bash
# 根 .env（权限 600，已在 .gitignore 里）
# 没配主密钥时控制台写入会被禁用（fail closed），已存凭证降级为不可用
EAP_CREDENTIAL_MASTER_KEY=<openssl rand -hex 32>
```

> ⚠️ 主密钥**只进 `.env`、不进版本库**。换主密钥 = 以前用控制台写入的凭证全部失效
> （会自动回落到环境变量 / OAuth 凭证文件，平台不会因此起不来）。

##### ② 在控制台配 key

浏览器打开控制台 →「管理与运维」→「厂商接入与凭证」。每家厂商卡片展示连接配置及账号池，
每个账号分别显示来源（控制台 / 环境变量 / OAuth 文件 / 未配置）和掩码（`***abcd`）。
管理员按账号粘贴 Key →「保存密钥」，需要时点「测试连接」；非管理员不显示该管理页面。
自定义厂商可编辑、启停和删除；被模型引用的厂商或账号不能删除，避免破坏现有路由。

**改完不用重启网关**：写入时网关当场刷新进程内快照，后续请求立刻用新 key
（多副本部署下最多 30s 内其他副本跟上）。

##### ③ 来源优先级与回落

```
控制台(DB)  >  环境变量  >  OAuth 凭证文件
```

控制台优先，因为它是运维显式表达的「这把 key 现在作数」。
点「删除密钥」会删掉该账号的控制台凭证；存在下级来源时自动回落，没有下级来源时显示为未配置。

##### ④ 命令行等价操作（自动化 / 排障用）

```bash
# 取管理员令牌（Keycloak 真实账号）
TOKEN=$(curl -s -X POST http://127.0.0.1:8082/realms/enterprise/protocol/openid-connect/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=password' -d 'client_id=eap-webui' \
  -d 'username=eap-admin' -d 'password=EapAdmin@2026' |
  python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')

# 读凭证视图（只含掩码）
curl -s http://127.0.0.1:8080/v1/admin/providers -H "Authorization: Bearer $TOKEN"

# 写 key（立刻生效）
curl -s -X PUT http://127.0.0.1:8080/v1/admin/providers/minimax-public \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"apiKey":"sk-xxx"}'

# 删除（回落到环境变量 / OAuth 凭证文件）
curl -s -X DELETE http://127.0.0.1:8080/v1/admin/providers/minimax-public \
  -H "Authorization: Bearer $TOKEN"
```

##### ⑤ 验收

```bash
bash scripts/verify-provider-credentials.sh
```

覆盖 17 项：掩码不回传明文、普通用户只读、管理员能写、**不重启即生效**、
库里是密文、审计里只有掩码、删除后回落。

##### ⑥ 边界说明（这几条是刻意设计的，别绕过去）

- **地址（BASE_URL）不在控制台改**：地址决定请求发往哪个厂商域名，改地址要同步改
  Envoy 的 SNI 出网白名单并重建 Envoy（见 `docs/egress-proxy.md`），那是变更不是配置。
- **主密钥没配就禁写**：宁可写不进去，也不要明文落库。
- **审计只记掩码**：`provider.credential.set` / `.delete` 事件里没有明文 key。
- **组件边界不变**：厂商 key 仍然只有网关进程可见；
  RAGFlow / DB-GPT 一律拿网关的服务间令牌，业务组件依旧拿不到厂商 key（见 4.4 / 8.5）。


## 9.2 部署形态

| 阶段 | 形态 | 本项目对应 |
|---|---|---|
| POC | 单机 Docker Compose | 完整实测为 `docker-compose.yml` + 重型 overlay 承载依赖、宿主脚本运行平台；基础 Compose 仅为编排基线 |
| 生产 | K8s（或 K3s）+ Helm，组件按层分 namespace | `deploy/helm/` |
| 离线环境 | Harbor 镜像仓 + 内网 TEI 模型仓 | `deploy/helm/templates/harbor.yaml` + `deploy/compose/README.md` |

配置纳管到企业现有 Git 仓库，不建独立 GitOps 流水线（方案 3.2 排除 ArgoCD + Gitea）。
发布手动执行 `helm upgrade` / `compose` 重启，变更记录写文档，回滚保留上一版 values。

## 9.3 网络要求

```
内网互通：AgentScope ↔ agentgateway ↔ RAGFlow/Infinity/DB-GPT/TEI ↔ 数据源
出网白名单：各商业 API 域名（经出网代理）
禁止：业务组件直连商业 API（必须过网关 + 代理）
```

本项目在网关内实现了 `assertEgressAllowed()`，从代码层保证「业务组件直连商业 API」不可能发生 ——
Agent Core 与 MCP Hub 的出网代码路径只有经网关一条。

## 9.4 关键部署参数

| 组件 | 参数 |
|---|---|
| RAGFlow | `docker/.env` 中 `DOC_ENGINE=infinity`；Infinity 数据目录挂载持久卷 |
| PG | 3 副本 + 流复制（生产） |
| agentgateway | 2 副本 + PDB；Gateway API CRD v1.5（K8s 模式） |
| MinIO | 开启版本化 |
| 网关 | 内置 metrics 端点（`GET /metrics`），不建常驻监控栈 |

### 9.4.1 身份相关必配项（生产）

| 变量 | 说明 |
|---|---|
| `AUTH_DEV_MODE` | 生产必须 `false`。为 `true` 时网关会放行本地 HS256 自签令牌，等于关闭鉴权 |
| `KEYCLOAK_BASE_URL` / `KEYCLOAK_REALM` | 服务间（后端 → Keycloak）的 realm 地址。容器内由 compose 覆盖成 `http://keycloak:8080` |
| `KEYCLOAK_ISSUER` | **允许的 issuer 列表（逗号分隔）**。Keycloak 按**请求 Host 头**生成 `iss`，同一 realm 在不同入口签出的 `iss` 不同：本机 `…127.0.0.1:8082…`、公网 `…<公网IP>:8082…`、容器网络内 `…keycloak:8080…`。**漏掉任何一个，对应入口的令牌都会被判 issuer 不匹配而 401** |
| `KEYCLOAK_PUBLIC_URL` | **浏览器可达**的 Keycloak 地址。控制台 OIDC 授权跳转用它，与服务间用的 `KEYCLOAK_BASE_URL` 不同（容器内地址对浏览器不可达）。支持 `{host}` 占位 —— 运行时按用户实际访问的入口替换主机名（`x-forwarded-host` 优先），一份配置同时适配本机与公网 |
| `KEYCLOAK_JWKS_URI` | 拉 JWKS 的地址。可与 issuer 分离，用于「issuer 是公网地址、但 JWKS 只从内网拉」的部署 |
| `KEYCLOAK_WEB_CLIENT_ID` / `KEYCLOAK_WEB_SCOPE` | 控制台 OIDC 客户端（公开客户端，无密钥）与请求的 scope，必须含 `openid` |
| `KEYCLOAK_SERVICE_CLIENT_ID` / `KEYCLOAK_SERVICE_CLIENT_SECRET` | 组件间机器对机器调用（MCP Hub 回调网关做 Text2SQL）用。缺配时内部回调会被网关 401，表现为「ChatBI 自然语言查数失败」 |
| `EGRESS_ALLOWED_HOSTS` | 网关出网白名单（商业 API 域名），配合出网代理收口 |
| `VITE_GATEWAY_URL` / `VITE_AGENT_URL` | 控制台后端地址。**默认留空 = 同源相对路径**（由 vite preview 的 proxy / 生产 Nginx / Envoy 反代）。写死绝对地址会让公网用户去连「自己电脑的 127.0.0.1」 |

服务账号客户端（默认 `eap-agent`）的 secret 只存在于环境变量 / K8s Secret，不进镜像、不进代码库。

**控制台回调地址**：Keycloak 客户端 `eap-webui` 的 `redirectUris` 需登记控制台地址
（本地 `http://127.0.0.1:5173/*`）。生产环境换成控制台域名后，
realm 里的 `redirectUris` 与 `webOrigins` 都要同步更新，否则换令牌会被 CORS 拒绝。

### 9.4.2 数据出网分级配置

网关把推理目标分为 `local`（内网本地推理，数据不出域）与 `external`（商业 API 出网）两级：

- `TEI` 等本地 provider → `local`
- `minimax` / `openai` / `deepseek` / `qwen` / `zhipu` → `external`
- 涉密主体（`sensitivity=confidential`）只允许 `local`；商业目标在**策略层**被拒、在**护栏层**被拦、Failover 时被跳过
- 未声明时按 `external` 保守处理

新增本地 provider 时记得同步 `packages/gateway/src/llm/providers.ts` 的 `LOCAL_PROVIDERS` 集合，
否则涉密流量会被误判为出网而全部拒绝。

---

## 10. 实施计划与本项目完成度

| 阶段 | 周期 | 方案内容 | 本项目状态 |
|---|---|---|---|
| P1 平台跑通 | 2 周 | AgentScope + RAGFlow(Infinity) + agentgateway + TEI + 商业 API，接 1 个文档源 | ✅ 网关/内核/鉴权/文档检索已跑通；RAGFlow/TEI 为等价本地实现 |
| P2 数据自助分析 | 2 周 | DB-GPT MCP 接入，配置 1–2 个核心数据源，口径字典 v1 | ✅ Text2SQL + 只读沙箱 + 口径字典已跑通 |
| P3 身份与业务系统 | 1–2 周 | Keycloak SSO + 鉴权中间件 + OA/ERP MCP 封装 3–5 个高频工具 | ✅ 鉴权中间件 + 业务 MCP（4 个工具）已跑通；Keycloak 已容器化并完成 OIDC 浏览器验收 |
| P4 安全加固 | 1 周 | 出网代理 + 网关内置脱敏规则调优 + 审计日志 + 数据分级路由 | ✅ 护栏/脱敏/注入检测/审计/分级路由全部落地并有测试；Envoy 编排已交付 |
| P5 生产化 | 1 周 | K8s 化 + Langfuse 成本报表 + 健康检查 + 轻量备份脚本 | ✅ Helm Chart + OTel→Langfuse + 健康检查已交付 |
| P6 扩展 | 按需 | 多租户后台、更多数据源、Dify 工作流 | 🟡 单租户 + 部门隔离已实现，多租户数据结构已就绪 |

### 里程碑验收标准（方案第 10 章）与验证方式

| 里程碑 | 验收标准 | 验证方式 |
|---|---|---|
| P1 | 文档问答准确率抽检 85%+，端到端响应 10s 以内 | `POST /api/chat` 实测；检索命中见 `tests/knowledge.test.ts` |
| P2 | Top 10 高频查询问题 SQL/图表正确率 80%+ | `chatbi.query` 实测；口径一致性见 `METRIC_DICTIONARY` |
| P4 | PII 脱敏回归测试用例全通过，审计日志可还原任一次调用 | `tests/guardrails.test.ts`（15 用例）；`GET /v1/admin/audit/:traceId` |

---

## 11. 运维保障

### 11.1 监控分层

| 观测对象 | 手段 |
|---|---|
| LLM 调用层 | Langfuse Trace / 延迟 / Token / 成本 / 错误率 |
| 组件健康 | K8s 探针 / Docker restart 策略 |
| RAGFlow / Infinity | 自带管理页，人工巡检解析队列积压与检索状态 |
| DB-GPT | 自带管理页，巡检数据源连接与沙箱状态 |
| 网关 | 内置 `GET /metrics`，临时抓取排查，不建常驻监控栈 |

告警降级：核心兜底是 agentgateway 的 Failover 链自动切换，模型故障不中断服务；
辅助手段是关键日志（磁盘、PG 连接、429 频率）用轻量 cron 脚本巡检 + 企业微信/钉钉 webhook 通知。

### 11.2 成本管理

- Langfuse 按租户 / 部门 / 应用 / 模型出 Token 与金额报表
- agentgateway 预算硬上限 + 月度对账（与 Provider 账单核对计价口径）
- 上下文压缩：RAG 检索 Top-K 控制在 3–5 个 Chunk（`AGENT_RAG_TOP_K`，默认 5）
- 计价表可用 `PRICING_JSON` 覆盖，默认值见 `packages/gateway/src/llm/pricing.ts`

### 11.3 数据保护

| 对象 | 手段 |
|---|---|
| PostgreSQL | crontab 每日 pg_dump → 存 MinIO，保留 7 份滚动 |
| MinIO | 开启版本化，防误删 |
| Infinity | 数据目录每日打包备份到 MinIO（替代原 ES 快照） |
| 恢复演练 | 半年一次，验证 pg_dump 与 Infinity 目录恢复可用 |

轻量模式的元数据默认在 SQLite，可用 `cp data/platform.db` 做离线备份；完整本机验证模式
按根 README 切换到 PostgreSQL。当前定时 `pg_dump`、Infinity 目录备份和恢复演练尚未完整交付，
上表是方案目标，不是已交付能力；生产启用前必须补齐并实际演练。

### 11.4 变更与发布

配置文件（Helm values / compose / 网关策略）纳管到企业现有 Git 仓库；
发布流程手动执行，变更记录写文档；回滚保留上一版 values 文件，一条命令回退。

---

## 运维命令速查

```bash
# —— 平台服务启停 ——
./scripts/start-all.sh start | stop

# —— 网络收口检查（应全部为 127.0.0.1）——
ss -tln | awk 'NR>1{split($4,a,":");p=a[length(a)];ad=substr($4,1,length($4)-length(p)-1);
  if(p+0>=1000&&ad!="127.0.0.1"&&ad!="[::1]"&&ad!="172.17.0.1") print p,ad}'
# 回环桥（容器 → 宿主，仅本机与本机容器可达）
tail -f data/logs/loopback-bridge.log

# —— 重型组件栈启停（与平台服务隔离，容器前缀 eapheavy-）——
./scripts/start-heavy.sh start        # keycloak langfuse-worker/web clickhouse infinity tei
./scripts/start-heavy.sh start ragflow db-gpt   # 追加大体积组件
./scripts/start-heavy.sh status
./scripts/start-heavy.sh logs keycloak
./scripts/verify-heavy.sh             # 逐项实测重型组件是否真的可用

# —— 离线镜像仓 Harbor（eapheavy-harbor-*，端口 8098）——
python3 scripts/download_harbor.py /tmp/harbor-offline-installer.tgz v2.15.5
./scripts/start-harbor.sh start
./scripts/verify-harbor.sh           # 真实 push + 删除 + pull 拉回

# 查看日志
tail -f data/logs/gateway.log
tail -f data/logs/agent-core.log
tail -f data/logs/mcp-hub.log

# 健康检查
curl -s http://127.0.0.1:8080/healthz
curl -s http://127.0.0.1:8090/healthz
curl -s http://127.0.0.1:8080/v1/mcp/health -H "Authorization: Bearer $TOKEN"

# 网关指标
curl -s http://127.0.0.1:8080/metrics -H "Authorization: Bearer $TOKEN"

# 构建与测试
npm run build
npm test

# 控制台登录端到端（真实浏览器跑完整 OIDC 授权码 + PKCE）
npx playwright install chromium          # 首次
node scripts/verify-console-login.mjs

# 控制台流式对话端到端（AG-UI 标准事件流，真模型 + 真工具）
node scripts/verify-console-stream.mjs
PUB_IP=203.0.113.10   # 文档保留示例地址，执行前必须替换
node scripts/verify-console-stream.mjs "http://$PUB_IP:5173"

# 公网明文 HTTP 访问专用：非安全上下文下 PKCE 仍可完成授权跳转
# （crypto.subtle 不可用时退回纯 JS SHA-256，见 docs/access.md 6.7）
node scripts/verify-secure-context-pkce.mjs "http://$PUB_IP:5173"

# Keycloak realm 管理（scope / 用户 / 客户端）
python3 scripts/keycloak-admin.py scopes enterprise
python3 scripts/keycloak-admin.py users enterprise

# 开发令牌（AUTH_DEV_MODE=false 时需改用 Keycloak 真实令牌）
npx tsx scripts/issue-token.ts admin t-default dept-general internal

# Keycloak 真实令牌（本地开发账号，见 deploy/compose/keycloak/realm-eap.json）
curl -s -X POST http://127.0.0.1:8082/realms/enterprise/protocol/openid-connect/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=password' -d 'client_id=eap-webui' \
  -d 'username=eap-admin' -d 'password=EapAdmin@2026'

# 服务账号令牌（组件间机器对机器调用，MCP Hub 回调网关用）
curl -s -X POST http://127.0.0.1:8082/realms/enterprise/protocol/openid-connect/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=client_credentials' -d 'client_id=eap-agent' \
  -d 'client_secret=eap-agent-local-secret-2026'
```

### 本地开发账号（Keycloak realm `enterprise`）

| 用户名 | 口令 | 平台角色 | 部门 | 密级 | 用途 |
|---|---|---|---|---|---|
| `eap-admin` | `EapAdmin@2026` | platform-admin | dept-platform | confidential | 涉密主体，验证「涉密不得出网」 |
| `eap-ops` | `EapOps@2026` | platform-admin | dept-general | internal | 管理操作与常规模型调用 |
| `eap-manager` | `EapManager@2026` | manager | dept-finance | internal | 审批人 |
| `eap-demo` | `EapDemo@2026` | employee | dept-finance | internal | 普通员工（除本人审批单列表外，管理接口应 403） |

另有服务账号 `service-account-eap-agent`（客户端 `eap-agent`，client_credentials），无口令登录入口。

> 上线前必须替换这些口令，并清空 `deploy/compose/.env` 中的 `CHANGE_ME_*` 占位符。

### 换 Keycloak 管理员（kc-admin）的口令

`start-heavy.sh start` 会通过 `python3 scripts/keycloak-admin.py ensure-admin` 幂等创建并核验
永久管理员，再删除独立的临时引导账号；已有永久管理员不会因此被重置口令。直接使用
Compose 启动时需要手动执行该命令，详见[永久管理员初始化](../deploy/compose/keycloak/README.md#永久管理员初始化)。

管理员口令存在 `deploy/compose/.env` 的 `KEYCLOAK_ADMIN_PASSWORD`（该文件不入库），
被三个地方消费：`scripts/keycloak-admin.py`、`scripts/keycloak-hostname.py`、
以及 Keycloak 容器的 `KC_BOOTSTRAP_ADMIN_PASSWORD`。

**改口令必须同步 `.env`**，否则所有管理命令立刻 401
（脚本会明确提示「请同步 deploy/compose/.env 的 KEYCLOAK_ADMIN_PASSWORD」）。
完整步骤见
[deploy/compose/keycloak/README.md](../deploy/compose/keycloak/README.md#换掉管理员口令kc-admin)，
两个要点：

- **改完不用重建容器** —— `KC_BOOTSTRAP_ADMIN_PASSWORD` 只在数据卷为空首次启动时
  创建引导管理员，对已存在的用户无效。
- **改口令会让已签发的管理令牌立即失效**（Keycloak 在凭据变更时吊销管理会话）。
  连续改两次时，第二次必须用新口令重新取令牌。

### 业务账号的日常管理（改属性 / 改口令 / 启停 / 新建）

平台的租户、部门、角色、密级这四个维度**存在 Keycloak 的用户属性里**，
经 `eap-context` scope 映射成令牌 claim，网关按 claim 做隔离与出网策略。
管理命令统一走 `scripts/keycloak-admin.py`（管理员凭据取 `.env` 的
`KEYCLOAK_ADMIN` / `KEYCLOAK_ADMIN_PASSWORD`，即 master realm 的 `kc-admin`）：

```bash
# 看现状：账号、启用状态、email、四个平台属性
sudo -n python3 scripts/keycloak-admin.py users enterprise

# 改属性（role / tenant_id / dept_id / sensitivity，名字和取值都有白名单校验）
sudo -n python3 scripts/keycloak-admin.py set-attrs enterprise eap-demo \
    dept_id=dept-general role=manager

# 重置口令：只动凭据，不碰 email / 属性 / 启用状态；不给新口令则生成随机串并打印一次
sudo -n python3 scripts/keycloak-admin.py reset-password enterprise eap-demo '新口令@2026'

# 停用 / 启用（停用后登录直接 400）
sudo -n python3 scripts/keycloak-admin.py disable-user enterprise eap-demo
sudo -n python3 scripts/keycloak-admin.py enable-user  enterprise eap-demo

# 新建 / 删除（新建的账号不在 realm 文件里，重建 realm 会丢失）
sudo -n python3 scripts/keycloak-admin.py create-user enterprise zhangsan \
    --email zhangsan@example.com --attr role=employee --attr tenant_id=t-default \
    --attr dept_id=dept-finance --attr sensitivity=internal
sudo -n python3 scripts/keycloak-admin.py delete-user enterprise zhangsan

# 文件 → 运行态：把 realm-eap.json 里的定义同步进运行中的 realm（账号定义改了走这条）
sudo -n python3 scripts/keycloak-admin.py sync-users enterprise
```

**四个必须记住的约束**（都来自实测）：

| 约束 | 后果 |
|---|---|
| 用户 `PUT` 是**全量替换** | 漏传 `email` / `firstName` / `lastName` 会被清空 |
| User Profile 把 `email` / `firstName` / `lastName` 设为**必填** | 任一为空 → 「Account is not fully set up」→ **账号登不上** |
| `unmanagedAttributePolicy` 默认 `DISABLED` | 平台属性被**静默丢弃**，命令不报错但令牌里没 claim（工具会自动置 `ENABLED`） |
| claim 是**令牌签发时的快照**，access token 有效 30 分钟 | 改完属性要让用户**重新登录**才生效 |

> `unmanagedAttributePolicy` 没有写进 `realm-eap.json`（Keycloak 26 的 REST 建 realm 路径
> 带 `components` 段会 500），改成**运行时自愈**：重建 realm 后跑一次任意用户命令即恢复。
>
> 完整说明见
> [deploy/compose/keycloak/README.md](../deploy/compose/keycloak/README.md#平台业务账号的管理enterprise-realm-的-4-个账号)，
> 入口视角见 [docs/access.md](access.md#七平台业务账号的管理)。

### 运维账号与 Docker 权限

本平台**统一以 root 身份运维**：`/opt/agent` 目录属主为 `root:root`，所有服务进程
（gateway / mcp-hub / agent-core / loopback-bridge / webui）均由 root 启动，
脚本与文档中的操作命令都按 root 口径书写，不再引入额外的普通用户。

```bash
# —— 目录属主（root）
chown -R root:root /opt/agent

# —— 服务以 root 启动
cd /opt/agent && set -a && . ./.env && set +a && \
  setsid npx tsx packages/gateway/src/main.ts > data/logs/gateway.log 2>&1 < /dev/null & disown
```

root 已内置 Docker 客户端访问权限（`/var/run/docker.sock`），无需再 `usermod -aG docker`：

```bash
docker ps
```

### loopback-bridge：容器怎么访问宿主上的平台服务

平台服务（网关 8080 / MCP Hub 8091-8093）以**宿主进程**运行，且只绑 `127.0.0.1`。
而容器内的组件（如 DB-GPT）要用 `host.docker.internal:8080` 访问它们 ——
`host.docker.internal` 解析到的是 docker0 网关地址（`172.17.0.1`），
那里本来什么都没有。**loopback-bridge** 就是在 `172.17.0.1` 上建代理、
把流量转回 `127.0.0.1` 的那一环：

```bash
cd /opt/agent && set -a && . ./.env && set +a && \
  setsid npx tsx scripts/loopback-bridge.ts > data/logs/loopback-bridge.log 2>&1 < /dev/null & disown
```

`scripts/start-all.sh` 会自动拉起它。

**它挂了会是什么症状**：DB-GPT 侧报
`LLMServer Generate Error, Please CheckErrorInfo.: Connection error.` → HTTP 400，
**而网关侧日志一切正常**（网关根本没收到请求）。症状极具迷惑性，
因为错误指向 DB-GPT，真正坏的是桥。

因此 `scripts/verify-heavy.sh` 里有一条直接检查
「`172.17.0.1:8080` 是否有监听」的守卫，桥一死立刻暴露。

> ⚠ 这个进程名（`loopback-bridge`）与 `mcp-hub` 的命令行相近，
> 批量重启平台服务时容易连带误杀 —— 误杀后 DB-GPT 会突然全线 400。

`scripts/start-heavy.sh` 与 `scripts/verify-heavy.sh` 会**自动探测** Docker 访问方式：
当前用户能直接执行 `docker` 就直连，否则回退 `sudo docker`。

**凭据路径**：模型 OAuth 凭证放在 `/root/.minimax/auth/prod/cn/mcode-public/auth.json`
（`root:root` `0600`），`.env` 的 `LLM_CREDENTIAL_FILE` 指向该路径 ——
平台不依赖任何普通用户的家目录，网关进程以 root 运行时可直接读取。

> ⚠ **凭据是活文件，不能用快照副本。**
> 该文件由 MCode CLI 维护，含 `accessToken` / `refreshToken` / `expiresAtMs`，
> 轮换方式是「写临时文件再 rename」——**原子替换**。
> 因此 `/root/.minimax/auth/prod/cn/mcode-public` 必须是**目录级**软链接：
>
> ```bash
> rm -rf /root/.minimax/auth/prod/cn/mcode-public
> ln -s /home/ibox/.minimax/auth/prod/cn/mcode-public \
>       /root/.minimax/auth/prod/cn/mcode-public
> ```
>
> **文件级软链接也不行**（它会钉在旧 inode 上，不跟随 rename）；
> **复制快照更不行**。
>
> 踩过的症状：复制了 08:49 的快照，MCode CLI 在 12:21 轮换后快照即失效，
> 网关把所有 provider 判为「未配置可用凭证」，`smart-model` 的
> minimax → deepseek → openai 逐级 failover 全部失败，最终报
> 「所有 Failover 目标均失败：provider 'openai' 未配置或未连接」。
> 而这条报错**指向 openai**，真正失效的却是 minimax —— 排查时极易被带偏。
>
> 长期解法：让 MCode CLI 本身以 root 运行，凭据就会自然落在
> `/root/.minimax` 下，届时不再需要这个链接。

> **关于 `/tmp` 的 sticky 位**：`/tmp` 是 `1777`，即便进程是 root，
> 也**不能 truncate** 别人拥有的文件（只能删除）。因此浏览器验收脚本的截图
> 必须由同一个用户创建 —— 全程用 root 跑即可，避免出现
> `EACCES: permission denied, open '/tmp/xxx.png'`。
> Playwright 浏览器缓存相应地放在 `/root/.cache/ms-playwright`。

#### 切到 root 时踩到的两个坑

**坑一：`chown -R root:root /opt/agent` 会打断容器的权限模型。**

Harbor 的数据目录是 bind mount 进容器的，而容器**不以 root 运行**：

| 容器 | 宿主目录 | 属主 |
|---|---|---|
| core / registry / jobservice / log / portal | `data/harbor/data/{registry,job_logs,ca_download,secret}` | `10000:10000` |
| db / redis | `data/harbor/data/{database,redis}` | `999:999` |

一旦被 `chown -R root:root` 改成 root，容器里的 postgres（uid 999）就**启动不了**
（PGDATA 权限校验失败），`harbor-db` / `harbor-redis` 直接 unhealthy，
连带 Harbor 验收从 21 项掉到 11 项。

**正确做法**：整目录归 root 时要**排除容器数据目录**：

```bash
chown -R root:root /opt/agent
# —— 立刻把容器数据目录的属主还回去
W=/opt/agent/data/harbor
chown -R 10000:10000 "$W/data/registry" "$W/data/job_logs" "$W/data/ca_download" "$W/data/secret"
chown -R 999:999    "$W/data/database" "$W/data/redis"
chmod -R o+rX "$W/harbor/common"; chmod 755 "$W/data"
```

（`scripts/start-harbor.sh` 启动时本来就会做这套修正；属主被改坏后
重启 `harbor-db` / `harbor-redis` 容器即可恢复。）

其余 bind mount 在 `deploy/compose/docker-compose*.yml` 里**全是 `:ro` 只读挂配置**，
归 root 完全没问题；平台栈的 PG / Redis / MinIO 用的是 named volume
（`eap-pg-data` / `eap-redis-data` / `eap-minio-data`），也不受宿主属主影响。

**坑二：`/tmp` 是 sticky 位目录，换用户后写固定路径会 EACCES。**

`/tmp` 是 `1777`（sticky）。即便进程是 root、有完整 capabilities，
也**不能 truncate** 别人拥有的文件（只能删除、不能覆盖写）。
所以上一次用普通用户跑过验收后，改用 root 再跑就会报：

```
EACCES: permission denied, open '/tmp/console-stream-1-empty.png'
```

验收脚本已就此加固：Harbor 的 push/pull 日志改用 `mktemp` 生成唯一名，
四个浏览器验收脚本在开始前先清掉本项目前缀的旧截图。
**根治办法仍是全程用同一个用户（root）跑验收。**

### 重型组件运维：RAGFlow / DB-GPT

```bash
# 启停（默认服务集已含 ragflow / db-gpt / mysql / infinity-ragflow）
./scripts/start-heavy.sh start ragflow db-gpt
./scripts/start-heavy.sh status
./scripts/start-heavy.sh logs ragflow

# 单独跑功能验收
python3 scripts/verify-ragflow.py     # 端到端 10 项
bash scripts/verify-ragflow-logout.sh # 登出链路 19 项（含真实免密与缺失 id_token 分支）
python3 scripts/verify-dbgpt.py       # 端到端 19 项（API + Web + MCP Server + MCP 客户端）
python3 scripts/ragflow-sso.py verify  # RAGFlow ↔ Keycloak 账号打通（SSO 渠道/建号/提权）
bash scripts/verify-provider-credentials.sh # 厂商凭证管理 17 项（掩码/权限/不重启即生效/密文落库）

# 全量验收（含 RAGFlow / DB-GPT / Harbor / 出网代理等节，当前 61 项）
set -a && . ./.env && set +a && ./scripts/verify-heavy.sh
```

> **验收脚本要串行跑，不要并发**。实测并发执行 `e2e-check.sh` 与 `verify-heavy.sh` 时，
> 两者会同时对同一个 Keycloak 账号（`eap-admin`）发起 password grant，
> enterprise realm 的防爆破保护（`bruteForceProtected=true`）在并发下会出现
> 计数错乱，随机报 `invalid_grant / Invalid user credentials`，
> 表现为某一侧凭空少 2 项 —— 这是**脚本互相抢**导致的偶发，不是功能回归。
> 单独跑两个脚本都是满过（e2e-check 42 项、verify-heavy 64 项）。

| 组件 | 宿主端口 | 容器名 | 关键依赖 |
|---|---|---|---|
| RAGFlow API / Web | 9380 / 8095 | `eapheavy-ragflow` | mysql、infinity-ragflow、tei |
| RAGFlow 元数据库 | 3307 | `eapheavy-mysql` | — |
| RAGFlow 专用 Infinity | 容器内 23817/23820 | `eapheavy-infinity-ragflow` | — |
| DB-GPT 模型 API Server | 8094 | `eapheavy-dbgpt` | postgres、agentgateway |
| DB-GPT Web Server | 8096 | `eapheavy-dbgpt` | postgres、agentgateway |
| DB-GPT MCP Server（适配器） | 8097 | `eapheavy-dbgpt` | DB-GPT 自身 |

DB-GPT 容器内四个进程：`controller`（8000）、`worker`（8001）、`apiserver`（8092）、
`webserver`（8093）+ MCP Server 适配器（8094）。日志分别在 `/app/logs/` 下的
`controller.log` / `worker.log` / `webserver.log` / `mcp_adapter.log` / `init_db.log`。

**DB-GPT 踩坑要点（均为实测踩中，非推测）：**

0. **0.9.x 从未发布** —— Docker Hub 56 个标签最高 `v0.8.3`、PyPI 最高 0.8.2、
   GitHub（`eosphoros-ai/DB-GPT`，注意组织名带连字符）56 个 tag 最高 `v0.8.3`，
   且 **main 分支版本号仍是 0.8.3、CLI 无 `mcp` 子命令**。升级不是解法。
0.1 **官方镜像缺 `psycopg2`** —— webserver 元数据库用 `postgresql` 时会
   `ModuleNotFoundError: No module named 'psycopg2'`。用 `deploy/compose/dbgpt/Dockerfile`
   打补丁层装 `psycopg2-binary`（基础层复用，不重下 21GB）：
   ```bash
   docker build -t eapheavy/dbgpt:0.8.3-pg -f deploy/compose/dbgpt/Dockerfile deploy/compose/dbgpt
   ```
0.2 **非 SQLite 元数据库不会自动建表** —— DB-GPT 只对 SQLite 走 `db.create_all()`；
   postgres 分支只打印 warning 要求手工执行 `assets/schema/dbgpt.sql`，而那份脚本是 **MySQL 方言**，
   镜像里的 alembic `versions/` 也是空的 → 表建不出来，报 `relation "dbgpt_serve_flow" does not exist`。
   已用 `deploy/compose/dbgpt/init_db.py`（SQLAlchemy `create_all()`，方言无关 + 全量模型扫描导入）解决，
   实测建出 63 张表。
0.3 **`[service.web.database] type` 必须是 `postgresql`** —— 写 `postgres` 直接启动失败。
0.4 **PG 不接受 `TEXT(2147483647)`** —— DB-GPT 模型用 `Text(length=2**31-1)`（MySQL/SQLite 写法），
   需 SQLAlchemy 编译钩子渲染成 `TEXT`（已在 init_db.py 内）。
0.5 **`app.on_event("startup")` 无效** —— DB-GPT 的 app 设了 `lifespan_context`，
   FastAPI 会静默忽略 on_event 处理器；要用 `dbgpt.util.fastapi.register_event_handler`。
0.6 **FastMCP 默认绑 127.0.0.1:8000** —— 与 controller 端口冲突，必须显式设
   `mcp.settings.host` / `mcp.settings.port`。
0.7 **改 bind-mount 的脚本后要 `restart` 容器** —— `up -d` 不会因挂载文件内容变化而重启进程。
0.8 **DB-GPT 的 Text2SQL 生成结果有方言抖动** —— 演示数据源注册为 `db_type="sqlite"`
   （`deploy/compose/dbgpt/mcp_adapter.py`），但模型偶尔会生成 **PostgreSQL 方言**的 SQL
   （实测出现 `order_date::date < DATE '2024-12-01'`），
   SQLite 不认 `::` 转型 → `sqlite3.OperationalError: unrecognized token: ":"`，
   表现为 `chatbi.query` 偶发失败（同一份脚本单跑可通过，属模型输出不确定性而非链路故障）。
   收敛办法：在数据源描述/提示里显式声明方言，或让验收脚本对生成的 SQL 做方言校验后重试。

**RAGFlow 踩坑要点（均为实测踩中，非推测）：**

1. **Infinity 版本必须隔离** —— RAGFlow 内置 `infinity-sdk` 走**线上协议 0.6.7**，
   服务端 0.7.5 会报 `(2004, 'Expected version index: 0.7.5, connecting version: 0.6.7')`。
   RAGFlow 必须连 0.6.5 实例（`deploy/compose/ragflow/infinity_conf_v065.toml`）。
   注意该文件里的 `version = "0.6.7"` 指的是**线上协议版本索引**，不是发布版本号 ——
   写成 `"0.6.5"` 会让服务端拒绝 0.6.7 客户端，表现为 Thrift `recv_Connect` **无限阻塞不报错**
   （必须用 `py-spy dump` 抓栈才能定位）。
2. **RAGFlow 必须声明 TEI profile** —— 源码是子串匹配 `"tei-" in COMPOSE_PROFILES`，
   且 `TEI_MODEL` 必须等于 `llm` 表里 Builtin 模型的 `llm_name`（`BAAI/bge-m3`）。
3. **RAGFlow 必须设置 `HF_ENDPOINT`** —— DeepDoc 分词器需经镜像站下载（直连 huggingface.co 不可达），
   缺失时解析任务会**卡死在 progress 0.0023**。当前用 `https://hf-mirror.com`。
4. **DB-GPT 后台进程秒退** —— 重定向日志的 `/app/logs` 目录必须先 `mkdir -p`，否则 controller / worker 立即退出。
5. **端口冲突** —— DB-GPT 默认 8092 与平台 ChatBI MCP 撞车；RAGFlow Web 默认 80 是特权端口。
   分别移至 8094 / 8095。
6. **Infinity Thrift 连接池必须留够余量**（详见下方「排障」章）—— RAGFlow 每个进程会**预建**
   32 条 Thrift 连接，容器内 3 个进程合计 96 条；一旦超过 Infinity 的连接上限（默认 64），
   `task_executor`（唯一注册 Redis 消费者的进程）会**永久卡死**在握手，解析任务全部堆积。
   现已通过 `deploy/compose/ragflow/eap-entrypoint.sh` 把 `max_size` 收敛到 8（合计 24 条），
   并把 Infinity 的 `connection_pool_size` 提到 256 作为纵深防御。

**RAGFlow ↔ Keycloak 账号打通（SSO）**

RAGFlow 0.22 自带第三方登录渠道，本项目把 Keycloak 配成它的身份源：
登录页点 "Keycloak" → Keycloak 授权 → 回调 `/v1/user/oauth/callback/keycloak` →
RAGFlow 按 userinfo 的 email **自动建号**。

启用需要三个动作（缺一不可）：

```bash
# 1) 客户端进 realm（realm 文件是事实来源；已有 realm 不会因改文件自动生效）
# 管理脚本默认读取 deploy/compose/.env 的 KEYCLOAK_ADMIN / KEYCLOAK_ADMIN_PASSWORD；
# 也可用 KC_ADMIN_USER / KC_ADMIN_PASSWORD 显式覆盖。
python3 scripts/keycloak-admin.py apply-client enterprise eap-ragflow

# 2) 变量就位（deploy/compose/.env）：
#    EAP_PUBLIC_KEYCLOAK_ORIGIN   浏览器访问 Keycloak 的地址
#    EAP_PUBLIC_RAGFLOW_ORIGIN     浏览器访问 RAGFlow 的地址（同时是 SSO 回调地址）
#    RAGFLOW_OAUTH_CLIENT_ID / RAGFLOW_OAUTH_CLIENT_SECRET  与 realm 里的 eap-ragflow 一致
#    4 个都为空 → 不启用 SSO（仅本地账号）；只配一半 → 容器启动直接失败

# 3) 重启 RAGFlow 加载 oauth 配置（改 env 后必须重建容器，up -d 会因 env 变化自动 recreate）
./scripts/start-heavy.sh start ragflow
docker logs eapheavy-ragflow 2>&1 | grep eap-sso   # 打印实际生效的授权/回调地址

# 验收（幂等：管理员未提权会自动补提权）
python3 scripts/ragflow-sso.py verify
```

轮换已有 `eap-ragflow` 客户端的密钥时，不能只改 `.env`：Keycloak 与 RAGFlow 必须同步更新。
下面的命令通过 Admin REST 生成新密钥并打印到终端，然后立即把输出值填入
`deploy/compose/.env` 的 `RAGFLOW_OAUTH_CLIENT_SECRET`，再重建用到它的组件：

```bash
python3 scripts/keycloak-admin.py rotate-secret enterprise eap-ragflow
# 将上面输出的新密钥写入 deploy/compose/.env 后再执行下一条
./scripts/start-heavy.sh start ragflow keycloak
```

> **两个容器都要重建**：RAGFlow 侧要用新密钥（env 变更 → 重建）；
> Keycloak 侧也要重建，让容器的环境变量与 `.env` 保持一致 —— 否则将来
> realm 被重新导入时（见 9.4.3），会用容器里的**旧**环境变量写回旧密钥，
> 与 `.env`、与 RAGFlow 侧对不上，表现为「SSO 突然全挂」。
> `docker compose up -d` 检测到 env 变化会自动重建；`docker restart` 不会。

生成新密钥后旧密钥立即失效，因此上述步骤之间存在短暂的 SSO 登录中断。`apply-client`
只负责创建客户端或更新非密属性，并会先核对已有客户端密钥；发现不一致时直接退出。
初始 realm 导入仍从同一个 `.env` 变量取得密钥，不要把轮换后的值写回 realm 文件。

> **管理凭据的变量名不要混用**：
> - `KC_ADMIN_USER` / `KC_ADMIN_PASSWORD`（`scripts/keycloak-admin.py`）= **master realm**
>   的系统管理员，与 `deploy/compose/.env` 的 `KEYCLOAK_ADMIN` / `KEYCLOAK_ADMIN_PASSWORD` 同源；
> - `RAGFLOW_SSO_ADMIN_USER` / `RAGFLOW_SSO_ADMIN_PWD`（`scripts/ragflow-sso.py`）=
>   **enterprise realm** 的演示管理员。
>
> 两者属于不同 realm，混用会直接认证失败。master realm 的管理员是独立的
> `kc-admin`（永久管理员，已删除临时引导管理员），与 enterprise 的 `eap-admin`
> **不同名**——浏览器密码管理器不会再把两个站点匹配到同一份凭据。
> `scripts/ragflow-sso.py` 仍兼容旧的 `KC_ADMIN_USER` / `KC_ADMIN_PWD`，但会打印弃用提示。

要点：

- **Keycloak 客户端的 `redirect_uri` 必须与 RAGFlow 侧配置的完全一致**，
  否则 Keycloak 直接 `invalid_redirect_uri`；
- **浏览器侧与后端侧必须同 Host** —— Keycloak 动态 hostname 下令牌 `iss` 跟随签发时的
  请求 Host，后端侧若换成容器内 `keycloak:8080`，userinfo 会 401（详见 `docs/access.md` 6.8）；
- **登录页会被 Keycloak 接管** —— nginx 把 `/login` 拦到 `/login-sso.html`（中文说明页 +
  兜底链接）再跳 Keycloak；`/login?local=1` 保留 RAGFlow 原生的本地账号表单。
  片段由 `eap-entrypoint.sh` 在容器启动时生成（`/etc/nginx/sso/ragflow-sso.conf`），
  未启用 SSO 时不生成，登录页保持原样；
- **企业 SSO 登出会一并结束 Keycloak 会话**；本地账号只退出 RAGFlow，不修改企业 SSO。
  后端补丁 `deploy/compose/ragflow/eap-patch-sso-logout.py` 固定 LocalProxy 背后的 ORM 用户对象，
  确保 `INVALID_...` token 真正落库（旧 token 请求返回业务码 401）；OAuth 回调时写
  HttpOnly Cookie `eap_kc_id_token`，登出时按渠道写 `eap_sso_logout=keycloak|password`。
  nginx 对企业 SSO 跳 `end_session`：有 `id_token_hint` 时静默结束；缺失时进入 Keycloak
  确认页，用户确认后才回 `/logout-done.html`，不会提前展示成功。端到端验收：
  `./scripts/verify-ragflow-logout.sh`。Cookie 为 HttpOnly + SameSite=Lax，HTTPS 对外地址自动加 `Secure`。
  控制台本地令牌不会被跨应用立即清除；已打开的控制台可能继续使用现有 token 到过期，
  下次重新 OIDC 认证才需要口令；
- **静默 `end_session` 需要 `id_token_hint`** —— 只给 `client_id` +
  `post_logout_redirect_uri` 时 Keycloak 26.0.8 会弹「Do you want to log out?」确认页，
  用户确认后才结束会话；带 `id_token_hint` 才 302 直接跳回并终止会话。
  id_token 过期不影响（`end_session` 只取 token 里的 `sid`，不校验 `exp`，实测）；
- **`post.logout.redirect.uris` 多值分隔符是 `##`** —— 逗号 / `+` / 换行都无效（返回 400
  `invalid_redirect_uri`），`##` 可以；且支持 `*` 通配（本项目登记
  `${EAP_PUBLIC_RAGFLOW_ORIGIN}/*##http://127.0.0.1:8095/*`）。
  控制台侧因为只登记了单一 origin，仍保持**不带** `post_logout_redirect_uri` 的写法；
- **改 `deploy/compose/ragflow/nginx/*.conf` 后要重启容器** —— bind-mount 的**内容**变化
  不会触发 compose recreate，nginx 也不会重读配置（实测踩过：改完 `absolute_redirect off`
  却仍按旧配置返回绝对 Location）；
- **RAGFlow 没有提权 API** —— 用户创建接口一律 `is_superuser=False`，
  管理员由 `scripts/ragflow-sso.py promote` 直接改 `user.is_superuser`
  （与 RAGFlow 自身 `api/db/init_data.py` 建 root 账号的做法一致），改完立刻用
  `/v1/user/info` 复核；
- **本地账号保留兜底** —— `eap-admin@eap.local` / `EapAdmin@2026` 仍可登录（普通权限），
  `REGISTER_ENABLED=0` 依旧关闭自注册；
- Keycloak 的角色（platform-admin / manager / employee）**不会**自动映射到 RAGFlow，
  需要映射时在 `scripts/ragflow-sso.py` 里按 email 建规则。

**排障：RAGFlow 解析任务卡死**

```bash
# 容器已加 SYS_PTRACE；py-spy 需现装（PyPI 可达）
TASK_EXECUTOR_PID=1234   # 示例，替换为实际 task_executor 进程号
docker exec eapheavy-ragflow sh -c "/ragflow/.venv/bin/py-spy dump --pid $TASK_EXECUTOR_PID"
```

**已定位的根因（实测，非推测）：Infinity Thrift 连接数打满 → 执行器握手永久阻塞。**

完整链路：

1. `infinity-sdk` 的 `ConnectionPool.__init__` 会**预建** `max_size` 条连接，不是懒建：
   ```python
   for i in range(max_size):
       self._create_conn()
   ```
2. RAGFlow 的 `rag/utils/infinity_conn.py` 写死 `ConnectionPool(infinity_uri, max_size=32)`，
   且 `InfinityConnection` 是 `@singleton` —— 但**每个进程各自一份**单例。
3. 容器内同时跑三个会调 `init_settings()` 的进程，各自建一个连接池：
   `ragflow_server` / `sync_data_source` / **`task_executor`**。
4. 3 × 32 = **96** 条，而 Infinity 的 `client_port` 连接上限默认 **64**
   （`infinity_conf_v065.toml` 的 `connection_pool_size`）。
5. 于是前两个进程各占满 32 条（合计 64 = 上限），**第 3 个进程 `task_executor` 的首条连接
   被 accept 但服务端不再分配处理线程** → Thrift `recv_Connect` **永久阻塞**（不报错、不返回）。
6. `task_executor` 卡死在 `init_settings()`，**从未加入 Redis 消费组** →
   文档解析任务全部堆积在队列，表现为 `run=RUNNING` / `progress` 冻结在 0.009 /
   `"N tasks are ahead in the queue"`。

**为什么难发现**：HTTP API 正常、健康检查全绿、TCP 也能连 —— 唯一异常是「没有消费者」。
`verify-heavy.sh` 现在会同时查三件事（进程在 / 日志里有 `Port: 23817 is healthy` /
连接数远离上限），避免这类「看着全绿其实没干活」的回归。

```bash
# ① 执行器是否完成握手（卡在握手时这行永远不会出现）
docker exec eapheavy-ragflow sh -c \
  "grep -l 'Port: 23817 is healthy' /ragflow/logs/task_executor_*.log | tail -1"

# ② RAGFlow→Infinity 的 Thrift 连接数（补丁后应为 24；接近 256 就会再次卡死）
docker exec eapheavy-ragflow sh -c \
  'cat /proc/net/tcp | awk "NR>1 && \$4==\"01\" && \$3 ~ /:5D09$/ {c++} END{print c+0}"'

# ③ 抓阻塞栈确认（应看到 recv_Connect 阻塞在 read）
TASK_EXECUTOR_PID=1234   # 示例，替换为实际 task_executor 进程号
docker exec eapheavy-ragflow /ragflow/.venv/bin/py-spy dump --pid "$TASK_EXECUTOR_PID"
```

**修复与预防**：

- `deploy/compose/ragflow/eap-entrypoint.sh` —— 启动前把 `max_size=32` 改为 `max_size=8`；
  若上游结构变化导致替换不生效，脚本**直接退出 1**，不允许「补丁没生效但服务照常启动」。
- `deploy/compose/ragflow/infinity_conf_v065.toml` —— `connection_pool_size` 由 64 提到 256。
- **重建 RAGFlow 后必须确认连接数回落到 ~24**；若持续增长，说明上游有连接泄漏，
  需同时重启 `infinity-ragflow` 清空服务端连接。

### 服务间静态凭证（`AUTH_SERVICE_TOKENS`）

DB-GPT 的 OpenAI 代理客户端、RAGFlow 等组件无法走 OIDC 流程，需要用静态 API Key 直调网关。
网关为此开了一条服务间凭证通道（详见 `docs/api.md` 4.3）：

```bash
# .env —— 格式：<凭证>:<角色>:<租户>:<部门>:<密级>
AUTH_SERVICE_TOKENS=eap-dbgpt-local-key:employee:t-default:dept-general:internal
```

关键约束：**只解决「怎么进来」，不解决「进来之后做什么」**。服务身份与用户身份走同一条链路，
策略引擎、三级预算、护栏、审计全部照常生效；角色非法时降级 `employee`；凭证不进日志。
默认不配置即关闭。上线前须替换为正式凭证，建议由 Vault / K8s Secret 注入。

### 9.4.3 realm 文件变更的生效方式

Keycloak 的 `--import-realm` 对**已存在**的 realm 是 `IGNORE_EXISTING`，改了 `realm-eap.json` 直接重启容器**不会生效**。
正确做法：

> **删除 realm 是破坏性操作**：未写回文件的用户、角色映射和客户端变更会丢失，SSO 会话也会失效。
> 先备份 Keycloak 数据库或数据卷并确认可以重建；生产环境优先用 `sync-users` / `apply-client`
> 做增量变更，不要直接执行下面的删除命令。

```bash
# 1. 用 master realm 管理员令牌删除旧 realm
KC=http://127.0.0.1:8082
AT=$(python3 scripts/keycloak-admin.py token)
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE "$KC/admin/realms/enterprise" -H "Authorization: Bearer $AT"

# 2. 强制重建容器触发重新导入（约 60s）
#    --force-recreate 必须带：默认 `compose up -d` 只在 env 变化时才重建，
#    删完 realm 后 env 没变，不强制重建就不会重新导入。
./scripts/start-heavy.sh start --force-recreate keycloak
```

> **必须 recreate，不能只 `docker restart`**：realm 里的 `${...}` 占位符
> （`${EAP_PUBLIC_*}`、`${RAGFLOW_OAUTH_CLIENT_SECRET}`）是由 **Keycloak 容器自己的
> 环境变量**在导入时替换的。`docker restart` 只复用旧容器的环境变量快照，
> `.env` 改了也不会生效 —— 重新导入出来的 realm 会带着**旧值**（极端情况是
> 字面量占位符，表现为「登录后跳到无效地址」或「客户端密钥失效」）。
> `docker compose up -d` 会检测到 env 变化并重建容器；`--force-recreate` 是保险
> —— **删掉 realm 之后 env 没变，这时只有 `--force-recreate` 能触发重新导入**。
>
> 启动前 `scripts/start-heavy.sh` 会校验占位符：变量没设、或者有值但**没传进
> keycloak 容器**，都会直接拒绝启动。
>
> 重新导入后有两处要自己补（实测确认）：realm 文件里固化不了
> `unmanagedAttributePolicy`（建 realm 带 `components` 段会 500），导入后回到未启用，
> 此时管理 API 写平台属性会被静默丢弃 —— 跑一次任意用户命令即自动恢复；
> 客户端 `attributes` 按版本可能被丢弃，至少执行下面两条恢复控制台 PKCE 与 RAGFlow SSO 属性：
> ```bash
> python3 scripts/keycloak-admin.py apply-client enterprise eap-webui
> python3 scripts/keycloak-admin.py apply-client enterprise eap-ragflow
> ```

导入是**严格反序列化**：realm JSON 里出现任何 Keycloak 不认识的字段（如 `UserRepresentation` 不支持的 `description`）
会导致**整个 realm 导入失败**，Keycloak 直接启动失败。改完先看容器日志确认 `Realm 'enterprise' imported`。

**Keycloak 踩坑要点（均为实测踩中，非推测）：**

1. **文件导入会丢内置 client scope** —— Keycloak 26 的 `--import-realm` **文件导入路径不会种下**
   `profile` / `email` / `roles` / `web-origins` / `acr` / `basic` 等内置 scope，
   而用管理 API 创建 realm 时才会。realm JSON 里一旦声明了 `clientScopes` 数组，导入结果就只剩数组里列出的那几个。
   后果：客户端 `defaultClientScopes` 被静默裁剪、access_token 缺 `sub` / `preferred_username` /
   `realm_access`（**所有用户 user_id 塌缩成同一个值，审计无法区分操作者**）、
   请求 `scope=openid profile` 报 `Invalid scopes`。
   已修：`realm-eap.json` 显式内联全部内置 scope 定义（副本见
   `deploy/compose/keycloak/builtin-client-scopes.json`），导入后 14 个 scope 齐备。
   复核：`python3 scripts/keycloak-admin.py scopes enterprise`
2. **Keycloak 固定给认证 cookie 打 `Secure; SameSite=None`** —— 明文 HTTP 下，
   Python 的 `http.cookiejar` 不回传该 cookie，表现为登录表单提交 400 +
   日志 `error="cookie_not_found"`。真实浏览器不受影响（Chrome / Firefox 把
   `http://127.0.0.1` 视为潜在可信源），已用真实 Chromium 端到端验证通过。
3. **管理 CLI 是公开客户端** —— `admin-cli` 不能用 `client_credentials` 取令牌
   （报 `Public client not allowed to retrieve service account`），
   必须用 `grant_type=password` + master realm 管理账号。
4. **失效的 `DISPLAY` 会让无头浏览器卡死** —— 本机残留 `DISPLAY=localhost:13.0`，
   Chromium 会去连它导致合成器不出帧，Playwright 的 `screenshot()` 与 `click()` 全部卡住。
   启动浏览器时清掉 `DISPLAY` 即可。
5. **`post.logout.redirect.uris` 的多值分隔符是 `##`** —— Keycloak 26.0.8 把该属性按
   **整串**匹配，`+` / 换行 / 逗号分隔全部无效（实测三种格式都返回 400
   `invalid_redirect_uri`）；**`##` 分隔的多值有效**，且支持 `*` 通配
   （实测 `http://<host>:8095/*` 能匹配 `http://<host>:8095/logout-done.html` 并 302）。
   → RAGFlow 侧据此登记 `${EAP_PUBLIC_RAGFLOW_ORIGIN}/*##http://127.0.0.1:8095/*`，
   登出后能回跳自己的「已退出」页。
   → 控制台侧因为只登记了**单一**对外 origin，仍保持**不带** `post_logout_redirect_uri`
   的写法（只带 `client_id` + `id_token_hint`，返回 200，SSO 会话确实结束）；
   → 另一个坑：只给 `client_id` + `post_logout_redirect_uri`（没有 `id_token_hint`）时，
   Keycloak 会返回**确认页**，需要用户确认后才结束会话；要静默结束必须带 `id_token_hint`。
   因此 RAGFlow 缺少 id_token 时走确认页，不能提前跳到「已退出」成功页。
6. **变量替换只在 `--import-realm` 路径生效** —— realm JSON 里的 `${EAP_PUBLIC_WEB_ORIGIN}`
   在**启动导入**（`--import-realm`）时会被替换成实际地址（实测 Keycloak 26.0：占位符
   被替换为 `http://198.51.100.77:5173`，无残留）。但 `kcadm.sh import` / REST
   `PUT /admin/realms/{realm}` **不走**这条链，占位符原样进入 URI 校验 → Keycloak
   **直接拒绝导入**（`validateClient` 报错），属于 fail-fast，不会静默写入字面量。
   手动导入前必须先 `sed` 替换（见 `deploy/compose/keycloak/README.md`）。
7. **变量缺失时 Keycloak 保留字面量且不告警** —— 这是最阴的坑：realm 里写了
   `${EAP_PUBLIC_WEB_ORIGIN}` 但环境变量没设，导入**不报错**，客户端的 redirect URI
   里就留着占位符，表现为「控制台登录后跳到无效地址」，极难定位。
   故 `scripts/start-heavy.sh` 在拉起 Keycloak 前强制校验该变量，未设置直接拒绝启动；
   可用 `./scripts/start-heavy.sh check` 单独校验（不启停任何服务）。
8. **realm 文件导入会丢弃 client 的 `attributes`** —— `--import-realm` 与 `kcadm.sh import`
   两条路径都会丢（实测 `attributes` 为 `{}`），`post.logout.redirect.uris` /
   `pkce.code.challenge.method` 不会随文件生效。生产环境这两项是由
   `scripts/keycloak-admin.py` 的补齐流程经管理 API 写入的，不是靠 realm 文件。
   → `realm-eap.json` 里的 `attributes` 只作**事实来源**：改完必须跑
   `python3 scripts/keycloak-admin.py apply-client enterprise eap-ragflow`，
   由它经管理 API 写进运行中的 realm（`apply-client` 会读同一份文件）。
   刚导入 realm、还没跑 `apply-client` 时，`post.logout.redirect.uris` 是空的 ——
   表现为 RAGFlow 登出后 Keycloak 返回 400 `invalid_redirect_uri`。
9. **`unknown model 'minimax' (2013)` = 把虚拟模型名当成了厂商型号** —— RAGFlow 报
   `Fail to access model(OpenAI-API-Compatible/minimax)` 且错误体来自 MiniMax
   （带 `request_id`、`bad_request_error`、错误码 2013），说明请求**直连了公有云**
   （`api.minimax.cn`）而不是网关。`minimax` 是**网关的虚拟模型别名**，只有网关认识；
   公有云只认真实型号（`MiniMax-M3.1-Flash` / `MiniMax-M3` / `MiniMax-M2.7-highspeed`）。
   → 正确填法：Base URL 指网关 `http://172.17.0.1:8080/v1`、模型名填虚拟模型名；
     要用公有云账号就把公有云接成网关 provider（见上文「接入 MiniMax 公有云」），
     RAGFlow 侧模型名用 `minimax-public`。
   → 快速判别：**看错误体里有没有 `request_id`**。有 → 是厂商返回的（说明直连了厂商）；
     没有 → 是网关自己的错误（如「虚拟模型 'X' 不存在或已禁用」）。
   → 另一条同源坑：即使 Base URL 指对了网关，模型名填真实型号也一样失败 ——
     网关只认虚拟模型名，真实型号会返回 404「虚拟模型 'X' 不存在或已禁用」。
10. **RAGFlow 表单里 API Key 填错 = 网关回 401「令牌无效或已过期」** ——
    报 `Fail to access model(OpenAI-API-Compatible/xxx).**ERROR**: AUTH_ERROR - Error code: 401
    - {'error': 'invalid_token', 'message': '令牌无效或已过期'}`，
    错误体是**网关自己**的格式（不是厂商格式），说明请求**到了网关**但鉴权没过：
    表单的 API Key 填成了厂商 key，而这里必须填**网关的服务间静态凭证**
    `eap-dbgpt-local-key`（根 `.env` 的 `AUTH_SERVICE_TOKENS`）。
    → 厂商 key 只放在**网关侧**（根 `.env` 的 `MINIMAX_API_KEY` / `MINIMAX_PUBLIC_API_KEY` 等），
      业务组件永远只拿网关令牌，不接触厂商凭证。
    → 错误体形状速查：带 `request_id` = 厂商返回的（Base URL 指到了厂商）；
      不带 `request_id` 且是 `invalid_token` = 网关鉴权失败（API Key 填错）。

### 部署环境参数与公网地址占位

本仓库为**公开仓库**，不内置任何部署环境的真实公网地址 —— 那等于对外公布目标地址。
约定：

| 位置 | 写法 | 说明 |
|---|---|---|
| 文档正文 / 表格 | `<公网IP>` | 占位符，读者自行替换 |
| 命令示例 | `$PUB_IP` / `$OFFICE_CIDR` | 用文档保留地址赋值，执行前替换 |
| Keycloak realm | `${EAP_PUBLIC_WEB_ORIGIN}` | 导入 realm 时由环境变量替换 |
| 验收脚本 | `EAP_PUBLIC_IP` / `EAP_CONSOLE_URL` | 脚本从环境变量读地址 |

实际取值集中在**内部参数表** `docs/internal/host-params.local.md`
（该目录已 gitignore，不在公开仓库内），用下面这个脚本生成：

```bash
./scripts/gen-host-params.sh 203.0.113.10 198.51.100.20/32
# 上述为文档保留示例地址，执行前必须替换
```

脚本会自动探测虚拟机内网 IP（默认路由的 src）与宿主内网 IP（默认路由的 via）；
公网 IP 优先用命令行参数，其次 `EAP_PUBLIC_IP` 环境变量，最后尝试外网探测，
办公出口也可通过 `EAP_OFFICE_CIDR` 提供。脚本会校验地址并拒绝 `0.0.0.0/0`，
公网 IP 探测失败时必须显式传参。它只生成参数表，不生成防火墙规则；
转发操作统一以 `docs/host-handoff.md` 为准。

> **踩坑**：`.env` 里同一个键写两遍是**静默**的 —— 后定义覆盖先定义，
> `docker compose config` 也只看最终值，不提示你哪条被覆盖了。
> 收敛后请对比收敛前后的 `docker compose config` 输出，确认生效值没变。
> 用 `./scripts/gen-host-params.sh` 之外的方式改 `.env` 时，同样注意这一点。
>
> `deploy/compose/.env` 曾有 11 个重复键（如 `KEYCLOAK_ADMIN` 既写 `admin`
> 又写 `eap-admin`），现已收敛为每个键只出现一次。

### 服务监听地址（回环收口）

平台服务默认**只绑回环**，由四个环境变量控制，默认值均为 `127.0.0.1`：

| 变量 | 作用 | 默认 |
|---|---|---|
| `GATEWAY_HOST` | agentgateway 监听地址 | `127.0.0.1` |
| `AGENT_HOST` | agent-core 监听地址 | `127.0.0.1` |
| `MCP_HUB_HOST` | MCP Hub 三个 MCP Server 监听地址 | `127.0.0.1` |
| `WEBUI_HOST` | 控制台预览服务监听地址 | `127.0.0.1` |

> **历史坑**：这几个值原先在代码里默认 `0.0.0.0`，而 `.env.example` 里**一个 HOST 键都没有** ——
> 照文档 `cp .env.example .env` 起步的人会把网关 / agent-core / MCP Hub 绑到**所有网卡**，
> 管理面直接暴露在局域网。现已改为代码默认 `127.0.0.1`，`.env.example` 也补齐了这四项。

容器化部署不受影响：`deploy/compose/docker-compose.yml` 里 `agentgateway` / `agent-core`
显式声明 `GATEWAY_HOST=0.0.0.0`，`mcp-hub` 显式声明 `MCP_HUB_HOST=0.0.0.0`，
供同网络容器按服务名互访。**宿主进程模式不要改成 `0.0.0.0`**。

容器访问宿主服务仍走 `scripts/loopback-bridge.ts`（见下节），与监听地址无关。

### 网络收口与容器回调（见 docs/network-access.md）

平台服务与容器端口已全部收口到 `127.0.0.1`。容器（DB-GPT）仍需回调宿主的网关与 MCP Server，
靠 `scripts/loopback-bridge.ts` 在 docker 网桥 `172.17.0.1` 上转发到 `127.0.0.1`：

```bash
# 检查回环桥是否在跑
tail -5 data/logs/loopback-bridge.log
# 容器侧验证
docker exec eapheavy-dbgpt python3 -c "
import socket
s=socket.create_connection(('host.docker.internal',8080),5); s.close(); print('容器 → 宿主网关 OK')"
```

> **踩坑**：`start-all.sh` 的兜底 `pkill -f` 模式必须足够精确 ——
> 过宽的模式（如 `pkill -f loopback-bridge`）会匹配到**调用方自身的 shell**，
> 导致执行脚本的终端被自己杀掉。回环桥由 pid 文件机制回收，不需要额外的 pkill。

