/**
 * 元数据存储（对应 3.1 存储组件 PostgreSQL 16 —— 全平台元数据）。
 *
 * 生产用 Postgres，开发/单机 POC 用 SQLite，接口一致，通过 STORE_KIND 切换。
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type {
  ApprovalRequest,
  Application,
  AuditEvent,
  Tenant,
  TraceRecord,
  VirtualModel,
  ProviderCredential,
  ProviderDefinition,
} from '../types.js';
import {
  SQLITE_WORKFLOW_SCHEMA,
  assertWorkflowLockVersion,
  assertWorkflowRunSnapshot,
  assertWorkflowRunStatus,
  assertWorkflowStepAttempt,
  assertWorkflowStepCallCount,
  assertWorkflowStepStatus,
  assertWorkflowTemplateScope,
  assertWorkflowTemplateStatus,
  assertWorkflowVersionNumber,
  assertWorkflowVersionStatus,
  assertWorkflowVisibility,
  buildWorkflowNotDeletedCondition,
  buildWorkflowPublishBranchCondition,
  buildWorkflowRunVisibilityWhere,
  buildWorkflowSelfReviewCondition,
  buildWorkflowVersionVisibilityWhere,
  buildWorkflowVisibilityWhere,
  canManageWorkflow,
  canReviewWorkflow,
  mapWorkflowRow,
  mapWorkflowRunRow,
  mapWorkflowStepRunRow,
  mapWorkflowTemplateRow,
  mapWorkflowTemplateVersionRow,
  mapWorkflowVersionRow,
  normalizeTimestamp,
  parseWorkflowCursor,
  parseWorkflowVersionCursor,
  requireJsonField,
  resolveWorkflowDepartment,
  resolveWorkflowOwnerId,
  resolveWorkflowListLimit,
  type WorkflowActor,
  type WorkflowRecord,
  type WorkflowRunRecord,
  type WorkflowRunTransitionPatch,
  type WorkflowRunStatus,
  type WorkflowStepRunRecord,
  type WorkflowStore,
  type WorkflowTemplateRecord,
  type WorkflowTemplateVersionRecord,
  type WorkflowVersionRecord,
  type WorkflowVisibility,
} from './workflow.js';

export interface UsageRecord {
  scope: 'platform' | 'tenant' | 'app';
  scopeId: string;
  month: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  requests: number;
}

export interface SessionRecord {
  id: string;
  tenantId: string;
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  appId?: string;
}

export interface MessageRecord {
  id: string;
  sessionId: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  createdAt: string;
  toolCalls?: unknown;
  toolCallId?: string;
  traceId?: string;
}

export interface KnowledgeDoc {
  id: string;
  tenantId: string;
  deptId: string;
  title: string;
  content: string;
  /** 密级 —— 召回前过滤依据（见 4.2 知识库划分） */
  sensitivity: 'confidential' | 'internal' | 'public';
  ownerId: string;
  updatedAt: string;
}

export interface MetadataStore extends WorkflowStore {
  init(): Promise<void>;
  close(): Promise<void>;

  // 租户 / 应用
  upsertTenant(t: Tenant): Promise<void>;
  getTenant(id: string): Promise<Tenant | undefined>;
  listTenants(): Promise<Tenant[]>;
  upsertApplication(a: Application): Promise<void>;
  listApplications(tenantId?: string): Promise<Application[]>;

  // 虚拟模型
  upsertVirtualModel(m: VirtualModel): Promise<void>;
  getVirtualModel(name: string): Promise<VirtualModel | undefined>;
  listVirtualModels(): Promise<VirtualModel[]>;
  deleteVirtualModel(name: string): Promise<boolean>;

  // 自定义 Provider（平台级连接配置，不含密钥）
  upsertProviderDefinition(p: ProviderDefinition): Promise<void>;
  getProviderDefinition(name: string): Promise<ProviderDefinition | undefined>;
  listProviderDefinitions(): Promise<ProviderDefinition[]>;
  deleteProviderDefinition(name: string): Promise<boolean>;

  // Provider 凭证（平台级，密文存储；见 8.5 凭证安全）
  upsertProviderCredential(c: ProviderCredential): Promise<void>;
  getProviderCredential(provider: string): Promise<ProviderCredential | undefined>;
  listProviderCredentials(): Promise<ProviderCredential[]>;
  deleteProviderCredential(provider: string): Promise<boolean>;

  // 会话
  createSession(s: SessionRecord): Promise<void>;
  updateSession(id: string, patch: Partial<SessionRecord>): Promise<void>;
  getSession(id: string): Promise<SessionRecord | undefined>;
  listSessions(tenantId: string, userId?: string): Promise<SessionRecord[]>;
  deleteSession(id: string): Promise<boolean>;
  appendMessage(m: MessageRecord): Promise<void>;
  listMessages(sessionId: string): Promise<MessageRecord[]>;

  // HITL 审批
  createApproval(a: ApprovalRequest): Promise<void>;
  updateApproval(id: string, patch: Partial<ApprovalRequest>): Promise<void>;
  transitionApproval(
    id: string,
    tenantId: string,
    fromStatus: ApprovalRequest['status'],
    patch: Partial<ApprovalRequest>,
  ): Promise<boolean>;
  getApproval(id: string): Promise<ApprovalRequest | undefined>;
  listApprovals(filter: { tenantId?: string; status?: string; userId?: string }): Promise<ApprovalRequest[]>;

  // 审计
  appendAudit(e: AuditEvent): Promise<void>;
  listAudit(filter: { tenantId?: string; kind?: string; limit?: number }): Promise<AuditEvent[]>;

  // Trace
  appendTrace(t: TraceRecord): Promise<void>;
  listTraces(filter: { tenantId?: string; limit?: number }): Promise<TraceRecord[]>;

  // 预算用量
  addUsage(u: UsageRecord): Promise<void>;
  getUsage(scope: 'platform' | 'tenant' | 'app', scopeId: string, month: string): Promise<UsageRecord>;

