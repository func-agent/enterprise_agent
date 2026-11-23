/**
 * 知识库管理接口测试（控制台「知识库」页的后端）。
 *
 * 关键断言：
 *   ① 可见性是「密级优先」——密级高于本人密级的文档，管理员也不可见；
 *   ② 部门隔离：普通用户只见本部门，管理员跨部门；
 *   ③ 跨租户不可见；
 *   ④ 写操作**不直接落库**，只生成审批单（202）；
 *   ⑤ 审批通过后才真正写入，且写入时以**申请人**身份执行（owner 是申请人）；
 *   ⑥ 不可见的文档返回 404 而不是 403 —— 不泄露文档是否存在。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { SqliteMetadataStore, type Identity } from '@eap/platform-core';
import {
  KB_DELETE_TOOL,
  KB_UPSERT_TOOL,
  executeApprovedKnowledgeWrite,
  isDocVisible,
  knowledgeRoutes,
  visibleDocs,
} from '../packages/gateway/src/routes/knowledge.js';

// —— 测试用身份

const ADMIN: Identity = {
  tenantId: 't-1',
  userId: 'u-admin',
  role: 'platform-admin',
  deptId: 'dept-platform',
  scopes: [],
  sensitivity: 'confidential',
  claims: {},
};

const OPS: Identity = {
  tenantId: 't-1',
  userId: 'u-ops',
  role: 'platform-admin',
  deptId: 'dept-general',
  scopes: [],
  sensitivity: 'internal',
  claims: {},
};

const EMPLOYEE: Identity = {
  tenantId: 't-1',
  userId: 'u-emp',
  role: 'employee',
  deptId: 'dept-general',
  scopes: [],
  sensitivity: 'internal',
  claims: {},
};

const OTHER_TENANT_ADMIN: Identity = {
  ...ADMIN,
  tenantId: 't-2',
  userId: 'u-other',
};

const DOCS = [
  { id: 'd-general', deptId: 'dept-general', sensitivity: 'internal' as const, title: '员工年假管理制度', content: '满 1 年 5 天年假。' },
  { id: 'd-east', deptId: 'dept-east', sensitivity: 'confidential' as const, title: '华东区采购框架协议', content: '采购总额不超过 1200 万元。' },
  { id: 'd-public', deptId: 'dept-general', sensitivity: 'public' as const, title: '公司公开信息', content: '公司地址与联系方式。' },
  { id: 'd-other-tenant', deptId: 'dept-general', sensitivity: 'internal' as const, title: '别的租户的文档', content: '不应被看到。' },
];

async function seed(): Promise<SqliteMetadataStore> {
  const store = new SqliteMetadataStore(':memory:');
  await store.init();
  for (const d of DOCS) {
    await store.upsertKnowledgeDoc({
      ...d,
      tenantId: d.id === 'd-other-tenant' ? 't-2' : 't-1',
      ownerId: 'owner',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  }
  return store;
}

// —— 可见性规则（纯函数）

describe('知识文档可见性', () => {
  it('密级优先：机密文档对 internal 密级的平台管理员也不可见', () => {
    const doc = { ...DOCS[1], tenantId: 't-1', ownerId: 'o', updatedAt: '' };
    expect(isDocVisible(doc, ADMIN)).toBe(true); // confidential 身份可见
    expect(isDocVisible(doc, OPS)).toBe(false); // internal 身份不可见
    expect(isDocVisible(doc, EMPLOYEE)).toBe(false);
  });

  it('部门隔离：普通用户只见本部门，管理员跨部门', () => {
    const docs = DOCS.filter((d) => d.id !== 'd-other-tenant').map((d) => ({
      ...d,
      tenantId: 't-1',
      ownerId: 'o',
      updatedAt: '',
    }));
    expect(visibleDocs(docs, EMPLOYEE).map((d) => d.id)).toEqual(['d-general', 'd-public']);
    expect(visibleDocs(docs, ADMIN).map((d) => d.id)).toEqual(['d-general', 'd-east', 'd-public']);
  });

  it('跨租户不可见', () => {
    const docs = DOCS.map((d) => ({
      ...d,
      tenantId: d.id === 'd-other-tenant' ? 't-2' : 't-1',
      ownerId: 'o',
      updatedAt: '',
    }));
    expect(visibleDocs(docs, ADMIN).some((d) => d.id === 'd-other-tenant')).toBe(false);
    expect(visibleDocs(docs, OTHER_TENANT_ADMIN).some((d) => d.id === 'd-other-tenant')).toBe(true);
  });

  it('public 密级对所有人可见', () => {
    const doc = { ...DOCS[2], tenantId: 't-1', ownerId: 'o', updatedAt: '' };
    expect(isDocVisible(doc, EMPLOYEE)).toBe(true);
    expect(isDocVisible(doc, ADMIN)).toBe(true);
  });
});

// —— HTTP 路由

describe('知识库路由', () => {
  let store: SqliteMetadataStore;
  let server: ReturnType<express.Express['listen']>;
  let baseUrl: string;
  /** MCP 调用的记录 —— 用于断言审批通过后真的走了 knowledge 工具 */
  const mcpCalls: { toolName: string; args: Record<string, unknown>; userId: string }[] = [];

  const ctx = () =>
    ({
      store,
      mcp: {
        call: async (params: {
          identity: Identity;
          toolName: string;
          args: Record<string, unknown>;
        }) => {
          mcpCalls.push({ toolName: params.toolName, args: params.args, userId: params.identity.userId });
          return { ok: true, content: '写入成功', structured: {}, traceId: 't' };
        },
      },
      audit: { record: async () => undefined },
    }) as never;

  beforeEach(async () => {
    mcpCalls.length = 0;
    store = await seed();
    const app = express();
    app.use(express.json());
    // 用 Authorization 头里的身份标记来模拟不同的登录用户
    app.use((req, _res, next) => {
      const who = req.headers['x-test-user'];
      const map: Record<string, Identity> = { admin: ADMIN, ops: OPS, emp: EMPLOYEE };
      const identity = map[String(who)];
      if (identity) (req as unknown as { identity: Identity }).identity = identity;
      next();
    });
    app.use(knowledgeRoutes(ctx()));
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await store.close();
  });

  const call = (path: string, user: string, init: RequestInit = {}) =>
    fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', 'x-test-user': user, ...(init.headers ?? {}) },
    });

  it('列表按身份过滤', async () => {
    const admin = await (await call('/v1/knowledge/docs', 'admin')).json();
    expect(admin.data.map((d: { id: string }) => d.id).sort()).toEqual(['d-east', 'd-general', 'd-public']);

    const emp = await (await call('/v1/knowledge/docs', 'emp')).json();
    expect(emp.data.map((d: { id: string }) => d.id).sort()).toEqual(['d-general', 'd-public']);
  });

  it('列表支持关键字与密级过滤', async () => {
    const byKeyword = await (await call('/v1/knowledge/docs?q=年假', 'admin')).json();
    expect(byKeyword.data).toHaveLength(1);
    expect(byKeyword.data[0].id).toBe('d-general');

    const bySens = await (await call('/v1/knowledge/docs?sensitivity=confidential', 'admin')).json();
    expect(bySens.data.map((d: { id: string }) => d.id)).toEqual(['d-east']);
  });

  it('列表支持分页并返回权限范围内的总数', async () => {
    const res = await call('/v1/knowledge/docs?page=2&pageSize=1', 'admin');
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.pagination).toEqual({ page: 2, pageSize: 1, total: 3, totalPages: 3 });
  });

  it('详情不可见时返回 404（不泄露文档是否存在）', async () => {
    const ok = await call('/v1/knowledge/docs/d-east', 'admin');
    expect(ok.status).toBe(200);
    const denied = await call('/v1/knowledge/docs/d-east', 'ops');
    expect(denied.status).toBe(404);
    const otherTenant = await call('/v1/knowledge/docs/d-other-tenant', 'admin');
    expect(otherTenant.status).toBe(404);
  });

  it('普通用户发起写操作被拒（403）', async () => {
    const res = await call('/v1/knowledge/docs', 'emp', {
      method: 'POST',
      body: JSON.stringify({ title: 'x', content: 'y' }),
    });
    expect(res.status).toBe(403);
  });

  it('写操作返回 202 并生成审批单，且不立即落库', async () => {
    const before = await store.listKnowledgeDocs('t-1');
    const res = await call('/v1/knowledge/docs', 'admin', {
      method: 'POST',
      body: JSON.stringify({
        title: '新制度',
        content: '正文',
        deptId: 'dept-general',
        sensitivity: 'internal',
      }),
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.data.status).toBe('pending');
    expect(body.data.tool).toBe(KB_UPSERT_TOOL);
    expect(body.data.approvalId).toBeTruthy();

    // 审批单已落库，但文档还没写
    const approvals = await store.listApprovals({ tenantId: 't-1', status: 'pending' });
    expect(approvals).toHaveLength(1);
    expect(approvals[0].tool).toBe(KB_UPSERT_TOOL);
    expect(approvals[0].args.title).toBe('新制度');

    const after = await store.listKnowledgeDocs('t-1');
    expect(after.length).toBe(before.length);
  });

  it('标题或正文为空返回 400', async () => {
    const res = await call('/v1/knowledge/docs', 'admin', {
      method: 'POST',
      body: JSON.stringify({ title: '', content: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('非法密级返回 400', async () => {
    const res = await call('/v1/knowledge/docs', 'admin', {
      method: 'POST',
      body: JSON.stringify({ title: 't', content: 'c', sensitivity: 'top-secret' }),
    });
    expect(res.status).toBe(400);
  });

  it('删除同样生成审批单', async () => {
    const res = await call('/v1/knowledge/docs/d-general', 'admin', { method: 'DELETE' });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.data.tool).toBe(KB_DELETE_TOOL);
    expect(body.data.approvalId).toBeTruthy();
  });

  it('删除不存在的文档返回 404', async () => {
    const res = await call('/v1/knowledge/docs/nope', 'admin', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('删除高于自身密级的文档被拒（403）', async () => {
    const res = await call('/v1/knowledge/docs/d-east', 'ops', { method: 'DELETE' });
    expect(res.status).toBe(403);
  });
});

// —— 审批通过后的执行

describe('审批通过后执行知识库写入', () => {
  let store: SqliteMetadataStore;

  beforeEach(async () => {
    store = await seed();
  });

  afterEach(async () => {
    await store.close();
  });

  const fakeCtx = (calls: { userId: string; toolName: string; args: Record<string, unknown> }[]) =>
    ({
      store,
      mcp: {
        call: async (params: {
          identity: Identity;
          toolName: string;
          args: Record<string, unknown>;
        }) => {
          calls.push({ userId: params.identity.userId, toolName: params.toolName, args: params.args });
          return { ok: true, content: '写入成功', structured: {}, traceId: 't' };
        },
      },
      audit: { record: async () => undefined },
    }) as never;

  it('以申请人身份执行 knowledge.upsert_document', async () => {
    const calls: { userId: string; toolName: string; args: Record<string, unknown> }[] = [];
    const approval = {
      id: 'a1',
      tenantId: 't-1',
      userId: 'u-admin',
      sessionId: 'console',
      traceId: 'knowledge-trace',
      tool: KB_UPSERT_TOOL,
      args: { id: 'd-new', title: '新制度', content: '正文', deptId: 'dept-general', sensitivity: 'internal' },
      reason: '控制台写入',
      status: 'approved' as const,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const result = await executeApprovedKnowledgeWrite(fakeCtx(calls), approval, 'u-ops');
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].toolName).toBe(KB_UPSERT_TOOL);
    // owner 记的是**申请人**，不是审批人
    expect(calls[0].userId).toBe('u-admin');
    expect(calls[0].args.title).toBe('新制度');
  });

  it('非知识库写操作不执行', async () => {
    const calls: { userId: string; toolName: string; args: Record<string, unknown> }[] = [];
    const result = await executeApprovedKnowledgeWrite(
      fakeCtx(calls),
      {
        id: 'a2',
        tenantId: 't-1',
        userId: 'u-admin',
        sessionId: 'console',
        traceId: 'x',
        tool: 'some.other.tool',
        args: {},
        reason: '',
        status: 'approved',
        createdAt: '',
      },
      'u-ops',
    );
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
