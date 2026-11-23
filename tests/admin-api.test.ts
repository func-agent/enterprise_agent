import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { SqliteMetadataStore, type Identity } from '@eap/platform-core';
import { adminRoutes } from '../packages/gateway/src/routes/admin.js';
import { KB_UPSERT_TOOL } from '../packages/gateway/src/routes/knowledge.js';

const identities: Record<string, Identity> = {
  admin: { tenantId: 't-1', userId: 'u-admin', role: 'platform-admin', deptId: 'd', sensitivity: 'internal', scopes: [], claims: {} },
  admin2: { tenantId: 't-1', userId: 'u-admin-2', role: 'platform-admin', deptId: 'd', sensitivity: 'internal', scopes: [], claims: {} },
  manager: { tenantId: 't-1', userId: 'u-manager', role: 'manager', deptId: 'd', sensitivity: 'internal', scopes: [], claims: {} },
  manager2: { tenantId: 't-1', userId: 'u-manager-2', role: 'manager', deptId: 'd', sensitivity: 'internal', scopes: [], claims: {} },
  employee: { tenantId: 't-1', userId: 'u-employee', role: 'employee', deptId: 'd', sensitivity: 'internal', scopes: [], claims: {} },
  other: { tenantId: 't-2', userId: 'u-other', role: 'manager', deptId: 'd', sensitivity: 'internal', scopes: [], claims: {} },
};

describe('管理接口授权与审批状态迁移', () => {
  let store: SqliteMetadataStore;
  let server: ReturnType<express.Express['listen']>;
  let baseUrl: string;
  let mcpCalls: number;

  beforeEach(async () => {
    store = new SqliteMetadataStore(':memory:');
    await store.init();
    mcpCalls = 0;
    const ctx = {
      store,
      budget: { summary: async () => ({}) },
      audit: {
        record: async () => undefined,
        list: async () => [],
        reconstruct: async () => ({ events: [], traces: [] }),
      },
      policy: { list: () => [], replaceAll: () => undefined },
      router: { listVirtualModels: async () => [] },
      mcp: {
        call: async () => {
          mcpCalls++;
          return { ok: true, content: 'ok', traceId: 'trace' };
        },
      },
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const identity = identities[String(req.headers['x-test-user'])];
      if (identity) req.identity = identity;
      next();
    });
    app.use(adminRoutes(ctx as never));
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.close();
  });

  async function call(path: string, user: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-test-user': user, ...(init.headers ?? {}) },
    });
  }

  async function createApproval(id: string, tenantId = 't-1'): Promise<void> {
    await store.createApproval({
      id,
      tenantId,
      userId: 'u-admin',
      sessionId: 'console',
      traceId: `trace-${id}`,
      tool: KB_UPSERT_TOOL,
      args: { id: `doc-${id}`, title: 'title', content: 'content', deptId: 'd', sensitivity: 'internal' },
      reason: 'test',
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
  }

  it('普通员工不能读取管理接口', async () => {
    for (const path of ['/v1/admin/tenants', '/v1/admin/policies', '/v1/admin/agents', '/v1/admin/audit', '/v1/admin/traces']) {
      const res = await call(path, 'employee');
      expect(res.status, path).toBe(403);
    }
  });

  it('普通员工读审批列表只能拿到自己发起的单', async () => {
    // 别人发起的单：看不到
    await createApproval('by-admin');
    // 自己发起的单：对话页据此展示「等待人工确认」的只读状态。
    await store.createApproval({
      id: 'by-employee',
      tenantId: 't-1',
      userId: 'u-employee',
      sessionId: 'console',
      traceId: 'trace-by-employee',
      tool: KB_UPSERT_TOOL,
      args: { id: 'doc-mine', title: 't', content: 'c', deptId: 'd', sensitivity: 'internal' },
      reason: 'test',
      status: 'pending',
      createdAt: new Date().toISOString(),
    });

    const res = await call('/v1/admin/approvals', 'employee');
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = (body.data as { id: string }[]).map((a) => a.id);
    expect(ids).toContain('by-employee');
    expect(ids).not.toContain('by-admin');
  });

  it('主管可以查看审批但不能读取平台策略', async () => {
    expect((await call('/v1/admin/approvals', 'manager')).status).toBe(200);
    expect((await call('/v1/admin/policies', 'manager')).status).toBe(403);
  });

  it('跨租户审批按不存在处理且状态不变', async () => {
    await createApproval('cross-tenant');
    const res = await call('/v1/admin/approvals/cross-tenant/decide', 'other', {
      method: 'POST',
      body: JSON.stringify({ decision: 'approved' }),
    });
    expect(res.status).toBe(404);
    expect((await store.getApproval('cross-tenant'))?.status).toBe('pending');
    expect(mcpCalls).toBe(0);
  });

  it('审批只能处理一次，知识库写入不会重复执行', async () => {
    await createApproval('once');
    const approved = await call('/v1/admin/approvals/once/decide', 'manager', {
      method: 'POST',
      body: JSON.stringify({ decision: 'approved' }),
    });
    expect(approved.status).toBe(200);
    const repeated = await call('/v1/admin/approvals/once/decide', 'manager2', {
      method: 'POST',
      body: JSON.stringify({ decision: 'rejected' }),
    });
    expect(repeated.status).toBe(409);
    expect((await store.getApproval('once'))?.status).toBe('approved');
    expect(mcpCalls).toBe(1);
  });

  it('并发审批只有一个请求完成状态迁移', async () => {
    await createApproval('concurrent');
    const responses = await Promise.all([
      call('/v1/admin/approvals/concurrent/decide', 'manager', {
        method: 'POST',
        body: JSON.stringify({ decision: 'approved' }),
      }),
      call('/v1/admin/approvals/concurrent/decide', 'manager2', {
        method: 'POST',
        body: JSON.stringify({ decision: 'approved' }),
      }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(mcpCalls).toBe(1);
  });
});
