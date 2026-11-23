# 官方 AgentScope 对照报告

> 生成日期：2026-11-19
> 目的：核实本平台「以 TypeScript 实现了 AgentScope Core 契约」的说法是否成立、成立到什么程度，
> 并给出「用官方实现替换自研内核」的可行性、工作量与风险结论。
>
> 结论一句话：**自研内核在企业治理维度（多租户/预算/审计/脱敏/网关强制路由）上官方无可替代品，
> 在 Agent 运行时机制维度上官方 TypeScript 版可复用约 70%——但官方 TS 版是 `0.0.15` 预 1.0，
> 且完全没有 Middleware 系统，与 PDF 3.1 明写的「ReAct + Toolkit + Middleware」不匹配。**
> 推荐路线 C：保留自研内核，对齐官方消息/事件契约。

---

## 〇、对照素材与事实基线

| 素材 | 版本 | 获取方式 | 体量 | 位置（临时） |
|---|---|---|---|---|
| AgentScope（Python 主仓） | **2.0.12** | PyPI wheel 解包 | 27 个顶层子模块 | `/tmp/as/x/agentscope/` |
| agentscope-typescript | **0.0.15** | GitHub `agentscope-ai/agentscope-typescript` | 67 个 `.ts` / **15,281 行** | `/tmp/as/repos/agentscope-typescript` |
| agentscope-studio | main | GitHub `agentscope-ai/agentscope-studio` | client 16,424 行 / 四包结构 | `/tmp/as/repos/agentscope-studio` |
| agentscope-runtime | main | GitHub `agentscope-ai/agentscope-runtime` | **72,488 行** Python | `/tmp/as/repos/agentscope-runtime` |
| 本平台自研内核 | — | 本仓库 | **770 行 / 7 文件**（6 实现 + 1 barrel） | `packages/agent-core/src/` |

npm 发布记录（`npm view @agentscope-ai/agentscope`）：版本序列 `0.0.2 … 0.0.15`，
`latest = 0.0.15`，**15 个版本全部为 0.0.x，无 1.0**。

自研内核文件明细：

| 文件 | 行数 | 职责 |
|---|---|---|
| `packages/agent-core/src/runtime.ts` | 255 | ReAct 推理循环 |
| `packages/agent-core/src/main.ts` | 157 | Service 层：会话/消息 API |
| `packages/agent-core/src/gateway-client.ts` | 137 | 网关客户端（Chat + MCP + 工具目录） |
| `packages/agent-core/src/middleware.ts` | 102 | Middleware 链（before/after/onError） |
| `packages/agent-core/src/hitl.ts` | 59 | 人工确认（HITL）审批单 |
| `packages/agent-core/src/toolkit.ts` | 55 | 工具目录与 OpenAI function schema 转换 |
| `packages/agent-core/src/index.ts` | 5 | barrel 导出 |

---

## 一、PDF 3.1 的原始要求 vs 官方实际实现

PDF 第 4 页 3.1 组件总览对 AgentScope 三行的描述是：

- **AgentScope Core**：`2.x` —— 能力 = `ReAct + Toolkit + Middleware`
- **AgentScope Service**：`官方最新` —— 多租户注册 / 会话管理 / 分布式协调
- **AgentScope Web UI**：`官方示例改造` —— 唯一用户入口

逐条核实官方实际实现：

| PDF 描述 | 官方 Python 2.0.12 | 官方 TypeScript 0.0.15 | 结论 |
|---|---|---|---|
| Core 基类是 ReAct | ❌ 基类是 `Agent`（`agent/_agent.py`，4087 行）；ReAct 拆在 `app/` 模块 | ❌ 基类 `Agent`（`agent/agent.ts`，1094 行） | PDF 的「ReAct」是**能力描述**不是类名，两者不矛盾 |
| Core 有 Toolkit | ✅ `tool/_toolkit.py`（695 行） | ✅ `tool/toolkit.ts`（616 行） | **一致** |
| Core 有 Middleware | ✅ `middleware/_base.py`（303 行，**7 个 hook**） | ❌ **整个 TS 仓无 middleware 模块** | **TS 版不满足 PDF 描述** |
| Service 多租户 | ⚠️ `app/access/_policy.py` 是「跨 owner 资源共享」策略，**owner 隔离默认拒绝跨用户访问**，非租户模型 | ❌ 无 | **官方 Service 不提供企业多租户** |
| Web UI = 官方示例改造 | `agentscope/console/` + `tui/` 是**终端形态**，非 Web | ✅ `agentscope-studio` 是真正的 Web UI（四包） | **PDF 所指「官方示例」应为 studio 仓** |

