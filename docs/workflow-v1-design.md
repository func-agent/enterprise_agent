# AI 工作流 V1 分析与设计

> 状态：设计已评审，并补齐 R1–R11 共 11 项契约。
> **阶段 A1（领域类型 / DAG 校验 / 条件求值 / JSON Schema 最小子集 / 引用解析）已实现**，
> 位于 `packages/workflow-core/`，单测见 `tests/workflow-dag.test.ts`（37 例）。
> 阶段 A2（存储层）及之后尚未开始。分支：`feat/workflow-v1`。
>
> 目标用户：需要自行搭建业务流程的普通业务人员，以及负责节点、发布和安全治理的管理员。

## 1. 设计目标

在现有平台内增加可视化 AI 工作流，让业务人员通过拖拽节点、表单配置和调试运行完成流程搭建，同时保持现有平台的统一身份、模型路由、工具治理、预算、审批和审计。

第一版的核心不是单纯画出流程图，而是形成以下闭环：

```text
模板或空白流程 → 可视化搭建 → 服务端校验 → 调试运行
              → 分级发布 → 授权使用 → 运行观测与审计
```

### 1.1 已确定的架构决策

| 决策点 | V1 口径 |
|---|---|
| 执行器位置 | 独立 `packages/workflow-core`，先由 agent-core 同进程加载，不新增微服务 |
| 可视化 | React Flow（`@xyflow/react`），DAG JSON 是服务端执行的唯一依据 |
| 业务人员权限 | 可创建私有草稿、调试和运行授权流程；共享发布受控 |
| 跨租户复用 | 可执行定义不跨租户；平台模板采用复制安装和本地资源绑定 |
| 工具审批 | 逐次工具级审批，不接受工作流级长期审批背书 |
| 身份 | 按实际运行者身份调用模型、知识和工具，不借用创建者或审批者权限 |
| 执行范围 | 有界 DAG、顺序执行、短时在线运行，支持安全恢复；不承诺跨天自动执行 |
| 网关治理 | 所有 LLM 和 MCP 调用继续经过 agentgateway，不新增旁路 |
| 节点实现版本 | 节点类型带 `implVersion`，执行器按版本分派；已发布流程不因节点语义升级而改变行为 |
| 运行并发 | 单租户、单用户同时在跑的运行数有上限，平台可配，业务用户只能调低 |
| 条件求值 | 工作流条件 AST 自带最小求值器；后续与网关策略 CEL 子集抽取共享实现 |
| Schema 校验 | 自研最小 JSON Schema 子集（type/required/properties/enum/min/max），不引入通用 JSON Schema 库 |

> 本轮评审补入的 11 项契约在文中以 **【R1】–【R11】** 标注，便于逐条追溯：
> R1 工具审批调用顺序、R2 工作流上下文透传、R3 合流输入规则、R4 节点实现版本、
> R5 运行并发上限、R6 敏感数据落点、R7 清理任务落地、R8 JSON Schema 子集、
> R9 发布接口作用域、R10 SSE 鉴权与重连、R11 部署侧影响。

### 1.2 V1 功能范围

- 工作流列表、私有草稿、版本校验、发布和授权运行。
- 可视化节点拖入、连线、配置、删除、复制、缩放和校验定位。
- 输入、LLM、知识检索、MCP 工具、条件、Agent、人工审核、输出节点。
- 单节点调试、整流调试、节点状态高亮、输入输出和错误查看。
- 运行取消、失败恢复、幂等启动和运行级限额。
- 私有、部门、租户三种可见范围。
- 平台内置模板和租户模板，安装时复制，不直接跨租户执行。
- SQLite 与 PostgreSQL 存储一致，生产以 PostgreSQL 为准。

### 1.3 明确不纳入 V1

- 任意 JavaScript、Python、Shell 或任意 HTTP 节点。
- 循环、并行执行、子流程嵌套和 Agent 反向调用工作流。
- 跨天无人值守执行、定时调度、多副本 Worker 和分布式锁。
- 第三方开放模板市场及模板自动升级。
- 跨租户直接引用可执行工作流、知识库或工具连接。
- 工作流级永久审批、跳过工具审批或自定义审批绕过标志。
- 用 React Flow 的画布状态直接代替服务端执行状态。

## 2. 现有基础与约束

### 2.1 可直接复用的能力

- `AgentRuntime` 已提供 ReAct、模型调用、工具调用和 HITL，可作为 Agent 节点的实现基础。
- `GatewayClient` 已统一封装 LLM、流式 LLM 和 MCP 调用。
- 网关已执行虚拟模型校验、租户模型白名单、策略、预算、Guardrails、Failover、审计和 Trace。
- MCP 目录和调用均按租户过滤，网关注入真实的 `tenant/user/role/dept/sensitivity` 上下文。
- 写工具审批已绑定用户、会话、Trace、工具名和规范化参数，且审批只能消费一次。
- `MetadataStore` 已提供 SQLite/PostgreSQL 双实现，可扩展工作流存储。
- 控制台已有角色导航、审批中心、模型选择、审计和 Trace 页面。

### 2.2 不能原样复用的部分

- 当前 `AgentRuntime` 是自主 ReAct 循环，不是 DAG 执行器，不能通过增加几个条件分支代替工作流状态机。
- 当前 `HitlManager.wait()` 是单次运行内轮询，默认等待 5 分钟，不适合直接承担跨天工作流等待。
- 当前 `SessionLifecycle` 使用内存 Map/Set，只适用于单 agent-core 进程，不能作为多副本协调机制。
- Keycloak access token 当前默认有效期 30 分钟，不能将长时间工作流建立在一个永久有效的用户令牌上。
- AgentRuntime 会直接读写会话消息。Agent 节点需要增加非会话持久化模式，避免工作流运行污染“最近任务”。
- 前端尚未依赖 `@xyflow/react`，实施时需显式新增依赖并锁定版本。

## 3. 角色与权限模型

### 3.1 默认角色行为

