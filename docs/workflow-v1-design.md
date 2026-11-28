# AI 工作流 V1 分析与设计

> 状态：设计已评审，并补齐 R1–R11 共 11 项契约。
> **阶段 A1（领域类型 / DAG 校验 / 条件求值 / JSON Schema 最小子集 / 引用解析）已实现**，
> 位于 `packages/workflow-core/`，单测见 `tests/workflow-dag.test.ts`（100 例）。
> 阶段 A2（SQLite/PostgreSQL 双存储、六张工作流表、幂等与乐观锁）已实现；
> 双存储契约见 `tests/workflow-store.test.ts`（SQLite 36 例 + PostgreSQL 36 例，均已实际执行；
> CI 已配置 PostgreSQL service，PG 分支不再跳过）。
> 阶段 A3（状态机、稳定顺序调度、分支合流、重试/超时/取消、并发端口与幂等）已实现；
> 调度与持久化行为见 `tests/workflow-runtime.test.ts`（38 例，使用真实 SQLite 存储与 mock 节点端口），
> 依赖面守卫见 `tests/workflow-package.test.ts`。
> A3 复审提出的三项问题已修掉：缺失引用落库留痕（步骤级 + 运行级）、取消与执行器收敛的终态竞态、
> `workflow-core` 对 `platform-core` 的依赖降级为仅类型导入（开发期依赖）。
> 第二轮独立复核（A1 校验层 4 条 / A2 存储层 6 条 / A3 运行时 2 条）已全部修复并补齐回归用例：
> 原型污染查表、嵌套 `$ref` 逃逸、深度超限与超限 CPU 放大、版本写路径身份判定、
> 审核留痕可伪造与可抹除、CHECK 校验两端异构、owner 伪造、草稿版本泄露、
> `repeated_approval` 误留副作用标志、缺处理器仍占额度。
> 第三轮独立复核（A1 校验层 4 条 / A2 存储层 8 条 / A3 运行时 5 条，共 17 条）已全部修复并补齐回归用例：
> 校验器被畸形 Schema 打成异常入口、实现版本白名单表项非法、`validateValue` 对畸形 Schema 抛异常、
> 资源白名单漏报；版本自审判据失真（改为「作者 + 最后修改者」双列）、
> 更新省略 `deptId` 抹掉部门归属、软删除后仍可送审发布、直发伪造审核留痕、
> 版本号非单调递增、单条读与列表读口径分叉、版本指针无人维护；
> 并发同幂等键的失败传播、节点超时被合成为可重试、副作用证据跨 attempt 继承、
> 并发限额无天花板、终态路径不释放租约。
> 阶段 B（执行适配和 API）及之后尚未开始。分支：`feat/workflow-v1`。
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
| 执行器位置 | 独立 `packages/workflow-core` **代码包**，但**先同进程部署在 agent-core 内**，不新增微服务；依赖方向 `agent-core → workflow-core → platform-core` |
| 可视化 | React Flow（`@xyflow/react`），DAG JSON 是服务端执行的唯一依据 |
| 业务人员权限 | 可创建私有草稿、调试和运行授权流程；共享发布受控 |
| 跨租户复用 | 可执行定义**不跨租户共享**；跨租户只复用**不可变模板**，安装时复制成租户草稿并完成本地资源绑定 |
| 工具审批 | 逐次工具级审批，**不开放工作流级审批背书**；后续如需优化只做「运行清单审批」 |
| 身份 | 按实际运行者身份调用模型、知识和工具，不借用创建者或审批者权限 |
| 执行范围 | 有界 DAG、顺序执行、短时在线运行，支持安全恢复；不承诺跨天自动执行 |
| 网关治理 | 所有 LLM 和 MCP 调用继续经过 agentgateway，不新增旁路 |
| 节点实现版本 | 节点类型带 `implVersion`，执行器按版本分派；已发布流程不因节点语义升级而改变行为 |
| 运行并发 | 单租户、单用户同时在跑的运行数有上限，平台可配，业务用户只能调低 |
| 条件求值 | 工作流条件 AST 自带最小求值器；后续与网关策略 CEL 子集抽取共享实现 |
| Schema 校验 | 自研最小 JSON Schema 子集（type/required/properties/enum/min/max），不引入通用 JSON Schema 库 |

#### 三项已确认决策的展开口径

以下三项在评审中逐条确认，展开为可执行约束，后续章节以此为准。

**① 执行器：独立包、同进程运行**

把「代码边界」和「部署边界」分开：

```text
packages/workflow-core
  ├─ DAG 类型定义
  ├─ 校验器
  ├─ 执行状态机
  ├─ 分支、重试、取消、恢复
  └─ Model / Tool / Approval / Store 等端口接口

packages/agent-core/src/workflow
  ├─ HTTP 路由
  ├─ GatewayClient 适配器
  ├─ 审批与 AG-UI 事件适配器
  └─ 工作流运行 Worker
```

依赖方向固定为：

```text
agent-core → workflow-core → platform-core
```

- `workflow-core` 不依赖 Express、React、AG-UI，也不直接持有 Provider 凭证；
  可以依赖 `platform-core` 的共享类型，**不得反向依赖 `agent-core` 或 `gateway`**。
- 模型和工具通过注入的端口调用，仍由 agent-core 使用现有 `GatewayClient` 适配。
- 这样做的好处：避免继续扩大当前 ReAct `AgentRuntime`；DAG 校验和状态推进可以独立做单元测试；
  暂时不用维护新的微服务和网络鉴权链路；将来拆独立 Worker 或接 Temporal 时，
  不需要重写 API 和节点定义。
- **明确不做**：V1 不启动独立 `workflow-core` 服务 —— 那会提前增加部署、服务鉴权、追踪和运维成本。

**② 跨租户：共享模板，不共享可执行定义**

区分可执行定义与两类模板：

| 对象 | 归属 | 跨租户可见性 |
|---|---|---|
| 可执行工作流 | `tenantId + workflowId + version` | **不可**。可见范围只有 `private` / `department` / `tenant`，不能被其他租户直接引用或运行 |
| 平台模板 | `scope=platform`，`tenantId=NULL` | **可**。只读、不可变、未绑定资源的流程骨架，可安装到任意租户 |
| 租户模板 | `scope=tenant + tenantId` | **不可**。仅归属租户可见和安装，不能成为跨租户共享通道 |

可执行定义不能跨租户的原因：知识库、工具参数、输出字段和身份信息一旦跨租户串联，
就会形成越权通道。

平台模板的硬约束：

- 由 `platform-admin` 制作和发布；
- 不包含知识库 ID、文档内容、API Key、Base URL、用户身份等租户数据；
- 使用「资源槽位」描述所需能力（例如「选择一个知识库」「选择一个通知工具」）；
- 安装时复制成租户自己的草稿，由租户完成资源绑定和权限校验；
- 记录 `templateId / templateVersion / sourceChecksum`，便于检查更新；
- 模板升级只生成新草稿，不能自动改变已发布或正在运行的流程。

租户模板由当前租户的 `admin / platform-admin` 创建、编辑和发布，所有接口必须校验模板 `tenantId`
与调用者租户一致；`platform-admin` 也不能通过模板管理接口直接改写其他租户内容。

模板市场先做「平台内置模板 + 租户模板」，**暂缓开放第三方市场**：
第三方模板可能包含诱导提示词和危险工具编排，必须按可执行内容审核，不能当作普通文本分享。

**③ 审批：不按整个工作流长期背书**

流程发布审批、流程启动审批、工具执行审批是三件不同的事。
流程发布或启动获批，**不代表后续写操作自动获批**。默认规则：

- 只读 LLM、知识检索节点无需工具审批；
- 每次写库、发通知、调外部系统等副作用操作，继续执行现有工具级 HITL；
- 循环、重试和后续新运行不能继承旧审批；
- 工作流定义不能携带 `skipApproval` 之类的绕过配置；
- 即使上游 Agent 或 LLM 修改了工具参数，也必须重新计算审批内容。

否则一个「已批准工作流」可能被提示词注入或上游数据影响，在后续运行中执行完全不同的写操作。

后续如果需要优化体验，只能增加**运行清单审批**，而不是笼统的工作流级背书。
审批授权绑定：