### 1.1 Python 版 Middleware 的 7 个 hook（PDF「Middleware」的真身）

`/tmp/as/x/agentscope/middleware/_base.py` 实际定义：

| hook | 签名位置 | 用途 |
|---|---|---|
| `on_reply` | :68 | 回复前 |
| `on_reasoning` | :36 / :101 | 推理前（transformer 洋葱） |
| `on_acting` | :124 | 工具执行前 |
| `on_check_permission` | :170 | 权限检查 |
| `on_model_call` | :213 | 模型调用（transformer 洋葱） |
| `on_compress_context` | :241 | 上下文压缩 |
| `on_system_prompt` | :264 | 系统提示词改写 |

采用**洋葱模型（transformer）**：`on_reasoning` 与 `on_model_call` 可包裹并改写行为。

### 1.2 官方 TypeScript 版确认无 Middleware

```
$ grep -rn "middleware" --include=*.ts src/ | grep -v "\.test\."
src/agent/agent.ts:387:  * Core reply logic without middlewares.
src/agent/agent.ts:580:  * Core reasoning logic without middlewares.
src/agent/agent.ts:708:  * Core acting logic without middlewares.
```

三处均为注释，明确说明核心逻辑「**without middlewares**」。TS 仓目录树无 `middleware/`：

```
src/{agent,event,formatter,mcp,message,model,permission,state,storage,tool,type,_utils}
```

**这是本报告最重要的一条事实**：若把内核换成官方 TypeScript 版，PDF 3.1 明写的 `Middleware` 维度会直接消失，
必须自行补齐（官方 Python 版的 7-hook 洋葱模型是唯一现成参照）。

---

## 二、逐项契约对照

### 2.1 ReAct 推理循环

| 维度 | 官方 TS 0.0.15 | 官方 Python 2.0.12 | 本平台自研 |
|---|---|---|---|
| 主入口 | `Agent.replyStream(options): AsyncGenerator<AgentEvent, Msg>`<br>`Agent.reply(options): Promise<Msg>` | `class Agent`（4087 行） | `AgentRuntime.run(opts): Promise<AgentResult>` |
| 循环结构 | `while (curIter < maxIters)`，reasoning → acting → observe | 同构 | `for (iteration = 1; iteration <= maxIterations; iteration++)` |
| 迭代上限 | `maxIters`（默认 **20**） | 有 | `maxIterations`（可配） |
| 流式 | ✅ **27 种事件类型**（`event/index.ts`） | ✅ | ❌ **仅最终结果，无流式** |
| 上下文压缩 | ✅ 内置 `compressionConfig`（阈值触发 + zod 结构化摘要 + `keepRecent`） | ✅ `on_compress_context` hook | ❌ 无 |
| 结构化输出 | ✅ `structuredModel?: z.ZodObject` | ✅ | ❌ 无 |
| Skills（SKILL.md） | ✅ `Toolkit.getSkillsPrompt()` + 内置 `Skill` 工具 | ✅ | ❌ 无 |
| 子任务 | ✅ `TaskCreate/TaskUpdate/TaskGet/TaskList` | ✅ | ❌ 无 |
| 多模态 | ✅ 内容块支持 `base64/url/data`（图像/音视频） | ✅ | ❌ **纯文本消息**（`{role, content, tool_calls}`） |
| 最大轮次收尾 | 抛 `EXCEED_MAX_ITERS` 事件 | 有 | ✅ **强制收尾**：追加「已达最大轮次，立即给结论」提示并再调一次模型 |
| 持久化 | `StorageBase`（load/save AgentState） | ✅ | ✅ 走 `MetadataStore`（PG） |