| 操作 | employee | manager | admin | platform-admin |
|---|---|---|---|---|
| 创建和编辑自己的私有草稿 | 允许 | 允许 | 允许 | 允许 |
| 以本人身份调试 | 允许 | 允许 | 允许 | 允许 |
| 运行已授权版本 | 允许 | 允许 | 允许 | 允许 |
| 查看自己的运行 | 允许 | 允许 | 允许 | 允许 |
| 分享部门或租户版本 | 提交发布申请 | 提交发布申请 | 审核并发布 | 审核并发布 |
| 审批敏感工具 | 按现有审批规则 | 按现有审批规则 | 按现有审批规则 | 按现有审批规则 |
| 查看本租户全部运行 | 不允许 | 不允许 | 允许 | 允许 |
| 管理平台模板 | 不允许 | 不允许 | 不允许 | 允许 |
| 管理节点实现和限额上限 | 不允许 | 不允许 | 不允许 | 允许 |

V1 不强制新增 Keycloak 主角色。若后续只希望部分员工搭建，可增加 `workflow-builder` scope，但不能用前端隐藏代替服务端校验。

### 3.2 所有权和可见范围

每个工作流必须保存 `tenantId`、`ownerId` 和 `visibility`：

- `private`：仅所有者和管理员可见。
- `department`：同租户、同部门用户可运行已发布版本。
- `tenant`：同租户用户可运行已发布版本。

草稿始终只有所有者和管理员可以编辑。已发布版本不可修改；再次编辑会创建新的草稿版本。

### 3.3 运行身份

- 调试时使用当前登录用户的身份。
- 正式运行时使用实际调用者的身份，不使用流程创建者身份提升权限。
- 发布者和审批者身份只用于审计，不进入模型或工具的数据权限上下文。
- 每次运行及恢复都重新校验租户、可见范围、模型、知识和工具权限。
- 用户角色或部门发生变化后，以恢复时的最新令牌权限为准，不沿用旧的更高权限。

## 4. 总体架构

```text
apps/webui
  工作流列表 / React Flow 编辑器 / 运行时间线
                    │ REST + SSE
                    ▼
agent-core
  WorkflowRoutes / WorkflowWorker / 端口适配器
                    │
                    ▼
packages/workflow-core
  DAG 校验 / 状态机 / 引用解析 / 条件求值 / 限额
                    │
          ┌─────────┼──────────┐
          ▼         ▼          ▼
      LLM 端口    Tool 端口   Store / Approval / Event 端口
          │         │          │
          └─────────┴──────────┘
                    ▼
        GatewayClient + MetadataStore + HITL
                    │
                    ▼
              agentgateway
```

### 4.1 模块职责

#### `packages/workflow-core`

只包含可独立测试的领域逻辑：

- DAG、节点、条件、运行和步骤类型。
- 定义校验和版本校验。
- 引用解析、输入输出 JSON Schema 校验。
- 顺序调度、分支和跳过传播。
- 节点重试、超时、取消、限额和恢复判断。
- Model、Tool、Agent、Approval、Store、Event 等端口接口。

不依赖 Express、React、AG-UI、Keycloak 或 Provider 实现，不直接读取环境密钥。

**A1 阶段的具体文件划分**（纯函数，无 IO）：

| 文件 | 职责 |
|---|---|
| `src/types.ts` | DAG、节点、配置、运行/步骤状态、限额、端口接口 |
| `src/limits.ts` | 平台默认限额与业务可调范围 |
| `src/refs.ts` | `$ref` 解析与祖先可达性判定 |
| `src/schema.ts` | JSON Schema 最小子集的校验器（R8） |
| `src/condition.ts` | 条件 AST 类型与自带求值器（5.2） |
| `src/validate.ts` | 图校验器（5.3、R4 的实现版本白名单） |
| `src/index.ts` | 对外导出 |

#### `packages/agent-core/src/workflow`

- REST/SSE 路由和身份校验。
- `GatewayClient` 的 LLM、知识和工具端口实现。
- AgentRuntime 的 Agent 节点适配器。
- ApprovalRequest、审批唤醒和运行事件适配。
- 单进程 Worker、启动时中断标记和恢复控制。

#### `packages/platform-core`

- 工作流共享记录类型和 `MetadataStore` 扩展。
- SQLite/PostgreSQL 表结构、查询和乐观锁实现。
- 配置项、日志脱敏和保留策略。

#### `apps/webui`

- 工作流列表、版本和模板页面。
- React Flow 编辑器、节点配置表单和规则编辑器。
- 运行状态画布、节点详情和错误定位。

## 5. DAG 定义契约

### 5.1 顶层结构

```json
{
  "schemaVersion": 1,
  "name": "制度审查",
  "description": "检索制度并生成审查意见",
  "inputSchema": {
    "type": "object",
    "required": ["question"],
    "properties": {
      "question": { "type": "string", "description": "审查问题" }
    }
  },
  "nodes": [],
  "edges": [],
  "limits": {
    "maxSteps": 50,
    "maxLlmCalls": 10,
    "maxToolCalls": 10,
    "timeoutMs": 900000,
    "approvalTimeoutMs": 300000
  }
}
```

数据库记录拥有独立的 `workflowId` 和 `version`，不允许由客户端在 DAG 内覆盖租户、所有者或身份。

节点公共字段：

```json
{
  "id": "review",
  "type": "llm",
  "implVersion": 1,
  "name": "AI 审查",
  "position": { "x": 420, "y": 120 },
  "config": {},
  "inputSchema": {},
  "outputSchema": {}
}
```

**【R4】节点实现版本（`implVersion`）**

已发布版本不可变，但**节点语义本身会演进**。若 V1.1 改了 `llm` 节点的 `config` 结构或输出字段，
老流程用新实现执行就会静默跑偏或直接报错 —— 所以版本号必须落在**节点类型**上，而不是只靠顶层 `schemaVersion`。

- 每个节点带 `implVersion`（正整数）。缺省视为 `1`，但**落库时必须显式写入**，不依赖缺省推断。
- 执行器按 `(type, implVersion)` 分派到具体实现；未知组合在**发布校验**阶段就应被拒绝，
  不能等到运行期才失败。
- 顶层 `schemaVersion` 管的是**定义结构**（字段增删、引用语法、边结构），
  `implVersion` 管的是**单个节点的执行语义**，两者独立演进。
- 语义不兼容的节点改动必须**提升 `implVersion`**，旧的实现保留至少一个兼容周期，
  到期后老流程显式标记为"需要迁移"，而不是悄悄按新语义执行。
