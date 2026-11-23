/**
 * 平台共享类型定义
 * 对应《企业级 AI Agent 平台建设方案》2.1 架构分层与 3.1 组件总览。
 */

/** 身份上下文 —— Keycloak JWT 签发后由鉴权中间件注入（见 4.1 / 7.1） */
export interface Identity {
  tenantId: string;
  userId: string;
  role: string;
  deptId: string;
  scopes: string[];
  /** 数据密级 —— 决定出网路由（见 8.1 数据分级与路由） */
  sensitivity: SensitivityLevel;
  claims: Record<string, unknown>;
}

/** 数据密级 —— 涉密 / 内部普通 / 公开（见 8.1） */
export type SensitivityLevel = 'confidential' | 'internal' | 'public';

/** 租户（见 7.2 租户体系） */
export interface Tenant {
  id: string;
  name: string;
  /** 租户级模型白名单 */
  models: string[];
  /** 租户级工具白名单 */
  tools: string[];
  /** 租户级知识库 */
  knowledgeBases: string[];
  /** 月度预算（金额，单位 USD） */
  monthlyBudgetUsd: number;
  /** 月度 Token 预算 */
  monthlyTokenBudget: number;
  enabled: boolean;
}

/** 应用（预算三级体系中的「应用级」，见 4.3） */
export interface Application {
  id: string;
  tenantId: string;
  name: string;
  qpsLimit: number;
  perRequestTokenLimit: number;
  monthlyBudgetUsd: number;
  enabled: boolean;
}

export type ProviderProtocol = 'openai' | 'anthropic';
export type ProviderAuthMode = 'auto' | 'bearer' | 'x-api-key';