**差距集中在两点**：① 流式事件（官方有，我们无）；② 上下文压缩与多模态（官方有，我们无）。
其余（ReAct 骨架、工具调用循环、最大轮次处理）语义等价。

### 2.2 Toolkit 工具抽象

| 维度 | 官方 TS 0.0.15 | 本平台自研 | 判定 |
|---|---|---|---|
| 工具注册 | `registerToolFunction(tool)` / `registerMCPClient({client, enabledTools, disabledTools, requireUserConfirm})` | `register(spec)` / `replaceAll(specs)` | 等价 |
| 内置工具 | **11 个**：`Read/Write/Edit/Bash/Grep/Glob/TaskCreate/TaskUpdate/TaskGet/TaskList/Skill` | 0（全部来自网关目录） | 官方更全 |
| Schema 输出 | `getJSONSchemas()` → OpenAI function schema（zod → openapi-3.0） | `toFunctionSchemas()` → OpenAI function schema | **等价** |
| 入参校验 | zod `ZodObject` 或 JSON-Schema（`@cfworker/json-schema`），失败返回 `InvalidArgumentError` | **无校验**（直接透传网关） | 官方更严 |
| 工具返回 | 支持 `string / ToolResponse / Generator / AsyncGenerator`，并合并相邻 text 块 | 仅 `string` | 官方更强 |
| MCP 工具封装 | `MCPTool`（`getClient`/`releaseClient` 连接池） | 无（走网关 HTTP） | 官方更完整 |
| 工具来源 | 本地进程 + MCP 直连 | **仅网关 MCP 端点**（不直连任何 MCP Server） | **自研是安全边界，官方无此约束** |

**关键结论**：Toolkit 的**函数级契约完全等价**，官方可直接替换且不破坏语义；
但官方 Toolkit 允许「直连 MCP Server / 执行本地 shell」，与 PDF 4.1「Toolkit 的 MCP Server 地址全部指向 agentgateway」
及本平台「Agent 侧不直连 MCP Server」的安全边界**直接冲突**。替换时必须封装官方 Toolkit 而非直接使用。

### 2.3 Middleware 中间件

| 维度 | 官方 Python 2.0.12 | 官方 TS 0.0.15 | 本平台自研 |
|---|---|---|---|
| 机制 | 洋葱 / transformer，`on_reasoning` 与 `on_model_call` 可包裹改写 | **不存在** | 线性链 |
| hook 数 | **7** | 0 | 3（`before` / `after` / `onError`） |
| 顺序 | 洋葱（入栈出栈） | — | `before` 正序、`after`/`onError` 逆序（**等价于洋葱的最外层语义**） |
| 现成内置件 | `budget` / `model_router` / `rag` / `steering` / `longterm_memory` / `tracing` / `tts` | — | `metricsMiddleware`（成本与耗时统计） |

**本平台的 `middleware.ts`（102 行）实际覆盖了官方 Python 7-hook 中最关键的 `on_model_call`（横切成本/日志）语义，
但缺少 `on_check_permission` / `on_compress_context` / `on_system_prompt` 三个 hook 的等价位。
自研侧已由其他模块承担了这三件事：权限 → `auth-middleware` + `hitl.ts`；压缩 → 未实现；系统提示词 → `AGENT_SYSTEM_PROMPT` 常量。

**这是 PDF 对齐的唯一硬缺口**：自研内核的中间件维度**弱于**官方 Python 版。

### 2.4 MCP 客户端

| 维度 | 官方 TS 0.0.15 | 官方 Python 2.0.12 | 本平台自研 |
|---|---|---|---|
| 传输 | `HTTPMCPClient`（`streamable-http` / `sse`）、`StdioMCPClient`，基于 `@modelcontextprotocol/sdk` ^1.27.1 | `mcp/_mcp_client.py`（657 行） | 网关 `/v1/mcp/tools` + `/v1/mcp/call` |
| API | `connect/close/listTools/getTool` | `connect/close/list_raw_tools/list_tools/get_tool/set_runtime_headers` | `listTools()` / `callTool()` |
| 认证 | `transportOpts.requestInit` 可注入 Bearer | `set_runtime_headers` | 网关侧鉴权 + 租户过滤 |
| 直连能力 | ✅ 可直连任意 MCP Server | ✅ | ❌ **仅经网关** |