- 只增不改（纯新增可选字段、输出字段追加）可以不提升版本；
  判定标准是：**老流程在新实现下的行为是否可能改变**。
- 校验器需要维护一张「已支持的 `(type, implVersion)` 白名单」，
  这张表随平台版本发布，模板与草稿的发布校验都查它。

边公共字段：

```json
{
  "id": "edge-risk-true",
  "source": "risk",
  "target": "manual-review",
  "branch": "true"
}
```

`position` 仅用于展示，不参与执行语义。节点 ID 使用受限字符串，不能包含 `.`、空白或控制字符，避免与引用路径冲突。

### 5.2 值引用和条件

V1 只支持字面量和受限引用：

```json
[
  { "$ref": "input.question" },
  { "$ref": "nodes.review.output.risk" }
]
```

- 工具参数可递归包含受限引用。
- LLM 提示词由文本片段和引用片段组成，执行器负责拼接。
- 引用必须指向真实存在的上游节点和已声明输出字段。
- 禁止引用下游节点、密钥、原始令牌和任意环境变量。

条件由业务规则编辑器生成结构化 AST，例如：

```json
{
  "all": [
    { "left": { "$ref": "nodes.review.output.risk" }, "operator": "eq", "right": "high" },
    { "left": { "$ref": "nodes.review.output.score" }, "operator": "gte", "right": 80 }
  ]
}
```

服务端不接收业务用户提交的任意 JavaScript。实施时可将条件 AST 编译到现有 CEL 子集，并抽取共享求值器供 gateway 与 workflow-core 使用；编译器负责字段白名单和字面量转义。

**V1 的落地口径**：A1 阶段在 `workflow-core` 内实现**自带**的最小条件求值器
（只支持结构化 AST 里的比较/逻辑算子，不接受字符串表达式），保证 A1 不依赖 gateway 包。
到 D 阶段再把两边的求值能力抽取为共享实现（`platform-core`），
gateway 的策略 CEL 与工作流条件共用同一套转义与白名单规则。
**在此之前，workflow-core 不得 import gateway 的 `policy/cel.ts`** —— 那会造成包依赖倒置。

### 5.3 图校验

发布和每次运行前均执行服务端校验：

- `schemaVersion` 必须受支持，节点 ID 和边 ID 唯一。
- 恰好一个输入节点和一个输出节点。
- 节点类型、配置、输入输出 Schema 和引用合法。
- 边两端存在，不允许自环、重复边和循环。
- 所有节点从输入可达，并且能到达输出节点。
- 条件节点必须明确 `true`、`false` 两类出口。
- 模型、知识库和工具必须是当前用户可用的逻辑资源。
- 节点数、边数、提示词、输入和输出大小不得超过平台上限。
- 已发布版本必须再次校验，不能只信任发布时的结果。

**【R8】JSON Schema 校验采用自研最小子集**

文档多处要求「输入输出 JSON Schema 校验」，但 V1 **不引入通用 JSON Schema 库**
（与仓库「自研等价实现、避免引入重型依赖」的既有风格一致，也避免业务用户用任意 Schema
表达超出平台能力的约束）。只支持下列关键字，其余一律在校验时拒绝：

| 关键字 | 支持 | 说明 |
|---|---|---|
| `type` | ✅ | `string` / `number` / `integer` / `boolean` / `object` / `array` |
| `properties` | ✅ | 对象字段声明 |
| `required` | ✅ | 必填字段 |
| `enum` | ✅ | 枚举取值 |
| `minLength` / `maxLength` | ✅ | 字符串长度 |
| `minimum` / `maximum` | ✅ | 数值范围 |
| `items` | ✅ | 数组元素 Schema（仅支持对象/标量，不支持嵌套组合关键字） |
| `additionalProperties` | ✅ | 仅支持 `false`（禁止未声明字段） |

- **不支持**：`$ref` / `allOf` / `anyOf` / `oneOf` / `not` / `patternProperties` / `format` / `if-then-else` 等。
  遇到未支持关键字时，**发布校验直接报错**（而不是忽略），避免"以为生效其实没校验"。
- `pattern`（正则）也**不支持**：业务用户提交的正则会带来 ReDoS 风险，V1 一律拒绝。
- 校验器是纯函数、无 IO，可独立单测；输入输出两侧共用同一套实现。
- Schema 体积本身也受限（默认 32 KiB），避免超大 Schema 拖慢发布校验。

## 6. 节点契约

### 6.1 输入节点

定义运行表单和输入 JSON Schema。业务人员可配置字符串、数字、布尔、枚举和受限文本字段。文件上传和任意二进制输入不纳入 V1。

### 6.2 LLM 节点

配置：

- 虚拟模型名，不允许填写真实 Provider、Base URL 或 API Key。
- 系统提示词、用户提示词和变量引用。
- 最大输出 Token 和结构化输出 Schema。

输出统一为 `{ text, structured?, promptTokens, completionTokens, model, traceId }`。实际 Provider 和 Failover 仍以网关结果为准。

### 6.3 知识检索节点

V1 使用受治理的 `knowledge.search`，配置查询、Top-K 和可选知识范围。输出统一归一为 `{ text, sources }`，屏蔽 MCP 传输细节。权限过滤继续由网关和 MCP 完成。

### 6.4 MCP 工具节点

- 只能从后端按当前租户和角色返回的节点目录中选择。
- 保存逻辑 `serverId/tool` 和参数映射，不允许覆盖 `__ctx`。
- `requiresConfirmation` 由工具目录决定，流程定义不能修改。
- 写工具没有自动重试；运输结果不明时禁止直接重放。
- 输出保存为 `{ ok, content, structured, reason, traceId }`。

**【R1】审批调用顺序（必须复刻现有 Agent 路径，顺序不可颠倒）**

写工具节点的执行顺序固定为：

```text
1. 解析参数 → 2. 生成审批单 → 3. 等待审批 → 4. 带 approval_id 调用网关 → 5. 原子消费
```

- **第 2 步由工作流自己创建审批单**，调用 `HitlManager.request({ identity, sessionId, traceId, tool, args, reason })`
  或等价的 `MetadataStore.createApproval`，**不是**调用网关后等它返回 `confirmation_required`。
  网关只做校验与原子消费，**从不创建审批单**；若工作流直接调 MCP 而不先建单，
  `registry.ts` 的校验必然失败，运行会永远卡在「需要审批」。
