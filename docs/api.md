# API 契约

所有受保护接口均需 `Authorization: Bearer <token>`。Token 由 Keycloak 签发（生产）或开发态登录接口签发（开发）。

---

## 一、agentgateway（默认 8080）

请求体 JSON 格式错误返回 `400 invalid_json`，超过 `SECURITY_MAX_BODY_BYTES` 返回
`413 payload_too_large`；未处理的服务端异常返回 `500 internal_error`，响应不包含内部异常细节
（数据库地址、上游厂商报错等只进日志）。

### 1.0 鉴权配置（免鉴权）

控制台登录的唯一配置来源 —— 前端据此判断走 Keycloak 统一登录还是开发态登录。

```http
GET /v1/auth/config
```

```json
{
  "mode": "oidc",
  "clientId": "eap-webui",
  "scope": "openid profile email",
  "authorizationUrl": "http://127.0.0.1:8082/realms/enterprise/protocol/openid-connect/auth",
  "tokenUrl": "http://127.0.0.1:8082/realms/enterprise/protocol/openid-connect/token",
  "endSessionUrl": "http://127.0.0.1:8082/realms/enterprise/protocol/openid-connect/logout",
  "issuer": "http://127.0.0.1:8082/realms/enterprise",
  "redirectPath": "/auth/callback",
  "devMode": false
}
```

`mode` 为 `oidc` 时，控制台用「授权码 + PKCE S256」跳转 `authorizationUrl`，
回调地址为 `${页面 origin}${redirectPath}`，令牌交换在浏览器侧完成。
`KEYCLOAK_PUBLIC_URL` 决定 `authorizationUrl` / `tokenUrl` 的主机部分 —— 必须是**浏览器可达**的地址。

### 1.1 开发态登录

```http
POST /v1/auth/dev-token
Content-Type: application/json

{ "role": "admin", "tenant_id": "t-default", "dept_id": "dept-general", "sensitivity": "internal" }
```

```json
{
  "access_token": "eyJ...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "identity": { "tenant_id": "t-default", "user_id": "dev-admin", "role": "admin", "dept_id": "dept-general", "sensitivity": "internal" }
}
```

> 仅在 `AUTH_DEV_MODE=true` 时可用；生产由 Keycloak 统一登录（方案 7.1）。
> `AUTH_DEV_MODE=false` 时本接口返回 `404 {"error":"not_found","message":"开发登录接口已关闭"}`。

### 1.2 虚拟模型列表

```http
GET /v1/models
```

```json
{
  "object": "list",
  "data": [{
    "id": "smart-model",
    "object": "model",
    "description": "主力对话 / 工具调用…",
    "scenarios": ["日常对话", "工具调用"],
    "targets": [{ "provider": "minimax", "model": "MiniMax-M3.1-Flash", "role": "primary" }]
  }]
}
```

结果按租户模型白名单过滤。

### 1.3 Chat Completions（OpenAI 兼容）

