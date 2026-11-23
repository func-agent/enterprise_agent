/**
 * 后端接口封装 —— 统一处理鉴权头、JSON 编解码与错误信息提取。
 *
 * 所有页面都只经由本模块访问后端，避免请求细节散落在组件里。
 */
import type {
  AgentMessage,
  AgentToolSpec,
  Approval,
  AuditEvent,
  AuthConfig,
  BudgetSummary,
  ChatResponse,
  DevTokenResponse,
  GatewayTool,
  McpServerHealth,
  SessionSummary,
  TraceRecord,
  VirtualModel,
  AgentModel,
  KnowledgeDoc,
  KnowledgeSearchResult,
  KnowledgeSummary,
  KnowledgeWriteTicket,
  ProviderCredential,
  ModelConfigList,
  ProviderDefinitionInput,
  ProviderOption,
  ProviderTestResult,
  ManagedTenant,
  ManagedUser,
  ManagedUserInput,
  ManagedUserMutation,
  ManagedUserUpdate,
} from './types';

/** 读取构建期环境变量，缺省时回落到本地默认端口 */
function readEnv(key: string, fallback: string): string {
  const raw: unknown = import.meta.env[key];
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  return fallback;
}

/**
 * 后端地址 —— 默认走**同源相对路径**（空串），由前置层（本地 vite preview 的
 * proxy / 生产 Nginx / Envoy）反代到网关与 Agent 内核。
 *
 * 为什么不用绝对地址：绝对地址在构建时写死，一旦控制台经公网 IP 访问，
 * 浏览器就会去连「用户自己电脑的 127.0.0.1:8080」而失败。同源相对路径
 * 天然跟随用户实际访问的入口，无需按部署形态重编译。
 *
 * 需要直连时仍可用 VITE_GATEWAY_URL / VITE_AGENT_URL 显式覆盖。
 */
export const GATEWAY_URL = readEnv('VITE_GATEWAY_URL', '');
export const AGENT_URL = readEnv('VITE_AGENT_URL', '');

const TOKEN_KEY = 'eap.token';
const IDENTITY_KEY = 'eap.identity';
const EXPIRES_KEY = 'eap.token.expires';
/** id_token —— RP-initiated 登出时作为 id_token_hint 传给 Keycloak */
const ID_TOKEN_KEY = 'eap.id_token';
const REFRESH_TOKEN_KEY = 'eap.refresh_token';

/** 后端错误码 → 中文提示 */
const CODE_TEXT: Record<string, string> = {
  forbidden: '需要管理员权限',
  unauthorized: '身份凭证无效或已过期，请重新登录',
  not_found: '请求的资源不存在',
  internal_error: '服务内部错误',
  bad_request: '请求参数不合法',
  search_failed: '检索失败',
};

/** 统一错误类型：携带 HTTP 状态码，便于上层区分 403 / 401 / 网络故障 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }

  /** 是否为权限不足（网关管理接口对非管理员返回 403） */
  get isForbidden(): boolean {
    return this.status === 403;
  }
}

/* ------------------------------------------------------------------ *
 * 本地身份存储
 * ------------------------------------------------------------------ */

export function getToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getStoredIdentity(): string | null {
  try {
    return window.localStorage.getItem(IDENTITY_KEY);
  } catch {
    return null;
  }
}

/** 保存令牌与身份；expiresIn 为秒 */
export function persistAuth(token: string, identityJson: string, expiresIn: number): void {
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
    window.localStorage.setItem(IDENTITY_KEY, identityJson);
    window.localStorage.setItem(EXPIRES_KEY, String(Date.now() + expiresIn * 1000));
  } catch {
    /* 隐私模式下 localStorage 不可用，忽略即可（本次会话内仍可用） */
  }
}

/** 单独保存 id_token（登出时用） */
export function persistIdToken(idToken: string): void {
  try {
    window.localStorage.setItem(ID_TOKEN_KEY, idToken);
  } catch {
    /* ignore */
  }
}