- 第 3 步支持两种形态：短时等待（在线轮询）与持久化等待（写入 `waiting_approval` 后交还 Worker）。
- 第 4 步的 `trace_id` / `session_id` / `approval_id` / `app_id` **必须与审批单中的值逐项相同**，
  网关会校验 `tenant + user + session + trace + tool + canonicalArgs` 全等并原子消费为 `executed`。
- **参数必须在挂起前定稿**：审批单保存的是规范化参数摘要，挂起后再改参数会导致
  `canonicalJson(args)` 不相等而被拒绝。
- 两个网关端口的传参位置不同，必须分别实现：
  - `/v1/mcp/call`：`trace_id` / `session_id` / `approval_id` / `app_id` **只从 body 读取**，无 header 兜底；
  - `/v1/chat/completions`：`session_id` / `app_id` 可来自 body 或 `X-Session-Id` / `X-App-Id` header。
- `sessionId` 约定：工作流运行用 `workflowRunId`；Agent 节点内部用 `runId:nodeId`；
  两者不可混用，否则审批单与实际调用的 `sessionId` 不匹配。

### 6.5 条件节点

根据条件 AST 选择 `true` 或 `false` 出口。条件输入只能是 JSON 值，不允许执行函数或访问网络。

### 6.6 Agent 节点

复用现有 ReAct 能力，配置虚拟模型、任务指令、最大迭代和允许的工具子集。

实施时需要为 AgentRuntime 增加工作流执行模式：

- 不写入普通 sessions/messages，避免出现在“最近任务”。
- 使用 `runId:nodeId` 作为内部工具和审批关联 ID。
- 保留独立 Agent Trace，并与工作流根 Trace 关联。
- 禁止 Agent 调用工作流本身，防止递归执行。
- 输出归一为 `{ content, toolCalls, traceId }`。

### 6.7 人工审核节点

用于“内容是否通过”和后续分支，不代表后续工具已获执行授权。

- 审核标题、说明、内容摘要和通过/驳回分支。
- 复用 ApprovalRequest 和审批中心，可增加 `resourceType=workflow`、`resourceId=runId:nodeId`。
- 审批单只保存必要摘要，不保存完整敏感正文。
- 后续写工具仍需自己的工具级审批。
- 若目的只是批准一次固定写操作，应直接使用工具审批，避免重复配置人工审核节点。

### 6.8 输出节点

声明最终文本或 JSON 输出。所有到达输出节点的数据必须通过输出 Schema 和大小校验。

## 7. 执行语义

### 7.1 状态模型

工作流运行状态：

```text
queued → running → succeeded
                 → failed
                 → cancelled
                 → interrupted
                 ⇄ waiting_approval
```

节点状态：

```text
pending → running → succeeded
                  → failed
                  → skipped
                  → waiting_approval
```

`interrupted` 表示进程重启、身份过期或可恢复执行中断，不等于业务失败。

### 7.2 顺序调度和分支合并

- V1 不并行执行节点；就绪节点按稳定拓扑顺序逐个执行。
- 普通节点的所有有效出口都被选中。
- 条件节点只选择一个出口。
- 多前驱节点必须等待所有直接前驱进入终态。
- 至少一条入边被选中时节点执行；全部入边未选中时节点标记 `skipped`。
- 跳过状态沿 DAG 向下传播，避免条件分支合流时永久等待。
- 默认任一节点失败即停止调度新节点；V1 不开放 `continueOnError`。

**【R3】合流节点的输入合流规则**

多个前驱都执行时，下游节点的输入如何合成，必须有确定规则，不能靠实现者临场决定。

- **命名空间天然隔离**：节点输出以 `nodes.<nodeId>.output.<field>` 引用，
  不同前驱的字段路径不同，**不存在同名冲突**，合流无需做冲突消解。
- **引用可寻址**：合流节点在配置里逐字段声明需要哪个前驱的哪个字段，
  例如 `{"from": "nodes.retrieve.output.text", "to": "context"}`；
  校验器负责确认 `from` 指向的节点确实是本节点的**祖先**（不可引用下游或旁支节点）。
- **缺失字段语义**：引用路径解析不到值时——
  - 被跳过（`skipped`）的前驱，其输出视为**不存在**，引用它等价于"未提供"；
  - 未提供与提供 `null` **不等价**，下游取不到值就是取不到值；
  - 若该引用在节点的 `inputSchema` 中是 `required`，则节点进入 `failed`
    并给出明确错误码 `missing_input`，**不得**静默填默认值。
- **合并语义是"按引用取值"，不是"深度合并"**：合流节点的输入 = 其声明引用的取值集合，
  不做对象展开、不做数组拼接、不做隐式同名覆盖。
- **旁支未被选中**：若某条入边未被选中（条件走了另一支），该前驱的输出不参与合流，
  但只要本节点至少有**一条**入边被选中，本节点照常执行 —— 前提是它的必填引用全部可解析，
  否则按上一条失败规则处理。
- **合流不等于并行**：因为不并行执行，合流节点总是等齐所有前驱终态后才启动，
  判定「是否执行」只看入边是否被选中，判定「能否执行」看必填引用是否可解析，两者分开判断。

### 7.3 启动和幂等

1. 校验流程版本、可见范围和输入 Schema。
2. 固化 `workflowId/version`、完整定义快照、输入、运行者身份摘要和根 Trace；调试运行同样绑定启动时的草稿快照。
3. 以 `tenantId + workflowId + initiatorId + idempotencyKey` 防止重复启动。
4. 创建 run 和全部 pending step 后才允许 Worker 执行。
5. 每个节点先持久化 `running`，再调用外部能力；成功后持久化输出和状态。

相同幂等键返回原运行，不创建第二次副作用。

### 7.4 重试和超时

- LLM、知识和明确只读的工具最多允许有限重试，默认不超过 2 次。
- 身份失败、策略拒绝、预算拒绝、参数校验失败不重试。
- 网关 Failover 与工作流重试分别计数，避免形成多层放大。
- 写工具不自动重试；审批只能消费一次。
- 每个节点和整个运行都有超时，取消通过 AbortController 传递到模型调用。
- 写请求已经发出后发生断连或崩溃，结果视为不确定，必须人工核查，不能自动重放。

