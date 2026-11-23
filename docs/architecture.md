# 总体架构

> 对应方案第 2 章「总体架构」与第 4 章「核心组件详细设计」。

## 2.1 架构分层

```
┌──────────────────────────────────────────────────────────────────────┐
│ 用户层    企业用户（浏览器）                                          │
├──────────────────────────────────────────────────────────────────────┤
│ 应用层    AgentScope Web UI  +  Agent Core                          │
│           Chat / 会话 / HITL 人工确认 / ReAct 循环                    │
├──────────────────────────────────────────────────────────────────────┤
│ 网关层    ★ agentgateway                                             │
│           LLM 路由 · 虚拟模型 · 预算管控 · MCP 治理 · 工具白名单      │
│           租户隔离 · Guardrails · 审计埋点 · A2A 预留                 │
├──────────────────────────────────────────────────────────────────────┤
│ 能力层    ① 商业大模型 API（出网代理 + 内置脱敏）                     │
│           ② 文档知识库（RAGFlow + Infinity + TEI）                   │
│           ③ DB-GPT MCP（Text2SQL / 图表 / 报告 / 沙箱执行）          │
├──────────────────────────────────────────────────────────────────────┤
│ 数据层    文档共享盘 · MySQL/PG · ERP/CRM/OA API · 老系统              │
├──────────────────────────────────────────────────────────────────────┤
│ 支撑层    Keycloak(SSO) · PostgreSQL · Redis · MinIO · 出网代理       │
├──────────────────────────────────────────────────────────────────────┤
│ 观测层    Langfuse（Trace + 成本归因，唯一观测组件）                   │
└──────────────────────────────────────────────────────────────────────┘
```

**调用关系**：用户 → AgentScope → agentgateway → 三大能力 → 企业数据源。
所有出网流量必须经过网关与出网代理。

## 2.2 设计原则的代码落点

| 原则 | 强制点 |
|---|---|
| 单一网关 | `packages/agent-core` 与 `packages/mcp-hub` 内部调用 LLM 时，一律经 `GatewayClient` → 网关；无直连出口 |
| 单一身份源 | 所有 HTTP 入口挂 `authMiddleware`；身份由 `AuthService.verify` 解析后注入 `req.identity` |
| 单一前端 | RAG / ChatBI 能力仅以 MCP 工具暴露，不提供独立 Web 入口 |
| 单一观测点 | Trace 只写 Langfuse + 本地降级库，不引入 Prometheus 栈；`/metrics` 为临时抓取端点 |
| 数据分级 | `GuardrailService.apply` 判定涉密 → 直接阻断出网 |
| 凭证隔离 | 凭证解析集中在 `CredentialResolver`，只被网关 Provider 适配器引用 |

---

## 关键链路一：普通问答（制度检索）

```
浏览器
  │ POST /api/chat  {message}
  ▼
Agent Core
  │ 1. 刷新工具目录 → GatewayClient.listTools → 网关按租户过滤下发
  │ 2. ReAct 循环：GatewayClient.chat → 网关 /v1/chat/completions
  │ 3. 模型返回 tool_calls
  │ 4. GatewayClient.callTool → 网关 /v1/mcp/call
  ▼
agentgateway
  │ 1) 虚拟模型解析 + 租户模型白名单
  │ 2) CEL 策略评估（service=llm）
  │ 3) 三级预算预检
  │ 4) Guardrails：注入检测 → 密级判定 → PII 脱敏
  │ 5) 主用目标按权重选路，失败后沿 Failover 链逐个尝试
  │ 6) 记账 + 审计 + Trace
  ▼
MCP Server（knowledge）
  │ 召回前过滤（tenant / dept / sensitivity）→ BM25 排序 → Top-K
  ▼
工具结果 → 网关脱敏 → 回灌模型 → 最终答案（含来源标注）
```

## 关键链路二：自助查数（ChatBI）

```
用户："上月华东区销售额环比多少？画个趋势图"
  │
  ├─→ Agent 判断需要查数
  ├─→ 网关：鉴权 + 工具白名单校验 + 正则脱敏
  ├─→ DB-GPT MCP Server：
  │     1. Text2SQL（LLM 生成 SQL，prompt 注入 schema + 指标口径字典）
  │     2. 沙箱执行（只读 + 行数上限 + worker 隔离 + 超时终止）
  │     3. 生成图表规格与分析报告
  ├─→ DB-GPT 内置脱敏 → 网关再次脱敏
  └─→ 回灌 AgentScope → 图表 + 分析结论
```

对应方案 6.1 的五步链路。

## 关键链路三：写操作 + 人工确认（HITL）

```
Agent 判断需调用 business.write.submit_expense
  │ ToolSpec.requiresConfirmation === true
  ▼
HitlManager.request → 生成审批单（status=pending）落库
  ▼
HitlManager.wait 轮询（默认 5 分钟超时）
  │                     ▲
  │                     │ 管理员在 Web 控制台「审批中心」点批准/驳回
  │                     │
  ▼                     │
approved → 继续调用工具 │ rejected/expired → 回灌"未执行"，模型据此作答
```

对应方案 4.1「敏感操作注册为需人工确认的工具」与 6.2「写操作一律禁止自动写库；确需写操作走业务 MCP + HITL 人工确认」。