```text
runId + workflowVersion + nodeId + tool + canonicalArgsHash + identity
```

任何参数、版本、身份或执行次数变化都要重新审批。审批前必须已经确定并展示：
工作流版本和运行实例、具体节点与工具、完整规范化参数及参数摘要、
操作对象与数据密级与执行身份、明确的次数、有效期和幂等键。

对于「人工审批节点 → 固定写操作」这种常见场景，可以合并成一次界面审批，
但审批内容必须展示最终写操作及其完整参数 —— 这样减少一次点击，
却没有开放「整个工作流以后都可信」的口子。

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
| 管理本租户模板 | 不允许 | 不允许 | 允许 | 允许（限当前租户） |
| 管理节点实现和限额上限 | 不允许 | 不允许 | 不允许 | 允许 |

V1 不强制新增 Keycloak 主角色。若后续只希望部分员工搭建，可增加 `workflow-builder` scope，但不能用前端隐藏代替服务端校验。

### 3.2 所有权和可见范围

每个工作流必须保存 `tenantId`、`ownerId` 和 `visibility`：

- `private`：仅所有者和管理员可见。
- `department`：同租户、同部门用户可运行已发布版本。
- `tenant`：同租户用户可运行已发布版本。

草稿始终只有所有者和管理员可以编辑。已发布版本不可修改；再次编辑会创建新的草稿版本。

可见范围只在**租户内部**生效：可执行定义不跨租户共享，跨租户只能通过不可变模板复制安装
（见 1.1 决策 ②、12 章）。

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

### 4.0 依赖方向与部署边界

**代码边界与部署边界分开**（见 1.1 决策 ①）：

```text
依赖方向：agent-core → workflow-core → platform-core
```

- `workflow-core` **不得**依赖 `agent-core`、`gateway`、`webui` 或任何 Provider 实现，
  也不直接持有 Provider 凭证；需要平台共享类型时只依赖 `platform-core`。
- `workflow-core` 对 `platform-core` 的依赖**只有类型导入**（`import type`），
  编译产物不产生任何运行时 `import`。因此 `platform-core` 在 `workflow-core` 的
  `package.json` 里只登记为 `devDependencies` —— 只在编译期需要，
  不进入生产安装面，避免把整个共享层拖进运行时依赖。
  该约束由 `tests/workflow-package.test.ts` 守卫（源码只允许类型导入 + 产物零运行时导入）。
- `agent-core` 负责注入端口实现（`GatewayClient`、存储、审批、事件），`workflow-core` 只声明接口。
- V1 的部署形态是**同进程**：`workflow-core` 作为 `agent-core` 进程内的库被加载，
  **不新增微服务**，因此不需要服务间鉴权、跨进程追踪和额外部署编排。
- 拆分独立 Worker 或改用 Temporal 时，只需替换端口实现，API 与节点定义不变。

| 边界 | 内容 | 归属 |
|---|---|---|
| 代码边界 | 领域逻辑与端口接口 | `packages/workflow-core` |
| 部署边界 | 路由、端口适配、Worker、事件与审批接线 | `packages/agent-core/src/workflow` |
| 出网边界 | 所有 LLM / MCP 调用 | 继续经 `agentgateway`，不新增旁路 |

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
依赖方向上只允许向下依赖 `platform-core` 的共享类型，**不得依赖 `agent-core`**；
本包不含路由和具体 Provider/数据库连接实现；外部 IO 只通过注入端口完成，V1 以同进程库形式被 `agent-core` 加载。
A3 的单进程并发限制器是唯一内置的默认端口实现，不代表多进程生产能力。

**A1 阶段的具体文件划分**（纯函数，无 IO）：

| 文件 | 职责 |
|---|---|
| `src/types.ts` | DAG、节点、配置、运行/步骤状态、限额和资源配置类型 |
| `src/limits.ts` | 平台默认限额、业务可调范围与结构上限（含逐项回退的平台上限） |
| `src/refs.ts` | `$ref` 解析与祖先可达性判定 |
| `src/schema.ts` | JSON Schema 最小子集的校验器（R8） |
| `src/condition.ts` | 条件 AST 类型与自带求值器（5.2） |
| `src/validate.ts` | 图校验器、逐类资源校验状态与有效输出 Schema 合并（5.3、R4） |
| `src/index.ts` | 对外导出 |

**A3 阶段新增的运行时文件**（外部能力仍通过端口注入）：

| 文件 | 职责 |
|---|---|
| `src/state.ts` | 运行/步骤合法转换，终态禁止重开；同 attempt 重试允许 `running → running` |
| `src/topology.ts` | 与定义校验器共用的稳定拓扑排序 |
| `src/concurrency.ts` | 租户/用户/工作流并发端口、租约和单进程默认实现 |
| `src/runtime.ts` | 幂等启动、pending 固化、顺序执行、条件选边、跳过传播、审批恢复、重试、超时、取消、终态并发收敛和限额 |
| `tests/workflow-runtime.test.ts` | 使用真实 SQLite 存储与 mock 节点处理器的 33 项行为测试 |
| `tests/workflow-package.test.ts` | 依赖面守卫：源码只允许类型导入 `@eap/platform-core`，产物零运行时导入 |

处理器键为 `${node.type}:${node.implVersion ?? 1}`。处理器收到解析后的配置、只读运行上下文、attempt、
恢复标记、剩余调用额度和节点级 `AbortSignal`；`input` 与 `condition` 由领域层直接执行，其余节点在阶段 B 接入真实端口。
并发端口默认实现只用于 V1 单进程；阶段 B 的生产适配仍需接入可启动重建的 Redis 计数，不能把单进程计数器当作多副本协调。

#### `packages/agent-core/src/workflow`

- REST/SSE 路由和身份校验。
- `GatewayClient` 的 LLM、知识和工具端口实现。
- AgentRuntime 的 Agent 节点适配器。
- ApprovalRequest、审批唤醒和运行事件适配。
- 单进程 Worker、启动时中断标记和恢复控制。

本层是 `workflow-core` 外部服务端口的**部署适配方**：把领域层声明的 Model / Tool / Approval / Store / Event
接口接到现有 `GatewayClient`、`MetadataStore` 和 `HitlManager` 上；并发端口在阶段 B 替换为可启动重建的 Redis 实现。
它也是 V1 中工作流的**部署宿主** —— `workflow-core` 不单独起服务，与 agent-core 同进程运行。

#### `packages/platform-core`

- 工作流共享记录类型和 `MetadataStore` 扩展。
- SQLite/PostgreSQL 表结构、查询和乐观锁实现。
- 配置项、日志脱敏和保留策略。

平台共享层位于依赖链最底端，`workflow-core` 可以依赖它的记录类型与存储接口，
`agent-core` 通过扩展 `MetadataStore` 获得工作流存储能力，不另起一套数据库访问层。

**A2 阶段的具体文件**：

| 文件 | 职责 |
|---|---|
| `src/store/workflow.ts` | 工作流记录类型、`WorkflowStore` 接口、双数据库 DDL、统一行映射、游标分页与 JSON 字段校验 |
| `src/store/metadata.ts` | `MetadataStore extends WorkflowStore` 及 SQLite 实现 |
| `src/store/pg.ts` | PostgreSQL JSONB/TIMESTAMPTZ 同构实现 |
| `tests/workflow-store.test.ts` | 同一组契约在 SQLite 与 PostgreSQL 上分别执行 |

发布版本通过条件更新禁止修改，运行转换同时匹配原状态和 `lock_version`；步骤写入先验证运行租户，
模板表以 CHECK 保证 `platform` 的 `tenant_id IS NULL`、`tenant` 必须携带真实租户。
`WORKFLOW_TEST_POSTGRES_URL` 仅用于显式指定的 PostgreSQL 专用测试库，不默认连接部署主库。
CI 通过 `services: postgres` 提供专用库，并在每个用例前清理工作流表，
使 PostgreSQL 与 SQLite 的 `:memory:` 具备同等隔离，契约断言不受历史数据影响。

存储层的几条硬约束（写进表结构与条件更新，而不是只写在文档里）：