### 7.5 默认限额

以下为产品默认值，实施时通过配置覆盖，但业务用户只能调低、不能突破平台上限：

| 限额 | 默认值 |
|---|---:|
| 单流程节点数 | 50 |
| 单次运行步骤数 | 50 |
| LLM 调用次数 | 10 |
| MCP 工具调用次数 | 10 |
| Agent 单节点迭代数 | 不超过现有平台上限 |
| 单次运行时长 | 15 分钟 |
| 单次审批等待 | 5 分钟，且不超过运行总时限 |
| 单节点输入/输出 | 64 KiB |
| 单次运行持久化状态总量 | 1 MiB |

现有平台、租户和应用预算继续生效。V1 的运行级限额主要限制调用次数、Token 和时长；精确的运行级美元预算需要网关返回统一成本结果后再增加。

**【R5】运行并发上限**

上表限制的是**单次运行**的开销，但不同 `idempotencyKey` 可以无限并发地发起运行，
每个运行都会占用 LLM 配额、预算和 Worker 执行槽。因此还需要**并发维度**的上限：

| 并发限额 | 默认值 | 说明 |
|---|---:|---|
| 单租户同时在跑的运行数 | 20 | 覆盖 `queued` / `running` / `waiting_approval` |
| 单用户同时在跑的运行数 | 3 | 防止单人占满租户额度 |
| 单工作流同时在跑的运行数 | 5 | 同一流程版本并发压测保护 |

- 实现方式复用现有 Redis 窗口机制（网关 `llm/budget.ts` 的 `eap:qps:<appId>` 模式），
  按 `eap:wf:concurrent:tenant:<tenantId>` / `...:user:<userId>` / `...:workflow:<workflowId>` 计数。
- 计数在运行进入终态时释放；进程重启后由启动时的运行表扫描重建，
  否则计数会因崩溃泄漏而逐步收紧到"谁都跑不了"。
- 超出上限时返回明确错误码 `too_many_running_runs`，**不排队**（V1 不做运行队列），
  客户端可稍后重试。
- 业务用户只能调低、不能突破平台上限，与 7.5 的口径一致。
- 等待人工审批的运行**计入并发**（它仍占着额度），但审批等待超时后必须释放。

## 8. 审批、身份时效与恢复

### 8.1 工具级审批

工作流工具审批沿用现有网关校验：

```text
tenant + user + session/run + trace + tool + canonicalArgs
```

V1 约定：

- `sessionId` 使用 `workflowRunId`，Agent 节点内部使用 `runId:nodeId`。
- 每次运行生成根 `traceId`，工具审批与实际调用使用同一 Trace。
- `appId` 只在绑定真实 Application 时传递，不伪造应用 ID。
- 审批被消费后不能重放。
- 审批节点、发布审批和启动审批均不能替代工具审批。
- V1 不实现运行清单级批量授权。

### 8.2 access token 处理

- access token 只保存在当前 Worker 的内存执行上下文，不写数据库、运行事件、审计或 Trace。
- 正常运行和短时审批等待期间，审批结果通过 Worker 唤醒执行器，不需要一直保持浏览器 HTTP 请求。
- 不保存用户 refresh token，不使用管理员服务账号冒充运行者。
- 身份过期或服务重启导致无法继续时，运行进入 `interrupted`。

### 8.3 安全恢复

发起人或具有明确权限的管理员可调用恢复接口：

- 使用当前请求的最新用户令牌重新建立执行上下文。
- 用户 `sub` 和租户必须与原运行一致，并重新校验全部权限。
- 已成功节点不重复执行，从第一个可恢复节点继续。
- 仍处于 pending 的审批继续等待；已批准审批按原参数摘要核验。
- 角色、部门或密级变化后的调用使用最新权限并记录恢复审计。
- 存在不确定写副作用时禁止自动恢复，必须人工确认外部系统状态。

跨天无人值守、服务重启后自动恢复和多副本协调留给 Temporal 等持久化执行底座，不在 V1 伪装支持。

## 9. 存储设计

建议增加以下逻辑表，字段在 SQLite/PostgreSQL 实现中保持同构。

### 9.1 `workflows`

- `id`、`tenant_id`、`owner_id`、`name`、`description`。
- `visibility`、`current_draft_version`、`latest_published_version`。
- `created_at`、`updated_at`、`deleted_at`。

### 9.2 `workflow_versions`

- `workflow_id`、`version`、`tenant_id`。
- `definition_json`、`checksum`、`status`：`draft / in_review / published / rejected`。
- `created_by`、`created_at`、`reviewed_by`、`reviewed_at`、`review_comment`、`published_by`、`published_at`。

已发布版本不可更新或随工作流删除而物理清除，历史运行必须可追溯。普通用户提交审核后草稿锁定；管理员驳回时记录意见并重新开放草稿，审核通过时将该版本转为不可变的已发布版本。

### 9.3 `workflow_runs`

- `id`、`tenant_id`、`workflow_id`、`workflow_version`。
- `initiator_id`、`identity_snapshot`、`input_json`、`definition_snapshot`、`mode`、`status`。
- `mode` 为 `debug / published`；`trace_id`、`idempotency_key`、`lock_version`。
- `error_code`、`error_message`、`created_at`、`started_at`、`ended_at`、`updated_at`、`expires_at`。

`identity_snapshot` 只保留审计所需身份字段，不包含令牌。`lock_version` 用于状态转换的乐观锁。

### 9.4 `workflow_step_runs`

- `id`、`run_id`、`node_id`、`attempt`、`status`。
- `input_json`、`output_json`、`error_code`、`error_message`。
- `approval_id`、`idempotency_key`、`side_effect_unknown`。
- `started_at`、`ended_at`、`updated_at`。

### 9.5 模板表

平台和租户模板使用独立表，不使用特殊租户 ID 混入普通工作流查询：

- `workflow_templates`：模板归属、名称、说明、可见性和状态。
- `workflow_template_versions`：不可变定义、资源槽位、版本、校验和及发布信息。

必要索引：

- 工作流：`tenant_id + owner_id + updated_at`。
- 版本：`workflow_id + version` 唯一。
- 运行：`tenant_id + initiator_id + created_at`。
- 幂等：`tenant_id + workflow_id + initiator_id + idempotency_key` 唯一。
- 步骤：`run_id + node_id` 唯一。