**官方 MCP 客户端可以直接指向本平台网关的 MCP 端点**（`StreamableHTTPClientTransportOptions.requestInit` 支持自定义头），
因此这一维度**可复用度最高**，且复用后不破坏「Agent 不直连 MCP Server」的边界——只要把 URL 指向网关。
唯一代价是官方实现是**在 Agent 进程内建连**，会绕过网关的审计与限流落点；本平台要求工具调用必须经网关记录，
因此**建议保留自研 `gateway-client.ts` 的调用路径，仅在需要 MCP 原生能力（stdio/多 server/连接池）时局部复用**。

### 2.5 官方 TS 版有、自研没有的能力（可复用清单）

| 模块 | 官方 TS | 说明 | 自研现状 |
|---|---|---|---|
| `message/` | 内容块模型：text / thinking / hint / tool_call / tool_result / base64 / url / data | 与 Studio 共享同一套类型 | ❌ 纯文本消息 |
| `event/` | 27 种事件类型（`REPLY_START`、`TEXT_BLOCK_DELTA`、`TOOL_CALL_*`、`TOOL_RESULT_*`、`REQUIRE_USER_CONFIRM` …） | 现成的流式前端协议 | ❌ 无流式 |
| `formatter/` | OpenAI / DashScope / DeepSeek / Ollama 四种 chat formatter | 多 provider 消息格式 | ✅ 收敛在网关 `providers.ts` |
| `model/` | `ChatModelBase`（226 行）+ `OpenAIChatModel`（343 行）+ DashScope/DeepSeek/Ollama | 官方 `OpenAIChatModel` 可直连本平台网关的 OpenAI 兼容端口 | ✅ 自研 `gateway-client.ts` |
| `tool/` | 11 个内置工具 | 文件/搜索/任务/技能 | ❌ 无 |
| `permission/` | 201 行，`PermissionMode`（DEFAULT / ACCEPT_EDITS / EXPLORE / BYPASS / DONT_ASK）+ `PermissionBehavior`（ALLOW / DENY / ASK / PASSTHROUGH）+ `bypass_immune` 语义 | 现成的细粒度工具权限引擎 | ⚠️ 只有布尔 `requiresConfirmation` |
| `storage/` | `StorageBase` 抽象 + `FileSystemStorage` | 可扩展存储后端 | ✅ 自研 `MetadataStore`（PG） |
| `state/` | `Task` / `TaskContext` | 任务状态模型 | ❌ 无 |

### 2.6 官方没有、必须保留自研的能力（治理层）

这一层是本平台与官方实现的**根本差异**，也是「不能简单换官方」的核心理由。

| 平台能力 | 官方 TS 0.0.15 | 官方 Python app 模块 | 自研位置 |
|---|---|---|---|
| **多租户隔离** | ❌ 全文无 `tenant` 概念 | ❌ 仅 owner 隔离（`access/_policy.py` 默认拒绝跨用户访问），非租户模型 | `packages/platform-core` 租户 + `auth-middleware` |
| **RBAC / Cedar 策略** | ❌ | ⚠️ 仅 READ/EDIT 两级资源权限 | `packages/platform-core` + `auth-middleware` |
| **三级预算**（租户/应用/会话） | ❌ | ⚠️ 有 `budget` middleware，但非企业三级额度 | `packages/gateway/src/llm/budget.ts` |
| **审计日志** | ❌ | ⚠️ 有 `tracing` middleware（OTL 链路），非合规审计 | `packages/platform-core` 审计存储 + 控制台审计页 |
| **数据脱敏 / PII** | ❌ | ❌ | `packages/platform-core` |
| **HITL 审批单** | ⚠️ 有 `requireUserConfirm` + `REQUIRE_USER_CONFIRM` 事件，但**无审批单持久化、无审批人、无超时** | 同 | `packages/agent-core/src/hitl.ts` + `platform-core` 审批表 |
| **网关强制路由**（模型走虚拟名、工具走网关） | ❌ Toolkit 可直连 MCP、模型可直连任意 Provider | 同 | `gateway-client.ts` + 网关 `router.ts` / `providers.ts` |
| **出网代理（Envoy）** | ❌ | ❌ | `packages/gateway/src/llm/egress.ts` + Envoy |
| **模型路由与降级** | ⚠️ `model_router` middleware（在 Python） | 有 | `packages/gateway/src/llm/router.ts` |

