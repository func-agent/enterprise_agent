/**
 * 前端类型定义 —— 与后端 API 契约一一对应。
 *
 * 命名约定：后端 camelCase 字段保持原样；后端 snake_case 字段保持原样，
 * 避免在前端做二次映射造成的歧义。
 */

/** 平台角色（开发态登录可选） */
export const ROLES = ['employee', 'manager', 'admin', 'platform-admin'] as const;
export type Role = (typeof ROLES)[number];

/** 数据密级 */
export const SENSITIVITIES = ['public', 'internal', 'confidential'] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];

/** 登录返回的身份信息 */
export interface Identity {
  tenant_id: string;
  user_id: string;
  role: Role | string;
  dept_id: string;
  sensitivity: Sensitivity | string;
  /**
   * 登录名 —— 仅用于界面展示。
   * user_id 是稳定主体标识（OIDC 的 sub），审计与权限判定以它为准；
   * 身份菜单展示 UUID 不友好，故另带用户名。
   */
  username?: string;
}

/** 开发态登录响应 */
export interface DevTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  identity: Identity;
}

export interface ManagedUser {
  id: string;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  enabled: boolean;
  role: string;
  tenantId: string;
  deptId: string;
  sensitivity: string;
  serviceAccount: boolean;
}

export interface ManagedUserInput {
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  tenantId: string;
  deptId: string;
  sensitivity: string;
}

export type ManagedUserUpdate = Omit<ManagedUserInput, 'username'>;

export interface ManagedUserMutation {
  user: ManagedUser;
  password?: string;
  sessionRevoked?: boolean;
}

export interface ManagedTenant {
  id: string;
  name: string;
  enabled: boolean;
}

/**
 * 网关下发的鉴权配置（GET /v1/auth/config）。
 *
 * mode = 'oidc' 时控制台走 Keycloak 授权码 + PKCE 统一登录；
 * mode = 'dev'  时走开发态身份选择（仅 AUTH_DEV_MODE=true 时可用）。
 */
export interface AuthConfig {
  mode: 'dev' | 'oidc';
  clientId: string;
  scope: string;
  authorizationUrl: string;
  tokenUrl: string;
  endSessionUrl: string;
  issuer: string;
  redirectPath: string;
  devMode: boolean;
}

/** 会话摘要 */
export interface SessionSummary {
  id: string;
  tenantId: string;
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/** 一次工具调用记录 */
export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  output: string;
}

/** 对话响应 */
export interface ChatResponse {
  session_id: string;
  content: string;
  iterations: number;
  tool_calls: ToolCallRecord[];
  trace_id: string;
}

/** 会话消息（Agent 存储结构） */
export interface AgentMessage {
  id: string;
  sessionId: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  createdAt: string;
  toolCalls?: unknown;
  traceId?: string;
}

/** 工具规格（Agent /api/tools，camelCase） */
export interface AgentToolSpec {
  name: string;
  description: string;
  inputSchema: unknown;
  serverId: string;
  requiresConfirmation: boolean;
  sensitivity: Sensitivity | string;
  dataScope?: string;
}

/** 工具目录（网关 /v1/mcp/tools，snake_case） */
export interface GatewayTool {
  name: string;
  description: string;
  input_schema: unknown;
  server_id: string;
  requires_confirmation: boolean;
  sensitivity: Sensitivity | string;
  data_scope?: string;
}

/** Failover 链上的一个真实模型 */
export interface ProviderTarget {
  provider: string;
  model: string;
  role: 'primary' | 'fallback';
  account?: string;
  weight?: number;
  maxTokens?: number;
}

/** 虚拟模型（网关 /v1/models） */
export interface VirtualModel {
  id: string;
  description?: string;
  scenarios?: string[];
  targets: ProviderTarget[];
}

/** 虚拟模型（网关 /v1/admin/agents，含 enabled / weight） */
export interface AgentModel {
  name: string;
  description: string;
  targets: ProviderTarget[];
  scenarios: string[];
  enabled: boolean;
}

export type ProviderProtocol = 'openai' | 'anthropic';
export type ProviderAuthMode = 'auto' | 'bearer' | 'x-api-key';