  // 知识库
  upsertKnowledgeDoc(d: KnowledgeDoc): Promise<boolean>;
  deleteKnowledgeDoc(id: string, tenantId: string): Promise<boolean>;
  listKnowledgeDocs(tenantId: string): Promise<KnowledgeDoc[]>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, models TEXT NOT NULL, tools TEXT NOT NULL,
  knowledge_bases TEXT NOT NULL, monthly_budget_usd REAL NOT NULL DEFAULT 0,
  monthly_token_budget REAL NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
  qps_limit INTEGER NOT NULL DEFAULT 10, per_request_token_limit INTEGER NOT NULL DEFAULT 8000,
  monthly_budget_usd REAL NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS virtual_models (
  name TEXT PRIMARY KEY, description TEXT NOT NULL, targets TEXT NOT NULL,
  scenarios TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS provider_credentials (
  provider TEXT PRIMARY KEY, secret_cipher TEXT NOT NULL, source TEXT NOT NULL,
  updated_at TEXT NOT NULL, updated_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_definitions (
  name TEXT PRIMARY KEY, base_url TEXT NOT NULL, protocol TEXT NOT NULL,
  auth_mode TEXT NOT NULL, accounts TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, title TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, app_id TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
  created_at TEXT NOT NULL, tool_calls TEXT, tool_call_id TEXT, trace_id TEXT
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, session_id TEXT NOT NULL,
  trace_id TEXT NOT NULL, tool TEXT NOT NULL, args TEXT NOT NULL, reason TEXT NOT NULL,
  status TEXT NOT NULL, created_at TEXT NOT NULL, decided_at TEXT, decided_by TEXT
);
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY, ts TEXT NOT NULL, kind TEXT NOT NULL, tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL, role TEXT, dept_id TEXT, app_id TEXT, session_id TEXT, trace_id TEXT NOT NULL,
  model TEXT, provider TEXT, tool TEXT, server_id TEXT, prompt_tokens INTEGER,
  completion_tokens INTEGER, cost_usd REAL, status TEXT NOT NULL, reason TEXT, detail TEXT
);
CREATE TABLE IF NOT EXISTS traces (
  trace_id TEXT PRIMARY KEY, session_id TEXT, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL,
  name TEXT NOT NULL, ts TEXT NOT NULL, input TEXT, output TEXT, prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0, model TEXT, metadata TEXT
);
CREATE TABLE IF NOT EXISTS usage (
  scope TEXT NOT NULL, scope_id TEXT NOT NULL, month TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, scope_id, month)
);
CREATE TABLE IF NOT EXISTS knowledge_docs (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, dept_id TEXT NOT NULL, title TEXT NOT NULL,
  content TEXT NOT NULL, sensitivity TEXT NOT NULL, owner_id TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant_ts ON audit_events(tenant_id, ts);
CREATE INDEX IF NOT EXISTS idx_audit_trace ON audit_events(trace_id);
CREATE INDEX IF NOT EXISTS idx_msg_session ON messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(tenant_id, user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_docs_tenant ON knowledge_docs(tenant_id);
${SQLITE_WORKFLOW_SCHEMA}
`;

export class SqliteMetadataStore implements MetadataStore {
  private db: Database.Database;

  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
  }

  async init(): Promise<void> {
    this.db.exec(SCHEMA);
    // 轻量迁移：新增列（老库兼容）。
    // 必须先查列是否存在再 ALTER：SQLite 在列已存在时抛 "duplicate column name"，
    // 直接 catch 会把其他真实错误一起吞掉，两端行为也会分裂。
    this.addColumnIfMissing('messages', 'tool_call_id', 'TEXT');
    // 缺失引用留痕列：A3 复审新增，老库必须补列，否则写入直接报「no such column」。
    this.addColumnIfMissing('workflow_runs', 'missing_refs', 'TEXT');
    this.addColumnIfMissing('workflow_versions', 'last_modified_by', 'TEXT');
    this.addColumnIfMissing('workflow_step_runs', 'missing_refs', 'TEXT');
    this.addColumnIfMissing('workflow_step_runs', 'llm_calls', 'INTEGER NOT NULL DEFAULT 0 CHECK (llm_calls >= 0)');
    this.addColumnIfMissing('workflow_step_runs', 'tool_calls', 'INTEGER NOT NULL DEFAULT 0 CHECK (tool_calls >= 0)');
    // 部门列：可见范围判定需要，老库补列后才能写 dept_id。
    this.addColumnIfMissing('workflows', 'dept_id', 'TEXT');
  }

  /**
   * 列不存在时补上；已存在则跳过。
   *
   * 表名与列名都是内部常量，不来自外部输入。
   */
  private addColumnIfMissing(table: string, column: string, type: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (columns.some((item) => item.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  async close(): Promise<void> {
    this.db.close();
  }

  async upsertTenant(t: Tenant): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO tenants (id,name,models,tools,knowledge_bases,monthly_budget_usd,monthly_token_budget,enabled)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, models=excluded.models, tools=excluded.tools,
           knowledge_bases=excluded.knowledge_bases, monthly_budget_usd=excluded.monthly_budget_usd,
           monthly_token_budget=excluded.monthly_token_budget, enabled=excluded.enabled`,
      )
      .run(t.id, t.name, JSON.stringify(t.models), JSON.stringify(t.tools), JSON.stringify(t.knowledgeBases), t.monthlyBudgetUsd, t.monthlyTokenBudget, t.enabled ? 1 : 0);
  }

  async getTenant(id: string): Promise<Tenant | undefined> {
    const row = this.db.prepare('SELECT * FROM tenants WHERE id=?').get(id) as any;
    if (!row) return undefined;
    return {
      id: row.id,
      name: row.name,
      models: JSON.parse(row.models),
      tools: JSON.parse(row.tools),
      knowledgeBases: JSON.parse(row.knowledge_bases),
      monthlyBudgetUsd: row.monthly_budget_usd,
      monthlyTokenBudget: row.monthly_token_budget,
      enabled: !!row.enabled,
    };
  }

  async listTenants(): Promise<Tenant[]> {
    const rows = this.db.prepare('SELECT id FROM tenants ORDER BY id').all() as any[];
    const out: Tenant[] = [];
    for (const r of rows) {
      const t = await this.getTenant(r.id);
      if (t) out.push(t);
    }
    return out;
  }