```http
POST /v1/chat/completions
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `model` | string | **虚拟模型名**，非真实模型名 |
| `messages` | array | OpenAI 格式 |
| `tools` | array | 可选；存在时平台自动以租户工具目录覆盖下发 |
| `temperature` | number | 可选 |
| `max_tokens` | number | 可选 |
| `stream` | boolean | 可选，SSE |
| `session_id` / `app_id` | string | 平台扩展：会话与应用维度预算/审计 |

响应在 OpenAI 标准字段外附加 `eap` 扩展块：

```json
{
  "id": "chatcmpl-…",
  "object": "chat.completion",
  "model": "smart-model",
  "choices": [{ "index": 0, "message": { "role": "assistant", "content": "…" }, "finish_reason": "stop" }],
  "usage": { "prompt_tokens": 20, "completion_tokens": 220, "total_tokens": 240 },
  "eap": {
    "trace_id": "e86407099efa483c9fb0a6d67cb1d2d4",
    "provider": "minimax",
    "real_model": "MiniMax-M3.1-Flash",
    "account": "default",
    "cost_usd": 0.00034,
    "failover": []
  }
}
```

### 1.4 Embeddings（OpenAI 兼容，仅本地 TEI）

```http
POST /v1/embeddings
```

对应方案 4.2「本地 Embedding，数据不出域」。**只走内网 TEI**，不经过任何商业大模型 API，
因此不接受虚拟模型之外的模型名，也不产生外部 API 费用。

| 字段 | 类型 | 说明 |
|---|---|---|
| `model` | string | 虚拟模型名，默认 `embedding-model`；其目标必须是 TEI |
| `input` | string \| string[] | 待嵌入文本，数组则返回等量向量 |
| `session_id` / `app_id` | string | 平台扩展：用于应用级 QPS 限流与审计 |

```json
{
  "object": "list",
  "data": [{ "object": "embedding", "index": 0, "embedding": [0.021, -0.114, "…"] }],
  "model": "embedding-model",
  "usage": { "prompt_tokens": 0, "total_tokens": 0 },
  "eap": {
    "trace_id": "9c2b…",
    "provider": "tei",
    "real_model": "intfloat/multilingual-e5-small",
    "dimensions": 384
  }
}
```

治理约束：

- 输入同样过护栏（PII 脱敏 + Prompt 注入检测），命中注入规则直接 400
- TEI 地址必须是环回或私有网段 —— 不借用商业 API 的出网白名单，否则嵌入内容会外发
- 本地推理不计费，但仍受租户预算熔断与应用级 QPS 限流保护
- 用 `embedding-model` 调 `/v1/chat/completions` 会返回 400 并提示改用本接口
- **本地推理属于 `local` 出网级别**：涉密主体（`sensitivity=confidential`）可以调用本接口
  （数据不出域即方案 8.1 要求的合规闭环），而同样的涉密主体调 `/v1/chat/completions` 会被
  `deny-confidential-egress` 拒绝（403）
- 本地推理时 PII **只统计不替换**（占位符会破坏向量语义），命中情况仍写入审计

### 1.5 MCP 工具目录

```http
GET /v1/mcp/tools
```

```json
{
  "object": "list",
  "data": [{
    "name": "knowledge.search",
    "description": "在企业文档知识库中检索…",
    "input_schema": { "type": "object", "properties": { "query": { "type": "string" } } },
    "server_id": "knowledge",
    "requires_confirmation": false,
    "sensitivity": "internal",
    "data_scope": "tenant+dept+sensitivity"
  }]
}
```

### 1.6 MCP 工具调用（受治理）

```http
POST /v1/mcp/call
{ "server_id": "knowledge", "tool": "knowledge.search", "arguments": { "query": "年假制度" }, "trace_id": "…" }
```

```json
{
  "ok": true,
  "content": "[1] 《员工年假管理制度》（来源 doc-policy-leave，密级 internal，得分 2.6551）…",
  "structured": { "count": 1, "hits": [{ "docId": "doc-policy-leave", "score": 2.6551 }] },
  "reason": null,
  "trace_id": "…"
}
```

拒绝场景 `ok=false`，`reason` 取值：`tool_not_allowed` / `policy_denied` / `guardrail_blocked` / `budget_exceeded` / `confirmation_required` / `approval_replayed` / `mcp_error`。

`requiresConfirmation=true` 的写工具不能只靠直接调用此接口执行。请求必须携带与身份、租户、工具、会话、trace 和参数完全匹配的 `approval_id`；正常流程由 Agent 自动传递。审批在执行前被原子消费为 `executed`，不能重放。

### 1.7 管理接口

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| GET | `/v1/admin/tenants` | 租户列表 | admin / platform-admin |
| POST | `/v1/admin/tenants` | 新建/更新租户 | admin / platform-admin |
| GET | `/v1/admin/users` | Keycloak 人员账号实时列表，排除服务账号 | **仅 platform-admin** |
| POST | `/v1/admin/users` | 新建人员账号并返回一次性随机密码；校验角色、租户、部门和密级 | **仅 platform-admin** |
| PUT | `/v1/admin/users/:id` | 修改邮箱、姓名和平台属性并尝试注销现有会话；禁止修改自己的角色或租户，也禁止降级最后一个启用中的平台管理员 | **仅 platform-admin** |
| PATCH | `/v1/admin/users/:id` | 启停账号 `{ "enabled": false }`；禁止停用自己或最后一个启用中的平台管理员（已停用的管理员不受此限） | **仅 platform-admin** |
| POST | `/v1/admin/users/:id/reset-password` | 返回一次性随机密码并尝试注销现有会话，审计不记录密码 | **仅 platform-admin** |
| DELETE | `/v1/admin/users/:id` | 删除人员账号；禁止删除自己或最后一个启用中的平台管理员（已停用的管理员不受此限） | **仅 platform-admin** |
| GET | `/v1/admin/budget` | 预算看板（平台 + 租户） | admin 看本租户；platform-admin 看全部 |
| GET | `/v1/admin/audit?kind=&limit=` | 审计事件 | admin 看本租户；platform-admin 看全部 |
| GET | `/v1/admin/audit/:traceId` | 按 trace 还原完整调用链 | 同上，存储查询时强制租户过滤 |
| GET | `/v1/admin/policies` | 策略列表 | admin / platform-admin |
| PUT | `/v1/admin/policies` | 替换策略集 | admin / platform-admin |
| GET | `/v1/admin/models` | 虚拟模型列表、Provider 连接元数据（不含密钥）及 `defaultModel` 默认对话模型 | admin / platform-admin |
| POST | `/v1/admin/models` | 新增虚拟模型；重名返回 409；以禁用状态创建默认模型返回 409 | admin / platform-admin |
| PUT | `/v1/admin/models/:name` | 修改描述、场景、目标和启停状态；模型名不可改，默认模型不可禁用 | admin / platform-admin |
| PATCH | `/v1/admin/models/:name` | 仅修改启停状态 `{ "enabled": false }`；禁用默认模型返回 409 | admin / platform-admin |
| DELETE | `/v1/admin/models/:name` | 删除虚拟模型；默认模型或仍被租户白名单引用时返回 409 | admin / platform-admin |
| GET | `/v1/admin/agents` | 兼容的虚拟模型只读列表；管理操作统一使用 `/v1/admin/models` | admin / platform-admin |
| GET | `/v1/admin/provider-definitions` | 内置与自定义 Provider 连接元数据，不含密钥 | admin / platform-admin |
| POST | `/v1/admin/provider-definitions` | 新增 OpenAI / Anthropic 兼容 Provider；重名返回 409 | admin / platform-admin |
| PUT | `/v1/admin/provider-definitions/:name` | 修改自定义 Provider；缩减账号池时检查模型引用并清理移除账号的控制台密钥 | admin / platform-admin |
| PATCH | `/v1/admin/provider-definitions/:name` | 启停自定义 Provider `{ "enabled": false }` | admin / platform-admin |
| DELETE | `/v1/admin/provider-definitions/:name` | 删除自定义 Provider 及其控制台密钥；被模型引用时返回 409 | admin / platform-admin |
| POST | `/v1/admin/provider-definitions/:name/test` | 按账号请求 `/models` 测试连接，不生成内容 | admin / platform-admin |
| GET | `/v1/admin/providers` | 厂商账号凭证视图（只含掩码与来源，**永不回传明文**） | 任意登录用户（只读） |
| PUT | `/v1/admin/providers/:provider` | 写账号凭证 `{ "account": "default", "apiKey": "sk-…" }`，立即生效；account 缺省为 default | admin / platform-admin |
| DELETE | `/v1/admin/providers/:provider?account=default` | 删账号控制台凭证，回落到环境变量 / OAuth 凭证文件 | admin / platform-admin |
| GET | `/v1/admin/approvals?status=` | HITL 审批单 | 任意登录用户；普通用户仅本人工单，审批角色可查看本租户全部 |
| POST | `/v1/admin/approvals/:id/decide` | 审批 `{ "decision": "approved" \| "rejected" }` | 上述审批角色，限本租户且不得自审，只能处理一次 |
| GET | `/v1/admin/traces` | Trace 列表 | 同审计 |
| GET | `/v1/mcp/health` | MCP Server 连通性 | 任意登录用户 |
| GET | `/healthz` | 存活探针（免鉴权） | 公开 |
| GET | `/metrics` | Prometheus 文本格式指标（临时抓取） | admin / platform-admin |

**校验错误的返回形态**：模型与 Provider 的写入接口会**一次列出全部问题**，而不是只报第一个 ——
提交一次就能知道要改哪几处。响应体形如：

```json
{
  "error": "invalid_provider",
  "message": "以下 3 项需要修正：\nProvider 名不能为空\n协议必须为 openai 或 anthropic\n账号池必须包含 1–8 个账号别名",
  "issues": ["Provider 名不能为空", "协议必须为 openai 或 anthropic", "账号池必须包含 1–8 个账号别名"]
}
```

`message` 是给界面直接展示的（换行分隔，一条一行）；`issues` 是结构化数组，便于程序化处理。

虚拟模型的写入示例：

```json
{
  "name": "customer-service-model",
  "description": "客服对话",
  "scenarios": ["日常对话", "工具调用"],
  "enabled": true,
  "targets": [
    { "provider": "minimax", "model": "MiniMax-M3.1-Flash", "role": "primary", "weight": 80, "maxTokens": 4096 },
    { "provider": "deepseek", "model": "DeepSeek-chat", "role": "fallback" }
  ]
}
```

目标 Provider 必须是内置 Provider 或已通过 `/v1/admin/provider-definitions` 注册的自定义 Provider，`account` 必须是该 Provider 已配置的账号别名，缺省为 `default`。主用目标只要有一个配置了权重，就按相对权重选取首选目标，未填按 1 计算；全部未配置时保持固定顺序。其余主用目标仍按顺序参与故障转移，随后才尝试备用目标。`maxTokens` 为 1–65536 的整数，缺省时使用请求值。TEI 嵌入目标不能与对话目标混用。

`GET /v1/models` 只返回当前租户可用且已启用的模型。管理接口的每次变更都记录审计；Provider 元数据只包含协议、无凭证 URL 和账号别名，不返回 API Key。

**审批权限的前后端口径**（两处必须一致，否则用户会看到能点但必然 403 的按钮）：

| 判定 | 规则 | 表现 |
|---|---|---|
| 谁能审批 | 角色 ∈ {admin, platform-admin, manager} | 其余角色（如 employee）永远只读 |
| 审批谁的单 | `approval.userId !== identity.userId` | **不得审批自己发起的申请**（防自批） |
| 能看到哪些单 | 审批角色看本租户全部；普通用户只看**自己发起**的 | 普通用户不会在列表里看到别人的工单 |

前端的判定在 `apps/webui/src/permissions.ts` 的 `canDecideApproval()`，
对话页与审批中心共用；不可判定时显示「等待其他审批人处理」而不是给出按钮。
后端 `POST /v1/admin/approvals/:id/decide` 是**最终防线**：自审、跨租户、
重复审批一律拒绝（403 / 404 / 409），绕过前端直接调接口同样拦得住。

### 1.8 知识库接口（控制台「知识库」页）

平台真正的业务知识在主库 `knowledge_docs` 表（制度、合同、指标口径等），
由 `knowledge` MCP 服务负责检索（Infinity 向量 + 全文召回 + 引擎内过滤）。
**RAGFlow 是同一职责的可选外购组件，与这组接口的数据互不相通。**

**可见性口径**（列表、详情、检索三者一致）：

1. 租户隔离 —— 只能看自己租户的文档
2. **密级优先** —— 文档密级高于本人密级的一律不可见，**管理员也不例外**
3. 部门隔离 —— 管理员跨部门可见；普通用户只能看本部门 + `dept_id='all'` 的文档

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| GET | `/v1/knowledge/docs?dept_id=&sensitivity=&q=&page=&pageSize=` | 分页文档列表（摘要，不含正文，返回 `pagination`） | 任意登录用户（按可见性过滤） |
| GET | `/v1/knowledge/docs/:id` | 文档详情（含正文）；不可见返回 **404**（不泄露是否存在） | 同上 |
| POST | `/v1/knowledge/search` | 检索测试，走与 Agent 完全相同的检索链路 | 同上 |
| POST | `/v1/knowledge/docs` | 新增/更新文档 → **202 + 审批单**，不直接落库 | platform-admin / admin |
| DELETE | `/v1/knowledge/docs/:id` | 删除文档 → **202 + 审批单** | platform-admin / admin |

> **写操作是审批制**：POST / DELETE 只生成审批单（`status: 'pending'`），
> 需由**另一位**有审批权限的人在「审批中心」通过后才真正落库
> （沿用 4.1 HITL 链路；发起人不得审批自己发起的单）。
> 审批通过时由网关回放对应的 `knowledge.upsert_document` /
> `knowledge.delete_document` 工具，写入以**申请人**身份执行（owner 记申请人）。

```bash
# 列出当前身份可见的文档
curl -s http://127.0.0.1:8080/v1/knowledge/docs -H "Authorization: Bearer $TOKEN"