---

## 核心设计决策

### 1. 为什么网关必须提供 OpenAI 兼容端口

方案 4.1 要求「ChatModel 全部指向 agentgateway 的 OpenAI 兼容端口，模型名使用网关的虚拟模型名（如 smart-model），不感知真实 Provider」。
这样做的收益：

- Agent 侧代码与 Provider 完全解耦，换模型不改业务代码
- Failover、预算、护栏、审计对所有 Agent 无差别生效（单一收口的真正价值）
- 可直接复用生态里现成的 OpenAI 客户端

本项目实现于 `packages/gateway/src/routes/chat.ts`，支持普通与 SSE 流式两种响应。

### 2. 为什么自研 CEL 求值器

方案 4.3 要求「Cedar/CEL 策略 —— 租户级 allow/deny 模型与工具」，但 3.2 明确排除引入额外组件。
Node 生态没有成熟的 CEL 实现（`cel-js` 维护活跃度低、Cedar 官方 SDK 仅覆盖部分语言），
因此在 `packages/gateway/src/policy/cel.ts` 实现了一个 **CEL 子集递归下降求值器**（约 500 行）：

- 支持：字面量、路径访问、数组下标、`&& || ! == != < <= > >= + - * / %`、`in`、三元、内置函数、`has()`
- 扩展：方法调用语法 `x.startsWith(y)`（接收者作为首参）
- 语义对齐 Cedar：**显式 deny 优先于 allow**；无策略命中时按 `POLICY_DEFAULT_DECISION` 处理（默认 enforce → 拒绝）

策略主体/动作/资源三元组匹配 + CEL 条件表达式，足以覆盖方案第 7.2 节的租户/部门/用户三级隔离模型。

### 3. 为什么 MCP 工具治理放在网关而不是 Agent 侧

方案 2.1 把「MCP 治理、工具白名单、租户隔离」列为网关层职责。本项目在 `gateway/src/mcp/registry.ts` 实现：

- **目录过滤**：下发前按租户工具白名单裁剪，Agent 根本看不到未授权工具
- **调用校验**：即使 Agent 伪造工具名，调用时仍会二次校验白名单 + 策略
- **上下文透传**：网关注入 `__ctx`，MCP Server 侧做行级 / 文档级过滤（方案 5.2）
- **双重脱敏**：入参与返回值都过 Guardrails

### 4. 为什么检索过滤必须先于打分

平台同时支持 Infinity（BM25 + 向量混合召回）与本地 BM25 降级实现。两种实现遵循同一条硬约束：
**tenant / dept / sensitivity 过滤在打分之前完成**，禁止全库召回后再过滤。
Infinity 不可用时才切换到本地 BM25，工具契约与权限语义保持一致；切换状态会在知识库检索测试中显示。

---

## 目录与模块职责

| 模块 | 职责 | 关键文件 |
|---|---|---|
| platform-core | 共享类型、配置、日志脱敏、存储抽象、开发令牌 | `types.ts` `config.ts` `logger.ts` `store/*` `auth/dev-token.ts` |
| auth-middleware | JWT 校验与身份注入 | `index.ts` |
| gateway | 网关全部能力 | `llm/router.ts` `llm/providers.ts` `llm/budget.ts` `policy/*` `guardrails/*` `mcp/registry.ts` `audit/service.ts` `observability/tracing.ts` `routes/*` |
| agent-core | Agent 内核与会话服务 | `runtime.ts` `toolkit.ts` `middleware.ts` `hitl.ts` `gateway-client.ts` |
| mcp-hub | MCP 客户端 + 三个本地 MCP Server | `client.ts` `server-base.ts` `sandbox.ts` `servers/*` |

---

## 可扩展点

| 扩展需求 | 改动位置 |
|---|---|
| 新增虚拟模型或调整路由 | 管理员在控制台「模型与路由」操作，或调用 `/v1/admin/models`；支持主备顺序、主用权重、账号和输出上限，无需重启。默认入口由 Agent 与网关共享的 `AGENT_DEFAULT_MODEL` 指定，默认模型不可禁用或删除 |
| 新增 Provider | 控制台「厂商接入与凭证」直接新增 OpenAI / Anthropic 兼容厂商，配置 BASE_URL、认证方式和账号池，按账号加密保存 Key；配置热生效。内置厂商仍走环境变量，私有协议需新增适配器 |
| 管理人员账号与权限 | 仅 platform-admin 使用控制台「用户与权限」或 `/v1/admin/users`；网关通过独立 eap-gateway 服务账号实时读写 Keycloak，支持新建、编辑、启停、重置密码和删除，含自身与最后管理员保护、会话注销及脱敏审计 |
| 新增 MCP Server | `MCP_SERVERS` 增加 `serverId=url`，实现方暴露 MCP 协议即可被治理 |
| 新增脱敏规则 | `GUARDRAILS_CUSTOM_RULES_FILE` 指定的 JSON 规则库，无需改代码 |
| 调整策略 | `PUT /v1/admin/policies` 热更新，或 `POLICY_FILE` 静态加载 |
| 多租户拆分 | Keycloak realm/group + `Tenant` 表的模型/工具/知识库白名单；首期单租户 + 部门隔离已在 `AUTH_SINGLE_TENANT_MODE` 预留 |