| 约束 | 落地方式 |
|---|---|
| 步骤的「结果不确定」标志不可被抹掉 | `side_effect_unknown` 只允许 `false → true`（SQLite `MAX`、PG `OR`） |
| 步骤重试与快照防止回退 | `attempt` 取 `MAX`/`GREATEST`；仅 `(attempt, updated_at)` 较新的写入可替换状态快照 |
| 审批参数与调用额度可恢复 | `step.input` 固化挂起前参数；`llm_calls/tool_calls` 随快照持久化，恢复时按全部步骤求和 |
| 已发布模板不得被普通 upsert 改回草稿 | 条件更新拦截 `published → draft`；下架需要显式动作 |
| 列表必须分页 | 全部 list 接口带 `limit`（默认 50、上限 200）与游标，排序方向与游标谓词严格一致 |
| 缺失引用必须留痕 | `step.missing_refs` 记录本步骤未解析的引用；运行收敛时去重汇总写入 `run.missing_refs` |
| 不可序列化的 JSON 字段 | 统一抛 `TypeError` 领域错误，不落到驱动原始报错 |

新增列一律走**轻量补列**而不是重建表：`init()` 在建表之后补 `ALTER TABLE ... ADD COLUMN`，
SQLite 先查 `PRAGMA table_info`，PG 使用 `ADD COLUMN IF NOT EXISTS`。除了 `missing_refs`，
早期 A2 表缺少的 `llm_calls / tool_calls` 也会带默认值与非负约束补齐。
PostgreSQL 初始化在同一事务内执行，并用事务级 advisory lock 串行化多副本建表；
唯一索引冲突等真实错误仍会抛出并回滚，不会被当成并发建表竞争吞掉。
上述迁移由 `tests/workflow-store.test.ts` 的「老库补列迁移」用例覆盖。

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

- 工具参数可递归包含受限引用，配置嵌套深度最多 64 层；`$ref` 对象只能包含一个字符串类型的 `$ref` 字段。
  **超限不静默截断**：超过上限直接报 `config_too_deep` —— 静默截掉的部分正好是危险键与嵌套 `$ref`
  的藏身处，截断等于放行（实测 64 层以上可让 `__proto__` 与嵌套 `$ref` 溜过检查）。
- LLM 提示词由文本片段和引用片段组成，执行器负责拼接。
- 引用必须指向真实存在的上游节点和已声明输出字段；`input.*` 必须在顶层 `inputSchema.properties` 中声明。
- 禁止引用下游节点、密钥、原始令牌和任意环境变量。

节点未显式提供 `outputSchema` 时，可引用以下内置输出字段：

| 节点类型 | 默认可引用输出字段 |
|---|---|
| `input` | 顶层 `inputSchema.properties` 声明的字段 |
| `llm` | `text / structured / promptTokens / completionTokens / model / traceId` |
| `knowledge` | `text / sources` |
| `tool` | `ok / content / structured / reason / traceId` |
| `agent` | `content / toolCalls / traceId` |

显式 `node.outputSchema.properties` 是对内置字段的**补充声明**，不是替换：执行器始终会产出内置字段
（LLM 的 `text / promptTokens / traceId` 等），若显式 Schema 把它们顶掉，运行期就会产出无法寻址的字段。
可寻址字段集合 = **内置字段 ∪ 显式 Schema 声明的字段**。
节点输出 Schema 与顶层 `inputSchema` 的根类型都必须**显式声明为 `object`**（缺 `type` 也拒绝）。
结构化输出声明统一放在 `node.outputSchema`，不接受 `config.outputSchema`，避免同一节点出现两套输出契约。
执行器必须使用 `getEffectiveOutputSchema(node, definition)` 校验完整输出，不能直接把原始自定义 Schema
用于整个输出对象。该函数合并内置与自定义 `properties/required`，因此即使自定义 Schema 设置
`additionalProperties: false`，也不会误伤内置字段。

自定义 Schema 可以**追加字段或收紧同名字段约束**，但不得改写内置字段类型或放松内置底线：
例如 Token 的内置 `minimum: 0` 不可降低，`minimum/minLength` 取两边较大值，
`maximum/maxLength` 取两边较小值，`enum` 只能取内置集合的子集；类型冲突、空区间和空枚举均拒绝发布。
上述规则递归应用于嵌套 `properties/items`。有效 Schema 始终保留内置底线，即使调用方绕过发布校验，
也不能通过自定义声明放松运行期校验。
条件、人工审核和输出节点如需向下游暴露数据，必须显式声明输出 Schema。

条件由业务规则编辑器生成结构化 AST，例如：

```json
{
  "all": [
    { "left": { "$ref": "nodes.review.output.risk" }, "operator": "eq", "right": "high" },
    { "left": { "$ref": "nodes.review.output.score" }, "operator": "gte", "right": 80 }
  ]
}
```

条件 AST 在发布时递归校验，逻辑嵌套最多 32 层。结构错误、非法引用或二元比较任一操作数缺失时，
求值结果一律为 `false` 并返回错误；错误不会被 `not` 反转成 `true`。`exists / not_exists`
用于显式处理字段不存在，其余算子不做隐式默认值或缺失值反转。

比较节点按算子分类约束操作数：

| 算子类别 | 算子 | `right` |
|---|---|---|
| 一元算子 | `exists / not_exists / is_true / is_false` | **不写**；写了会被校验拒绝 |
| 二元算子 | `eq / ne / gt / gte / lt / lte / contains / not_contains` | **必填** |

**操作数只支持两种形态**：字面量（字符串 / 数字 / 布尔 / null / 数组 / 对象字面量），
或**顶层 `$ref` 对象**（只有一个 `$ref` 字段）。操作数内部**不允许再嵌套 `$ref`** ——
求值器只解析顶层 `$ref`，嵌套引用会被当成字面量对象，比较恒为 `false` 且不留任何痕迹；
这类表达式必须在**发布期**被拒绝（`invalid_condition`），不能等到运行期静默走错分支。
「内部」指**任意层级**：数组元素与对象属性里出现的 `$ref` 同样在发布期被拒，
不能只检查顶层键 —— 只看顶层会让 `{"right": [{"$ref": "..."}]}` 这类写法绕过检查。
操作数内部同样禁止 `__proto__` / `constructor` / `prototype` 键（见 13 章），
且该检查覆盖数组元素与对象属性的全部层级。

`contains / not_contains` 的左值必须是字符串或数组；左值不可比较时结果为 `false` 并返回
`invalid_operand` 错误 —— 不允许 `not_contains` 静默退化成「必须包含」。

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
- 节点类型、配置、输入输出 Schema 和引用合法；节点配置字段按类型设置白名单，未知字段直接拒绝。
- 边两端存在，不允许自环、重复边和循环；普通节点的边禁止携带 `branch`。
- 所有节点从输入可达，并且能到达输出节点。
- 条件节点必须显式提供 `true`、`false` 两类出口，其他分支值一律拒绝。
- 模型、知识库、知识范围和工具必须是当前用户可用的逻辑资源；Agent 的工具子集也逐项校验，
  工具标识统一为 `serverId/tool` 格式。
- 输入节点的表单字段必须在 `inputSchema.properties` 中声明，且**必须覆盖 `inputSchema.required`**；
  Schema 自身的 `required` 也必须在 `properties` 中声明，否则用户无从填写。
- 节点数、边数、提示词、配置深度、输入和输出大小不得超过平台上限；Schema 按 UTF-8 字节计量。
  配置深度、条件深度与引用收集深度统一取自 `STRUCTURE_LIMITS`，不允许各处各写一份魔数。
  **规模超限必须立即返回**：节点数 / 边数超限时直接给错，不再继续做 O(N×(N+E)) 的可达性判定与引用收集 ——
  否则超大定义会把发布校验变成 CPU 放大器（实测 6000 节点链式定义耗时 12.5 秒，立即返回后为 2 毫秒）。
- 已发布版本必须再次校验，不能只信任发布时的结果。
- **校验器本身不得成为异常入口**：Schema 形态非法（`required` 不是字符串数组、`enum` 不是数组、
  `properties` 不是对象等）与实现版本白名单表项非法，一律报成**校验问题**（`invalid_schema` /
  `invalid_node_implementations`），不能抛异常。
  业务用户提交的 JSON 完全可控，校验器一旦能被它打成裸 `TypeError`，
  接口就会返回 500 而不是 400，错误也无法定位到画布上的具体节点。