export function getIdToken(): string | null {
  try {
    return window.localStorage.getItem(ID_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function persistRefreshToken(refreshToken: string): void {
  try {
    window.localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
  } catch {
    /* ignore */
  }
}

export function getRefreshToken(): string | null {
  try {
    return window.localStorage.getItem(REFRESH_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getTokenExpiresAt(): number | null {
  try {
    const value = Number(window.localStorage.getItem(EXPIRES_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function clearAuth(): void {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
    window.localStorage.removeItem(IDENTITY_KEY);
    window.localStorage.removeItem(EXPIRES_KEY);
    window.localStorage.removeItem(ID_TOKEN_KEY);
    window.localStorage.removeItem(REFRESH_TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

/** 令牌是否已过期（缺失视为未登录） */
export function isTokenExpired(): boolean {
  try {
    const raw = window.localStorage.getItem(EXPIRES_KEY);
    if (!raw) return true;
    const expiresAt = Number(raw);
    return Number.isFinite(expiresAt) && Date.now() > expiresAt;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * 请求内核
 * ------------------------------------------------------------------ */

function extractError(payload: unknown, status: number): { message: string; code?: string } {
  if (typeof payload === 'string' && payload.trim()) {
    return { message: payload.trim() };
  }
  if (payload && typeof payload === 'object') {
    const rec = payload as Record<string, unknown>;
    const err = rec.error;
    if (typeof err === 'string' && err) {
      const text = CODE_TEXT[err] ?? (typeof rec.message === 'string' ? rec.message : err);
      return { message: text, code: err };
    }
    if (err && typeof err === 'object') {
      const inner = err as Record<string, unknown>;
      const type = typeof inner.type === 'string' ? inner.type : undefined;
      const message =
        typeof inner.message === 'string' ? inner.message : type ? CODE_TEXT[type] ?? type : undefined;
      if (message) return { message, code: type };
    }
    if (typeof rec.message === 'string') return { message: rec.message };
  }
  return { message: `请求失败（HTTP ${status}）` };
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  /** 是否附带 Authorization 头（登录接口不需要） */
  auth?: boolean;
}

async function request<T>(base: string, path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers({ Accept: 'application/json' });
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  if (options.auth !== false) {
    const token = getToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
  }

  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError('网络请求失败，请确认网关与 Agent 服务已启动', 0);
  }

  const text = await response.text();
  let payload: unknown;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    const { message, code } = extractError(payload, response.status);
    throw new ApiError(message, response.status, code);
  }
  return payload as T;
}

/** 解包 `{ data: [...] }` 包装 */
function unwrap<T>(payload: unknown): T {
  if (payload && typeof payload === 'object' && 'data' in (payload as Record<string, unknown>)) {
    return (payload as { data: T }).data;
  }
  return payload as T;
}

/** 把任意异常转换为可展示的中文提示 */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return '未知错误';
}

/** 是否为用户主动取消的请求 */
export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/* ------------------------------------------------------------------ *
 * 登录（网关，免鉴权）
 * ------------------------------------------------------------------ */

export interface DevLoginInput {
  role: string;
  tenantId: string;
  deptId: string;
  sensitivity: string;
}

export async function devLogin(input: DevLoginInput, signal?: AbortSignal): Promise<DevTokenResponse> {
  return request<DevTokenResponse>(GATEWAY_URL, '/v1/auth/dev-token', {
    method: 'POST',
    auth: false,
    signal,
    body: {
      role: input.role,
      tenant_id: input.tenantId,
      dept_id: input.deptId,
      sensitivity: input.sensitivity,
    },
  });
}

/**
 * 读取网关下发的鉴权模式与 OIDC 授权配置。
 * 该端点公开（免鉴权）—— 控制台据此决定走统一登录还是开发态登录。
 */
export async function getAuthConfig(signal?: AbortSignal): Promise<AuthConfig> {
  return request<AuthConfig>(GATEWAY_URL, '/v1/auth/config', { auth: false, signal });
}

/* ------------------------------------------------------------------ *
 * 网关（端口 8080）
 * ------------------------------------------------------------------ */

export async function listModels(signal?: AbortSignal): Promise<VirtualModel[]> {
  return unwrap<VirtualModel[]>(await request(GATEWAY_URL, '/v1/models', { signal }));
}

export async function listManagedUsers(signal?: AbortSignal): Promise<ManagedUser[]> {
  return unwrap<ManagedUser[]>(await request(GATEWAY_URL, '/v1/admin/users', { signal }));
}

export async function listManagedTenants(signal?: AbortSignal): Promise<ManagedTenant[]> {
  return unwrap<ManagedTenant[]>(await request(GATEWAY_URL, '/v1/admin/tenants', { signal }));
}

export async function createManagedUser(input: ManagedUserInput): Promise<ManagedUserMutation> {
  const payload = await request<{ data: ManagedUser; password: string }>(GATEWAY_URL, '/v1/admin/users', {
    method: 'POST', body: input,
  });
  return { user: payload.data, password: payload.password };
}

export async function updateManagedUser(id: string, input: ManagedUserUpdate): Promise<ManagedUserMutation> {
  const payload = await request<{ data: ManagedUser; sessionRevoked: boolean }>(GATEWAY_URL, `/v1/admin/users/${encodeURIComponent(id)}`, {
    method: 'PUT', body: input,
  });
  return { user: payload.data, sessionRevoked: payload.sessionRevoked };
}

export async function setManagedUserEnabled(id: string, enabled: boolean): Promise<ManagedUserMutation> {
  const payload = await request<{ data: ManagedUser; sessionRevoked: boolean }>(GATEWAY_URL, `/v1/admin/users/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: { enabled },
  });
  return { user: payload.data, sessionRevoked: payload.sessionRevoked };
}

export async function resetManagedUserPassword(id: string): Promise<{ password: string; sessionRevoked: boolean }> {
  return request(GATEWAY_URL, `/v1/admin/users/${encodeURIComponent(id)}/reset-password`, { method: 'POST' });
}

export async function deleteManagedUser(id: string): Promise<ManagedUser> {
  return unwrap<ManagedUser>(await request(GATEWAY_URL, `/v1/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' }));
}

export async function listMcpTools(signal?: AbortSignal): Promise<GatewayTool[]> {
  return unwrap<GatewayTool[]>(await request(GATEWAY_URL, '/v1/mcp/tools', { signal }));
}

export async function listApprovals(
  status: 'pending' | 'approved' | 'executed' | 'rejected' | 'all' = 'pending',
  signal?: AbortSignal,
): Promise<Approval[]> {
  const query = status === 'all' ? '' : `?status=${encodeURIComponent(status)}`;
  return unwrap<Approval[]>(await request(GATEWAY_URL, `/v1/admin/approvals${query}`, { signal }));
}

export async function decideApproval(
  id: string,
  decision: 'approved' | 'rejected',
  signal?: AbortSignal,
): Promise<Approval> {
  const payload = await request<{ data: Approval }>(
    GATEWAY_URL,
    `/v1/admin/approvals/${encodeURIComponent(id)}/decide`,
    { method: 'POST', body: { decision }, signal },
  );
  return payload.data;
}

export async function fetchBudget(signal?: AbortSignal): Promise<BudgetSummary> {
  return request<BudgetSummary>(GATEWAY_URL, '/v1/admin/budget', { signal });
}

export async function fetchAudit(
  kind: 'llm' | 'tool' | 'admin' | 'all' = 'all',
  limit = 200,
  signal?: AbortSignal,
): Promise<AuditEvent[]> {
  const query = kind === 'all' ? `?limit=${limit}` : `?limit=${limit}&kind=${encodeURIComponent(kind)}`;
  return unwrap<AuditEvent[]>(await request(GATEWAY_URL, `/v1/admin/audit${query}`, { signal }));
}

export async function fetchTraces(signal?: AbortSignal): Promise<TraceRecord[]> {
  return unwrap<TraceRecord[]>(await request(GATEWAY_URL, '/v1/admin/traces', { signal }));
}

export async function listModelConfigs(signal?: AbortSignal): Promise<ModelConfigList> {
  return request<ModelConfigList>(GATEWAY_URL, '/v1/admin/models', { signal });
}

export async function createModelConfig(model: AgentModel, signal?: AbortSignal): Promise<AgentModel> {
  const payload = await request<{ data: AgentModel }>(GATEWAY_URL, '/v1/admin/models', {
    method: 'POST', body: model, signal,
  });
  return payload.data;
}

export async function updateModelConfig(model: AgentModel, signal?: AbortSignal): Promise<AgentModel> {
  const payload = await request<{ data: AgentModel }>(
    GATEWAY_URL,
    `/v1/admin/models/${encodeURIComponent(model.name)}`,
    { method: 'PUT', body: model, signal },
  );
  return payload.data;
}

export async function setModelEnabled(name: string, enabled: boolean, signal?: AbortSignal): Promise<AgentModel> {
  const payload = await request<{ data: AgentModel }>(
    GATEWAY_URL,
    `/v1/admin/models/${encodeURIComponent(name)}`,
    { method: 'PATCH', body: { enabled }, signal },
  );
  return payload.data;
}

export async function deleteModelConfig(name: string, signal?: AbortSignal): Promise<void> {
  await request(GATEWAY_URL, `/v1/admin/models/${encodeURIComponent(name)}`, { method: 'DELETE', signal });
}

/* ------------------------------------------------------------------ *
 * 厂商凭证（商业大模型 key）
 * ------------------------------------------------------------------ */

/** 凭证列表 + 主密钥是否已配置 */
export interface ProviderCredentialList {
  data: ProviderCredential[];
  masterKeyConfigured: boolean;
}

/**
 * 读取厂商凭证视图。
 *
 * 只返回掩码与来源，**永不返回明文**。
 */
export async function listProviderCredentials(signal?: AbortSignal): Promise<ProviderCredentialList> {
  return request<ProviderCredentialList>(GATEWAY_URL, '/v1/admin/providers', { signal });
}

/** 写入厂商凭证（管理员）。写入后网关立即生效，无需重启。 */
export async function setProviderCredential(
  provider: string,
  apiKey: string,
  account = 'default',
  signal?: AbortSignal,
): Promise<ProviderCredential> {
  const payload = await request<{ data: ProviderCredential }>(
    GATEWAY_URL,
    `/v1/admin/providers/${encodeURIComponent(provider)}`,
    { method: 'PUT', body: { apiKey, account }, signal },
  );
  return payload.data;
}

/** 删除厂商凭证（管理员）。删除后回落到环境变量 / OAuth 凭证文件。 */
export async function deleteProviderCredential(
  provider: string,
  account = 'default',
  signal?: AbortSignal,
): Promise<ProviderCredential> {
  const payload = await request<{ data: ProviderCredential }>(
    GATEWAY_URL,
    `/v1/admin/providers/${encodeURIComponent(provider)}?account=${encodeURIComponent(account)}`,
    { method: 'DELETE', signal },
  );
  return payload.data;
}

export async function createProviderDefinition(input: ProviderDefinitionInput): Promise<ProviderOption> {
  const payload = await request<{ data: ProviderOption }>(GATEWAY_URL, '/v1/admin/provider-definitions', { method: 'POST', body: input });
  return payload.data;
}

export async function updateProviderDefinition(name: string, input: ProviderDefinitionInput): Promise<ProviderOption> {
  const payload = await request<{ data: ProviderOption }>(GATEWAY_URL, `/v1/admin/provider-definitions/${encodeURIComponent(name)}`, { method: 'PUT', body: input });
  return payload.data;
}

export async function setProviderEnabled(name: string, enabled: boolean): Promise<ProviderOption> {
  const payload = await request<{ data: ProviderOption }>(GATEWAY_URL, `/v1/admin/provider-definitions/${encodeURIComponent(name)}`, { method: 'PATCH', body: { enabled } });
  return payload.data;
}

export async function deleteProviderDefinition(name: string): Promise<void> {
  await request(GATEWAY_URL, `/v1/admin/provider-definitions/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

export async function testProviderConnection(name: string, account = 'default'): Promise<ProviderTestResult> {
  const payload = await request<{ data: ProviderTestResult }>(GATEWAY_URL, `/v1/admin/provider-definitions/${encodeURIComponent(name)}/test`, { method: 'POST', body: { account } });
  return payload.data;
}

export async function fetchMcpHealth(signal?: AbortSignal): Promise<McpServerHealth[]> {
  const payload = await request<{ servers: McpServerHealth[] }>(GATEWAY_URL, '/v1/mcp/health', { signal });
  return payload.servers ?? [];
}

/* ------------------------------------------------------------------ *
 * 知识库
 * ------------------------------------------------------------------ */

/** 知识库文档列表（按当前身份的部门与密级过滤） */
export interface KnowledgeListPage {
  data: KnowledgeSummary[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

export async function listKnowledgeDocs(
  filter: { deptId?: string; sensitivity?: string; q?: string; page?: number; pageSize?: number } = {},
  signal?: AbortSignal,
): Promise<KnowledgeListPage> {
  const query = new URLSearchParams();
  if (filter.deptId) query.set('dept_id', filter.deptId);
  if (filter.sensitivity) query.set('sensitivity', filter.sensitivity);
  if (filter.q) query.set('q', filter.q);
  query.set('page', String(filter.page ?? 1));
  query.set('pageSize', String(filter.pageSize ?? 50));
  return request<KnowledgeListPage>(GATEWAY_URL, `/v1/knowledge/docs?${query.toString()}`, { signal });
}

/** 知识库文档详情 */
export async function getKnowledgeDoc(id: string, signal?: AbortSignal): Promise<KnowledgeDoc> {
  const payload = await request<{ data: KnowledgeDoc }>(
    GATEWAY_URL,
    `/v1/knowledge/docs/${encodeURIComponent(id)}`,
    { signal },
  );
  return payload.data;
}

/** 检索测试 —— 走与 Agent 完全相同的知识检索链路（Infinity 向量 + 全文召回） */
export async function searchKnowledge(
  query: string,
  topK = 5,
  signal?: AbortSignal,
): Promise<KnowledgeSearchResult> {
  const payload = await request<{ data: KnowledgeSearchResult }>(GATEWAY_URL, '/v1/knowledge/search', {
    method: 'POST',
    body: { query, topK },
    signal,
  });
  return payload.data;
}

/**
 * 新增 / 更新知识库文档。
 *
 * 注意：写操作**不直接落库** —— 网关只生成审批单（HTTP 202），
 * 需由另一位有审批权限的人在「审批中心」通过后才真正生效。
 */
export async function createKnowledgeDoc(
  input: { id?: string; title: string; content: string; deptId: string; sensitivity: string },
  signal?: AbortSignal,
): Promise<KnowledgeWriteTicket> {
  const payload = await request<{ data: KnowledgeWriteTicket }>(GATEWAY_URL, '/v1/knowledge/docs', {
    method: 'POST',
    body: input,
    signal,
  });
  return payload.data;
}

/** 删除知识库文档（同为审批制：返回审批单，审批通过后才真正删除） */
export async function deleteKnowledgeDoc(id: string, signal?: AbortSignal): Promise<KnowledgeWriteTicket> {
  const payload = await request<{ data: KnowledgeWriteTicket }>(
    GATEWAY_URL,
    `/v1/knowledge/docs/${encodeURIComponent(id)}`,
    { method: 'DELETE', signal },
  );
  return payload.data;
}

/* ------------------------------------------------------------------ *
 * Agent（端口 8090）
 * ------------------------------------------------------------------ */

export async function listSessions(signal?: AbortSignal): Promise<SessionSummary[]> {
  return unwrap<SessionSummary[]>(await request(AGENT_URL, '/api/sessions', { signal }));
}

export async function listMessages(sessionId: string, signal?: AbortSignal): Promise<AgentMessage[]> {
  return unwrap<AgentMessage[]>(
    await request(AGENT_URL, `/api/sessions/${encodeURIComponent(sessionId)}/messages`, { signal }),
  );
}

export async function deleteSession(sessionId: string, signal?: AbortSignal): Promise<void> {
  await request<void>(AGENT_URL, `/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE', signal });
}

export async function listAgentTools(signal?: AbortSignal): Promise<AgentToolSpec[]> {
  return unwrap<AgentToolSpec[]>(await request(AGENT_URL, '/api/tools', { signal }));
}

export interface ChatInput {
  message: string;
  sessionId?: string;
  appId?: string;
  model?: string;
}

/**
 * 发起一次对话。
 *
 * 注意：后端 agent-core 读取的是 `sessionId` / `appId`（驼峰），
 * 而网关 OpenAI 兼容层读取 `session_id` / `app_id`（下划线）。
 * 此处同时下发两种写法，兼容两端实现。
 */
export async function chat(input: ChatInput, signal?: AbortSignal): Promise<ChatResponse> {
  const body: Record<string, unknown> = { message: input.message };
  if (input.sessionId) {
    body.sessionId = input.sessionId;
    body.session_id = input.sessionId;
  }
  if (input.appId) {
    body.appId = input.appId;
    body.app_id = input.appId;
  }
  if (input.model) body.model = input.model;

  return request<ChatResponse>(AGENT_URL, '/api/chat', { method: 'POST', body, signal });
}