  async upsertApplication(a: Application): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO applications (id,tenant_id,name,qps_limit,per_request_token_limit,monthly_budget_usd,enabled)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET tenant_id=excluded.tenant_id, name=excluded.name,
           qps_limit=excluded.qps_limit, per_request_token_limit=excluded.per_request_token_limit,
           monthly_budget_usd=excluded.monthly_budget_usd, enabled=excluded.enabled`,
      )
      .run(a.id, a.tenantId, a.name, a.qpsLimit, a.perRequestTokenLimit, a.monthlyBudgetUsd, a.enabled ? 1 : 0);
  }

  async listApplications(tenantId?: string): Promise<Application[]> {
    const rows = tenantId
      ? this.db.prepare('SELECT * FROM applications WHERE tenant_id=?').all(tenantId)
      : this.db.prepare('SELECT * FROM applications').all();
    return (rows as any[]).map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      name: r.name,
      qpsLimit: r.qps_limit,
      perRequestTokenLimit: r.per_request_token_limit,
      monthlyBudgetUsd: r.monthly_budget_usd,
      enabled: !!r.enabled,
    }));
  }

  async upsertVirtualModel(m: VirtualModel): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO virtual_models (name,description,targets,scenarios,enabled) VALUES (?,?,?,?,?)
         ON CONFLICT(name) DO UPDATE SET description=excluded.description, targets=excluded.targets,
           scenarios=excluded.scenarios, enabled=excluded.enabled`,
      )
      .run(m.name, m.description, JSON.stringify(m.targets), JSON.stringify(m.scenarios), m.enabled ? 1 : 0);
  }

  async getVirtualModel(name: string): Promise<VirtualModel | undefined> {
    const row = this.db.prepare('SELECT * FROM virtual_models WHERE name=?').get(name) as any;
    if (!row) return undefined;
    return {
      name: row.name,
      description: row.description,
      targets: JSON.parse(row.targets),
      scenarios: JSON.parse(row.scenarios),
      enabled: !!row.enabled,
    };
  }

  async listVirtualModels(): Promise<VirtualModel[]> {
    const rows = this.db.prepare('SELECT name FROM virtual_models ORDER BY name').all() as any[];
    const out: VirtualModel[] = [];
    for (const r of rows) {
      const m = await this.getVirtualModel(r.name);
      if (m) out.push(m);
    }
    return out;
  }

  async deleteVirtualModel(name: string): Promise<boolean> {
    return this.db.prepare('DELETE FROM virtual_models WHERE name=?').run(name).changes > 0;
  }

  async upsertProviderDefinition(p: ProviderDefinition): Promise<void> {
    this.db.prepare(
      `INSERT INTO provider_definitions (name,base_url,protocol,auth_mode,accounts,enabled,created_at,updated_at,updated_by)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(name) DO UPDATE SET base_url=excluded.base_url, protocol=excluded.protocol,
         auth_mode=excluded.auth_mode, accounts=excluded.accounts, enabled=excluded.enabled,
         updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
    ).run(p.name, p.baseUrl, p.protocol, p.authMode, JSON.stringify(p.accounts), p.enabled ? 1 : 0, p.createdAt, p.updatedAt, p.updatedBy);
  }

  async getProviderDefinition(name: string): Promise<ProviderDefinition | undefined> {
    const row = this.db.prepare('SELECT * FROM provider_definitions WHERE name=?').get(name) as any;
    if (!row) return undefined;
    return {
      name: row.name, baseUrl: row.base_url, protocol: row.protocol, authMode: row.auth_mode,
      accounts: JSON.parse(row.accounts), enabled: !!row.enabled,
      createdAt: row.created_at, updatedAt: row.updated_at, updatedBy: row.updated_by,
    };
  }

  async listProviderDefinitions(): Promise<ProviderDefinition[]> {
    const rows = this.db.prepare('SELECT name FROM provider_definitions ORDER BY name').all() as { name: string }[];
    const result: ProviderDefinition[] = [];
    for (const row of rows) {
      const provider = await this.getProviderDefinition(row.name);
      if (provider) result.push(provider);
    }
    return result;
  }

  async deleteProviderDefinition(name: string): Promise<boolean> {
    return this.db.prepare('DELETE FROM provider_definitions WHERE name=?').run(name).changes > 0;
  }

  async upsertProviderCredential(c: ProviderCredential): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO provider_credentials (provider,secret_cipher,source,updated_at,updated_by)
         VALUES (?,?,?,?,?)
         ON CONFLICT(provider) DO UPDATE SET secret_cipher=excluded.secret_cipher,
           source=excluded.source, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
      )
      .run(c.provider, c.secretCipher, c.source, c.updatedAt, c.updatedBy);
  }

  async getProviderCredential(provider: string): Promise<ProviderCredential | undefined> {
    const row = this.db
      .prepare('SELECT * FROM provider_credentials WHERE provider=?')
      .get(provider) as any;
    if (!row) return undefined;
    return {
      provider: row.provider,
      secretCipher: row.secret_cipher,
      source: row.source,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    };
  }

  async listProviderCredentials(): Promise<ProviderCredential[]> {
    const rows = this.db
      .prepare('SELECT provider FROM provider_credentials ORDER BY provider')
      .all() as any[];
    const out: ProviderCredential[] = [];
    for (const r of rows) {
      const c = await this.getProviderCredential(r.provider);
      if (c) out.push(c);
    }
    return out;
  }

  async deleteProviderCredential(provider: string): Promise<boolean> {
    const info = this.db.prepare('DELETE FROM provider_credentials WHERE provider=?').run(provider);
    return info.changes > 0;
  }

  async createSession(s: SessionRecord): Promise<void> {
    this.db
      .prepare('INSERT INTO sessions (id,tenant_id,user_id,title,created_at,updated_at,app_id) VALUES (?,?,?,?,?,?,?)')
      .run(s.id, s.tenantId, s.userId, s.title, s.createdAt, s.updatedAt, s.appId ?? null);
  }

  async updateSession(id: string, patch: Partial<SessionRecord>): Promise<void> {
    const current = await this.getSession(id);
    if (!current) return;
    const merged = { ...current, ...patch };
    this.db
      .prepare('UPDATE sessions SET title=?, updated_at=?, app_id=? WHERE id=?')
      .run(merged.title, merged.updatedAt, merged.appId ?? null, id);
  }

  async getSession(id: string): Promise<SessionRecord | undefined> {
    const r = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id) as any;
    if (!r) return undefined;
    return {
      id: r.id,
      tenantId: r.tenant_id,
      userId: r.user_id,
      title: r.title,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      appId: r.app_id ?? undefined,
    };
  }

  async listSessions(tenantId: string, userId?: string): Promise<SessionRecord[]> {
    const rows = userId
      ? this.db.prepare('SELECT * FROM sessions WHERE tenant_id=? AND user_id=? ORDER BY updated_at DESC').all(tenantId, userId)
      : this.db.prepare('SELECT * FROM sessions WHERE tenant_id=? ORDER BY updated_at DESC').all(tenantId);
    return (rows as any[]).map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      userId: r.user_id,
      title: r.title,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      appId: r.app_id ?? undefined,
    }));
  }

  async deleteSession(id: string): Promise<boolean> {
    return this.db.transaction(() => {
      this.db.prepare('DELETE FROM messages WHERE session_id=?').run(id);
      return this.db.prepare('DELETE FROM sessions WHERE id=?').run(id).changes > 0;
    })();
  }

  async appendMessage(m: MessageRecord): Promise<void> {
    this.db
      .prepare('INSERT INTO messages (id,session_id,role,content,created_at,tool_calls,tool_call_id,trace_id) VALUES (?,?,?,?,?,?,?,?)')
      .run(m.id, m.sessionId, m.role, m.content, m.createdAt, m.toolCalls ? JSON.stringify(m.toolCalls) : null, m.toolCallId ?? null, m.traceId ?? null);
  }

  async listMessages(sessionId: string): Promise<MessageRecord[]> {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE session_id=? ORDER BY created_at ASC, rowid ASC')
      .all(sessionId) as any[];
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      role: r.role,
      content: r.content,
      createdAt: r.created_at,
      toolCalls: r.tool_calls ? JSON.parse(r.tool_calls) : undefined,
      toolCallId: r.tool_call_id ?? undefined,
      traceId: r.trace_id ?? undefined,
    }));
  }

  async createApproval(a: ApprovalRequest): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO approvals (id,tenant_id,user_id,session_id,trace_id,tool,args,reason,status,created_at,decided_at,decided_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(a.id, a.tenantId, a.userId, a.sessionId, a.traceId, a.tool, JSON.stringify(a.args), a.reason, a.status, a.createdAt, a.decidedAt ?? null, a.decidedBy ?? null);
  }

  async updateApproval(id: string, patch: Partial<ApprovalRequest>): Promise<void> {
    const cur = await this.getApproval(id);
    if (!cur) return;
    const m = { ...cur, ...patch };
    this.db
      .prepare('UPDATE approvals SET status=?, decided_at=?, decided_by=? WHERE id=?')
      .run(m.status, m.decidedAt ?? null, m.decidedBy ?? null, id);
  }

  async transitionApproval(
    id: string,
    tenantId: string,
    fromStatus: ApprovalRequest['status'],
    patch: Partial<ApprovalRequest>,
  ): Promise<boolean> {
    const cur = await this.getApproval(id);
    if (!cur || cur.tenantId !== tenantId || cur.status !== fromStatus) return false;
    const m = { ...cur, ...patch };
    const result = this.db
      .prepare('UPDATE approvals SET status=?, decided_at=?, decided_by=? WHERE id=? AND tenant_id=? AND status=?')
      .run(m.status, m.decidedAt ?? null, m.decidedBy ?? null, id, tenantId, fromStatus);
    return result.changes === 1;
  }

  async getApproval(id: string): Promise<ApprovalRequest | undefined> {
    const r = this.db.prepare('SELECT * FROM approvals WHERE id=?').get(id) as any;
    if (!r) return undefined;
    return {
      id: r.id,
      tenantId: r.tenant_id,
      userId: r.user_id,
      sessionId: r.session_id,
      traceId: r.trace_id,
      tool: r.tool,
      args: JSON.parse(r.args),
      reason: r.reason,
      status: r.status,
      createdAt: r.created_at,
      decidedAt: r.decided_at ?? undefined,
      decidedBy: r.decided_by ?? undefined,
    };
  }

  async listApprovals(filter: { tenantId?: string; status?: string; userId?: string }): Promise<ApprovalRequest[]> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.tenantId) { where.push('tenant_id=?'); args.push(filter.tenantId); }
    if (filter.status) { where.push('status=?'); args.push(filter.status); }
    if (filter.userId) { where.push('user_id=?'); args.push(filter.userId); }
    const sql = `SELECT id FROM approvals ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT 200`;
    const rows = this.db.prepare(sql).all(...args) as any[];
    const out: ApprovalRequest[] = [];
    for (const r of rows) {
      const a = await this.getApproval(r.id);
      if (a) out.push(a);
    }
    return out;
  }

  async appendAudit(e: AuditEvent): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO audit_events (id,ts,kind,tenant_id,user_id,role,dept_id,app_id,session_id,trace_id,
          model,provider,tool,server_id,prompt_tokens,completion_tokens,cost_usd,status,reason,detail)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        e.id, e.ts, e.kind, e.tenantId, e.userId, e.role ?? null, e.deptId ?? null, e.appId ?? null,
        e.sessionId ?? null, e.traceId, e.model ?? null, e.provider ?? null, e.tool ?? null,
        e.serverId ?? null, e.promptTokens ?? null, e.completionTokens ?? null, e.costUsd ?? null,
        e.status, e.reason ?? null, e.detail ? JSON.stringify(e.detail) : null,
      );
  }

  async listAudit(filter: { tenantId?: string; kind?: string; limit?: number }): Promise<AuditEvent[]> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.tenantId) { where.push('tenant_id=?'); args.push(filter.tenantId); }
    if (filter.kind) { where.push('kind=?'); args.push(filter.kind); }
    const limit = Math.min(filter.limit ?? 100, 1000);
    const sql = `SELECT * FROM audit_events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC LIMIT ${limit}`;
    const rows = this.db.prepare(sql).all(...args) as any[];
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      kind: r.kind,
      tenantId: r.tenant_id,
      userId: r.user_id,
      role: r.role ?? undefined,
      deptId: r.dept_id ?? undefined,
      appId: r.app_id ?? undefined,
      sessionId: r.session_id ?? undefined,
      traceId: r.trace_id,
      model: r.model ?? undefined,
      provider: r.provider ?? undefined,
      tool: r.tool ?? undefined,
      serverId: r.server_id ?? undefined,
      promptTokens: r.prompt_tokens ?? undefined,
      completionTokens: r.completion_tokens ?? undefined,
      costUsd: r.cost_usd ?? undefined,
      status: r.status,
      reason: r.reason ?? undefined,
      detail: r.detail ? JSON.parse(r.detail) : undefined,
    }));
  }

  async appendTrace(t: TraceRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO traces (trace_id,session_id,tenant_id,user_id,name,ts,input,output,prompt_tokens,completion_tokens,cost_usd,model,metadata)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(trace_id) DO UPDATE SET output=excluded.output, prompt_tokens=excluded.prompt_tokens,
           completion_tokens=excluded.completion_tokens, cost_usd=excluded.cost_usd`,
      )
      .run(t.traceId, t.sessionId ?? null, t.tenantId, t.userId, t.name, t.ts, t.input ? JSON.stringify(t.input) : null, t.output ? JSON.stringify(t.output) : null, t.promptTokens, t.completionTokens, t.costUsd, t.model ?? null, JSON.stringify(t.metadata ?? {}));
  }

  async listTraces(filter: { tenantId?: string; limit?: number }): Promise<TraceRecord[]> {
    const limit = Math.min(filter.limit ?? 100, 1000);
    const rows = filter.tenantId
      ? (this.db.prepare('SELECT * FROM traces WHERE tenant_id=? ORDER BY ts DESC LIMIT ?').all(filter.tenantId, limit) as any[])
      : (this.db.prepare('SELECT * FROM traces ORDER BY ts DESC LIMIT ?').all(limit) as any[]);
    return rows.map((r) => ({
      traceId: r.trace_id,
      sessionId: r.session_id ?? undefined,
      tenantId: r.tenant_id,
      userId: r.user_id,
      name: r.name,
      ts: r.ts,
      input: r.input ? JSON.parse(r.input) : undefined,
      output: r.output ? JSON.parse(r.output) : undefined,
      promptTokens: r.prompt_tokens,
      completionTokens: r.completion_tokens,
      costUsd: r.cost_usd,
      model: r.model ?? undefined,
      metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
    }));
  }

  async addUsage(u: UsageRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO usage (scope,scope_id,month,prompt_tokens,completion_tokens,cost_usd,requests)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(scope,scope_id,month) DO UPDATE SET
           prompt_tokens = prompt_tokens + excluded.prompt_tokens,
           completion_tokens = completion_tokens + excluded.completion_tokens,
           cost_usd = cost_usd + excluded.cost_usd,
           requests = requests + excluded.requests`,
      )
      .run(u.scope, u.scopeId, u.month, u.promptTokens, u.completionTokens, u.costUsd, u.requests);
  }

  async getUsage(scope: 'platform' | 'tenant' | 'app', scopeId: string, month: string): Promise<UsageRecord> {
    const r = this.db
      .prepare('SELECT * FROM usage WHERE scope=? AND scope_id=? AND month=?')
      .get(scope, scopeId, month) as any;
    if (!r) return { scope, scopeId, month, promptTokens: 0, completionTokens: 0, costUsd: 0, requests: 0 };
    return {
      scope: r.scope,
      scopeId: r.scope_id,
      month: r.month,
      promptTokens: r.prompt_tokens,
      completionTokens: r.completion_tokens,
      costUsd: r.cost_usd,
      requests: r.requests,
    };
  }

  async upsertWorkflow(record: WorkflowRecord, actor?: WorkflowActor): Promise<boolean> {
    // 可见性取值域先在应用层校验：CHECK 只作最后兜底，两端错误类型与文案必须一致。
    assertWorkflowVisibility(record.visibility);
    // 所有者**从调用者身份取**，不认客户端传入的 ownerId（见 9.1）。
    const ownerId = resolveWorkflowOwnerId(record, actor);
    // 部门归属：省略即保留库中原值（更新路径），新建时才要求明确归属。
    // 先分清新建还是更新：省略 deptId 且为部门可见 → 新建时拒绝（多部门必须显式选择），
    // 更新时保留原值 —— 否则一次「只改名字」的更新会把部门归属清空，
    // visibility=department 的工作流随即对所有者与整个部门同时消失。
    const existing = await this.getWorkflow(record.tenantId, record.id, undefined, { includeDeleted: true });
    const department = resolveWorkflowDepartment(record, actor, { updating: Boolean(existing) });
    if (!department.allowed) return false;
    const args: unknown[] = [
      record.id, record.tenantId, ownerId, department.deptId ?? null, record.name, record.description ?? null,
      record.visibility, record.currentDraftVersion ?? null, record.latestPublishedVersion ?? null,
      normalizeTimestamp(record.createdAt), normalizeTimestamp(record.updatedAt),
      record.deletedAt === undefined ? null : normalizeTimestamp(record.deletedAt),
      // 显式提供了部门归属才覆盖，否则保留库中原值。
      department.provided ? 1 : 0,
    ];
    const where = ['workflows.tenant_id=excluded.tenant_id', 'workflows.deleted_at IS NULL'];
    // 所有权判定必须在 SQL 层生效：非管理员只能改写自己拥有的工作流。
    // owner_id 本身不参与更新 —— 创建后不可变，否则所有权可以被悄悄夺走。
    if (actor && !actor.isAdmin) {
      where.push('workflows.owner_id=?');
      args.push(actor.userId);
    }
    const result = this.db.prepare(
      `INSERT INTO workflows (id,tenant_id,owner_id,dept_id,name,description,visibility,current_draft_version,
         latest_published_version,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         dept_id=CASE WHEN ? THEN excluded.dept_id ELSE workflows.dept_id END,
         name=excluded.name,
         description=excluded.description, visibility=excluded.visibility,
         current_draft_version=CASE
           WHEN excluded.current_draft_version IS NULL THEN workflows.current_draft_version
           WHEN COALESCE(workflows.current_draft_version,0) >= excluded.current_draft_version
             THEN workflows.current_draft_version
           ELSE excluded.current_draft_version END,
         latest_published_version=CASE
           WHEN excluded.latest_published_version IS NULL THEN workflows.latest_published_version
           WHEN COALESCE(workflows.latest_published_version,0) >= excluded.latest_published_version
             THEN workflows.latest_published_version
           ELSE excluded.latest_published_version END,
         updated_at=excluded.updated_at,
         deleted_at=excluded.deleted_at
       WHERE ${where.join(' AND ')}`,
    ).run(...args);
    return result.changes === 1;
  }

  async getWorkflow(
    tenantId: string,
    id: string,
    actor?: WorkflowActor,
    options?: { includeDeleted?: boolean },
  ): Promise<WorkflowRecord | undefined> {
    const where = ['id=?', 'tenant_id=?'];
    const args: unknown[] = [id, tenantId];
    // 单条读与列表读口径一致：软删除的工作流默认读不到（列表默认也过滤 deleted_at）。
    // includeDeleted 用于内部判断「这一行是否存在」，以及 API 层展示已删除记录。
    if (!options?.includeDeleted) where.push('deleted_at IS NULL');
    // 可见范围谓词由共享实现生成，保证两端同构；省略 actor = 平台内部可信访问。
    where.push(...buildWorkflowVisibilityWhere({ actor }, (value) => {
      args.push(value);
      return '?';
    }));
    const row = this.db.prepare(`SELECT * FROM workflows WHERE ${where.join(' AND ')}`).get(...args);
    return row ? mapWorkflowRow(row) : undefined;
  }

  async listWorkflows(filter: {
    tenantId: string;
    actor?: WorkflowActor;
    ownerId?: string;
    includeDeleted?: boolean;
    visibility?: WorkflowVisibility[];
    limit?: number;
    cursor?: string;
  }): Promise<WorkflowRecord[]> {
    const where = ['tenant_id=?'];
    const args: unknown[] = [filter.tenantId];
    // ownerId 退化为纯 owner 过滤：不再承担授权语义（可见范围只看 actor）。
    if (filter.ownerId) { where.push('owner_id=?'); args.push(filter.ownerId); }
    if (!filter.includeDeleted) where.push('deleted_at IS NULL');
    // 可见范围谓词由共享实现生成，保证两端同构。
    where.push(...buildWorkflowVisibilityWhere(filter, (value) => {
      args.push(value);
      return '?';
    }));
    const cursor = parseWorkflowCursor(filter.cursor);
    if (cursor) {
      where.push('(updated_at, id) < (?, ?)');
      args.push(cursor.sortKey, cursor.id);
    }
    args.push(resolveWorkflowListLimit(filter.limit));
    const rows = this.db.prepare(
      `SELECT * FROM workflows WHERE ${where.join(' AND ')} ORDER BY updated_at DESC, id DESC LIMIT ?`,
    ).all(...args);
    return rows.map(mapWorkflowRow);
  }

  async deleteWorkflow(tenantId: string, id: string, deletedAt: string, actor?: WorkflowActor): Promise<boolean> {
    const stamp = normalizeTimestamp(deletedAt);
    const where = ['id=?', 'tenant_id=?', 'deleted_at IS NULL'];
    const args: unknown[] = [id, tenantId];
    // 删除也是「编辑」：只有所有者或管理员可以删（见 3.2）。
    // 省略 actor = 平台内部可信操作。
    if (actor && !actor.isAdmin) {
      where.push('owner_id=?');
      args.push(actor.userId);
    }
    const result = this.db.prepare(
      `UPDATE workflows SET deleted_at=?, updated_at=? WHERE ${where.join(' AND ')}`,
    ).run(stamp, stamp, ...args);
    return result.changes === 1;
  }

  async upsertWorkflowVersion(record: WorkflowVersionRecord, actor?: WorkflowActor): Promise<boolean> {
    const workflow = await this.getWorkflow(record.tenantId, record.workflowId);
    if (!workflow || workflow.deletedAt) return false;
    // 所有权判定：只有该工作流的所有者或管理员能改草稿（见 3.2）。
    if (!canManageWorkflow(workflow, actor)) return false;
    assertWorkflowVersionStatus(record.status);
    assertWorkflowVersionNumber(record.version);
    // 普通 upsert 只能写草稿态：in_review / published 既不能被改写，也不能被直接写入，
    // 否则可以绕过审核通道把未审核的定义直接置为已发布（见 9.2）。
    if (record.status !== 'draft' && record.status !== 'rejected') return false;
    // 版本号必须单调递增（见 10.1）：新版本号要大于该工作流已有的最大版本号。
    // 客户端指定版本号不能用来插空或回退，否则版本顺序与「当前草稿」指针都会失真。
    if (!this.isWorkflowVersionMonotonic(record.tenantId, record.workflowId, record.version)) return false;
    // 普通 upsert **不写审核 / 发布留痕字段**：那些字段只由审核通道写，
    // 否则可以伪造「已审核」证据，或把真实的驳回意见抹掉（见 9.2）。
    // created_by 是**最初作者**，创建后不变；last_modified_by 记**最后改动内容的人** ——
    // 「禁止自审」要同时看这两列，只看 created_by 会被管理员覆盖内容后自审自发绕过。
    const result = this.db.prepare(
      `INSERT INTO workflow_versions (workflow_id,version,tenant_id,definition_json,checksum,status,
         created_by,created_at,last_modified_by)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(workflow_id,version) DO UPDATE SET definition_json=excluded.definition_json,
         checksum=excluded.checksum, status=excluded.status,
         last_modified_by=COALESCE(excluded.last_modified_by, workflow_versions.last_modified_by)
       WHERE workflow_versions.tenant_id=excluded.tenant_id
         AND workflow_versions.status IN ('draft','rejected')
         AND excluded.status IN ('draft','rejected')`,
    ).run(
      record.workflowId, record.version, record.tenantId, requireJsonField(record.definition, '工作流定义'), record.checksum,
      record.status, actor?.userId ?? record.createdBy, normalizeTimestamp(record.createdAt),
      // 没有已认证身份时留空：平台内部写入不冒充具体的人，判定时按 created_by 兜底。
      actor?.userId ?? null,
    );
    if (result.changes !== 1) return false;
    // 「当前草稿版本」指针由存储层维护（取大语义，调用方也可以显式推高）。
    this.bumpWorkflowVersionPointer(record.tenantId, record.workflowId, 'current_draft_version', record.version);
    return true;
  }

  /**
   * 版本号是否满足单调递增。
   *
   * 已存在的版本号视为「更新这一版」，允许；新版本号必须大于该工作流已有的最大版本号。
   */
  private isWorkflowVersionMonotonic(tenantId: string, workflowId: string, version: number): boolean {
    const existing = this.db.prepare(
      `SELECT 1 FROM workflow_versions WHERE workflow_id=? AND tenant_id=? AND version=?`,
    ).get(workflowId, tenantId, version);
    if (existing) return true;
    const maxRow = this.db.prepare(
      `SELECT MAX(version) AS max_version FROM workflow_versions WHERE workflow_id=? AND tenant_id=?`,
    ).get(workflowId, tenantId) as { max_version?: number | null } | undefined;
    return version > Number(maxRow?.max_version ?? 0);
  }

  /**
   * 把工作流的版本指针推到不小于给定版本号。
   *
   * 指针只增不减：调用方也可能通过 upsertWorkflow 传版本号，两边都按「取大」收敛，
   * 谁都不会把指针写回去。不动 updated_at —— 指针变化不应该让工作流在列表里
   * 重新排序、扰动 keyset 游标。
   */
  private bumpWorkflowVersionPointer(
    tenantId: string,
    workflowId: string,
    // 取值只来自下面两个字面量，不接受外部输入。
    column: 'current_draft_version' | 'latest_published_version',
    version: number,
  ): void {
    this.db.prepare(
      `UPDATE workflows SET ${column}=CASE
         WHEN COALESCE(${column},0) >= ? THEN ${column}
         ELSE ? END
       WHERE id=? AND tenant_id=? AND deleted_at IS NULL`,
    ).run(version, version, workflowId, tenantId);
  }

  async submitWorkflowVersionForReview(
    tenantId: string,
    workflowId: string,
    version: number,
    actor?: WorkflowActor,
  ): Promise<boolean> {
    // 草稿 → 审核中：只改状态，审核与发布字段留空，审核留痕由审核通道完成。
    // 提交审核是「提交自己的草稿」：只有所有者或管理员能做（见 3.2）。
    // 软删除是终态：已删除的工作流不再进入审核流（getWorkflow 默认过滤软删除）。
    const workflow = await this.getWorkflow(tenantId, workflowId);
    if (!workflow || workflow.deletedAt || !canManageWorkflow(workflow, actor)) return false;
    // 管理员自己维护的草稿走直接发布，不能进入审核流后自审。
    if (actor?.isAdmin && workflow.ownerId === actor.userId) return false;
    const result = this.db.prepare(
      `UPDATE workflow_versions SET status='in_review'
       WHERE workflow_id=? AND version=? AND tenant_id=? AND status='draft'`,
    ).run(workflowId, version, tenantId);
    return result.changes === 1;
  }

  async rejectWorkflowVersion(
    tenantId: string,
    workflowId: string,
    version: number,
    review: { reviewer: string; comment: string; at: string },
    actor?: WorkflowActor,
  ): Promise<boolean> {
    // 审核与发布是管理员专属动作（见 10.1）。
    if (!canReviewWorkflow(actor)) return false;
    const reviewer = actor?.userId ?? review.reviewer;
    const where = [
      'workflow_id=?', 'version=?', 'tenant_id=?', "status='in_review'",
      // 软删除是终态：已删除的工作流不再接受审核。
      buildWorkflowNotDeletedCondition(),
    ];
    const args: unknown[] = [reviewer, normalizeTimestamp(review.at), review.comment, workflowId, version, tenantId];
    if (actor) {
      // 禁止自审：审核人不能是作者，也不能是最后改动内容的人。
      where.push(buildWorkflowSelfReviewCondition((value) => {
        args.push(value);
        return '?';
      }, actor.userId));
    }
    const result = this.db.prepare(
      `UPDATE workflow_versions SET status='rejected', reviewed_by=?, reviewed_at=?, review_comment=?
       WHERE ${where.join(' AND ')}`,
    ).run(...args);
    return result.changes === 1;
  }

  async publishWorkflowVersion(
    tenantId: string,
    workflowId: string,
    version: number,
    publish: { reviewer: string; at: string },
    actor?: WorkflowActor,
  ): Promise<boolean> {
    // 发布是管理员专属动作（见 10.1）。
    if (!canReviewWorkflow(actor)) return false;
    const reviewer = actor?.userId ?? publish.reviewer;
    const at = normalizeTimestamp(publish.at);
    const where = [
      'workflow_id=?', 'version=?', 'tenant_id=?',
      // 软删除是终态：已删除的工作流不再接受发布。
      buildWorkflowNotDeletedCondition(),
    ];
    const args: unknown[] = [reviewer, at, reviewer, at, workflowId, version, tenantId];
    if (actor) {
      // 审核流禁止作者自审；直接发布仅限管理员自己所有的工作流。
      where.push(buildWorkflowPublishBranchCondition((value) => {
        args.push(value);
        return '?';
      }, actor.userId));
    } else {
      // 平台内部发布（省略 actor）：允许审核流与草稿直发两种来源。
      where.push("status IN ('in_review','draft')");
    }
    const result = this.db.prepare(
      // 直发（draft）**不写审核留痕**：reviewed_by 是审核信息，直发没有审核人可写。
      // 写成发布人等于伪造「已审核」证据，事后无法区分「经审核发布」与「直接发布」。
      `UPDATE workflow_versions SET status='published',
         reviewed_by=CASE WHEN status='in_review' THEN ? ELSE NULL END,
         reviewed_at=CASE WHEN status='in_review' THEN ? ELSE NULL END,
         published_by=?, published_at=?
       WHERE ${where.join(' AND ')}`,
    ).run(...args);
    if (result.changes !== 1) return false;
    this.bumpWorkflowVersionPointer(tenantId, workflowId, 'latest_published_version', version);
    return true;
  }

  async getWorkflowVersion(
    tenantId: string,
    workflowId: string,
    version: number,
    actor?: WorkflowActor,
  ): Promise<WorkflowVersionRecord | undefined> {
    // 版本的可见性跟随所属工作流：工作流不可见时版本也不可见。
    const where = ['workflow_id=?', 'version=?', 'tenant_id=?'];
    const args: unknown[] = [workflowId, version, tenantId];
    where.push(...buildWorkflowVersionVisibilityWhere({ actor }, (value) => {
      args.push(value);
      return '?';
    }));
    const row = this.db.prepare(
      `SELECT v.* FROM workflow_versions v WHERE ${where.join(' AND ')}`,
    ).get(...args);
    return row ? mapWorkflowVersionRow(row) : undefined;
  }

  async listWorkflowVersions(
    tenantId: string,
    workflowId: string,
    options?: { actor?: WorkflowActor; limit?: number; cursor?: string },
  ): Promise<WorkflowVersionRecord[]> {
    const where = ['workflow_id=?', 'tenant_id=?'];
    const args: unknown[] = [workflowId, tenantId];
    where.push(...buildWorkflowVersionVisibilityWhere({ actor: options?.actor }, (value) => {
      args.push(value);
      return '?';
    }));
    const cursor = parseWorkflowVersionCursor(options?.cursor);
    if (cursor !== undefined) {
      where.push('version > ?');
      args.push(cursor);
    }
    args.push(resolveWorkflowListLimit(options?.limit));
    const rows = this.db.prepare(
      `SELECT v.* FROM workflow_versions v WHERE ${where.join(' AND ')} ORDER BY v.version LIMIT ?`,
    ).all(...args);
    return rows.map(mapWorkflowVersionRow);
  }

  async insertWorkflowRun(record: WorkflowRunRecord): Promise<boolean> {
    const workflow = await this.getWorkflow(record.tenantId, record.workflowId);
    if (!workflow || workflow.deletedAt) return false;
    // 模式与快照的组合先在应用层校验：CHECK 只作最后兜底（见 9.3）。
    assertWorkflowRunSnapshot(record.mode, record.definitionSnapshot !== undefined);
    assertWorkflowRunStatus(record.status);
    assertWorkflowLockVersion(record.lockVersion);
    const result = this.db.prepare(
      `INSERT INTO workflow_runs (id,tenant_id,workflow_id,workflow_version,initiator_id,identity_snapshot,
         input_json,mode,status,definition_snapshot,definition_checksum,trace_id,idempotency_key,lock_version,
         error_code,error_message,created_at,started_at,ended_at,updated_at,expires_at,missing_refs)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
    ).run(
      record.id, record.tenantId, record.workflowId, record.workflowVersion, record.initiatorId,
      requireJsonField(record.identitySnapshot, '身份快照'), requireJsonField(record.input, '运行输入'), record.mode, record.status,
      record.definitionSnapshot === undefined ? null : requireJsonField(record.definitionSnapshot, '定义快照'),
      record.definitionChecksum, record.traceId, record.idempotencyKey ?? null, record.lockVersion,
      record.errorCode ?? null, record.errorMessage ?? null, normalizeTimestamp(record.createdAt),
      record.startedAt === undefined ? null : normalizeTimestamp(record.startedAt),
      record.endedAt === undefined ? null : normalizeTimestamp(record.endedAt),
      normalizeTimestamp(record.updatedAt),
      record.expiresAt === undefined ? null : normalizeTimestamp(record.expiresAt),
      record.missingRefs === undefined ? null : requireJsonField(record.missingRefs, '运行缺失引用'),
    );
    return result.changes === 1;
  }

  async getWorkflowRun(tenantId: string, id: string, actor?: WorkflowActor): Promise<WorkflowRunRecord | undefined> {
    const where = ['r.id=?', 'r.tenant_id=?'];
    const args: unknown[] = [id, tenantId];
    // 运行可见范围判定在 SQL 层完成（R6）：发起人本人 / 工作流所有者 / 租户管理员。
    where.push(...buildWorkflowRunVisibilityWhere({ actor }, (value) => {
      args.push(value);
      return '?';
    }));
    const row = this.db.prepare(`SELECT r.* FROM workflow_runs r WHERE ${where.join(' AND ')}`).get(...args);
    return row ? mapWorkflowRunRow(row) : undefined;
  }

  async getWorkflowRunByIdempotencyKey(
    tenantId: string,
    workflowId: string,
    initiatorId: string,
    key: string,
  ): Promise<WorkflowRunRecord | undefined> {
    const row = this.db.prepare(
      `SELECT * FROM workflow_runs WHERE tenant_id=? AND workflow_id=? AND initiator_id=? AND idempotency_key=?`,
    ).get(tenantId, workflowId, initiatorId, key);
    return row ? mapWorkflowRunRow(row) : undefined;
  }

  async listWorkflowRuns(filter: {
    tenantId: string;
    actor?: WorkflowActor;
    workflowId?: string;
    initiatorId?: string;
    status?: WorkflowRunStatus;
    limit?: number;
    cursor?: string;
  }): Promise<WorkflowRunRecord[]> {
    const where = ['r.tenant_id=?'];
    const args: unknown[] = [filter.tenantId];
    if (filter.workflowId) { where.push('r.workflow_id=?'); args.push(filter.workflowId); }
    if (filter.initiatorId) { where.push('r.initiator_id=?'); args.push(filter.initiatorId); }
    if (filter.status) { where.push('r.status=?'); args.push(filter.status); }
    // 运行可见范围判定在 SQL 层完成（R6）。
    where.push(...buildWorkflowRunVisibilityWhere({ actor: filter.actor }, (value) => {
      args.push(value);
      return '?';
    }));
    const cursor = parseWorkflowCursor(filter.cursor);
    if (cursor) {
      where.push('(r.created_at, r.id) < (?, ?)');
      args.push(cursor.sortKey, cursor.id);
    }
    args.push(resolveWorkflowListLimit(filter.limit));
    const rows = this.db.prepare(
      `SELECT r.* FROM workflow_runs r WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC, r.id DESC LIMIT ?`,
    ).all(...args);
    return rows.map(mapWorkflowRunRow);
  }

  async transitionWorkflowRun(
    tenantId: string,
    id: string,
    fromStatus: WorkflowRunStatus,
    expectedLockVersion: number,
    patch: WorkflowRunTransitionPatch,
  ): Promise<WorkflowRunRecord | undefined> {
    assertWorkflowRunStatus(fromStatus);
    assertWorkflowRunStatus(patch.status);
    assertWorkflowLockVersion(expectedLockVersion);
    const current = await this.getWorkflowRun(tenantId, id);
    if (!current || current.status !== fromStatus || current.lockVersion !== expectedLockVersion) return undefined;
    const errorCode = patch.errorCode === undefined ? current.errorCode : patch.errorCode ?? undefined;
    const errorMessage = patch.errorMessage === undefined ? current.errorMessage : patch.errorMessage ?? undefined;
    const startedAt = patch.startedAt === undefined
      ? current.startedAt
      : patch.startedAt === null ? undefined : normalizeTimestamp(patch.startedAt);
    const endedAt = patch.endedAt === undefined
      ? current.endedAt
      : patch.endedAt === null ? undefined : normalizeTimestamp(patch.endedAt);
    const expiresAt = patch.expiresAt === undefined
      ? current.expiresAt
      : patch.expiresAt === null ? undefined : normalizeTimestamp(patch.expiresAt);
    const missingRefs = patch.missingRefs === undefined ? current.missingRefs : patch.missingRefs ?? undefined;
    const result = this.db.prepare(
      `UPDATE workflow_runs SET status=?, error_code=?, error_message=?, started_at=?, ended_at=?,
         updated_at=?, expires_at=?, missing_refs=?, lock_version=lock_version+1
       WHERE id=? AND tenant_id=? AND status=? AND lock_version=?`,
    ).run(
      patch.status, errorCode ?? null, errorMessage ?? null, startedAt ?? null, endedAt ?? null,
      normalizeTimestamp(patch.updatedAt), expiresAt ?? null,
      missingRefs === undefined ? null : requireJsonField(missingRefs, '运行缺失引用'),
      id, tenantId, fromStatus, expectedLockVersion,
    );
    return result.changes === 1 ? this.getWorkflowRun(tenantId, id) : undefined;
  }

  async upsertWorkflowStepRun(tenantId: string, record: WorkflowStepRunRecord): Promise<boolean> {
    const run = await this.getWorkflowRun(tenantId, record.runId);
    if (!run) return false;
    // 计数类 CHECK 先在应用层校验：两端错误类型与文案必须一致（见 9.4）。
    assertWorkflowStepAttempt(record.attempt);
    assertWorkflowStepStatus(record.status);
    assertWorkflowStepCallCount(record.llmCalls ?? 0, 'llm_calls');
    assertWorkflowStepCallCount(record.toolCalls ?? 0, 'tool_calls');
    const result = this.db.prepare(
      `INSERT INTO workflow_step_runs (id,run_id,node_id,attempt,status,input_json,output_json,error_code,
         error_message,approval_id,idempotency_key,side_effect_unknown,llm_calls,tool_calls,missing_refs,
         started_at,ended_at,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(run_id,node_id) DO UPDATE SET
         attempt=MAX(workflow_step_runs.attempt, excluded.attempt),
         status=CASE WHEN (excluded.attempt,excluded.updated_at) >= (workflow_step_runs.attempt,workflow_step_runs.updated_at)
           THEN excluded.status ELSE workflow_step_runs.status END,
         input_json=CASE WHEN (excluded.attempt,excluded.updated_at) >= (workflow_step_runs.attempt,workflow_step_runs.updated_at)
           THEN excluded.input_json ELSE workflow_step_runs.input_json END,
         output_json=CASE WHEN (excluded.attempt,excluded.updated_at) >= (workflow_step_runs.attempt,workflow_step_runs.updated_at)
           THEN excluded.output_json ELSE workflow_step_runs.output_json END,
         error_code=CASE WHEN (excluded.attempt,excluded.updated_at) >= (workflow_step_runs.attempt,workflow_step_runs.updated_at)
           THEN excluded.error_code ELSE workflow_step_runs.error_code END,
         error_message=CASE WHEN (excluded.attempt,excluded.updated_at) >= (workflow_step_runs.attempt,workflow_step_runs.updated_at)
           THEN excluded.error_message ELSE workflow_step_runs.error_message END,
         approval_id=CASE WHEN (excluded.attempt,excluded.updated_at) >= (workflow_step_runs.attempt,workflow_step_runs.updated_at)
           THEN excluded.approval_id ELSE workflow_step_runs.approval_id END,
         idempotency_key=CASE WHEN (excluded.attempt,excluded.updated_at) >= (workflow_step_runs.attempt,workflow_step_runs.updated_at)
           THEN excluded.idempotency_key ELSE workflow_step_runs.idempotency_key END,
         side_effect_unknown=MAX(workflow_step_runs.side_effect_unknown, excluded.side_effect_unknown),
         llm_calls=CASE WHEN (excluded.attempt,excluded.updated_at) >= (workflow_step_runs.attempt,workflow_step_runs.updated_at)
           THEN excluded.llm_calls ELSE workflow_step_runs.llm_calls END,
         tool_calls=CASE WHEN (excluded.attempt,excluded.updated_at) >= (workflow_step_runs.attempt,workflow_step_runs.updated_at)
           THEN excluded.tool_calls ELSE workflow_step_runs.tool_calls END,
         missing_refs=CASE WHEN (excluded.attempt,excluded.updated_at) >= (workflow_step_runs.attempt,workflow_step_runs.updated_at)
           THEN excluded.missing_refs ELSE workflow_step_runs.missing_refs END,
         started_at=CASE WHEN (excluded.attempt,excluded.updated_at) >= (workflow_step_runs.attempt,workflow_step_runs.updated_at)
           THEN excluded.started_at ELSE workflow_step_runs.started_at END,
         ended_at=CASE WHEN (excluded.attempt,excluded.updated_at) >= (workflow_step_runs.attempt,workflow_step_runs.updated_at)
           THEN excluded.ended_at ELSE workflow_step_runs.ended_at END,
         updated_at=CASE WHEN (excluded.attempt,excluded.updated_at) >= (workflow_step_runs.attempt,workflow_step_runs.updated_at)
           THEN excluded.updated_at ELSE workflow_step_runs.updated_at END`,
    ).run(
      record.id, record.runId, record.nodeId, record.attempt, record.status,
      record.input === undefined ? null : requireJsonField(record.input, '步骤输入'),
      record.output === undefined ? null : requireJsonField(record.output, '步骤输出'),
      record.errorCode ?? null,
      record.errorMessage ?? null, record.approvalId ?? null, record.idempotencyKey ?? null,
      record.sideEffectUnknown ? 1 : 0, record.llmCalls ?? 0, record.toolCalls ?? 0,
      record.missingRefs === undefined ? null : requireJsonField(record.missingRefs, '步骤缺失引用'),
      record.startedAt === undefined ? null : normalizeTimestamp(record.startedAt),
      record.endedAt === undefined ? null : normalizeTimestamp(record.endedAt),
      normalizeTimestamp(record.createdAt), normalizeTimestamp(record.updatedAt),
    );
    return result.changes === 1;
  }

  async getWorkflowStepRun(
    tenantId: string,
    runId: string,
    nodeId: string,
    actor?: WorkflowActor,
  ): Promise<WorkflowStepRunRecord | undefined> {
    const where = ['s.run_id=?', 's.node_id=?', 'r.tenant_id=?'];
    const args: unknown[] = [runId, nodeId, tenantId];
    // 步骤可见性跟随其所属运行（R6）。
    where.push(...buildWorkflowRunVisibilityWhere({ actor }, (value) => {
      args.push(value);
      return '?';
    }));
    const row = this.db.prepare(
      `SELECT s.* FROM workflow_step_runs s JOIN workflow_runs r ON r.id=s.run_id
       WHERE ${where.join(' AND ')}`,
    ).get(...args);
    return row ? mapWorkflowStepRunRow(row) : undefined;
  }

  async listWorkflowStepRuns(
    tenantId: string,
    runId: string,
    options?: { actor?: WorkflowActor; limit?: number; cursor?: string },
  ): Promise<WorkflowStepRunRecord[]> {
    const where = ['s.run_id=?', 'r.tenant_id=?'];
    const args: unknown[] = [runId, tenantId];
    // 步骤可见性跟随其所属运行（R6）。
    where.push(...buildWorkflowRunVisibilityWhere({ actor: options?.actor }, (value) => {
      args.push(value);
      return '?';
    }));
    const cursor = parseWorkflowCursor(options?.cursor);
    if (cursor) {
      where.push('(s.created_at, s.node_id) > (?, ?)');
      args.push(cursor.sortKey, cursor.id);
    }
    args.push(resolveWorkflowListLimit(options?.limit));
    const rows = this.db.prepare(
      `SELECT s.* FROM workflow_step_runs s JOIN workflow_runs r ON r.id=s.run_id
       WHERE ${where.join(' AND ')} ORDER BY s.created_at, s.node_id LIMIT ?`,
    ).all(...args);
    return rows.map(mapWorkflowStepRunRow);
  }

  async upsertTenantWorkflowTemplate(tenantId: string, record: WorkflowTemplateRecord): Promise<boolean> {
    if (record.scope !== 'tenant') return false;
    if (record.tenantId !== undefined && record.tenantId !== null && record.tenantId !== tenantId) return false;
    // 作用域与租户归属互斥先在应用层校验：CHECK 只作最后兜底（见 9.5）。
    assertWorkflowTemplateScope(record.scope, record.tenantId ?? tenantId);
    // 模板状态的 CHECK 先在应用层校验：两端错误类型与文案必须一致（见 9.5）。
    assertWorkflowTemplateStatus(record.status);
    const result = this.db.prepare(
      `INSERT INTO workflow_templates (id,scope,tenant_id,name,description,status,current_draft_version,
         latest_published_version,created_by,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description,
         status=excluded.status, current_draft_version=excluded.current_draft_version,
         latest_published_version=excluded.latest_published_version, updated_at=excluded.updated_at,
         deleted_at=excluded.deleted_at
       WHERE workflow_templates.scope='tenant' AND workflow_templates.tenant_id=excluded.tenant_id
         AND workflow_templates.deleted_at IS NULL
         AND (workflow_templates.status <> 'published' OR excluded.status = 'published')`,
    ).run(
      record.id, 'tenant', tenantId, record.name, record.description ?? null,
      record.status, record.currentDraftVersion ?? null, record.latestPublishedVersion ?? null,
      record.createdBy, normalizeTimestamp(record.createdAt), normalizeTimestamp(record.updatedAt),
      record.deletedAt === undefined ? null : normalizeTimestamp(record.deletedAt),
    );
    return result.changes === 1;
  }

  async upsertPlatformWorkflowTemplate(record: WorkflowTemplateRecord): Promise<boolean> {
    if (record.scope !== 'platform') return false;
    // 平台模板不能带租户归属：违反互斥约束时给统一领域错误，而不是驱动原始异常。
    assertWorkflowTemplateScope(record.scope, record.tenantId);
    // 模板状态的 CHECK 先在应用层校验：两端错误类型与文案必须一致（见 9.5）。
    assertWorkflowTemplateStatus(record.status);
    const result = this.db.prepare(
      `INSERT INTO workflow_templates (id,scope,tenant_id,name,description,status,current_draft_version,
         latest_published_version,created_by,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description,
         status=excluded.status, current_draft_version=excluded.current_draft_version,
         latest_published_version=excluded.latest_published_version, updated_at=excluded.updated_at,
         deleted_at=excluded.deleted_at
       WHERE workflow_templates.scope='platform' AND workflow_templates.tenant_id IS NULL
         AND workflow_templates.deleted_at IS NULL
         AND (workflow_templates.status <> 'published' OR excluded.status = 'published')`,
    ).run(
      record.id, 'platform', null, record.name, record.description ?? null,
      record.status, record.currentDraftVersion ?? null, record.latestPublishedVersion ?? null,
      record.createdBy, normalizeTimestamp(record.createdAt), normalizeTimestamp(record.updatedAt),
      record.deletedAt === undefined ? null : normalizeTimestamp(record.deletedAt),
    );
    return result.changes === 1;
  }

  async getWorkflowTemplate(tenantId: string, id: string): Promise<WorkflowTemplateRecord | undefined> {
    const row = this.db.prepare(
      `SELECT * FROM workflow_templates WHERE id=? AND deleted_at IS NULL
       AND (scope='platform' OR (scope='tenant' AND tenant_id=?))`,
    ).get(id, tenantId);
    return row ? mapWorkflowTemplateRow(row) : undefined;
  }

  async listWorkflowTemplates(
    tenantId: string,
    options?: { limit?: number; cursor?: string },
  ): Promise<WorkflowTemplateRecord[]> {
    const where = ["deleted_at IS NULL", "(scope='platform' OR (scope='tenant' AND tenant_id=?))"];
    const args: unknown[] = [tenantId];
    const cursor = parseWorkflowCursor(options?.cursor);
    if (cursor) {
      where.push('(updated_at, id) < (?, ?)');
      args.push(cursor.sortKey, cursor.id);
    }
    args.push(resolveWorkflowListLimit(options?.limit));
    const rows = this.db.prepare(
      `SELECT * FROM workflow_templates WHERE ${where.join(' AND ')} ORDER BY updated_at DESC, id DESC LIMIT ?`,
    ).all(...args);
    return rows.map(mapWorkflowTemplateRow);
  }

  async upsertTenantWorkflowTemplateVersion(
    tenantId: string,
    record: WorkflowTemplateVersionRecord,
  ): Promise<boolean> {
    // 模板必须是本租户的 tenant 模板：平台模板和他人模板都不给写。
    const template = this.db.prepare(
      `SELECT id FROM workflow_templates WHERE id=? AND scope='tenant' AND tenant_id=? AND deleted_at IS NULL`,
    ).get(record.templateId, tenantId);
    if (!template) return false;
    // 模板版本的 CHECK 先在应用层校验：两端错误类型与文案必须一致（见 9.5）。
    assertWorkflowTemplateStatus(record.status);
    assertWorkflowVersionNumber(record.version);
    const result = this.db.prepare(
      `INSERT INTO workflow_template_versions (template_id,version,definition_json,resource_slots,checksum,
         status,created_by,created_at,published_by,published_at) VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(template_id,version) DO UPDATE SET definition_json=excluded.definition_json,
         resource_slots=excluded.resource_slots, checksum=excluded.checksum, status=excluded.status,
         published_by=excluded.published_by, published_at=excluded.published_at
       WHERE workflow_template_versions.status <> 'published'`,
    ).run(
      record.templateId, record.version, requireJsonField(record.definition, '模板定义'), requireJsonField(record.resourceSlots, '资源槽位'),
      record.checksum, record.status, record.createdBy, normalizeTimestamp(record.createdAt),
      record.publishedBy ?? null,
      record.publishedAt === undefined ? null : normalizeTimestamp(record.publishedAt),
    );
    return result.changes === 1;
  }

  async upsertPlatformWorkflowTemplateVersion(record: WorkflowTemplateVersionRecord): Promise<boolean> {
    // 模板必须是 platform 模板（tenant_id 为空）。
    const template = this.db.prepare(
      `SELECT id FROM workflow_templates WHERE id=? AND scope='platform' AND tenant_id IS NULL AND deleted_at IS NULL`,
    ).get(record.templateId);
    if (!template) return false;
    // 模板版本的 CHECK 先在应用层校验：两端错误类型与文案必须一致（见 9.5）。
    assertWorkflowTemplateStatus(record.status);
    assertWorkflowVersionNumber(record.version);
    const result = this.db.prepare(
      `INSERT INTO workflow_template_versions (template_id,version,definition_json,resource_slots,checksum,
         status,created_by,created_at,published_by,published_at) VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(template_id,version) DO UPDATE SET definition_json=excluded.definition_json,
         resource_slots=excluded.resource_slots, checksum=excluded.checksum, status=excluded.status,
         published_by=excluded.published_by, published_at=excluded.published_at
       WHERE workflow_template_versions.status <> 'published'`,
    ).run(
      record.templateId, record.version, requireJsonField(record.definition, '模板定义'), requireJsonField(record.resourceSlots, '资源槽位'),
      record.checksum, record.status, record.createdBy, normalizeTimestamp(record.createdAt),
      record.publishedBy ?? null,
      record.publishedAt === undefined ? null : normalizeTimestamp(record.publishedAt),
    );
    return result.changes === 1;
  }

  async getWorkflowTemplateVersion(
    tenantId: string,
    templateId: string,
    version: number,
  ): Promise<WorkflowTemplateVersionRecord | undefined> {
    const row = this.db.prepare(
      `SELECT v.* FROM workflow_template_versions v JOIN workflow_templates t ON t.id=v.template_id
       WHERE v.template_id=? AND v.version=? AND t.deleted_at IS NULL
         AND (t.scope='platform' OR (t.scope='tenant' AND t.tenant_id=?))`,
    ).get(templateId, version, tenantId);
    return row ? mapWorkflowTemplateVersionRow(row) : undefined;
  }

  async listWorkflowTemplateVersions(
    tenantId: string,
    templateId: string,
    options?: { limit?: number; cursor?: string },
  ): Promise<WorkflowTemplateVersionRecord[]> {
    const where = ['v.template_id=?', 't.deleted_at IS NULL',
      "(t.scope='platform' OR (t.scope='tenant' AND t.tenant_id=?))"];
    const args: unknown[] = [templateId, tenantId];
    const cursor = parseWorkflowVersionCursor(options?.cursor);
    if (cursor !== undefined) {
      where.push('v.version > ?');
      args.push(cursor);
    }
    args.push(resolveWorkflowListLimit(options?.limit));
    const rows = this.db.prepare(
      `SELECT v.* FROM workflow_template_versions v JOIN workflow_templates t ON t.id=v.template_id
       WHERE ${where.join(' AND ')} ORDER BY v.version LIMIT ?`,
    ).all(...args);
    return rows.map(mapWorkflowTemplateVersionRow);
  }

  async upsertKnowledgeDoc(d: KnowledgeDoc): Promise<boolean> {
    const result = this.db
      .prepare(
        `INSERT INTO knowledge_docs (id,tenant_id,dept_id,title,content,sensitivity,owner_id,updated_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET dept_id=excluded.dept_id,
           title=excluded.title, content=excluded.content, sensitivity=excluded.sensitivity,
           owner_id=excluded.owner_id, updated_at=excluded.updated_at
         WHERE knowledge_docs.tenant_id=excluded.tenant_id`,
      )
      .run(d.id, d.tenantId, d.deptId, d.title, d.content, d.sensitivity, d.ownerId, d.updatedAt);
    return result.changes === 1;
  }

  async deleteKnowledgeDoc(id: string, tenantId: string): Promise<boolean> {
    return this.db.prepare('DELETE FROM knowledge_docs WHERE id=? AND tenant_id=?').run(id, tenantId).changes === 1;
  }

  async listKnowledgeDocs(tenantId: string): Promise<KnowledgeDoc[]> {
    const rows = this.db.prepare('SELECT * FROM knowledge_docs WHERE tenant_id=? ORDER BY updated_at DESC').all(tenantId) as any[];
    return rows.map((r) => ({
      id: r.id,
      tenantId: r.tenant_id,
      deptId: r.dept_id,
      title: r.title,
      content: r.content,
      sensitivity: r.sensitivity,
      ownerId: r.owner_id,
      updatedAt: r.updated_at,
    }));
  }
}