**资源白名单不得静默失效**：校验结果必须带逐类别的 `resourceCheck`：
`{ models, tools, knowledgeScopes }`，每项取值为 `performed / skipped / not_required`。
状态根据当前定义实际使用的资源计算：模型节点需要 `models`，工具节点及配置了工具的 Agent 节点需要 `tools`，
显式配置 `knowledgeScope` 的知识节点需要 `knowledgeScopes`。某一类白名单的注入不得把其他类别标成已校验。
统计基于**原始节点列表**而非校验通过的节点：节点 ID 非法而被丢弃时，资源需求不能跟着漏报成
`not_required`。发布、启动与恢复接口必须拒绝任何所需类别为 `skipped` 的结果；
`ok: true` 只表示定义结构合法，不能单独作为「资源已授权」的凭据。

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
| `minLength` / `maxLength` | ✅ | 非负整数，且 `minLength <= maxLength` |
| `minimum` / `maximum` | ✅ | 有限数值，且 `minimum <= maximum` |
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

内置输出始终包含 `{ text, structured?, promptTokens, completionTokens, model, traceId }` 的字段契约。
显式 `node.outputSchema` 追加结构化自定义字段；完整输出由 `getEffectiveOutputSchema()` 合并后校验。
实际 Provider 和 Failover 仍以网关结果为准。

### 6.3 知识检索节点

V1 使用受治理的 `knowledge.search`，配置查询、Top-K 和可选 `knowledgeScope`。知识范围必须在当前调用者的
`knowledgeScopes` 白名单内，发布、启动和恢复时均重新校验。输出统一归一为 `{ text, sources }`，屏蔽 MCP 传输细节。
权限过滤继续由网关和 MCP 完成。

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
工具子集 `allowedTools` 的元素格式统一为 `serverId/tool`，与工具节点和资源白名单同口径；
格式不合法的配置在发布校验期直接拒绝。

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

**分支语义（A3 起生效）**：人工审核节点的出边用 `branch: approved | rejected` 标注，
与条件节点的 `true | false` 分属两套取值（`NODE_BRANCH_VALUES` 统一登记）。
审核处理器必须显式返回布尔型 `output.approved`：

- `approved: true` → 走 `approved` 分支；
- `approved: false` → 走 `rejected` 分支；
- **缺少对应分支时运行直接失败**（`approval_branch_missing`）——
  审核被驳回绝不能因为「没有驳回分支」就沿通过路径继续执行后续写工具；
- 处理器没给出布尔型 `approved` 时按结果非法处理（`invalid_node_result`），**不得**默认按通过处理；
- 审核节点若一条出边都不带 `branch`，视为线性流程，按普通节点处理（无分支语义）。

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

**终态收敛口径（A3）**：`cancel()` / `interrupt()` 与执行器的失败收敛会**同时**推进同一个运行，
先写入的一方决定终态，后写入的一方因为乐观锁失败会拿到转换冲突。
此时后写入的一方必须**回读数据库里的最终运行记录并把它返回给调用方**，
不得抛 `run_transition_conflict` —— 调用方需要的是「这次运行最终怎么样了」，
而不是一个无法自行判断结果的异常。所有写入终态的路径（取消、执行器收敛、审批超时）
统一走同一个终态转换入口，保证两边口径一致。

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
  例如 `{"context": {"$ref": "nodes.retrieve.output.text"}}`；
  校验器负责确认引用指向的节点确实是本节点的**祖先**（不可引用下游或旁支节点），且字段已在上游输出契约中声明。
- **缺失字段语义**：引用路径解析不到值时——
  - 被跳过（`skipped`）的前驱，其输出视为**不存在**，引用它等价于"未提供"；
  - 未提供与提供 `null` **不等价**，下游取不到值就是取不到值；
  - 若该引用在节点的 `inputSchema` 中是 `required`，则节点进入 `failed`
    并给出明确错误码 `missing_input`，**不得**静默填默认值。
  - **缺失必须留痕**：非必填引用取不到值时，字段从解析结果里省略，
    但该引用表达式必须写进 `workflow_step_runs.missing_refs`，
    并在运行收敛时汇总到 `workflow_runs.missing_refs`。
    留痕发生在**输入校验之前**，因此必填引用缺失导致运行失败时同样有据可查；
    否则运行成功之后无从判断结果到底缺了哪些字段。
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

相同幂等键返回原运行，不创建第二次副作用。A3 对相同作用域幂等键使用 single-flight 共享初始化，
并以规范化 JSON 比较输入；同键但定义校验和、版本、模式或输入不同返回 `idempotency_conflict`。
**并发同键共享同一次初始化时也要做这层比对**：共享 promise 只能保证「不重复创建」，
不能代替「同键同内容」的校验，否则并发提交不同输入的调用方会拿到用别人输入构造的运行却以为是自己提交的。
数据库唯一索引仍负责最终去重，Worker 在全部 pending 步骤落库前不会执行任何节点。

### 7.4 重试和超时

- LLM、知识和明确只读的工具最多允许有限重试，默认不超过 2 次。
- 身份失败、策略拒绝、预算拒绝、参数校验失败不重试。
- 网关 Failover 与工作流重试分别计数，避免形成多层放大。
- 写工具不自动重试；审批只能消费一次。
- 每个节点和整个运行都有超时，取消通过 AbortController 传递到模型调用。
- 写请求已经发出后发生断连或崩溃，结果视为不确定，必须人工核查，不能自动重放。

A3 的具体执行口径：

- 只有处理器显式抛出 `retryable=true` 且 `sideEffect=read` 的 LLM、知识和只读工具错误才重试；
  默认额外重试 2 次，且每次调用都占用运行级 LLM/工具额度。写工具即使误标为可重试也不会重放。
  **运行时自己合成的超时不算可重试**：超时只说明处理器没在时限内返回，处理器可能仍在执行，
  重放等于重复发起同一次外部调用（网关自己的 Failover 已经覆盖了这类瞬时故障）。
- 每次外部调用前先把 resolved config 写入 `step.input`；审批恢复必须使用这份参数快照，
  不得根据可能已经变化的上游输出重新生成参数。`llm_calls/tool_calls` 与输入输出一起持久化。
- 节点超时和运行取消都通过 `AbortSignal` 到达处理器；写调用在超时或取消时结果不明，
  必须设置 `side_effect_unknown`。即使处理器不合作，运行时也通过竞态停止等待，不假装外部写操作已回滚。
- **写节点一旦调用过处理器，后续任何失败都要留 `side_effect_unknown`** ——
  包括「写已成功但返回值不合法」（输出超限、字段类型错、调用次数回报非法）。
  这类失败在外部写已经落地之后发生，若不留痕，恢复逻辑会误以为这次写是干净可重放的。
  配置校验失败发生在调用之前，不留此标志。
- 副作用判定**以处理器显式声明为准，而不是只看节点类型**：同一个 `tool` 节点既可能是只读工具，
  也可能是写工具。处理器声明 `sideEffect=write` 且请求已发出 → 结果不明；
  处理器声明 `sideEffect=read`（只读工具）→ 明确没有写副作用，可按只读错误重试；
  处理器声明 `sideEffect=none` 而节点是 `tool/agent` → 语义不明，保守按结果不明处理；
  处理器已经返回、随后结果校验失败 → 写操作可能已经落地，结果不明。
  处理器有义务如实声明副作用；声明与实际不符由处理器作者负责修正。
- `waiting_approval` 会交还 Worker，但审批等待计时器仍生效；超时通过与恢复相同的 `lock_version`
  条件更新竞争，自动把运行置为 `approval_timeout` 或 `run_timeout` 并释放并发租约。
- **每次调用处理器都要占用一次运行级额度，恢复执行同样要占**：否则反复 `resume()` 可以无限次调用处理器
  而不触碰上限，写工具就能在限额 1 的工作流里反复写外部系统。
  挂起那一次（处理器返回 `waiting_approval`）只是去申请审批、并没有完成外部动作，**额度退回**；
  真正执行外部调用的是恢复后的那次，它正常计入额度。
