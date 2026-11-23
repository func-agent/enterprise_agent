/**
 * PostgreSQL 元数据存储实现（对应 3.1 存储组件 PostgreSQL 16 —— 全平台元数据）。
 *
 * 与 SqliteMetadataStore 接口完全一致，通过 STORE_KIND=postgres 切换。
 * Schema 与 SQLite 版保持同构，差异仅在类型与占位符。
 */
import { Pool, type PoolClient } from 'pg';
import type {
  Application,
  ApprovalRequest,
  AuditEvent,
  ProviderCredential,
  ProviderDefinition,
  Tenant,
  TraceRecord,
  VirtualModel,
} from '../types.js';
import type { KnowledgeDoc, MessageRecord, SessionRecord, MetadataStore, UsageRecord } from './metadata.js';

const PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, models JSONB NOT NULL DEFAULT '[]',
  tools JSONB NOT NULL DEFAULT '[]', knowledge_bases JSONB NOT NULL DEFAULT '[]',
  monthly_budget_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  monthly_token_budget DOUBLE PRECISION NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
  qps_limit INTEGER NOT NULL DEFAULT 10, per_request_token_limit INTEGER NOT NULL DEFAULT 8000,
  monthly_budget_usd DOUBLE PRECISION NOT NULL DEFAULT 0, enabled BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE TABLE IF NOT EXISTS virtual_models (
  name TEXT PRIMARY KEY, description TEXT NOT NULL, targets JSONB NOT NULL DEFAULT '[]',
  scenarios JSONB NOT NULL DEFAULT '[]', enabled BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE TABLE IF NOT EXISTS provider_credentials (
  provider TEXT PRIMARY KEY, secret_cipher TEXT NOT NULL, source TEXT NOT NULL,
  updated_at TEXT NOT NULL, updated_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_definitions (
  name TEXT PRIMARY KEY, base_url TEXT NOT NULL, protocol TEXT NOT NULL,
  auth_mode TEXT NOT NULL, accounts JSONB NOT NULL DEFAULT '["default"]', enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, title TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  app_id TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), tool_calls JSONB, tool_call_id TEXT, trace_id TEXT
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, session_id TEXT NOT NULL,
  trace_id TEXT NOT NULL, tool TEXT NOT NULL, args JSONB NOT NULL DEFAULT '{}', reason TEXT NOT NULL,
  status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ, decided_by TEXT
);
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY, ts TIMESTAMPTZ NOT NULL DEFAULT now(), kind TEXT NOT NULL,
  tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT, dept_id TEXT, app_id TEXT,
  session_id TEXT, trace_id TEXT NOT NULL, model TEXT, provider TEXT, tool TEXT, server_id TEXT,
  prompt_tokens INTEGER, completion_tokens INTEGER, cost_usd DOUBLE PRECISION,
  status TEXT NOT NULL, reason TEXT, detail JSONB
);
CREATE TABLE IF NOT EXISTS traces (
  trace_id TEXT PRIMARY KEY, session_id TEXT, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL,
  name TEXT NOT NULL, ts TIMESTAMPTZ NOT NULL DEFAULT now(), input JSONB, output JSONB,
  prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0, model TEXT, metadata JSONB DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS usage (
  scope TEXT NOT NULL, scope_id TEXT NOT NULL, month TEXT NOT NULL,
  prompt_tokens BIGINT NOT NULL DEFAULT 0, completion_tokens BIGINT NOT NULL DEFAULT 0,
  cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0, requests BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, scope_id, month)
);
CREATE TABLE IF NOT EXISTS knowledge_docs (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, dept_id TEXT NOT NULL, title TEXT NOT NULL,
  content TEXT NOT NULL, sensitivity TEXT NOT NULL, owner_id TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant_ts ON audit_events(tenant_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_trace ON audit_events(trace_id);
CREATE INDEX IF NOT EXISTS idx_msg_session ON messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(tenant_id, user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_docs_tenant ON knowledge_docs(tenant_id);
`;

export class PgMetadataStore implements MetadataStore {
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 10 });
  }

  async init(): Promise<void> {
    // 逐条执行：多语句一次性下发时，CREATE TABLE IF NOT EXISTS 在并发启动下
    // 会撞 pg_type_typname_nsp_index 唯一约束（多个进程同时建表）
    for (const stmt of PG_SCHEMA.split(';')) {
      const sql = stmt.trim();
      if (!sql) continue;
      try {
        await this.pool.query(sql);
      } catch (err: any) {
        const code = err?.code;
        // 42P07 duplicate_table / 42710 duplicate_object / 42P06 已存在 → 可忽略
        if (code === '42P07' || code === '42710' || code === '42P06' || code === '23505') {
          continue;
        }
        throw err;
      }
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async upsertTenant(t: Tenant): Promise<void> {
    await this.pool.query(
      `INSERT INTO tenants (id,name,models,tools,knowledge_bases,monthly_budget_usd,monthly_token_budget,enabled)
       VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET name=excluded.name, models=excluded.models, tools=excluded.tools,
         knowledge_bases=excluded.knowledge_bases, monthly_budget_usd=excluded.monthly_budget_usd,
         monthly_token_budget=excluded.monthly_token_budget, enabled=excluded.enabled`,
      [t.id, t.name, JSON.stringify(t.models), JSON.stringify(t.tools), JSON.stringify(t.knowledgeBases), t.monthlyBudgetUsd, t.monthlyTokenBudget, t.enabled],
    );
  }

  async getTenant(id: string): Promise<Tenant | undefined> {
    const r = await this.pool.query('SELECT * FROM tenants WHERE id=$1', [id]);
    if (!r.rows.length) return undefined;
    const row = r.rows[0];
    return {
      id: row.id,
      name: row.name,
      models: row.models ?? [],
      tools: row.tools ?? [],
      knowledgeBases: row.knowledge_bases ?? [],
      monthlyBudgetUsd: Number(row.monthly_budget_usd),
      monthlyTokenBudget: Number(row.monthly_token_budget),
      enabled: row.enabled,
    };
  }

  async listTenants(): Promise<Tenant[]> {
    const r = await this.pool.query('SELECT id FROM tenants ORDER BY id');
    const out: Tenant[] = [];
    for (const row of r.rows) {
      const t = await this.getTenant(row.id);
      if (t) out.push(t);
    }
    return out;
  }

  async upsertApplication(a: Application): Promise<void> {
    await this.pool.query(
      `INSERT INTO applications (id,tenant_id,name,qps_limit,per_request_token_limit,monthly_budget_usd,enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET tenant_id=excluded.tenant_id, name=excluded.name,
         qps_limit=excluded.qps_limit, per_request_token_limit=excluded.per_request_token_limit,
         monthly_budget_usd=excluded.monthly_budget_usd, enabled=excluded.enabled`,
      [a.id, a.tenantId, a.name, a.qpsLimit, a.perRequestTokenLimit, a.monthlyBudgetUsd, a.enabled],
    );
  }

  async listApplications(tenantId?: string): Promise<Application[]> {
    const r = tenantId
      ? await this.pool.query('SELECT * FROM applications WHERE tenant_id=$1', [tenantId])
      : await this.pool.query('SELECT * FROM applications');
    return r.rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      name: row.name,
      qpsLimit: row.qps_limit,
      perRequestTokenLimit: row.per_request_token_limit,
      monthlyBudgetUsd: Number(row.monthly_budget_usd),
      enabled: row.enabled,
    }));
  }

  async upsertVirtualModel(m: VirtualModel): Promise<void> {
    await this.pool.query(
      `INSERT INTO virtual_models (name,description,targets,scenarios,enabled) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5)
       ON CONFLICT (name) DO UPDATE SET description=excluded.description, targets=excluded.targets,
         scenarios=excluded.scenarios, enabled=excluded.enabled`,
      [m.name, m.description, JSON.stringify(m.targets), JSON.stringify(m.scenarios), m.enabled],
    );
  }

  async getVirtualModel(name: string): Promise<VirtualModel | undefined> {
    const r = await this.pool.query('SELECT * FROM virtual_models WHERE name=$1', [name]);
    if (!r.rows.length) return undefined;
    const row = r.rows[0];
    return {
      name: row.name,
      description: row.description,
      targets: row.targets ?? [],
      scenarios: row.scenarios ?? [],
      enabled: row.enabled,
    };
  }

  async listVirtualModels(): Promise<VirtualModel[]> {
    const r = await this.pool.query('SELECT name FROM virtual_models ORDER BY name');
    const out: VirtualModel[] = [];
    for (const row of r.rows) {
      const m = await this.getVirtualModel(row.name);
      if (m) out.push(m);
    }
    return out;
  }

  async deleteVirtualModel(name: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM virtual_models WHERE name=$1', [name]);
    return (result.rowCount ?? 0) > 0;
  }

  async upsertProviderDefinition(p: ProviderDefinition): Promise<void> {
    await this.pool.query(
      `INSERT INTO provider_definitions (name,base_url,protocol,auth_mode,accounts,enabled,created_at,updated_at,updated_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)
       ON CONFLICT (name) DO UPDATE SET base_url=excluded.base_url, protocol=excluded.protocol,
         auth_mode=excluded.auth_mode, accounts=excluded.accounts, enabled=excluded.enabled,
         updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
      [p.name, p.baseUrl, p.protocol, p.authMode, JSON.stringify(p.accounts), p.enabled, p.createdAt, p.updatedAt, p.updatedBy],
    );
  }

  async getProviderDefinition(name: string): Promise<ProviderDefinition | undefined> {
    const result = await this.pool.query('SELECT * FROM provider_definitions WHERE name=$1', [name]);
    if (!result.rows.length) return undefined;
    const row = result.rows[0];
    return {
      name: row.name, baseUrl: row.base_url, protocol: row.protocol, authMode: row.auth_mode,
      accounts: row.accounts ?? ['default'], enabled: row.enabled,
      createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(), updatedBy: row.updated_by,
    };
  }

  async listProviderDefinitions(): Promise<ProviderDefinition[]> {
    const result = await this.pool.query('SELECT name FROM provider_definitions ORDER BY name');
    const providers: ProviderDefinition[] = [];
    for (const row of result.rows) {
      const provider = await this.getProviderDefinition(row.name);
      if (provider) providers.push(provider);
    }
    return providers;
  }

  async deleteProviderDefinition(name: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM provider_definitions WHERE name=$1', [name]);
    return (result.rowCount ?? 0) > 0;
  }

  // Provider 凭证（平台级，密文存储；见 8.5 凭证安全）

  async upsertProviderCredential(c: ProviderCredential): Promise<void> {
    await this.pool.query(
      `INSERT INTO provider_credentials (provider,secret_cipher,source,updated_at,updated_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (provider) DO UPDATE SET secret_cipher=excluded.secret_cipher,
         source=excluded.source, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
      [c.provider, c.secretCipher, c.source, c.updatedAt, c.updatedBy],
    );
  }

  async getProviderCredential(provider: string): Promise<ProviderCredential | undefined> {
    const r = await this.pool.query('SELECT * FROM provider_credentials WHERE provider=$1', [provider]);
    if (!r.rows.length) return undefined;
    const row = r.rows[0];
    return {
      provider: row.provider,
      secretCipher: row.secret_cipher,
      source: row.source,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    };
  }

  async listProviderCredentials(): Promise<ProviderCredential[]> {
    const r = await this.pool.query('SELECT * FROM provider_credentials ORDER BY provider');
    return r.rows.map((row) => ({
      provider: row.provider,
      secretCipher: row.secret_cipher,
      source: row.source,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    }));
  }

  async deleteProviderCredential(provider: string): Promise<boolean> {
    const r = await this.pool.query('DELETE FROM provider_credentials WHERE provider=$1', [provider]);
    return (r.rowCount ?? 0) > 0;
  }

  async createSession(s: SessionRecord): Promise<void> {
    await this.pool.query(
      'INSERT INTO sessions (id,tenant_id,user_id,title,created_at,updated_at,app_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [s.id, s.tenantId, s.userId, s.title, s.createdAt, s.updatedAt, s.appId ?? null],
    );
  }

  async updateSession(id: string, patch: Partial<SessionRecord>): Promise<void> {
    const cur = await this.getSession(id);
    if (!cur) return;
    const m = { ...cur, ...patch };
    await this.pool.query('UPDATE sessions SET title=$2, updated_at=$3, app_id=$4 WHERE id=$1', [
      id,
      m.title,
      m.updatedAt,
      m.appId ?? null,
    ]);
  }

  async getSession(id: string): Promise<SessionRecord | undefined> {
    const r = await this.pool.query('SELECT * FROM sessions WHERE id=$1', [id]);
    if (!r.rows.length) return undefined;
    const row = r.rows[0];
    return {
      id: row.id,
      tenantId: row.tenant_id,
      userId: row.user_id,
      title: row.title,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      appId: row.app_id ?? undefined,
    };
  }

  async listSessions(tenantId: string, userId?: string): Promise<SessionRecord[]> {
    const r = userId
      ? await this.pool.query('SELECT * FROM sessions WHERE tenant_id=$1 AND user_id=$2 ORDER BY updated_at DESC', [tenantId, userId])
      : await this.pool.query('SELECT * FROM sessions WHERE tenant_id=$1 ORDER BY updated_at DESC', [tenantId]);
    return r.rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      userId: row.user_id,
      title: row.title,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      appId: row.app_id ?? undefined,
    }));
  }

  async deleteSession(id: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM messages WHERE session_id=$1', [id]);
      const result = await client.query('DELETE FROM sessions WHERE id=$1', [id]);
      await client.query('COMMIT');
      return (result.rowCount ?? 0) > 0;
    } catch (err) {
      // 回滚本身可能失败（连接已断开），此时保留原始错误，避免掩盖真实原因
      try {
        await client.query('ROLLBACK');
      } catch {
        /* 忽略回滚失败，交由连接池丢弃该客户端 */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async appendMessage(m: MessageRecord): Promise<void> {
    await this.pool.query(
      'INSERT INTO messages (id,session_id,role,content,created_at,tool_calls,tool_call_id,trace_id) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)',
      [m.id, m.sessionId, m.role, m.content, m.createdAt, m.toolCalls ? JSON.stringify(m.toolCalls) : null, m.toolCallId ?? null, m.traceId ?? null],
    );
  }

  async listMessages(sessionId: string): Promise<MessageRecord[]> {
    const r = await this.pool.query(
      'SELECT * FROM messages WHERE session_id=$1 ORDER BY created_at ASC',
      [sessionId],
    );
    return r.rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      role: row.role,
      content: row.content,
      createdAt: new Date(row.created_at).toISOString(),
      toolCalls: row.tool_calls ?? undefined,
      toolCallId: row.tool_call_id ?? undefined,
      traceId: row.trace_id ?? undefined,
    }));
  }

  async createApproval(a: ApprovalRequest): Promise<void> {
    await this.pool.query(
      `INSERT INTO approvals (id,tenant_id,user_id,session_id,trace_id,tool,args,reason,status,created_at,decided_at,decided_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12)`,
      [a.id, a.tenantId, a.userId, a.sessionId, a.traceId, a.tool, JSON.stringify(a.args), a.reason, a.status, a.createdAt, a.decidedAt ?? null, a.decidedBy ?? null],
    );
  }

  async updateApproval(id: string, patch: Partial<ApprovalRequest>): Promise<void> {
    const cur = await this.getApproval(id);
    if (!cur) return;
    const m = { ...cur, ...patch };
    await this.pool.query('UPDATE approvals SET status=$2, decided_at=$3, decided_by=$4 WHERE id=$1', [
      id,
      m.status,
      m.decidedAt ?? null,
      m.decidedBy ?? null,
    ]);
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
    const result = await this.pool.query(
      'UPDATE approvals SET status=$4, decided_at=$5, decided_by=$6 WHERE id=$1 AND tenant_id=$2 AND status=$3',
      [id, tenantId, fromStatus, m.status, m.decidedAt ?? null, m.decidedBy ?? null],
    );
    return result.rowCount === 1;
  }

  async getApproval(id: string): Promise<ApprovalRequest | undefined> {
    const r = await this.pool.query('SELECT * FROM approvals WHERE id=$1', [id]);
    if (!r.rows.length) return undefined;
    const row = r.rows[0];
    return {
      id: row.id,
      tenantId: row.tenant_id,
      userId: row.user_id,
      sessionId: row.session_id,
      traceId: row.trace_id,
      tool: row.tool,
      args: row.args ?? {},
      reason: row.reason,
      status: row.status,
      createdAt: new Date(row.created_at).toISOString(),
      decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : undefined,
      decidedBy: row.decided_by ?? undefined,
    };
  }

  async listApprovals(filter: { tenantId?: string; status?: string; userId?: string }): Promise<ApprovalRequest[]> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.tenantId) { where.push(`tenant_id=$${args.length + 1}`); args.push(filter.tenantId); }
    if (filter.status) { where.push(`status=$${args.length + 1}`); args.push(filter.status); }
    if (filter.userId) { where.push(`user_id=$${args.length + 1}`); args.push(filter.userId); }
    const sql = `SELECT id FROM approvals ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT 200`;
    const r = await this.pool.query(sql, args);
    const out: ApprovalRequest[] = [];
    for (const row of r.rows) {
      const a = await this.getApproval(row.id);
      if (a) out.push(a);
    }
    return out;
  }

  async appendAudit(e: AuditEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_events (id,ts,kind,tenant_id,user_id,role,dept_id,app_id,session_id,trace_id,
         model,provider,tool,server_id,prompt_tokens,completion_tokens,cost_usd,status,reason,detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb)`,
      [e.id, e.ts, e.kind, e.tenantId, e.userId, e.role ?? null, e.deptId ?? null, e.appId ?? null,
       e.sessionId ?? null, e.traceId, e.model ?? null, e.provider ?? null, e.tool ?? null,
       e.serverId ?? null, e.promptTokens ?? null, e.completionTokens ?? null, e.costUsd ?? null,
       e.status, e.reason ?? null, e.detail ? JSON.stringify(e.detail) : null],
    );
  }

  async listAudit(filter: { tenantId?: string; kind?: string; limit?: number }): Promise<AuditEvent[]> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.tenantId) { where.push(`tenant_id=$${args.length + 1}`); args.push(filter.tenantId); }
    if (filter.kind) { where.push(`kind=$${args.length + 1}`); args.push(filter.kind); }
    args.push(Math.min(filter.limit ?? 100, 1000));
    const sql = `SELECT * FROM audit_events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ts DESC LIMIT $${args.length}`;
    const r = await this.pool.query(sql, args);
    return r.rows.map((row) => ({
      id: row.id,
      ts: new Date(row.ts).toISOString(),
      kind: row.kind,
      tenantId: row.tenant_id,
      userId: row.user_id,
      role: row.role ?? undefined,
      deptId: row.dept_id ?? undefined,
      appId: row.app_id ?? undefined,
      sessionId: row.session_id ?? undefined,
      traceId: row.trace_id,
      model: row.model ?? undefined,
      provider: row.provider ?? undefined,
      tool: row.tool ?? undefined,
      serverId: row.server_id ?? undefined,
      promptTokens: row.prompt_tokens ?? undefined,
      completionTokens: row.completion_tokens ?? undefined,
      costUsd: row.cost_usd === null ? undefined : Number(row.cost_usd),
      status: row.status,
      reason: row.reason ?? undefined,
      detail: row.detail ?? undefined,
    }));
  }

  async appendTrace(t: TraceRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO traces (trace_id,session_id,tenant_id,user_id,name,ts,input,output,prompt_tokens,completion_tokens,cost_usd,model,metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13::jsonb)
       ON CONFLICT (trace_id) DO UPDATE SET output=excluded.output, prompt_tokens=excluded.prompt_tokens,
         completion_tokens=excluded.completion_tokens, cost_usd=excluded.cost_usd`,
      [t.traceId, t.sessionId ?? null, t.tenantId, t.userId, t.name, t.ts,
       t.input ? JSON.stringify(t.input) : null, t.output ? JSON.stringify(t.output) : null,
       t.promptTokens, t.completionTokens, t.costUsd, t.model ?? null, JSON.stringify(t.metadata ?? {})],
    );
  }

  async listTraces(filter: { tenantId?: string; limit?: number }): Promise<TraceRecord[]> {
    const limit = Math.min(filter.limit ?? 100, 1000);
    const r = filter.tenantId
      ? await this.pool.query('SELECT * FROM traces WHERE tenant_id=$1 ORDER BY ts DESC LIMIT $2', [filter.tenantId, limit])
      : await this.pool.query('SELECT * FROM traces ORDER BY ts DESC LIMIT $1', [limit]);
    return r.rows.map((row) => ({
      traceId: row.trace_id,
      sessionId: row.session_id ?? undefined,
      tenantId: row.tenant_id,
      userId: row.user_id,
      name: row.name,
      ts: new Date(row.ts).toISOString(),
      input: row.input ?? undefined,
      output: row.output ?? undefined,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      costUsd: Number(row.cost_usd),
      model: row.model ?? undefined,
      metadata: row.metadata ?? undefined,
    }));
  }

  async addUsage(u: UsageRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO usage (scope,scope_id,month,prompt_tokens,completion_tokens,cost_usd,requests)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (scope,scope_id,month) DO UPDATE SET
         prompt_tokens = usage.prompt_tokens + EXCLUDED.prompt_tokens,
         completion_tokens = usage.completion_tokens + EXCLUDED.completion_tokens,
         cost_usd = usage.cost_usd + EXCLUDED.cost_usd,
         requests = usage.requests + EXCLUDED.requests`,
      [u.scope, u.scopeId, u.month, u.promptTokens, u.completionTokens, u.costUsd, u.requests],
    );
  }

  async getUsage(scope: 'platform' | 'tenant' | 'app', scopeId: string, month: string): Promise<UsageRecord> {
    const r = await this.pool.query(
      'SELECT * FROM usage WHERE scope=$1 AND scope_id=$2 AND month=$3',
      [scope, scopeId, month],
    );
    if (!r.rows.length) return { scope, scopeId, month, promptTokens: 0, completionTokens: 0, costUsd: 0, requests: 0 };
    const row = r.rows[0];
    return {
      scope: row.scope,
      scopeId: row.scope_id,
      month: row.month,
      promptTokens: Number(row.prompt_tokens),
      completionTokens: Number(row.completion_tokens),
      costUsd: Number(row.cost_usd),
      requests: Number(row.requests),
    };
  }

  async upsertKnowledgeDoc(d: KnowledgeDoc): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO knowledge_docs (id,tenant_id,dept_id,title,content,sensitivity,owner_id,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET dept_id=excluded.dept_id,
         title=excluded.title, content=excluded.content, sensitivity=excluded.sensitivity,
         owner_id=excluded.owner_id, updated_at=excluded.updated_at
       WHERE knowledge_docs.tenant_id=excluded.tenant_id`,
      [d.id, d.tenantId, d.deptId, d.title, d.content, d.sensitivity, d.ownerId, d.updatedAt],
    );
    return result.rowCount === 1;
  }

  async deleteKnowledgeDoc(id: string, tenantId: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM knowledge_docs WHERE id=$1 AND tenant_id=$2', [id, tenantId]);
    return result.rowCount === 1;
  }

  async listKnowledgeDocs(tenantId: string): Promise<KnowledgeDoc[]> {
    const r = await this.pool.query('SELECT * FROM knowledge_docs WHERE tenant_id=$1 ORDER BY updated_at DESC', [tenantId]);
    return r.rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      deptId: row.dept_id,
      title: row.title,
      content: row.content,
      sensitivity: row.sensitivity,
      ownerId: row.owner_id,
      updatedAt: new Date(row.updated_at).toISOString(),
    }));
  }
}
