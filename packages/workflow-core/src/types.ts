/**
 * 工作流领域类型 —— 见 docs/workflow-v1-design.md 第 5、6、7 节。
 *
 * 本包只放**纯领域逻辑**：不依赖 Express、React、AG-UI、Keycloak 或任何 Provider 实现，
 * 不读环境变量、不直接管理网络或数据库连接。执行所需的外部能力通过 A3 端口接口注入。
 */

/** 节点类型 —— V1 支持的八种。 */
export type WorkflowNodeType =
  | 'input'
  | 'llm'
  | 'knowledge'
  | 'tool'
  | 'condition'
  | 'agent'
  | 'approval'
  | 'output';

/**
 * 节点的分支出口标记。
 *
 * 条件节点用 `true / false`，人工审核节点用 `approved / rejected`；
 * 两套取值互不通用，由 `NODE_BRANCH_VALUES` 统一登记。
 */
export type BranchKind = 'true' | 'false' | 'approved' | 'rejected';

/**
 * 各节点类型允许的分支取值。
 *
 * 未列出的节点类型**不允许**携带 `branch`；列出的节点类型只能取表内的值。
 * 校验器与运行时共用这一张表，避免两处各写一份字符串数组导致口径漂移。
 *
 * 表建成 **null 原型对象**：节点类型来自不可信 JSON，
 * 用 `constructor` / `toString` 这类键查普通对象会从原型链上取到继承值，
 * 查表结果不再是「未命中」，而是拿到一个函数 —— 校验器会因此抛异常而不是返回问题。
 */
export const NODE_BRANCH_VALUES: Partial<Record<WorkflowNodeType, readonly BranchKind[]>> = Object.assign(
  Object.create(null) as Partial<Record<WorkflowNodeType, readonly BranchKind[]>>,
  {
    condition: ['true', 'false'],
    approval: ['approved', 'rejected'],
  },
);

/**
 * 平台当前支持的 (节点类型, 实现版本) 组合。
 *
 * 顶层 `schemaVersion` 管的是**定义结构**，`implVersion` 管的是**单个节点的执行语义**，
 * 两者独立演进（见设计文档 R4）。语义不兼容的改动必须提升 `implVersion`。
 *
 * 同样是 null 原型对象：查表键来自不可信 JSON。
 */
export const SUPPORTED_NODE_IMPLEMENTATIONS: Readonly<Record<WorkflowNodeType, readonly number[]>> = Object.assign(
  Object.create(null) as Record<WorkflowNodeType, readonly number[]>,
  {
    input: [1],
    output: [1],
    llm: [1],
    knowledge: [1],
    tool: [1],
    condition: [1],
    agent: [1],
    approval: [1],
  },
);

/** 定义结构版本。 */
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [1];

/** JSON Schema 最小子集 —— 见设计文档 R8。 */
export type JsonSchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';

/** JSON Schema 最小子集定义（只支持下列关键字，其余一律在校验期拒绝）。 */
export interface JsonSchema {
  type?: JsonSchemaType;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  items?: JsonSchema;
  additionalProperties?: boolean;
}

/** 受限引用 —— 只允许指向 `input.*` 与上游节点的已声明输出字段。 */
export interface RefValue {
  $ref: string;
}

/** 可含引用的配置片段：字面量或引用。 */
export type TemplatedValue = unknown;

/** 节点位置 —— 仅用于展示，不参与执行语义。 */
export interface NodePosition {
  x: number;
  y: number;
}

/** 输入节点配置。 */
export interface InputNodeConfig {
  /** 业务表单字段名（与 inputSchema.properties 对应）。 */
  fields?: string[];
}

/** LLM 提示词片段。 */
export type PromptFragment = string | RefValue;

/** LLM 节点配置。 */
export interface LlmNodeConfig {
  /** 虚拟模型名；不允许填写真实 Provider、Base URL 或 API Key。 */
  model?: string;
  systemPrompt?: string | PromptFragment[];
  userPrompt?: string | PromptFragment[];
  maxOutputTokens?: number;
}

/** 知识检索节点配置。 */
export interface KnowledgeNodeConfig {
  query?: TemplatedValue;
  topK?: number;
  /** 可选逻辑知识范围；由运行者可用的 knowledgeScopes 校验。 */
  knowledgeScope?: string;
}

/** MCP 工具节点配置。 */
export interface ToolNodeConfig {
  serverId?: string;
  tool?: string;
  args?: Record<string, TemplatedValue>;
}

/** Agent 节点配置。 */
export interface AgentNodeConfig {
  model?: string;
  instruction?: string;
  maxIterations?: number;
  /** 允许 Agent 调用的工具标识，格式固定为 `serverId/tool`。 */
  allowedTools?: string[];
}

/** 人工审核节点配置。 */
export interface ApprovalNodeConfig {
  title?: string;
  description?: string;
  summary?: TemplatedValue;
}

/** 输出节点配置。 */
export interface OutputNodeConfig {
  /** 输出字段名到值的映射。 */
  fields?: Record<string, TemplatedValue>;
}

/** 节点配置联合类型。 */
export type WorkflowNodeConfig =
  | InputNodeConfig
  | LlmNodeConfig
  | KnowledgeNodeConfig
  | ToolNodeConfig
  | AgentNodeConfig
  | ApprovalNodeConfig
  | OutputNodeConfig
  | Record<string, unknown>;