- **审批只能消费一次**：同一个步骤在恢复执行后不得再次返回 `waiting_approval`，
  否则就是「一次审批被反复消费」。这种情况按协议错误处理，运行失败并给出 `repeated_approval`，
  不会继续调用处理器，也不会把额度无限放出去。
  `repeated_approval` 与「挂起那次」同口径：**留痕里不留 `side_effect_unknown`** ——
  该次执行根本没有完成外部动作，标成「副作用不明」会让恢复逻辑误判为「可能有写已落地」而拒绝重放。
- **额度预留发生在处理器查找之后**：节点没有注册处理器时直接失败，
  不占用任何额度 —— 没有发生调用，就不该计费。口径与「挂起那次退回额度」一致。
- **副作用证据按 attempt 计**：「是否调用过处理器」「处理器是否已返回」两个标志每次尝试都重置。
  上一轮调用过处理器，不代表本轮也调用过 —— 重试时在**额度预留阶段**被拦下（没发生调用），
  不能继承上一轮的证据，否则一次干净的额度失败会被标成「副作用不明」，
  白白要求人工核查一个从未被写过的外部系统。真正「写请求已发出后失败」的场景仍然必须留痕。

### 7.5 默认限额

外部工作流定义提交的运行限额必须为正整数，`validateDefinition` 会拒绝小数、零、负数和非有限数值。
内部 `resolveLimits` 只做防御性归一化，不得把有效请求放大，也不得产生零或小数限额。

以下为产品默认值，实施时通过配置覆盖，但业务用户只能调低、不能突破平台上限；产品默认值本身也不能突破更小的平台上限：

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

A3 的 1 MiB 状态计量包括运行输入、身份摘要、调试定义快照，以及每个步骤实际持久化的 `input/output`；
不是只计算下游引用上下文。候选步骤先计量再写库，超限时保留最后一份合规快照并将当前步骤和运行置为失败。

现有平台、租户和应用预算继续生效。V1 的运行级限额主要限制调用次数、Token 和时长；精确的运行级美元预算需要网关返回统一成本结果后再增加。

**平台上限必须逐项生效**：平台上限可以只覆盖其中几项（配置或环境变量未必配全），
缺失或非法的项一律回落到内置平台上限，**不得产生 `NaN`** —— `maxSteps: NaN` 会让
「步骤数超限」判断恒为假，等于限额失效。校验侧同样按逐项回退后的上限比较，
超限的提交一律拒绝，不允许因为上限缺项而放行。

**并发限额同样有平台天花板**：`perTenant / perUser / perWorkflow` 各有一个平台上限
（`PLATFORM_CONCURRENCY_LIMIT_CAPS`），调用方提交的值一律被夹住，缺省值也按「取小」收敛。
口径与 `resolveLimits` 一致：逐项回退、不产生 `NaN`、非法值回落到缺省值。
没有天花板时，宿主一处配置笔误就能把单租户并发从 20 抬到 1000，R5 的保护形同虚设。

**内部防御性归一化绝不放大正数请求**：直接调用 `resolveLimits` 时，正小数上限或请求值向下取整并至少为
`1`（`10.8 → 10`、`1.5 → 1`、`0.5 → 1`），不能回落到更大的默认值或平台硬上限。
这不改变外部 API 的严格契约：业务用户通过定义接口提交的小数仍会被拒绝，不能把内部容错当成正式输入格式。
缺失、非正数或非有限的平台覆盖项按上一段规则回退；这些值不构成有效的收紧请求。

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

A3 已定义 `WorkflowConcurrencyPort` 和幂等租约，并提供 V1 单进程默认实现；queued、running、waiting_approval
都会持有租约，进入终态释放。默认实现不承诺跨进程一致；阶段 B 接真实部署时必须替换为 Redis 适配器，
并在 agent-core 启动时按运行表重建计数，不能因为 A3 的 mock/单进程验收通过就省略这一步。

**租约释放口径**：运行进入终态即释放；运行已不存在或已是终态时，执行器不再占用额度。
「排队中但始终没有被 Worker 取走」的运行，其租约回收**不属于 workflow-core 的职责** ——
按 R7 的口径，清理动作落在部署侧运维脚本与阶段 B 的 Redis 并发端口（启动重建 + 过期回收），
不在领域层塞定时器。

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
- 工作流定义**不能携带 `skipApproval` 之类的绕过配置**；即使上游 Agent 或 LLM 修改了工具参数，
  也必须重新计算审批内容（见 1.1 决策 ③）。

后续如果需要减少重复审批，唯一允许的方向是**运行清单审批**（不是工作流级背书），
授权绑定到：

```text
runId + workflowVersion + nodeId + tool + canonicalArgsHash + identity
```

任何参数、版本、身份或执行次数变化都要重新审批。

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

A3 的 `resume()` 只恢复 `waiting_approval`，并强制重新执行定义、输入与资源白名单校验；
`interrupted` 的身份重建和人工恢复接口属于阶段 B/D，A3 不开放终态重开，也不做进程重启后的自动重放。

跨天无人值守、服务重启后自动恢复和多副本协调留给 Temporal 等持久化执行底座，不在 V1 伪装支持。

## 9. 存储设计

建议增加以下逻辑表，字段在 SQLite/PostgreSQL 实现中保持同构。

### 9.1 `workflows`

- `id`、`tenant_id`、`owner_id`、`name`、`description`。
- `visibility`、`current_draft_version`、`latest_published_version`。
- `dept_id`：创建者所属部门。`visibility=department` 的可见性判定依赖它，缺省为 `NULL`（对任何调用者都不可见）。
- `created_at`、`updated_at`、`deleted_at`。

**可见范围必须在 SQL 层生效**：`private` 仅所有者（与管理员）可见、`department` 对同部门可见、
`tenant` 租户内全部可见。列表接口的过滤参数把**调用者身份**与**owner 过滤**拆成两个：

- `actor`（`userId / departmentIds / isAdmin`）承担可见范围判定：
  private 记录只有本人或管理员可见，department 记录只有同部门可见，管理员可见全部 private；
- `ownerId` 只是 owner 过滤（管理场景），**不承担授权语义**。

两者合成一个参数会陷入「传了就只看本人、不传自己的 private 又全被滤掉」的两难，
任何参数组合都表达不出「我的 private + 他人的 tenant」。
谓词由两端共用的构造器生成，保证 SQLite 与 PostgreSQL 行为一致。
**不允许**把整页取回后在内存里过滤 —— 那样会出现「过滤后空页、但更早的可视记录仍在库里」的分页失真。

**单条读路径同样要带谓词**：`getWorkflow` / `getWorkflowVersion` / `getWorkflowRun` / `getWorkflowStepRun`
在给出 `actor` 时按可见范围与所有权过滤 —— 版本跟随它所属的工作流（版本里存着完整定义与工具参数，
不能绕过工作流直接读），运行可见给发起人本人、工作流管理员与租户管理员，步骤跟随其所属运行；
省略 `actor` 表示平台内部可信访问（Worker、测试播种），租户隔离不变。
没有这层谓词，API 层只能取回后在内存里判断，既拿不到可执行的身份原语，又会泄露他人运行的敏感输入。

**`owner_id` 创建后不可变**：冲突更新不再改写 owner，
非 owner / 非管理员的 upsert 被条件更新直接拦下（返回 false），
避免「他人工作流被夺走、原 owner 列表里凭空消失、`private` 被静默放宽为 `tenant`」。
**删除同样是「编辑」**：给出 `actor` 时只有所有者或管理员能删（`deleteWorkflow` 同样带所有权谓词）。

**新建时所有者取自调用者身份，不认客户端传入的 `ownerId`**：
给出 `actor` 时，非管理员的工作流所有者一律落到 `actor.userId`；
管理员可以显式代指派所有者，未指定（空值）时退回管理员本人，避免出现「无人拥有」的工作流。
否则任何人都能把工作流挂到别人名下，再借 `tenant` 可见范围让攻击者写的内容以受害者名义对全租户可见。
`deptId` 同样不能由普通调用者伪造：非管理员只能选自己的部门；管理员代建和平台内部写入仍可显式指定。