运行输入和节点输出可能包含敏感业务数据，应设置保留期限和清理任务。V1 默认建议保留 30 天并由部署侧配置；审计和 Trace 仍按平台既有保留策略执行。日志与审计展示继续脱敏，执行数据接口必须按租户和所有权授权。

**【R6】敏感数据在工作流存储、Trace 与审计中的落点**

一次运行的数据会同时出现在三处，落点和保留期必须分别定义，不能含糊带过：

| 位置 | 存什么 | 脱敏 | 保留期 |
|---|---|---|---|
| `workflow_runs.input_json` | 启动输入 | **不做**（受存储加密与访问控制保护） | 30 天，可配 |
| `workflow_runs.definition_snapshot` | 定义快照 | 不做 | 30 天，可配 |
| `workflow_step_runs.input_json` / `output_json` | 节点输入输出 | 不做 | 30 天，可配 |
| `traces.input` / `traces.output` | Trace 记录 | **必须截断 + 脱敏**，与 chat 路由同口径 | 平台既有策略 |
| `audit_events.detail` | 审计明细 | 走既有 PII 掩码 | 平台既有策略 |

- 工作流节点的 Trace **不得写入完整输入输出**，按与 `chat.ts` 相同的规则截断并脱敏；
  否则工作流会成为绕过 Trace 脱敏的旁路。
- **`definition_snapshot` 的存储策略**：`published` 模式的运行只存 `workflow_version` 引用 +
  `checksum`，不存完整定义快照（版本本身不可变，随时可回查）；
  只有 `debug` 模式存快照（草稿随时会变，不存就复现不了）。
  这样 `workflow_runs` 不会随运行次数线性膨胀。
- `definition_snapshot` 若确实存在（debug 模式），其体积计入「单次运行持久化状态总量 1 MiB」。
- 执行数据接口（`GET /api/workflow-runs/:id`）必须按**租户 + 所有权**授权：
  运行者本人、同工作流的管理员、以及该租户的管理员可见；跨租户一律 404。

**【R7】清理任务的落地位置**

「保留 30 天」需要一个真正会被执行的清理动作，不能只写在文档里。

- 实现为**部署侧可配置的运维脚本**（沿用仓库 `scripts/` 下既有运维脚本范式），由外部调度器定时调用，
  而不是在 workflow-core 里塞一个定时器（与「不新增微服务、不引入分布式调度」的 V1 口径冲突）。
- 清理范围：`workflow_runs` / `workflow_step_runs` 中 `created_at` 超过保留期的记录；
  幂等记录单独按更短的 TTL 清理（默认 7 天），避免唯一索引无限增长。
- 清理必须**跳过仍在等待审批或仍在运行中的记录**，不能把活跃运行删掉。
- 已发布版本、`workflow_versions` 与审计证据**不随运行清理而删除**。
- 清理脚本本身要输出清理条数与跳过的条数，纳入运维巡检。

## 10. API 契约草案

所有接口挂在现有 `authMiddleware` 后，使用统一错误结构，身份只从令牌获取。

### 10.1 工作流与版本

```text
GET    /api/workflows
POST   /api/workflows
GET    /api/workflows/:id
PUT    /api/workflows/:id/draft
POST   /api/workflows/:id/validate
POST   /api/workflows/:id/submit-review
POST   /api/workflows/:id/review
POST   /api/workflows/:id/publish
GET    /api/workflows/:id/versions/:version
DELETE /api/workflows/:id
```

- `PUT` 仅修改自己的草稿。
- `submit-review` 由草稿所有者发起，锁定当前草稿并记录待审核版本。
- `review` 仅 admin/platform-admin，驳回时返回修改意见，通过时发布该版本；发布审核不复用工具 ApprovalRequest，避免 manager 通过通用审批接口越权发布。
- `publish` 仅 admin/platform-admin 用于直接发布自己维护的草稿，发布内容包含版本摘要和可见范围。
- `DELETE` 采用软删除，不删除已发布版本和历史运行。

**【R9】发布类接口的作用域边界**

`review` 与 `publish` 是两条不同的路径，作用域必须写死，否则 admin 之间会互相覆盖：

| 接口 | 允许的调用者 | 作用对象 | 副作用 |
|---|---|---|---|
| `submit-review` | 草稿所有者 | 自己的当前草稿 | 锁定草稿，进入待审核 |
| `review` | admin / platform-admin | **别人提交**的待审核版本 | 通过即发布；驳回记录意见并解锁草稿 |
| `publish` | admin / platform-admin | **自己维护**的草稿 | 直接发布，不经审核流 |

- `publish` **不能**发布他人所有的草稿 —— 别人共享版本必须走 `submit-review` → `review`，
  这样发布行为始终有"作者 + 审核人"两个主体可追溯。
- `review` 只能处理 `status = in_review` 的版本；不能对 `draft` 或 `published` 版本调用。
- **审核人不能是作者本人**：提交审核的版本，其作者不得审核自己的版本（自审自发），
  否则"作者 + 审核人"的双主体约束失效。admin 提交自己的草稿时，只能走 `publish`。
- 平台管理员**不能**绕过审核直接 `publish` 他人的草稿；需要他人在此场景下发布时，
  由他人自己提交审核，或平台管理员代为修订后以自己的身份重新提交。
- 版本号在发布时由服务端分配（同一工作流内单调递增），**不接受客户端指定版本号**。
- 发布动作写管理审计（`workflow.publish`），detail 记录 `workflowId / version / visibility / actorId`。

### 10.2 运行

```text
POST /api/workflows/:id/debug-runs
POST /api/workflows/:id/runs
GET  /api/workflow-runs/:id
GET  /api/workflow-runs/:id/events
POST /api/workflow-runs/:id/cancel
POST /api/workflow-runs/:id/resume
```

正式启动请求：

```json
{
  "version": 1,
  "input": { "question": "请审查这份制度" },
  "idempotencyKey": "client-generated-unique-key"
}
```

`debug-runs` 仅允许草稿所有者调用，额外支持可选 `nodeId`，并保存启动时的草稿定义快照；正式发布运行只能指定已发布版本。两种运行共用状态机和限额，调试模式不会改变工具审批要求。