**官方 `agentscope-runtime`（72,488 行 Python）提供的是 Agent-as-a-Service + 工具沙箱 + 容器编排**，
其定位是「把 Agent 部署成服务」，与本平台的「企业多租户 + 预算 + 审计 + 脱敏 + 网关治理」**不是同一层东西**，
两者叠加而非替代；且引入 Python 运行时栈会与现有全 TS 平台栈割裂。

### 2.7 Web UI 组件划分

**官方 `agentscope-studio`**（四包：`client` / `server` / `app` / `shared`）：

| 划分 | 内容 |
|---|---|
| 页面（8） | `HomePage`（含 `sidebar.tsx`、`config.tsx`）、`DashboardPage`、`TracePage`、`EvalPage`、`FridayPage`、`DefaultPage`、`ContentPage` |
| 组件（6 类） | `chat` / `tables` / `spans`（链路 span 树）/ `numbers`（指标）/ `buttons` / `ui` |
| 前端基建 | `api/trpc.ts`（**tRPC**）、`context/`、`hooks/`、`i18n/`、`theme/`、`assets/` |
| 共享契约 | `shared/src/types/`：`messageForm.ts`（内容块）、`trace.ts`（Trace/Span/Attributes）、`trpc.ts`（zod 入参 schema）、`usage.ts`（token 用量） |
| 前端体量 | `client/src` 16,424 行 |

**本平台 `apps/webui/`**（React + Vite）：7 个页签 —— Chat / 审批 / 工具 / 模型 / 预算 / 审计。

| 维度 | 官方 Studio | 本平台 | 判定 |
|---|---|---|---|
| 消息渲染契约 | 内容块模型（text/thinking/tool_use/tool_result/image…） | 纯文本 + 工具调用摘要 | **官方更细粒度** |
| 链路可视化 | `TracePage` + `spans` 组件（OTel 语义） | 审计页签（合规视角） | **视角不同，可并存** |
| API 风格 | tRPC（强类型端到端） | REST（`/api/sessions` 等） | **不兼容** |
| 多租户/预算/审批 UI | ❌ 无 | ✅ 有 | **自研是必须保留的** |
| 评估 | `EvalPage` | ❌ 无 | 官方可借鉴 |
| 国际化 / 主题 | ✅ i18n + theme | 基础 | 官方可借鉴 |

**结论**：Studio 不能整体替换本平台 Web UI——它缺多租户/预算/审批/审计四大页面，且 API 风格（tRPC vs REST）不兼容。
可复用的是其**消息内容块契约**与**trace/span 可视化组件**。

---

## 三、复用决策矩阵

| 能力 | 官方 TS 0.0.15 可复用？ | 官方 Python 2.0.12 可复用？ | 决策 |
|---|---|---|---|
| ReAct 循环骨架 | ✅ 可直接替换 | ✅ | 保留自研（已等价，且与治理层耦合紧密） |
| Toolkit 工具抽象 | ✅ 函数级等价 | ✅ | **保留自研封装**（守住「不直连 MCP」边界） |
| **Middleware** | ❌ **不存在** | ✅ 7-hook 洋葱 | **必须自研补齐**（PDF 硬要求） |
| MCP 客户端 | ✅ 高 | ✅ | 局部复用（stdio/连接池场景） |
| ChatModel 适配 | ✅ `OpenAIChatModel` 可指网关 | ✅ | 保留自研 `gateway-client.ts`（需注入 traceId/sessionId） |
| 消息内容块模型 | ✅ | ✅ | **建议对齐**（为流式 + 多模态铺路） |
| 流式事件模型 | ✅ 27 事件 | ✅ | **建议对齐**（Web UI 实时输出的现成契约） |
| 内置工具（文件/搜索/任务） | ✅ 11 个 | ✅ | 按需引入 |
| 细粒度权限引擎 | ✅ 201 行 | ✅ | **建议引入**（替换布尔 `requiresConfirmation`） |
| 上下文压缩 | ✅ | ✅ | 建议引入（长会话必需） |
| 多租户 / RBAC | ❌ | ❌ | **必须自研** |
| 三级预算 / 审计 / 脱敏 | ❌ | ❌ | **必须自研** |
| HITL 审批单 | ❌ 仅事件 | ❌ 仅事件 | **必须自研** |
| 网关强制路由 / 出网代理 | ❌ | ❌ | **必须自研** |
| Web UI 整体 | ⚠️ 缺 4 个必备页签 + API 不兼容 | — | **必须自研** |
| Trace/Span 可视化 | ✅ | — | 可借鉴组件 |