/** 控制台自定义的 OpenAI / Anthropic 兼容 Provider。 */
export interface ProviderDefinition {
  name: string;
  baseUrl: string;
  protocol: ProviderProtocol;
  authMode: ProviderAuthMode;
  accounts: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

export interface ProviderConnectionView {
  name: string;
  protocol: ProviderProtocol | 'tei';
  authMode?: ProviderAuthMode;
  baseUrl: string;
  accounts: string[];
  enabled: boolean;
  source: 'env' | 'console';
  createdAt?: string;
  updatedAt?: string;
  updatedBy?: string;
}

/** Provider 目标 —— Failover 链上的一环（见 4.4 Failover 链） */
export interface ProviderTarget {
  /** provider 标识，如 minimax / openai / qwen / deepseek */
  provider: string;
  /** 真实模型名 */
  model: string;
  /** 账号池别名，对应多个子账号（见 4.4 Key 治理第 1 条） */
  account?: string;
  /** 主用目标的相对权重；未设置时按 1 参与加权，全部未设置时保持固定顺序 */
  weight?: number;
  /** 在 Failover 链中的角色 */
  role: 'primary' | 'fallback';
  /** 该档位允许的最大输出 token */
  maxTokens?: number;
}

/** 虚拟模型 —— AgentScope 侧只感知虚拟模型名，不感知真实 Provider（见 4.1 关键配置） */
export interface VirtualModel {
  name: string;
  description: string;
  /** Failover 链，按顺序尝试 */
  targets: ProviderTarget[];
  /** 适用场景 */
  scenarios: string[];
  enabled: boolean;
}

/**
 * Provider 凭证（平台级）—— 控制台可管理，密文存储。
 *
 * 口径见方案 4.4 / 8.5：商业 API 凭证**只有网关进程可见**，
 * 业务组件（RAGFlow / DB-GPT 等）一律只拿网关的服务间令牌。
 * 因此这张表由网关独占读写，明文永不出网关、也永不回传浏览器。
 */
export interface ProviderCredential {
  /** 存储键：默认账号为 provider，其他账号为 provider#account */
  provider: string;
  /** 密文，格式 `v1:<iv>:<tag>:<ciphertext>`（AES-256-GCM） */
  secretCipher: string;
  /** 写入来源（当前只有 console = 控制台） */
  source: string;
  updatedAt: string;
  updatedBy: string;
}

/** 凭证的对外视图 —— **不含明文**，只有掩码与来源 */
export interface ProviderCredentialView {
  provider: string;
  /** 缺省为 default；其他账号通过 provider#account 形式加密存储 */
  account?: string;
  /** 是否已配置可用凭证 */
  configured: boolean;
  /** 掩码（只保留后 4 位），未配置时为空串 */
  masked: string;
  /** 当前生效来源：console=控制台 / env=环境变量 / credential-file=本地凭证文件 / none=未配置 */
  source: 'console' | 'env' | 'credential-file' | 'none';
  updatedAt: string;
  updatedBy: string;
  /**
   * 是否配了可达地址（BASE_URL）。
   *
   * 凭证只管鉴权，地址决定请求发往哪个厂商域名 —— 地址缺失时凭证写了也不生效，
   * 所以界面必须把「有 key 但没地址」这种半配置状态显式暴露出来。
   */
  baseUrlConfigured: boolean;
}

/** JSON Schema 子集 */
export interface JsonSchema {
  type: 'object' | 'array' | 'string' | 'number' | 'boolean';
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  description?: string;
  enum?: string[];
  default?: unknown;
}

/** 工具规格 —— 来自 MCP Server，经网关治理后下发给 Agent */
export interface ToolSpec {
  /** 全局唯一工具名，例如 chatbi.query_sales */
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** 来源 MCP Server 标识 */
  serverId: string;
  /** 是否需要人工确认（HITL，见 4.1） */
  requiresConfirmation: boolean;
  /** 工具产出数据的密级 */
  sensitivity: SensitivityLevel;
  /** 数据范围说明，审计用（见 8.4） */
  dataScope?: string;
}

/** MCP 工具目录（按租户下发，MCP Federation，见 4.3） */
export interface ToolCatalog {
  serverId: string;
  tools: ToolSpec[];
}

/** 预算维度 */
export interface BudgetScope {
  platformId?: string;
  tenantId: string;
  appId?: string;
}

/** 预算超限动作（见 4.3 预算与配额三级体系） */
export type BudgetAction = 'alert' | 'throttle' | 'circuit_break';

/** 审计事件（见 8.4 审计要求） */
export interface AuditEvent {
  id: string;
  ts: string;
  kind: 'llm' | 'tool' | 'admin' | 'auth';
  tenantId: string;
  userId: string;
  role?: string;
  deptId?: string;
  appId?: string;
  sessionId?: string;
  traceId: string;
  model?: string;
  provider?: string;
  tool?: string;
  serverId?: string;
  promptTokens?: number;
  completionTokens?: number;
  costUsd?: number;
  status: 'ok' | 'error' | 'blocked';
  /** 被拦截原因，如 guardrails 命中、预算超限、策略拒绝 */
  reason?: string;
  detail?: Record<string, unknown>;
}

/** Trace 摘要（Langfuse 对齐字段，见 11.2 成本管理） */
export interface TraceRecord {
  traceId: string;
  sessionId?: string;
  tenantId: string;
  userId: string;
  name: string;
  ts: string;
  input?: unknown;
  output?: unknown;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  model?: string;
  metadata: Record<string, unknown>;
}

/** 统一错误类型 */
export class PlatformError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 500,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'PlatformError';
  }
}

/** OpenAI 兼容的 chat message */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  content: string;
  isError?: boolean;
}

/** 工具调用请求 */
export interface ToolCallRequest {
  serverId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  identity: Identity;
  sessionId: string;
  traceId: string;
  appId?: string;
}

/** HITL 人工确认请求（见 4.1 HITL） */
export interface ApprovalRequest {
  id: string;
  tenantId: string;
  userId: string;
  sessionId: string;
  traceId: string;
  tool: string;
  args: Record<string, unknown>;
  reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'executed';
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
}