**省略与显式必须区分**（否则一次「只改名字」的更新就能抹掉部门归属）：

| 场景 | 省略 `deptId` | 显式给出 |
|---|---|---|
| 新建 + `visibility=department` + 单部门用户 | 自动绑定到该部门 | 校验是否属于自己的部门 |
| 新建 + `visibility=department` + 多部门用户 | **拒绝**（必须显式选择，避免归属伪造） | 校验是否属于自己的部门 |
| 新建 + 其他可见性 | 留空（`NULL`，表示无部门可见） | 校验是否属于自己的部门 |
| **更新**（任意可见性） | **保留库中原值**，不要求重新选择 | 校验是否属于自己的部门 |

「保留原值」是硬要求：`visibility=department` 且 `dept_id IS NULL` 时，
`dept_id IN (...)` 恒不成立，**连所有者本人都会读不到自己的工作流** ——
一次无意的更新就让部门可见的流程对所有非管理员彻底消失。
更新路径因此不能把「部门选择」当成任意字段更新的硬前置。
**草稿版本只对所有者与管理员可见**：版本可见性跟随所属工作流，
但 `draft / rejected / in_review` 版本额外要求调用者是该工作流的所有者（管理员除外）——
否则「工作流对全租户可见」会把未经审核的草稿定义、工具参数与校验和一起泄露出去。
`published` 版本按工作流的可见范围正常可见。

**版本指针由存储层维护**：`current_draft_version` 与 `latest_published_version`
不能只靠调用方传 —— 一旦漏更新，列表里就会出现「没有已发布版本」的工作流。
存储层在版本写入与发布成功后按**取大语义**推进指针（只增不减），
调用方仍然可以显式推高，但谁都写不回去。指针变化不动 `updated_at`：
它不应该让工作流在列表里重新排序、扰动 keyset 游标。

**单条读与列表读口径一致**：`getWorkflow` 默认过滤软删除的工作流
（与 `listWorkflows` 的默认口径相同），需要看删除痕迹时显式要求 `includeDeleted`。
但**版本、运行与审计证据不受影响** —— 删除工作流不删除历史证据。

**时间戳统一归一化**：所有写入路径在落库前把时间字符串归一化成 `toISOString()`。
SQLite 的时间列是 TEXT，PG 是 TIMESTAMPTZ；若不归一化，同一时刻会出现两种文本，
而 keyset 游标用的是读回后的归一化值 —— 两种文本混排会让分页**静默漏记录**。

### 9.2 `workflow_versions`

- `workflow_id`、`version`、`tenant_id`。
- `definition_json`、`checksum`、`status`：`draft / in_review / published / rejected`。
- `created_by`、`created_at`、`last_modified_by`、`reviewed_by`、`reviewed_at`、`review_comment`、`published_by`、`published_at`。

`created_by` 是**最初作者**，创建后不可变；`last_modified_by` 是**最后改动内容的人**，
给出 `actor` 时取 `actor.userId`（平台内部写入留空，判定时按 `created_by` 兜底）。
两列必须分开：只按 `created_by` 判「禁止自审」会被绕过 —— 管理员覆盖了别人的草稿后，
`created_by` 仍是原作者，但内容已经是管理员写的，按原作者判定就等于允许自审自发。

已发布版本不可更新或随工作流删除而物理清除，历史运行必须可追溯。普通用户提交审核后草稿锁定；管理员驳回时记录意见并重新开放草稿，审核通过时将该版本转为不可变的已发布版本。

**审核锁定必须落在条件更新里**：`published` 与 `in_review` 两个状态都**不能**被普通 upsert 改写
（否则「提交审核后草稿锁定」形同虚设，审核中的定义与校验和可以被悄悄换掉）。
**目标状态**同样受约束：普通 upsert 只能把版本写回 `draft` / `rejected`，
不能直接写 `in_review` 或 `published` —— 否则可以绕开审核通道产出
「看起来已发布、但没有任何审核与发布留痕」的版本，事后无法区分「管理员审核通过」与「一次普通 upsert」。
状态迁移走三个显式通道：

- `submitWorkflowVersionForReview(...)`：`draft → in_review`，锁定定义与校验和，只改状态；
- `rejectWorkflowVersion(...)`：`in_review → rejected`，记录审核人与意见；
- `publishWorkflowVersion(...)`：`in_review → published`
  （管理员直接发布自己维护的草稿也走这里，见 10.1），只改状态与发布信息，
  **不改定义与校验和** —— 发布的就是审核时的那一份。

**版本写路径必须带身份判定**（省略 `actor` 表示平台内部可信操作：Worker、测试播种）：

| 写路径 | 允许者 | 判定依据 |
|---|---|---|
| `upsertWorkflowVersion` | 所有者或管理员 | `canManageWorkflow`；`created_by` 强制取 `actor.userId`，`last_modified_by` 记最后改动内容的人 |
| `submitWorkflowVersionForReview` | 普通所有者，或维护他人工作流的管理员 | `canManageWorkflow`；管理员自己所有的草稿只能直接发布 |
| `rejectWorkflowVersion` | **仅管理员** | `canReviewWorkflow` + SQL 条件 `created_by <> actor.userId AND COALESCE(last_modified_by, created_by) <> actor.userId` |
| `publishWorkflowVersion` | **仅管理员** | 审核流走同一条自审条件；草稿直发通过 SQL 子查询要求工作流所有者为本人 |

**版本号由服务端单调分配**：新版本号必须大于该工作流已有的最大版本号，否则写入被拒。
存储层是这条规则的最后一道防线 —— 只在 API 层计算的话，任何一个绕过 API 的调用方
都能用客户端指定的版本号插空或回退，版本顺序与「当前草稿版本」指针都会失真。
更新一个**已存在**的版本号属于「改草稿」，不受此限制。

**软删除是终态，版本写路径必须认这条**：工作流被软删除后不能再送审、不能发布
（`submit` / `reject` / `publish` 都带「工作流未删除」条件）。
否则「已删除」的流程还能被推到已发布，历史运行与版本证据对不上。
已发布版本本身仍然可读 —— 删除工作流不删除版本、运行与审计证据。

审核与发布是管理员专属动作：所有者自审自批等于绕过审核通道，
在多人协作的租户里会让「分级发布」失去意义。`reviewed_by / published_by` 也必须取
`actor.userId`，不能采用请求对象里可伪造的 reviewer；作者与审核人的约束均落在条件更新中。

**普通 upsert 不写任何审核 / 发布留痕字段**（`reviewed_by / reviewed_at / review_comment /
published_by / published_at`）：这些字段只由审核通道写。否则会出现两种伪造 ——
把草稿直接写成「已审核通过」，或用一次普通 upsert **抹掉真实的驳回意见**。
普通 upsert 的 INSERT / UPDATE 都不得包含这些列。

**草稿直发不写审核留痕**：`publishWorkflowVersion` 的两条来源要分开留痕 ——
经审核发布（`in_review → published`）才写 `reviewed_by / reviewed_at`；
管理员直发自己维护的草稿（`draft → published`）**没有审核人**，只写 `published_by / published_at`。
把发布人写进 `reviewed_by` 等于伪造「已审核」证据，事后无法区分「经审核发布」与「直接发布」。

### 9.3 `workflow_runs`

- `id`、`tenant_id`、`workflow_id`、`workflow_version`。
- `initiator_id`、`identity_snapshot`、`input_json`、`mode`、`status`。
- `definition_snapshot` 仅在 `debug` 模式保存完整草稿快照，正式运行为 `NULL`；`definition_checksum` 保存启动时定义校验和。
- `mode` 为 `debug / published`；`trace_id`、`idempotency_key`（可空）、`lock_version`。
- `error_code`、`error_message`、`created_at`、`started_at`、`ended_at`、`updated_at`、`expires_at`。
- `missing_refs`：本次运行里**未能解析**的引用表达式汇总（JSON 数组）。运行收敛时由各步骤的
  `missing_refs` 去重汇总写入，让「运行结束后结果是否缺字段」一眼可见；没有缺失时不写。

`identity_snapshot` 只保留审计所需身份字段，不包含令牌。`lock_version` 用于状态转换的乐观锁。