# 检索测试（管理员会跨部门检索，但密级仍受自身 clearance 约束）
curl -s -X POST http://127.0.0.1:8080/v1/knowledge/search \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"query":"年假怎么计算","topK":5}'
# {"data":{"engine":"infinity","count":4,"hits":[...]},"query":"年假怎么计算","topK":5}

# 写入（返回 202，尚未落库）
curl -s -X POST http://127.0.0.1:8080/v1/knowledge/docs \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"员工年假管理制度","content":"……","deptId":"dept-general","sensitivity":"internal"}'
# {"data":{"approvalId":"…","status":"pending","tool":"knowledge.upsert_document", …}}
```

> `engine` 字段标明本次检索实际走的引擎：`infinity` = 向量 + 全文融合召回；
> `local-bm25` = Infinity 不可用时的本地兜底（全文 BM25，无向量语义）。

---

## 二、Agent Core（默认 8090）

请求体 JSON 格式错误返回 `400 invalid_json`，超过 `SECURITY_MAX_BODY_BYTES` 返回
`413 payload_too_large`；未处理的服务端异常返回 `500 internal_error`，响应不包含内部异常细节。

### 2.1 对话

```http
POST /api/chat
{ "message": "公司年假制度是怎么规定的？", "session_id": "可选", "app_id": "可选", "model": "可选" }
```

```json
{
  "session_id": "820a6dd6-…",
  "content": "## 结论\n根据公司《员工年假管理制度》…",
  "iterations": 3,
  "tool_calls": [{ "name": "knowledge.search", "args": { "query": "…" }, "ok": true, "output": "…" }],
  "trace_id": "e76e43d2354345bd85fd40baf5185ebb"
}
```

未传 `session_id` 时自动新建会话。

### 2.2 AG-UI 标准事件流（控制台流式对话）

```http
POST /ag-ui
Authorization: Bearer <JWT>
Content-Type: application/json
Accept: text/event-stream
```

请求体是 AG-UI 标准的 `RunAgentInput`：

```json
{
  "threadId": "会话 id（= 平台 sessionId）",
  "runId": "本轮 run id（可省略，后端生成）",
  "messages": [{ "id": "u1", "role": "user", "content": "查一下我的待办" }],
  "state": {},
  "tools": [],
  "context": [],
  "forwardedProps": { "sessionId": "可选，与 threadId 同义", "appId": "可选", "model": "可选；管理员按会话选择，缺省使用默认模型" }
}
```

响应为 `text/event-stream`，帧格式 `data: {json}\n\n`（`@ag-ui/client` 的 `parseSSEStream` 按此解析）。
事件字段与 `@ag-ui/core` 0.0.54 对齐：

| 事件 | 触发时机 | 关键字段 |
|---|---|---|
| `RUN_STARTED` | 本轮开始 | `threadId` `runId` |
| `CUSTOM` `eap.session` | 会话确定后 | `value.sessionId` |
| `TEXT_MESSAGE_START` | 每轮 ReAct 迭代开始 | `messageId` `role` |
| `TEXT_MESSAGE_CONTENT` | 模型正文增量 | `messageId` `delta` |
| `TEXT_MESSAGE_END` | 本轮正文结束 | `messageId` |
| `TOOL_CALL_START` | 工具调用开始 | `toolCallId` `toolCallName` `parentMessageId` |
| `TOOL_CALL_ARGS` | 工具参数分片 | `toolCallId` `delta` |
| `TOOL_CALL_END` | 参数收口 | `toolCallId` |
| `TOOL_CALL_RESULT` | 工具执行完成 | `messageId`（`<父消息id>:<toolCallId>`）`toolCallId` `content` `role` |
| `CUSTOM` `eap.approval_pending` | 命中需人工确认的工具 | `value.approvalId` `value.tool` `value.args` |
| `CUSTOM` `eap.approval_decided` | 审批有结论 | `value.decision`（approved/rejected/expired） |
| `RUN_FINISHED` | 本轮结束 | `threadId` `runId` `result` |
| `RUN_ERROR` | 本轮异常 | `message` `code` |

**会话语义**：会话 id 由客户端生成（`threadId` / `forwardedProps.sessionId`），
服务端按需创建 —— 已存在则沿用，跨租户或同租户跨用户访问均返回 403。

**人工确认（HITL）**：仍是跨用户审批。命中敏感写操作时后端挂起本轮请求、
SSE 连接保持打开（默认上限 `AGENT_APPROVAL_TIMEOUT_MS` = 300 秒），
在「审批中心」批准后工具继续执行，事件流不断。

```bash
TOKEN=$(curl -s -X POST "http://127.0.0.1:8082/realms/enterprise/protocol/openid-connect/token" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d "grant_type=password&client_id=eap-webui&username=eap-demo&password=EapDemo@2026" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")

curl -sN -X POST http://127.0.0.1:8090/ag-ui \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"threadId":"t1","runId":"r1","messages":[{"role":"user","content":"查一下我的待办"}]}'
```

### 2.3 会话

```http
GET /api/sessions                      → { "data": [{ "id", "tenantId", "userId", "title", "createdAt", "updatedAt" }] }
GET /api/sessions/:id/messages        → { "data": [{ "id", "sessionId", "role", "content", "createdAt", "toolCalls", "traceId" }] }
DELETE /api/sessions/:id               → 204；删除本人的会话及消息，审批、审计与 Trace 保留；不存在或无权访问返回 404，运行中返回 409
GET /api/tools                        → { "data": [ToolSpec], "count": 11 }
GET /healthz                          → { "ok": true, "service": "agent-core" }
```

> **运行与删除的互斥是进程内状态**：占用表保存在 agent-core 进程内存里，
> 因此「运行中拒绝删除（409）」只在**单个 agent-core 进程**内严格成立。
> Compose 与单机部署是单进程，语义完整；Helm 的 `appLayer.agentCore.replicaCount` 默认也为 1。
> 多副本下删除请求若落到另一个副本，可能与另一副本上的生成并行（生成结果会变成孤儿消息，
> 但不会复活已删除的会话）。扩展到多副本前需实现数据库或 Redis 共享协调及会话持久化。

---

## 三、MCP Server（8091 / 8092 / 8093）

标准 MCP Streamable HTTP 协议，路径 `/mcp`。非 MCP 客户端（如网关）走网关的 `/v1/mcp/*` 接口。

| Server | 端口 | 工具 |
|---|---|---|
| eap-knowledge | 8091 | `knowledge.search`、`knowledge.list_documents`、`knowledge.upsert_document`※、`knowledge.delete_document`※ |
| eap-chatbi | 8092 | `chatbi.query`、`chatbi.list_metrics`、`chatbi.run_sql` |
| eap-business | 8093 | `business.query_todo`、`business.query_contract`、`business.write.submit_expense`※、`business.write.approve_task`※ |

※ = 需人工确认（`requiresConfirmation: true`），会进入 HITL 流程。

工具元数据通过 MCP `_meta` 下发给网关：

```json
{ "requiresConfirmation": true, "sensitivity": "internal", "dataScope": "write" }
```

---

## 四、身份 claims 约定

| claim | 含义 | 缺失时 |
|---|---|---|
| `sub` | 用户 ID（稳定主体标识，审计与权限判定以此为准） | 依次回退 `preferred_username` → `oid` → `unknown` |
| `tenant_id` | 租户 ID | `AUTH_DEFAULT_TENANT_ID`（单租户模式） |
| `role` | 角色 | `employee` |
| `dept_id` | 部门 ID | `dept-general` |
| `sensitivity` | 数据密级 | `internal` |
| `scope` / `scopes` | 授权范围 | 空数组 |

> **`sub` 缺失必须回退，不能塌缩成 `unknown`**：否则所有用户的 `user_id` 相同，
> 审计日志与审批单无法区分操作者。回退链见 `packages/auth-middleware/src/index.ts`
> 的 `subjectFromClaims`，单测见 `tests/auth.test.ts`。

### 4.1 Keycloak 真实令牌

`deploy/compose/keycloak/realm-eap.json` 定义 realm `enterprise`，含三个客户端：

| clientId | 类型 | 用途 |
|---|---|---|
| `eap-webui` | 公开客户端 | 前端 OIDC 授权码 + PKCE，`directAccessGrantsEnabled` 便于本地直登 |
| `eap-agent` | 机密客户端 | 服务端 client_credentials 取 JWT（平台内部服务账号） |
| `eap-gateway` | 机密客户端 | 网关管理面调用 |

realm 内置 client scope `eap-context`，用 user-attribute 协议映射器把
`tenant_id` / `dept_id` / `sensitivity` / `role` 注入 access token ——
这是方案 7.1「JWT 含 tenant_id / user_id / role / dept_id」的落地方式。

> **realm JSON 必须显式内联 Keycloak 内置 client scope**
> （`profile` / `email` / `roles` / `web-origins` / `acr` / `basic` …）。
> Keycloak 26 的 `--import-realm` **文件导入路径不会种下内置 scope**，
> 一旦 realm JSON 里声明了 `clientScopes` 数组，导入结果就只剩数组里列出的那几个 ——
> 表现为客户端 `defaultClientScopes` 被静默裁剪、token 里没有 `sub` /
> `preferred_username` / `realm_access`、请求 `scope=openid profile` 报 `Invalid scopes`。
> 内置 scope 定义副本见 `deploy/compose/keycloak/builtin-client-scopes.json`，
> 复核命令：`python3 scripts/keycloak-admin.py scopes enterprise`。

realm 角色与平台内置角色一一对应：`platform-admin` / `admin` / `manager` / `employee`，
另有 `auditor` / `approver` 两个能力位（并入 `scopes` 下发）。
中间件的映射规则：

1. `role` 声明合法（属于上述四个）→ 直接采用
2. 否则按 `realm_access.roles` 优先级 `platform-admin` > `admin` > `manager` > `employee` 取
3. 都不命中 → 降级 `employee`

Keycloak 内置角色（`offline_access` / `uma_authorization`）**不会**被当作业务角色，
也不会进入 `scopes` —— 否则会越过角色校验。

**空串属性按缺失处理**：Keycloak 的 user-attribute 映射器在用户没有该属性时会下发空串，
中间件会把空串的 `tenant_id` / `dept_id` / `sensitivity` / `role` 全部按「缺失」回落
（默认租户 / `dept-general` / `internal` / `employee`），不产生畸形身份。

#### 服务账号令牌（组件间机器对机器调用）

MCP Hub 的 Text2SQL 需要回调网关，属于机器对机器调用，用 Keycloak `client_credentials`：

```http
POST /realms/enterprise/protocol/openid-connect/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&client_id=eap-agent&client_secret=***
```

- 服务账号身份 `service-account-eap-agent` 显式声明 `tenant_id=t-default` /
  `dept_id=dept-general` / `sensitivity=internal` / `role=employee`
- 客户端 secret 只在环境变量 / K8s Secret（`KEYCLOAK_SERVICE_CLIENT_ID` / `KEYCLOAK_SERVICE_CLIENT_SECRET`）
- 取令牌的实现：`packages/platform-core/src/auth/service-token.ts` → `serviceToken()`，
  按到期时间缓存（提前 30 秒续期），并发调用只打一次 Keycloak
- `AUTH_DEV_MODE=true` 时自动退回本地自签 token，不打 Keycloak（仅联调用）

### 4.2 开发态令牌

`AUTH_DEV_MODE=true` 时接受本地 HS256 签发的 dev token（`scripts/issue-token.ts`）。
生产必须 `AUTH_DEV_MODE=false`，此时只有 Keycloak 签发的 RS256 令牌能通过校验。

网关 `GET /healthz` 会回报当前鉴权模式，便于验收脚本自动判断令牌来源：

```json
{
  "ok": true,
  "service": "agentgateway",
  "eap": { "authMode": "oidc", "issuer": "http://127.0.0.1:8082/realms/enterprise" }
}
```

`authMode` 为 `oidc` 表示走真实 Keycloak；为 `dev` 表示接受本地自签令牌（仅限开发环境）。

### 4.3 服务间静态凭证（`AUTH_SERVICE_TOKENS`）

部分重型组件无法走 OIDC 流程（DB-GPT 的 OpenAI 代理客户端、RAGFlow 等第三方服务），
需要用静态 API Key 直调网关。为此网关开了一条**服务间静态凭证**通道：

```bash
# .env
# 格式：<凭证>:<角色>:<租户>:<部门>:<密级>
AUTH_SERVICE_TOKENS=eap-dbgpt-local-key:employee:t-default:dept-general:internal
```

- 中间件校验链**先查服务凭证、再查 Keycloak JWT**（`packages/auth-middleware/src/index.ts`
  的 `verifyServiceToken()`）
- **不旁路任何治理**：策略引擎、三级预算、护栏、审计照常生效，服务身份与用户身份走同一条链路
- 角色受限：只能是平台内置角色，非法角色**降级为 `employee`**而非放行
- 凭证本身**不进日志、不进审计 payload**（审计记录的是服务身份标识）
- 默认关闭：不配置 `AUTH_SERVICE_TOKENS` 时该通道完全不存在
- 上线前必须替换为正式凭证，建议改由 Vault / K8s Secret 注入

## 五、重型组件对外接口

重型组件与平台服务**端口完全隔离**（宿主端口整体右移），前缀 `eapheavy-`。

### 5.1 RAGFlow v0.22.1（文档引擎）

| 端点 | 端口 | 说明 |
|---|---|---|
| HTTP API | 9380 | `/v1/*` |
| Web 界面 | 8095 | 容器内 80，宿主映射 8095 |
| MySQL（元数据库） | 3307 | 库 `rag_flow` |

鉴权是**三段式**，三套凭证互不通用：

1. **Web API 令牌**：登录（`POST /v1/user/login`）后从**响应头** `Authorization` 取值。
   口令需先经服务端公钥 RSA PKCS1v1.5 加密（对 base64 后的密码再加密），不能明文提交。
   该令牌**不能带 `Bearer ` 前缀**，且 **body 的 `data` 字段无效**。
2. **SDK API Key**：`POST /v1/system/new_token` 生成 `api_key`，用于 `Authorization: Bearer <api_key>`。
3. **端点语义**：`POST /api/v1/datasets/{id}/chunks` 是**触发解析**（参数 `document_ids`），
   **检索**是 `POST /v1/retrieval`；嵌入模型标识必须是 `<llm_name>@<factory>` 形式，
   内置嵌入为 `BAAI/bge-m3@Builtin`。

```bash
# 健康检查（db / doc_engine / redis / storage 四项）
curl -s http://127.0.0.1:9380/v1/system/healthz
# {"db":"ok","doc_engine":"ok","redis":"ok","status":"ok","storage":"ok"}
```

### 5.2 DB-GPT 0.8.3（ChatBI 引擎）

| 端点 | 端口 | 说明 |
|---|---|---|
| 模型 API Server | 8094 | 容器内 8092（避开平台 ChatBI MCP 的 8092） |
| **Web Server** | **8096** | 容器内 8093 —— DB-GPT 原生形态（datasource / Text2SQL / awesomes / 知识库） |
| **MCP Server** | **8097** | 容器内 8094 —— 平台侧薄适配器（FastMCP + streamable-http），路径 `/mcp` |
| 元数据库 | 5433 | 库 `dbgpt`（复用重型栈 PostgreSQL） |

形态为 **controller + worker + apiserver + webserver 四件套同容器**，
模型服务对外是 OpenAI 兼容接口：

```bash
# 模型列表（无 Key → 401）
curl -s http://127.0.0.1:8094/api/v1/models -H "Authorization: Bearer eap-dbgpt-local-key"

# 对话（真实模型：apiserver → worker → proxy/openai → agentgateway → MiniMax-M3.1-Flash）
curl -s -X POST http://127.0.0.1:8094/api/v1/chat/completions \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer eap-dbgpt-local-key" \
  -d '{"model":"smart-model","messages":[{"role":"user","content":"用一句话说明差旅住宿标准"}],"max_tokens":512}'
```

- `service.model.api` 是配置前缀（不是 `service.web`）；TOML 数值不能写插值，须加引号
- cluster worker **只允许声明 1 个模型**，LLM 与 Embedding 同时声明会报错
  `Only one model config is supported...`，因此只声明 LLM，嵌入统一走网关 `/v1/embeddings`（→ TEI）
- DB-GPT **不直连商业 API**，LLM 指向 `agentgateway` 的 `proxy/openai`
  （`host.docker.internal:host-gateway`），符合方案 4.4 的 Key 治理要求

#### DB-GPT 的 MCP Server（适配器，宿主 8097）

DB-GPT 上游**没有任何 MCP Server 形态**。已实测核实：Docker Hub 共 56 个标签最高 `v0.8.3`；
PyPI `dbgpt`/`dbgpt-serve`/`dbgpt-app`/`dbgpt-client` 最高 0.8.2；GitHub `eosphoros-ai/DB-GPT`
共 56 个 tag 最高 `v0.8.3`，且 main 分支版本号仍为 0.8.3、CLI 无 `mcp` 子模块；
**0.9.x 从未发布**。DB-GPT 的 MCP 方向是**客户端**（`ConnectorManager`，支持 `sse` / `streamable_http`）。

因此 MCP Server 角色由**平台侧薄适配器**承担（`deploy/compose/dbgpt/mcp_adapter.py`），
在 DB-GPT 容器内用官方 MCP Python SDK（镜像已装 `mcp 1.27.2`）把 DB-GPT 的 ChatBI 能力
按 MCP 协议（streamable-http）暴露：

| 工具 | 说明 |
|---|---|
| `chatbi.query` | 自然语言查数：DB-GPT apiserver 生成 SQL → DB-GPT 数据源只读执行 → 表格 + 图表规格 |
| `chatbi.list_metrics` | 指标口径字典（与平台侧共用 `packages/mcp-hub/src/servers/metrics.json`） |
| `chatbi.run_sql` | 执行一条只读 SQL（写操作/DDL 一律拒绝） |

工具名与平台原有 `chatbi.*` 一致，网关的 `MCP_SERVERS` 里把 `chatbi` 指向该地址即可无缝切换：

```bash
# .env
MCP_SERVERS=knowledge=http://127.0.0.1:8091/mcp,chatbi=http://127.0.0.1:8097/mcp,business=http://127.0.0.1:8093/mcp
```

调用链：平台 Agent → 网关（鉴权 / 策略 / 预算 / 护栏 / 审计）→ DB-GPT MCP Server →
DB-GPT apiserver → 网关 → MiniMax → DB-GPT 数据源只读执行。
**模型出口仍经网关**，不直连商业 API（方案 4.4）。

#### DB-GPT 作为 MCP 客户端（反向互联）

`deploy/compose/dbgpt/register_platform_mcp.py` 用**上游原生**的
`ConnectorManager.create_connector()`（`connector_type="custom_mcp"` + `transport="streamable_http"`）
把平台的 knowledge / business MCP Server 注册进 **webserver 进程**，
DB-GPT 的 agent / awesomes 即可直接调用平台工具。

> 连接器状态是**进程内**的（DB-GPT 的 `CredentialStore` 只在内存），且 MCP 会话绑定创建它的事件循环，
> 所以注册必须在 webserver 进程 + uvicorn 事件循环内完成 ——
> 实现上用 `dbgpt.util.fastapi.register_event_handler(app, "startup", handler)`
> （**不能用** `app.on_event("startup")`：DB-GPT 的 app 设了 `lifespan_context`，
> FastAPI 会静默忽略 on_event 处理器）。
> 注册结果落在容器内 `/app/logs/platform_mcp.json`，便于验收读取。
