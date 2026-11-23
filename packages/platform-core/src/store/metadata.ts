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

export interface MetadataStore {
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
    // 轻量迁移：新增列（老库兼容）
    try {
      this.db.exec('ALTER TABLE messages ADD COLUMN tool_call_id TEXT');
    } catch {
      /* 已存在 */
    }
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