`events` 使用 SSE 推送运行快照和节点状态变化，重连时先发送最新快照。V1 不依赖 AG-UI 驱动画布；后续从对话启动工作流时，再映射 AG-UI CUSTOM 事件。

**【R10】SSE 的鉴权与重连机制**

浏览器原生 `EventSource` **无法携带 `Authorization` 头**，而工作流事件流必须鉴权，
所以不能用原生 `EventSource` 直连。

- **传输方式**：前端用 `fetch()` + `ReadableStream` 手工解析 SSE 帧
  （`data: {json}\n\n`），并显式带上 `Authorization: Bearer <token>`；
  或复用现有 `@ag-ui/client` 的 HttpAgent（它支持自定义头）。
  **不得**为了省事改成把令牌放进 query string（会进网关访问日志与浏览器历史）。
- **鉴权时机**：SSE 建立时校验一次；连接期间令牌过期不主动断开，
  但客户端在收到 `unauthorized` 事件后应重新登录并重连。
- **首帧是快照**：连接建立后**先发一帧完整快照**（运行状态 + 全部节点状态 + 当前步骤），
  再推增量；这样断线重连不需要客户端补历史，天然幂等。
- **心跳**：服务端每 15 秒发一个注释帧（`: ping`）防止中间代理断连；
  客户端 40 秒未收到任何帧即视为断开并重连（重连上限 5 次，之后退化为轮询运行详情）。
- **事件类型**（与现有 AG-UI CUSTOM 命名保持一致的字段风格，但**不混入 AG-UI 协议**）：
  `snapshot` / `run_status` / `step_status` / `approval_pending` / `approval_decided` / `error` / `done`。
- **越权防护**：订阅某个运行前先做租户 + 所有权校验，无权访问直接 404（不泄露"存在但无权"）。
- SSE 连接不计入运行并发（只是观察通道），但要限制**同一运行的并发订阅数**（默认 5）。

### 10.3 模板

```text
GET  /api/workflow-templates
POST /api/workflow-templates/:id/install
```

平台模板管理接口仅允许 platform-admin。安装操作在调用者租户内创建新草稿并返回需要绑定的资源槽位。

## 11. 前端设计

### 11.1 页面结构

新增“工作流”业务导航，而不是放入仅管理员可见的“管理与运维”。

包含三视图：

1. **流程列表**：我的草稿、可运行流程、模板入口和运行记录。
2. **流程编辑器**：左节点栏、中间画布、右配置栏、顶部校验/调试/发布。
3. **运行详情**：画布状态、步骤时间线、输入输出、错误、审批和 Trace。

### 11.2 业务易用性

- 节点名称和业务说明使用自然语言，隐藏 Provider、MCP 传输和 CEL 细节。
- 条件使用字段、操作符和值的规则编辑器。
- 变量通过上游字段选择器插入，不要求手写 `$ref`。
- 校验错误可定位到具体节点和字段。
- 支持单节点模拟输入调试和整流调试。
- 发布版本在画布中只读，编辑时明确创建新草稿。
- 离开未保存页面前提示，运行期间禁止修改运行所绑定版本。
- 拖拽之外提供“添加节点”和“连接节点”表单，保证键盘可操作性。

### 11.3 性能与依赖

- 新增 `@xyflow/react` 并锁定版本，不引入完整低代码平台。
- 工作流编辑器独立 lazy chunk，避免继续增大现有 ChatPage 包。
- 大节点输出默认截断展示，完整内容按需授权获取。
- SSE 断线只恢复状态快照，不在浏览器保存访问令牌以外的工作流敏感数据。

## 12. 模板和资源绑定

模板只包含流程结构和资源槽位，不包含租户物理资源。

资源槽位示例：

- `modelSlot`：需要一个当前租户可用的对话虚拟模型。
- `knowledgeSlot`：需要调用者有权访问的知识范围。
- `toolSlot`：需要匹配指定输入输出 Schema 的逻辑工具。

安装时：

1. 复制指定模板版本为租户内草稿。
2. 记录 `templateId/templateVersion/sourceChecksum`。
3. 要求用户选择本地资源，后端验证权限和 Schema 兼容性。
4. 未绑定完成前只能保存，不能发布或运行。
5. 模板更新只提示差异，不自动改变已安装、已发布或运行中的流程。

V1 仅开放平台和租户受信模板，第三方市场需要额外的内容审核和安全签名机制。

## 13. 审计、Trace 与安全

- 流程创建、修改、发布、删除、启动、取消、恢复和模板安装均写管理审计。
- LLM 和工具调用继续使用现有网关审计，并附加 `workflowId/runId/nodeId`。
- 每次运行使用根 Trace；Agent 节点保留子 Trace 关联。
- 审计和界面错误不暴露 Provider 密钥、访问令牌或完整敏感输入输出。
- 工作流节点输出按文本渲染，不能注入 HTML 或脚本。
- 工具节点不能覆盖网关注入的 `__ctx`。
- 知识、模型和工具在发布、启动和恢复三个时点都重新校验。
- 平台模板视为可执行内容，只能由受信管理员发布。
- 删除工作流不删除审计、Trace 或历史运行证据。

**【R2】工作流上下文的网关透传通道**

「附加 `workflowId/runId/nodeId`」需要网关侧有一条明确的承载路径。现状：

- `audit_events` 表**没有** `workflow_id` / `run_id` / `node_id` 三列，只有 `detail` jsonb 可承载；
- 网关目前只识别 `X-Session-Id` / `X-App-Id` 两个自定义 header（`chat.ts`），`/v1/mcp/call` 则全部走 body。

因此 V1 必须实现：

| 通道 | 传参方式 | 说明 |
|---|---|---|
| `/v1/chat/completions` | 新增 header `X-EAP-Workflow-Run` / `X-EAP-Workflow-Node` | 与既有 `X-Session-Id` / `X-App-Id` 同级 |
| `/v1/mcp/call` | 新增 body 字段 `workflow_run_id` / `workflow_node_id` | 该路由只从 body 取参，不引入 header 分支 |
| `audit_events` | 写入 `detail` jsonb 的 `workflowId` / `runId` / `nodeId` | 不新增列，避免影响既有审计查询与索引 |

约束：