---

## 四、三条替换路线的工作量评估

单位：人日（一名熟悉本仓库的 TS 工程师）。含改码 + 单测 + 回归 + 文档同步。

### 路线 A：全量换官方 Python 2.0.12

| 工作项 | 工作量 | 说明 |
|---|---|---|
| 内核重写为 Python | 25–35 | ReAct + Toolkit + Middleware 7-hook 迁移；引入 Python 运行时栈 |
| Service 层重写 | 20–30 | 官方 `app/` 模块（SessionService / SQLAlchemy storage / workspace_manager）与本平台 `platform-core` 语义冲突，需二选一 |
| 多租户/预算/审计/脱敏重建 | 30–45 | 官方无对应能力，全部按本平台语义重建 |
| HITL 审批流重建 | 10–15 | 官方只有事件回传，审批单存储/审批人/超时全要重写 |
| Web UI 协议改造 | 15–25 | REST → Python 后端 + 内容块消息模型对齐 |
| 联调 / 回归 / 文档 | 15–20 | |
| **合计** | **115–170** | 且引入 Python/TS 双栈运维成本 |

**风险**：官方 Python `app/` 本身是一套完整平台（与本平台重叠但不等价），容易演变成「两套平台并存」；
`agentscope-runtime` 再叠一层则变成三套。

### 路线 B：渐进换官方 TypeScript 0.0.15

| 工作项 | 工作量 | 说明 |
|---|---|---|
| 接入 `@agentscope-ai/agentscope` 0.0.15 | 3–5 | 依赖引入 + 类型适配 |
| 替换 ReAct 循环为官方 `Agent` | 10–15 | 语义差异（事件流、压缩、多模态块）需适配本平台消息存储 |
| **自研 Middleware 补齐**（官方 TS 无） | 10–15 | 对齐 Python 7-hook 或扩展自研 3-hook；**PDF 对齐必需项** |
| 封装官方 Toolkit（守网关边界） | 8–12 | 禁止直连 MCP / 本地 shell，需包一层代理 Toolkit |
| HITL 从布尔升级到官方 `REQUIRE_USER_CONFIRM` 事件模型 | 8–12 | 审批单持久化仍需自研 |
| 引入官方 `permission/` 替换布尔标记 | 5–8 | 五种模式 + 规则匹配 |
| 上下文压缩接入 | 3–5 | `compressionConfig` 直接可用 |
| 消息/事件契约对齐（影响 Web UI） | 8–12 | 内容块模型 + 流式事件 |
| 回归 / 文档 | 10–15 | |
| **合计** | **65–100** | |

**风险**：① `0.0.15` 为预 1.0，npm 上仅 15 个版本全为 0.0.x，**无稳定性承诺**，生产依赖需锁版本 + 自行承担回归；
② TS 版无 Middleware，PDF 对齐需自补；③ 官方 Toolkit/模型可直连外部，边界必须靠封装守住。

### 路线 C（推荐）：保留自研内核 + 官方契约对齐

| 工作项 | 工作量 | 说明 |
|---|---|---|
| 消息模型对齐官方内容块 | 5–8 | 自研 `{role, content}` → 内容块；为多模态铺路 |
| 引入官方流式事件协议 | 8–12 | `REPLY_START/TEXT_BLOCK_DELTA/TOOL_CALL_*` → SSE 到 Web UI |
| 引入官方 `permission/` 引擎 | 5–8 | 替换布尔 `requiresConfirmation` |
| 补齐 Middleware hook 语义（对齐 Python 7-hook 的关键子集） | 6–10 | 至少补 `on_check_permission` / `on_system_prompt` |
| 上下文压缩 | 3–5 | 借官方 `compressionConfig` 思路自研（需接本平台会话存储） |
| 文档同步（component-mapping / operations） | 2–3 | |
| **合计** | **29–46** | |