export interface ProviderOption {
  name: string;
  protocol: ProviderProtocol | 'tei' | string;
  authMode?: ProviderAuthMode;
  baseUrl: string;
  accounts: string[];
  enabled: boolean;
  source: 'env' | 'console';
  createdAt?: string;
  updatedAt?: string;
  updatedBy?: string;
}

export interface ProviderDefinitionInput {
  name: string;
  protocol: ProviderProtocol;
  authMode: ProviderAuthMode;
  baseUrl: string;
  accounts: string[];
  enabled: boolean;
}

export interface ProviderTestResult {
  ok: boolean;
  status?: number;
  latencyMs: number;
  message: string;
}

export interface ModelConfigList {
  data: AgentModel[];
  providers: ProviderOption[];
  defaultModel: string;
}

/**
 * 厂商凭证的对外视图（网关 /v1/admin/providers）。
 *
 * **只有掩码，没有明文** —— 网关永远不会把 key 回传给浏览器。
 */
export interface ProviderCredential {
  provider: string;
  account?: string;
  /** 是否已配置可用凭证 */
  configured: boolean;
  /** 掩码（只保留后 4 位） */
  masked: string;
  /** 当前生效来源 */
  source: 'console' | 'env' | 'credential-file' | 'none';
  updatedAt: string;
  updatedBy: string;
  /** 是否配了可达地址（BASE_URL） */
  baseUrlConfigured: boolean;
}

/** 前端渲染用的消息视图（服务端消息 + 本地乐观消息的统一形态） */
export interface ChatMessageView {
  id: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  createdAt: string;
  toolCalls?: ToolCallRecord[];
  traceId?: string;
}

/** HITL 审批单 */
export interface Approval {
  id: string;
  tenantId: string;
  userId: string;
  sessionId: string;
  traceId: string;
  tool: string;
  args: Record<string, unknown>;
  reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | string;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
}

/** 平台级用量 */
export interface PlatformUsage {
  costUsd: number;
  requests: number;
  promptTokens: number;
  completionTokens: number;
}

/** 租户预算行 */
export interface TenantBudget {
  tenantId: string;
  name: string;
  budgetUsd: number;
  usedUsd: number;
  usedTokens: number;
  tokenBudget: number;
  requests: number;
  ratio: number;
}

/** 预算看板 */
export interface BudgetSummary {
  month: string;
  platform: PlatformUsage;
  tenants: TenantBudget[];
}

/** 审计事件 */
export interface AuditEvent {
  id: string;
  ts: string;
  kind: 'llm' | 'tool' | 'admin' | 'auth' | string;
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
  status: 'ok' | 'error' | 'blocked' | string;
  reason?: string;
  detail?: Record<string, unknown>;
}

/** Trace 摘要 */
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

/** MCP Server 健康状态 */
export interface McpServerHealth {
  serverId: string;
  ok: boolean;
  tools: number;
  error?: string;
}

/* ------------------------------------------------------------------ *
 * 知识库（控制台「知识库」页）
 * ------------------------------------------------------------------ */

/** 知识库文档摘要（列表项，不含正文） */
export interface KnowledgeSummary {
  id: string;
  title: string;
  deptId: string;
  sensitivity: string;
  ownerId: string;
  updatedAt: string;
  contentLength: number;
  snippet: string;
}

/** 知识库文档详情（含正文） */
export interface KnowledgeDoc extends KnowledgeSummary {
  tenantId: string;
  content: string;
}

/** 检索命中项 */
export interface KnowledgeHit {
  docId: string;
  title: string;
  deptId: string;
  sensitivity: string;
  score: number;
  snippet: string;
}

/** 检索结果 */
export interface KnowledgeSearchResult {
  query: string;
  topK: number;
  /** 检索引擎：infinity（向量+全文）/ local-bm25（本地兜底） */
  engine: string;
  count: number;
  hits: KnowledgeHit[];
  /** 渲染后的命中文本（带来源标注） */
  content: string;
}

/** 写操作受理结果 —— 写操作不直接落库，而是生成审批单 */
export interface KnowledgeWriteTicket {
  approvalId: string;
  status: string;
  tool: string;
  reason: string;
  createdAt: string;
  message: string;
}