/** 工作流节点。 */
export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  /** 节点实现版本；缺省视为 1，但落库时必须显式写入。 */
  implVersion?: number;
  name?: string;
  position?: NodePosition;
  config?: WorkflowNodeConfig;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
}

/** 工作流边。 */
export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  /**
   * 分支出口标记：条件节点取 `true/false`，人工审核节点取 `approved/rejected`；
   * 其它节点类型不带。
   */
  branch?: BranchKind;
}

/** 运行级限额。 */
export interface WorkflowLimits {
  maxSteps: number;
  maxLlmCalls: number;
  maxToolCalls: number;
  timeoutMs: number;
  approvalTimeoutMs: number;
}

/** 工作流定义（服务端执行的唯一依据）。 */
export interface WorkflowDefinition {
  schemaVersion: number;
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  limits?: Partial<WorkflowLimits>;
}

/** 工作流可见范围。 */
export type WorkflowVisibility = 'private' | 'department' | 'tenant';

/** 版本状态。 */
export type WorkflowVersionStatus = 'draft' | 'in_review' | 'published' | 'rejected';

/** 运行模式。 */
export type WorkflowRunMode = 'debug' | 'published';

/** 运行状态机。 */
export type WorkflowRunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'waiting_approval';

/** 步骤状态机。 */
export type WorkflowStepStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'waiting_approval';

/** 终态集合 —— 调度器据此判断是否可以推进下游。 */
export const TERMINAL_RUN_STATUSES: readonly WorkflowRunStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
];

export const TERMINAL_STEP_STATUSES: readonly WorkflowStepStatus[] = [
  'succeeded',
  'failed',
  'skipped',
];

/** 校验问题。 */
export interface ValidationIssue {
  /** 稳定的错误码，便于前端定位与自动化断言。 */
  code: string;
  message: string;
  /** 出错节点（若能定位）。 */
  nodeId?: string;
  /** 出错边（若能定位）。 */
  edgeId?: string;
  /** 出错字段路径（如 `nodes.review.config.model`）。 */
  path?: string;
}

/** 单类资源的白名单校验状态。 */
export type ResourceCheckStatus =
  /** 当前定义使用了该资源，且已按调用者白名单校验。 */
  | 'performed'
  /** 当前定义使用了该资源，但调用方没有提供对应白名单。 */
  | 'skipped'
  /** 当前定义不使用该资源，无需校验。 */
  | 'not_required';

/** 按资源类别报告校验状态，避免部分注入被误认为整体已授权。 */
export interface ResourceCheckSummary {
  models: ResourceCheckStatus;
  tools: ResourceCheckStatus;
  knowledgeScopes: ResourceCheckStatus;
}

/** 校验结果。 */
export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  /**
   * 每类资源是否真正完成白名单校验。
   *
   * 发布、启动和恢复接口必须拒绝任何所需类别为 `skipped` 的结果；
   * `ok: true` 只表示定义结构合法，不代表资源已授权。
   */
  resourceCheck: ResourceCheckSummary;
}

/**
 * 条件 AST —— 结构化，不接受任意表达式。
 *
 * 二元算子必须带 `right`；一元算子（`exists / not_exists / is_true / is_false`）
 * **不接受** `right`，带上会被校验拒绝。
 */
export type ConditionExpr =
  | { all: ConditionExpr[] }
  | { any: ConditionExpr[] }
  | { not: ConditionExpr }
  | { left: TemplatedValue; operator: ConditionOperator; right?: TemplatedValue };

/** 条件算子。 */
export type ConditionOperator =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'not_contains'
  | 'exists'
  | 'not_exists'
  | 'is_true'
  | 'is_false';

/** 条件求值上下文：可解析引用。 */
export interface ConditionContext {
  /** 启动输入。 */
  input?: Record<string, unknown>;
  /** 已完成节点的输出，按节点 ID 索引。 */
  nodes?: Record<string, { output?: Record<string, unknown> }>;
}

/** 一次运行的外部资源可用性 —— 由上层（agent-core）按调用者身份注入。 */
export interface WorkflowResourceScope {
  /** 可用的虚拟模型名。 */
  models?: string[];
  /** 可用的知识范围标识。 */
  knowledgeScopes?: string[];
  /** 可用的工具，格式 `serverId/tool`。 */
  tools?: string[];
}

/** 校验上下文：决定「当前用户可用的逻辑资源」。 */
export interface ValidationContext {
  /**
   * 平台限额（业务用户只能调低）。
   *
   * 可以只覆盖其中几项，缺失项按内置 `PLATFORM_LIMIT_CAPS` 处理。
   */
  platformLimits?: Partial<WorkflowLimits>;
  /**
   * 当前用户可用的资源；缺省表示不做资源白名单校验。
   *
   * 缺省时，当前定义实际使用的资源类别在 `resourceCheck` 中标记为 `skipped`，
   * 未使用的类别标记为 `not_required`。
   */
  resources?: WorkflowResourceScope;
  /** 已支持的节点实现版本表；缺省用内置白名单。 */
  nodeImplementations?: Readonly<Record<WorkflowNodeType, readonly number[]>>;
}