### 9.4 `workflow_step_runs`

- `id`、`run_id`、`node_id`、`attempt`、`status`。
- `input_json`、`output_json`、`error_code`、`error_message`。
- `approval_id`、`idempotency_key`、`side_effect_unknown`。
- `llm_calls`、`tool_calls`：当前步骤累计调用次数；恢复时从全部步骤求和重建运行额度，不依赖 Worker 内存。
- `missing_refs`：本步骤**未能解析**的引用表达式（JSON 数组）。按 R3，引用不到值等价于「字段不存在」，
  非必填时不阻断运行，但必须留痕；它同样受 `(attempt, updated_at)` 新旧快照守卫约束，
  迟到的旧写入不得抹掉已有的缺失引用记录。
- `started_at`、`ended_at`、`created_at`、`updated_at`。

同节点唯一键是 `run_id + node_id`，重试在**同一行**上推进：

- `attempt` 只增不减（取 `MAX` / `GREATEST`），避免迟到的旧写入把重试计数改小；
- 以 `(attempt, updated_at)` 判断状态快照的新旧，旧尝试或同尝试的过期快照不得覆盖当前状态、输入输出和审批信息；
- `side_effect_unknown` 只能由 `false` 变 `true`，**不能被后续写入抹掉**。即使写入来自旧尝试，
  也必须保留这个安全标志，同时拒绝其覆盖较新的状态快照。它是「写操作结果不确定」的持久化证据，
  一旦丢失，恢复逻辑会误以为该写操作是干净的并自动重放，直接违反 7.4 与 8.3 的「不确定写副作用禁止自动恢复」。

### 9.5 模板表

平台和租户模板使用独立表，不使用特殊租户 ID 混入普通工作流查询：

- `workflow_templates`：`scope=platform/tenant`、`tenant_id`、名称、说明和状态；平台模板的 `tenant_id` 必须为 `NULL`，租户模板必须保存真实归属租户。
- `workflow_template_versions`：不可变定义、资源槽位、版本、校验和及发布信息。

**平台作用域与租户作用域的写路径必须在存储层分开**：
租户写入口只能写 `scope=tenant` 且归属自己的行，平台写入口只能写 `scope=platform` 的行；
两边不能共用一个「带 scope 就算合法」的 upsert，否则任意租户都能改写平台模板的名称与状态。
平台模板的发布与版本写入走平台管理入口（阶段 B 由平台身份校验兜住）。
- 目录查询只返回平台模板和调用者本租户模板；跨租户读取或安装租户模板一律返回 404。
- 必要索引：`scope + tenant_id + updated_at`；SQLite/PostgreSQL 均以应用层约束和数据库 CHECK 保证两种归属互斥。
- 模板的 `status` 一旦是 `published`，普通 upsert 不得把它改回 `draft`（条件更新拦截）——
  已发布模板的下架必须是显式动作，不能被一次顺手的状态更新悄悄改掉。

必要索引：

- 工作流：`tenant_id + owner_id + updated_at`。
- 版本：`workflow_id + version` 唯一。
- 运行：`tenant_id + initiator_id + created_at`。
- 幂等：`tenant_id + workflow_id + initiator_id + idempotency_key` 唯一。
- 步骤：`run_id + node_id` 唯一。

**列表一律分页**：所有 list 接口带 `limit`（默认 50、上限 200）和游标，
不允许一次拉走整张表。游标采用 keyset 形式（排序键 + 主键），
**排序方向必须与游标谓词严格一致** —— 倒序列表用 `(排序键, 主键) < (游标)`，
升序列表用 `>`；两边一旦不一致，同一时刻的多条记录会被重复返回。

**游标是客户端传来的不可信输入，必须先校验再比较**：游标的时间部分要能解析并归一化，
否则 SQLite 会把 `'garbage'` 当文本比较（谓词恒真 → **把第一页原样再发一遍**），
而 PostgreSQL 会抛 `22007 invalid input syntax` 的驱动原始错误。
两端行为必须一致：非法游标**直接抛明确错误**，绝不静默降级成「从头开始」——
静默降级会让客户端拿到重复数据，比报错更难排查。

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
  幂等键采用更短的 TTL（默认 7 天）：到期后仅将 `workflow_runs.idempotency_key` 置为 `NULL`，不删除运行或步骤记录；
  SQLite/PostgreSQL 唯一索引均允许多个 `NULL`。同一幂等键只在保留窗口内保证返回原运行，客户端不得跨窗口复用。
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
- **API 层必须按新契约传 `actor`**：存储层的「省略 actor = 平台内部可信访问」是留给 Worker 与
  测试播种的**内部通道**，API 层漏传 actor 等于放行整个租户。令牌解析出的用户 ID、部门归属与
  管理员标志必须组装成 `WorkflowActor{userId, departmentIds?, isAdmin?}` 后传给每个读写接口；
  工作流 / 版本、运行、模板三类接口逐个核对，不允许存在「忘了传」的路径。

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
- **审核人不能是作者本人，也不能是最后改动内容的人**：提交审核的版本，其作者不得审核自己的版本，
  最后改过定义的人也不得审核 —— 只按作者判定会被绕过：管理员覆盖了别人的草稿后，
  作者仍是原作者，但内容已经是管理员写的，"作者 + 审核人"的双主体约束就失效了。
  因此版本表同时记 `created_by`（最初作者，不可变）与 `last_modified_by`（最后修改者），
  自审条件对两列同时成立才算通过。admin 提交自己的草稿时，只能走 `publish`。
- **直发与经审核发布要分开留痕**：直发（自己维护的草稿 → published）**不写** `reviewed_by`，
  经审核发布才写。两者混同等于伪造「已审核」证据，事后无法区分两条发布路径。
- 平台管理员**不能**绕过审核直接 `publish` 他人的草稿；需要他人在此场景下发布时，
  由他人自己提交审核，或平台管理员代为修订后以自己的身份重新提交。
- 版本号在发布时由服务端分配（同一工作流内单调递增），**不接受客户端指定版本号**。
- 发布动作写管理审计（`workflow.publish`），detail 记录 `workflowId / version / visibility / actorId`。

### 10.2 运行

```text
POST /api/workflows/:id/debug-runs
POST /api/workflows/:id/runs
GET  /api/workflow-runs/:id
GET  /api/workflow-runs/:id/steps
GET  /api/workflow-runs/:id/events
POST /api/workflow-runs/:id/cancel
POST /api/workflow-runs/:id/resume
```