**路线 C 的收益**：保留全部企业治理层与「Agent 不直连 MCP / 模型只走网关」的边界，
同时把官方已打磨的消息/事件/权限契约吸收进来，且不引入 Python 栈、不承担 0.0.x 的稳定性风险。

---

## 五、结论

1. **「本仓库以 TypeScript 实现了 AgentScope Core 的三项核心契约」这句话成立，但需修正措辞**：
   ReAct 与 Toolkit 是**等价实现**；Middleware 是**子集实现**（3 hook 线性链 vs 官方 Python 7 hook 洋葱模型），
   且**官方 TypeScript 版根本没有 Middleware**。`docs/component-mapping.md:156` 的表述应据此细化。

2. **官方存在 TypeScript 实现**（`@agentscope-ai/agentscope` 0.0.15，15,281 行），这是本次对照最有价值的发现——
   它把「换官方」的成本从路线 A 的 115–170 人日压到路线 B 的 65–100 人日。但它是 0.0.x 预 1.0，且缺 Middleware。

3. **「完全替换官方」不成立也不必要**：官方在多租户、RBAC、三级预算、合规审计、脱敏、审批单、网关强制路由、
   出网代理这 8 项企业治理能力上**全部为空**，而这正是本平台相对通用框架的核心增量。

4. **推荐路线 C**：保留自研内核作为治理层底座，吸收官方 TS 的消息内容块、流式事件、权限引擎、上下文压缩四项契约。
   预计 29–46 人日，可在不破坏任何现有验收项的前提下增量落地。

5. **官方 Web UI（studio）不可整体替换**：缺多租户/预算/审批/审计四页，且 tRPC ↔ REST 协议不兼容；
   可复用其内容块消息契约与 trace/span 可视化组件。

---

## 附录 A：核对方法

```bash
# 官方 Python 主仓 2.0.12
pip download agentscope==2.0.12 --no-deps -d /tmp/as
unzip -q /tmp/as/agentscope-2.0.12*.whl -d /tmp/as/x
grep -n "async def on_" /tmp/as/x/agentscope/middleware/_base.py     # 7 个 hook

# 官方 TypeScript 主仓
git clone --depth 1 --filter=blob:none --no-checkout https://github.com/agentscope-ai/agentscope-typescript.git
cd agentscope-typescript && git sparse-checkout set packages && git checkout
grep -rn "middleware" --include=*.ts packages/agentscope/src/ | grep -v "\.test\."   # 仅 3 条注释

# 官方 Web UI
git clone --depth 1 --filter=blob:none --no-checkout https://github.com/agentscope-ai/agentscope-studio.git
cd agentscope-studio && git sparse-checkout set packages/client/src packages/shared && git checkout

# 官方 Service 框架
git clone --depth 1 --filter=blob:none --no-checkout https://github.com/agentscope-ai/agentscope-runtime.git
cd agentscope-runtime && git sparse-checkout set src && git checkout

# npm 发布状态
npm view @agentscope-ai/agentscope versions --json    # 0.0.2 … 0.0.15
```

## 附录 B：官方 TS 内置工具清单

`Read`、`Write`、`Edit`、`Bash`、`Grep`、`Glob`、`TaskCreate`、`TaskUpdate`、`TaskGet`、`TaskList`、`Skill`
（`src/tool/*.ts` + `src/tool/toolkit.ts` 的内置 `Skill` 工具）

## 附录 C：官方 TS 权限模式

`DEFAULT`、`ACCEPT_EDITS`、`EXPLORE`、`BYPASS`、`DONT_ASK`；
行为枚举 `ALLOW` / `DENY` / `ASK` / `PASSTHROUGH`；
`PermissionDecision.bypass_immune` 标记「即便 allow 规则命中也不得自动放行」的强制人工确认。