- 这三个值**只用于审计与 Trace 关联，不参与任何权限判定**；授权一律以网关注入的真实身份为准。
- 网关必须对这三个值做长度与字符白名单校验（禁止换行、禁止超长），避免污染日志与审计。
- `detail` 会经过既有 PII 掩码，落库形态是掩码后的值；这是预期行为，不要绕开。
- 平台侧的「按工作流筛选运行」接口以 `detail->>'runId'` 索引查询，索引随 9.x 的表结构一并建立。

## 14. 测试与验收设计

### 14.1 单元测试

- DAG：重复 ID、悬空边、环、不可达节点、非法引用和 Schema 错误。
- 调度：顺序、条件、合流、跳过传播、失败停止和输出到达。
- 重试：只读重试、不可重试错误、写工具禁止重放。
- 幂等：重复启动、审批重放和状态乐观锁。
- 恢复：成功节点不重复、身份变化重新授权、不确定写操作阻止恢复。
- 条件 AST：操作符、类型、转义和拒绝任意表达式。
- SQLite/PostgreSQL 契约一致性。

### 14.2 接口与安全测试

- 私有、部门、租户可见范围及跨租户拒绝。
- 普通用户可建私有草稿，但不能发布共享版本或读取他人运行。
- 伪造身份、租户、模型、工具、`__ctx` 和审批 ID 均被拒绝。
- 已发布版本不可修改，删除后历史运行仍可追溯。
- 取消、超时、身份过期、服务重启和恢复路径。
- 运行限额、输入输出上限及敏感信息不落日志。

### 14.3 浏览器验收

使用拦截模型响应，不调用真实商业模型：

1. 业务用户从模板创建私有流程，拖入节点、连线并完成表单配置。
2. 校验错误能定位节点，修正后单节点和整流调试成功。
3. 普通用户可提交发布审核但不能直接发布或审核；管理员通过后，授权用户可运行。
4. 条件真假分支、合流和跳过状态在画布中显示正确。
5. 写工具在审批前不执行，批准后仅执行一次，重复审批不能重放。
6. 取消、失败、SSE 重连和刷新后的状态恢复正确。
7. 深浅色、常用桌面分辨率和键盘操作可用。

### 14.4 V1 完成标准

至少完成两条端到端路径：

- **只读流程**：输入问题 → 知识检索 → LLM → 条件 → 输出。
- **审批流程**：输入内容 → LLM → 人工审核 → 需审批的写工具 → 输出。

同时满足：完整测试和构建通过、无跨租户越权、无网关旁路、无工作流级审批绕过、无不明确副作用自动重放。

## 15. 实施拆分

### 阶段 A：领域和存储底座

- 新增 workflow-core 类型、DAG 校验、状态机和端口。
- 扩展 MetadataStore 及 SQLite/PostgreSQL 表。
- 先完成单元测试，不接 UI。

**【R11】部署侧影响与阶段 A 拆分**

**部署侧影响**（工作流 Worker 与 agent-core 同进程，必须在部署层显式承认）：

- agent-core 的 Helm 副本数目前是 **1**（`deploy/helm/values.yaml` 的 `appLayer.agentCore.replicaCount`），
  且 **PDB 关闭** —— 原因是会话运行/删除互斥只在进程内成立。
  工作流 Worker 跑在同一进程内，因此**工作流的并发能力同样被单副本约束**；
  这不是 bug，是 V1「不承诺多副本」口径的必然结果，但必须在部署文档里写明。
- agent-core 重启会让所有 `waiting_approval` 的运行转入 `interrupted`。
  控制台必须提供**醒目的「恢复」入口**，并列出全部中断运行，
  否则用户只看到"卡住"却不知道为什么、也不知道怎么继续。
- 建议加一个**中断运行巡检**：启动时扫描 `interrupted` / 长时间 `waiting_approval` 的运行并告警。
- 由于 Worker 在 agent-core 进程内，`workflow-core` 的内存占用与 agent-core 共享；
  运行级限额（R5）也是防止 Worker 被拖垮的保护。

**阶段 A 拆成三步，逐步可评审**（原「阶段 A」一次做完体量过大）：

| 子阶段 | 内容 | 验收 | 依赖 |
|---|---|---|---|
| **A1** | `packages/workflow-core` 类型定义、DAG 校验器、条件 AST 与求值、JSON Schema 最小子集、引用解析 | 纯单测，不引入存储、不接 UI | 无，可立即开工 |
| **A2** | `MetadataStore` 扩展 + SQLite/PostgreSQL 双实现 + 表结构与索引 + 两端契约一致性测试 | 存储契约测试通过 | A1 的类型 |
| **A3** | 状态机、顺序调度、分支与跳过传播、重试/超时/取消、限额与幂等（端口用 mock） | 调度与状态机单测 | A1 + A2 |

- A1 是**纯函数**领域逻辑，不依赖存储、Express、React、AG-UI、Keycloak 或任何 Provider 实现，
  可以脱离其余部分独立评审与合并。
- 每个子阶段结束时，仓库现有的 typecheck、build 与全部测试必须仍然通过，
  不得出现"这一批先别跑测试"的中间状态。

### 阶段 B：执行和 API

- 实现 LLM、知识、工具、条件和输出节点。
- 接入 GatewayClient、身份、限额、幂等、取消和 SSE。
- 完成权限与接口测试。

### 阶段 C：可视化编辑器

- 新增 React Flow 页面和节点配置表单。
- 完成草稿、校验、调试、运行状态和浏览器验收。

### 阶段 D：发布、审批、Agent 和模板

- 实现版本发布、可见范围、人工审核和安全恢复。
- 抽取 AgentRuntime 工作流模式。
- 实现平台/租户模板复制安装和资源绑定。
- 完成两条端到端验收路径。

每个阶段都应保持现有测试和构建通过，不一次性提交无法拆查的大块实现。

## 16. 后续演进

当出现以下任一明确需求时，优先评估 Temporal，而不是继续扩大自研 Worker：

- 跨天审批和无人值守执行。
- 服务重启后自动恢复。
- 多副本 Worker、水平扩容和分布式协调。
- 定时调度、外部信号、复杂重试和长期补偿。

React Flow 画布、DAG 契约、节点端口和网关治理可以保留，仅替换持久化执行底座。