`GET /api/workflow-runs/:id/steps` 返回该运行的全部步骤记录（分页），含状态、输入输出、
调用次数、审批 ID 与**缺失引用**（`missingRefs`）。
SSE 的首帧快照只覆盖实时观察；运行结束、连接关闭后，
「这次运行到底缺了哪些字段、每一步的输入输出是什么」要靠这个端点查，
否则运行级与步骤级留痕只能翻数据库，达不到可观测的要求。
步骤列表同样按租户 + 所有权授权，跨租户一律 404。

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
GET    /api/workflow-templates
POST   /api/workflow-templates
PUT    /api/workflow-templates/:id/draft
POST   /api/workflow-templates/:id/publish
DELETE /api/workflow-templates/:id
POST   /api/workflow-templates/:id/install
```

- `GET` 只返回平台模板和调用者本租户模板，跨租户模板不可枚举。
- `POST` 创建 `platform` 模板仅限 `platform-admin`；创建 `tenant` 模板限当前租户 `admin / platform-admin`，归属租户从令牌获取，不接受客户端指定其他 `tenantId`。
- `PUT` 只能修改本作用域的草稿；`publish` 后版本不可变。平台模板由 `platform-admin` 发布，租户模板由当前租户 `admin / platform-admin` 发布。
- `DELETE` 仅软删除目录条目，不物理删除已发布版本和来源校验和；已安装副本与历史审计不受影响。
- `install` 允许安装平台模板或本租户模板，跨租户安装租户模板返回 404；安装在调用者租户内创建新草稿并返回需要绑定的资源槽位。

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

平台模板是 V1 **唯一的跨租户载体**（见 1.1 决策 ②）：可执行工作流和租户模板始终归属于具体租户
（`tenantId + workflowId + version` 或 `scope=tenant + tenantId`），不能被其他租户直接引用、安装或运行；
跨租户只能复用**不可变、未绑定资源的平台模板骨架**。

> 为什么不能共享可执行定义：知识库、工具参数、输出字段和身份信息一旦跨租户串联，
> 就会形成越权通道。可见范围（`private` / `department` / `tenant`）只在租户内部生效。

### 12.1 模板的内容边界

模板只包含流程结构和资源槽位，**不包含租户物理资源**：

- 不包含知识库 ID、文档内容、API Key、Base URL、用户身份等租户数据；
- 不允许在模板里绑定某个租户的具体资源实例；
- 模板版本一经发布即不可变；平台模板由 `platform-admin` 发布，租户模板由当前租户 `admin / platform-admin` 发布。

资源槽位示例：

- `modelSlot`：需要一个当前租户可用的对话虚拟模型。
- `knowledgeSlot`：需要调用者有权访问的知识范围。
- `toolSlot`：需要匹配指定输入输出 Schema 的逻辑工具。

### 12.2 安装即复制

安装时（`POST /api/workflow-templates/:id/install`）：

1. 复制指定模板版本为租户内草稿。
2. 记录 `templateId/templateVersion/sourceChecksum`，便于检查更新。
3. 要求用户选择本地资源，后端验证权限和 Schema 兼容性。
4. 未绑定完成前只能保存，不能发布或运行。
5. 模板更新只提示差异，不自动改变已安装、已发布或运行中的流程。

### 12.3 升级只生成新草稿

模板升级**不改变任何已安装的流程**：

- 升级动作只生成一份**新的草稿**，由租户主动安装；
- 已发布版本和正在运行的流程一律保持原样；
- 租户比较 `sourceChecksum` 决定是否查看差异，不做自动同步。

这条和「已发布版本不可修改」是同一原则：**任何会影响执行的语义变化都必须显式发生**，
不能靠后台同步悄悄生效。

### 12.4 模板市场的边界

V1 仅开放**平台内置模板 + 租户模板**，暂缓开放第三方市场。

第三方模板可能包含诱导提示词和危险工具编排，必须按**可执行内容**审核，
不能当作普通文本分享。开放第三方市场至少需要额外的内容审核和安全签名机制，
这超出 V1 范围。

### 12.5 与审批口径的关系

模板不改变审批口径：安装出来的流程和自建流程一样，**逐次工具级审批**，
不因为「来自受信模板」而获得任何审批背书（见 1.1 决策 ③、8.1）。

## 13. 审计、Trace 与安全

- 流程创建、修改、发布、删除、启动、取消、恢复和模板安装均写管理审计。
- LLM 和工具调用继续使用现有网关审计，并附加 `workflowId/runId/nodeId`。
- 每次运行使用根 Trace；Agent 节点保留子 Trace 关联。
- 审计和界面错误不暴露 Provider 密钥、访问令牌或完整敏感输入输出。
- 工作流节点输出按文本渲染，不能注入 HTML 或脚本。
- 工具节点不能覆盖网关注入的 `__ctx`。
- **节点配置任意层级都不得出现 `__proto__` / `constructor` / `prototype` 键**：
  这类键在模板解析时会把属性注入到原型链上，下游读到的是被注入的值，
  而序列化后又看不见，等于绕过审计。校验层直接拒绝，运行时解析结果用 null 原型对象承接（双保险）。
  **条件 AST 的操作数内部同样算「配置层级」**：它走独立的条件校验器，
  但不能因此漏掉原型污染键检查，否则同一份规则在不同层级出现两种口径。
- **校验器自己的查表也必须是安全查表**：节点类型、分支取值、配置字段白名单这类「键来自不可信输入」
  的映射，一律用 **null 原型对象**（`Object.create(null)`）承载，或用只认自有属性的 `ownEntry()` 读取。
  普通对象字面量会把 `constructor` / `toString` 等原型链成员当成合法条目 ——
  `node.type='constructor'` 会取到 `Object` 构造函数，随后 `.join()` 直接抛
  `allowedBranches.join is not a function`，校验器本身变成异常入口。
  查表结果本身也要先确认形态：拿到非数组的表项时先报校验问题，不要直接 `.includes()` / `.join()`。
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
- **缺失引用留痕**：跳过的上游分支、运行输入缺少非必填字段两种来源都要落到步骤与运行记录上；
  必填引用缺失导致运行失败时同样留痕。
- **终态并发收敛**：取消与执行器收敛同时推进同一个运行时，双方都返回最终运行记录，不抛转换冲突。
- **不可信查表**：以不可信输入做键的映射表（节点类型、分支取值、配置白名单）必须用 null 原型对象
  或只认自有属性的读取方式；`node.type='constructor'` 不得让校验器抛 `join is not a function`。
- **结构规模超限**：节点 / 边超限时立即返回，不继续做 O(N×(N+E)) 的可达性与引用收集；
  超大定义（如 6000 节点链式）的校验耗时有界。
- **条件操作数全层级**：数组元素与对象属性里的嵌套 `$ref`、原型污染键在发布期被拒；
  操作数深度超限报 `config_too_deep`，不静默截断。
- **校验器是全函数**：Schema 形态非法与实现版本白名单表项非法都只报校验问题，
  不得抛异常；畸形定义走运行时启动抛的是领域错误（`invalid_definition`），不是裸 `TypeError`。
- **版本写路径身份与自审**：管理员覆盖内容后不能自审自发（自审判据看作者与最后修改者两列）；
  软删除后不能再送审发布；直发不写审核留痕；版本号必须单调递增。
- **部门归属的省略语义**：省略 `deptId` 的更新保留库中原值，部门可见的工作流不会凭空消失；
  多部门用户新建时仍必须显式选择部门。
- **额度与副作用证据**：额度在预留阶段被拦下的那次尝试不算写副作用，
  真正写请求发出后失败仍必须留 `side_effect_unknown`；节点超时是运行时合成的错误，不触发自动重试。

### 14.2 接口与安全测试

- 私有、部门、租户可见范围及跨租户拒绝。
- 普通用户可建私有草稿，但不能发布共享版本或读取他人运行。
- 伪造身份、租户、模型、工具、`__ctx` 和审批 ID 均被拒绝。
- 已发布版本不可修改，删除后历史运行仍可追溯。
- 取消、超时、身份过期、服务重启和恢复路径。
- 运行限额、输入输出上限及敏感信息不落日志。
- **模板**：安装模板只在安装者租户内生成草稿，其他租户无法引用或运行该草稿；
  模板升级只生成新草稿，已发布版本与运行中的流程不受影响。
- **审批**：工作流定义携带 `skipApproval` 之类的绕过配置被拒绝；
  发布审批与启动审批通过后，写工具仍需逐次审批且审批不能重放。
- **版本写路径身份**：非所有者改不动他人草稿，非管理员做不了审核与发布；
  普通 upsert 既不能伪造审核留痕，也不能抹掉真实的驳回意见。
- **草稿版本可见性**：工作流对同租户可见时，其未发布版本仍只对所有者与管理员可见。

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
- 实现平台/租户模板复制安装和资源绑定；模板升级只生成新草稿。
- V1 不开放第三方模板市场，也不提供工作流级审批背书。
- 完成两条端到端验收路径。

每个阶段都应保持现有测试和构建通过，不一次性提交无法拆查的大块实现。

## 16. 后续演进

当出现以下任一明确需求时，优先评估 Temporal，而不是继续扩大自研 Worker：

- 跨天审批和无人值守执行。
- 服务重启后自动恢复。
- 多副本 Worker、水平扩容和分布式协调。
- 定时调度、外部信号、复杂重试和长期补偿。

React Flow 画布、DAG 契约、节点端口和网关治理可以保留，仅替换持久化执行底座。

拆分独立 Worker 时，`workflow-core` 的领域逻辑与节点定义**不需要重写**，
只需把 `agent-core/src/workflow` 里的端口实现整体搬到独立服务并补上服务间鉴权与追踪；
依赖方向 `agent-core → workflow-core → platform-core` 在拆分后可能变成
`workflow-worker → workflow-core → platform-core`，但领域层仍然不依赖任何宿主。
