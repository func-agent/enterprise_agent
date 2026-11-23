import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { SqliteMetadataStore, type Identity } from '@eap/platform-core';
import { adminRoutes } from '../packages/gateway/src/routes/admin.js';
import { gatewayErrorHandler } from '../packages/gateway/src/error-handler.js';
import { KeycloakUserError, KeycloakUserService, type ManagedUser } from '../packages/gateway/src/identity/user-admin.js';

const actor: Identity = {
  tenantId: 't-1', userId: 'admin-1', role: 'platform-admin', deptId: 'd', sensitivity: 'internal', scopes: [], claims: {},
};
const admin2 = makeUser('admin-2', 'eap-ops', 'platform-admin');
const target = makeUser('user-1', 'zhangsan', 'employee');

function makeUser(id: string, username: string, role: string): ManagedUser {
  return {
    id, username, email: `${username}@example.com`, firstName: '三', lastName: '张',
    enabled: true, role, tenantId: 't-1', deptId: 'dept-general', sensitivity: 'internal', serviceAccount: false,
  };
}

describe('用户与权限管理接口', () => {
  let store: SqliteMetadataStore;
  let server: ReturnType<express.Express['listen']>;
  let baseUrl: string;
  let users: ManagedUser[];
  let audits: { reason: string; detail: unknown }[];
  let service: {
    list: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    setEnabled: ReturnType<typeof vi.fn>;
    resetPassword: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    store = new SqliteMetadataStore(':memory:');
    await store.init();
    await store.upsertTenant({ id: 't-1', name: '测试租户', models: [], tools: [], knowledgeBases: [], monthlyBudgetUsd: 10, monthlyTokenBudget: 1000, enabled: true });
    users = [makeUser('admin-1', 'eap-admin', 'platform-admin'), { ...admin2 }, { ...target }];
    audits = [];
    service = {
      list: vi.fn(async () => users),
      get: vi.fn(async (id: string) => {
        const user = users.find((item) => item.id === id);
        if (!user) throw new KeycloakUserError(404, 'user_not_found', '用户不存在');
        return user;
      }),
      create: vi.fn(async (input) => {
        const user = { ...makeUser('created-1', input.username, input.role), deptId: input.deptId };
        users.push(user);
        return { user, password: 'one-time-create-secret' };
      }),
      update: vi.fn(async (id: string, input) => {
        const user = users.find((item) => item.id === id)!;
        Object.assign(user, input);
        return { user, sessionRevoked: true };
      }),
      setEnabled: vi.fn(async (id: string, enabled: boolean) => {
        const user = users.find((item) => item.id === id)!;
        user.enabled = enabled;
        return { user, sessionRevoked: !enabled };
      }),
      resetPassword: vi.fn(async () => ({ password: 'one-time-reset-secret', sessionRevoked: true })),
      remove: vi.fn(async (id: string) => { users = users.filter((item) => item.id !== id); }),
    };
    const ctx = {
      store,
      userAdmin: service,
      audit: { record: async (event) => { audits.push(event); }, list: async () => [], reconstruct: async () => ({}) },
      budget: { summary: async () => ({}) },
      policy: { list: () => [], replaceAll: () => undefined },
      router: { listVirtualModels: async () => [] },
      mcp: { call: async () => ({ ok: true }) },
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const role = String(req.headers['x-test-role'] ?? 'platform-admin');
      const userId = String(req.headers['x-test-user'] ?? actor.userId);
      req.identity = { ...actor, role, userId };
      next();
    });
    app.use(adminRoutes(ctx as never));
    app.use(gatewayErrorHandler);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.close();
  });

  async function call(path: string, init: RequestInit = {}, role = 'platform-admin', userId = actor.userId): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-test-role': role, 'x-test-user': userId, ...(init.headers ?? {}) },
    });
  }

  function validInput(username = 'new-user'): Record<string, unknown> {
    return {
      username, email: `${username}@example.com`, firstName: '三', lastName: '张',
      role: 'employee', tenantId: 't-1', deptId: 'dept-general', sensitivity: 'internal',
    };
  }

  it('仅 platform-admin 可以访问用户管理接口', async () => {
    expect((await call('/v1/admin/users', {}, 'admin')).status).toBe(403);
    expect((await call('/v1/admin/users', { method: 'POST', body: JSON.stringify(validInput()) }, 'employee')).status).toBe(403);
    expect((await call('/v1/admin/users/user-1', { method: 'DELETE' }, 'manager')).status).toBe(403);
  });

  it('创建用户只返回一次随机密码，审计不记录密码', async () => {
    const invalid = await call('/v1/admin/users', { method: 'POST', body: JSON.stringify({ ...validInput(), tenantId: 't-missing' }) });
    expect(invalid.status).toBe(400);
    const response = await call('/v1/admin/users', { method: 'POST', body: JSON.stringify(validInput()) });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.data.username).toBe('new-user');
    expect(body.password).toBe('one-time-create-secret');
    expect(service.create).toHaveBeenCalledOnce();
    expect(JSON.stringify(audits)).not.toContain('one-time-create-secret');
    expect(audits.some((event) => event.reason === 'user.create')).toBe(true);
  });

  it('禁止修改自己的角色、停用自己或删除自己', async () => {
    expect((await call('/v1/admin/users/admin-1', {
      method: 'PUT', body: JSON.stringify({ ...validInput('eap-admin'), role: 'admin' }),
    })).status).toBe(409);
    expect((await call('/v1/admin/users/admin-1', {
      method: 'PATCH', body: JSON.stringify({ enabled: false }),
    })).status).toBe(409);
    expect((await call('/v1/admin/users/admin-1', { method: 'DELETE' })).status).toBe(409);
    expect(service.update).not.toHaveBeenCalled();
    expect(service.setEnabled).not.toHaveBeenCalled();
    expect(service.remove).not.toHaveBeenCalled();
  });

  it('禁止移除最后一个启用中的平台管理员', async () => {
    users = users.filter((user) => user.id !== 'admin-2');
    const demote = await call('/v1/admin/users/admin-1', {
      method: 'PUT', body: JSON.stringify({ ...validInput('eap-admin'), role: 'admin' }),
    }, 'platform-admin', 'another-admin');
    expect(demote.status).toBe(409);
    expect((await call('/v1/admin/users/admin-1', {
      method: 'PATCH', body: JSON.stringify({ enabled: false }),
    }, 'platform-admin', 'another-admin')).status).toBe(409);
    expect((await call('/v1/admin/users/admin-1', { method: 'DELETE' }, 'platform-admin', 'another-admin')).status).toBe(409);
  });

  it('允许删除已停用的非启用中平台管理员', async () => {
    users = users.map((user) => user.id === 'admin-2' ? { ...user, enabled: false } : user);

    const response = await call('/v1/admin/users/admin-2', { method: 'DELETE' });

    expect(response.status).toBe(200);
    expect(service.remove).toHaveBeenCalledWith('admin-2');
    expect(users.some((user) => user.id === 'admin-2')).toBe(false);
  });

  it('允许降级已停用的非启用中平台管理员', async () => {
    users = users.map((user) => user.id === 'admin-2' ? { ...user, enabled: false } : user);

    const response = await call('/v1/admin/users/admin-2', {
      method: 'PUT', body: JSON.stringify({ ...validInput('eap-ops'), role: 'manager' }),
    });

    expect(response.status).toBe(200);
    expect(service.update).toHaveBeenCalledWith('admin-2', expect.objectContaining({ role: 'manager' }));
    expect(users.find((user) => user.id === 'admin-2')).toMatchObject({ role: 'manager', enabled: false });
  });

  it('意外的内部异常返回 500 而不是让请求挂起或暴露内部细节', async () => {
    // 模拟 Keycloak 连接异常这类不属于 KeycloakUserError 的失败
    service.list.mockRejectedValueOnce(new Error('模拟 Keycloak 连接失败'));
    const response = await call('/v1/admin/users');
    expect(response.status).toBe(500);
    const payload = await response.json();
    expect(payload).toEqual({ error: 'internal_error', message: '服务内部错误' });
    expect(JSON.stringify(payload)).not.toContain('模拟 Keycloak 连接失败');
  });

  it('支持修改、启停、重置密码和删除，并完整记录非敏感审计', async () => {
    const updated = await call('/v1/admin/users/user-1', {
      method: 'PUT', body: JSON.stringify({ ...validInput('zhangsan'), email: 'updated@example.com', role: 'manager', deptId: 'dept-finance' }),
    });
    expect(updated.status).toBe(200);
    expect(service.update).toHaveBeenCalledWith('user-1', expect.objectContaining({ role: 'manager', deptId: 'dept-finance' }));
    expect(audits.find((event) => event.reason === 'user.update')?.detail).toMatchObject({ emailChanged: true });

    expect((await call('/v1/admin/users/user-1', { method: 'PATCH', body: JSON.stringify({ enabled: false }) })).status).toBe(200);
    const reset = await call('/v1/admin/users/user-1/reset-password', { method: 'POST' });
    expect(reset.status).toBe(200);
    expect((await reset.json()).password).toBe('one-time-reset-secret');
    expect((await call('/v1/admin/users/user-1', { method: 'DELETE' })).status).toBe(200);
    expect(service.remove).toHaveBeenCalledWith('user-1');
    expect(JSON.stringify(audits)).not.toContain('one-time-reset-secret');
    for (const action of ['user.update', 'user.disable', 'user.password.reset', 'user.delete']) {
      expect(audits.some((event) => event.reason === action)).toBe(true);
    }
  });
});

describe('Keycloak 用户服务', () => {
  it('创建和修改时回读属性，并保留其它属性及注销会话', async () => {
    const calls: { url: string; method: string; body?: unknown }[] = [];
    let logoutCount = 0;
    const raw = {
      id: 'user-1', username: 'zhangsan', email: 'old@example.com', firstName: '三', lastName: '张', enabled: true,
      attributes: { custom: ['keep'], role: ['employee'], tenant_id: ['t-1'], dept_id: ['dept-general'], sensitivity: ['internal'] },
    };
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body && String(init.body).startsWith('{') ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      if (url.includes('/protocol/openid-connect/token')) return Response.json({ access_token: 'token', expires_in: 300 });
      if (url.includes('/users/user-1/logout')) { logoutCount++; return new Response(null, { status: 204 }); }
      if (url.includes('/users?username=zhangsan')) return Response.json([raw]);
      if (url.endsWith('/users/user-1') && method === 'PUT') { Object.assign(raw, body); return new Response(null, { status: 204 }); }
      if (url.endsWith('/users/user-1')) return Response.json(raw);
      if (url.endsWith('/users?first=0&max=200')) return Response.json([raw, { id: 'svc', username: 'service-account-eap-agent', serviceAccountClientId: 'eap-agent' }]);
      throw new Error(`未处理的请求 ${method} ${url}`);
    };
    const service = new KeycloakUserService({ baseUrl: 'http://keycloak', realm: 'enterprise', clientId: 'eap-gateway', clientSecret: 'secret', fetchImpl: fetchImpl as typeof fetch });
    const result = await service.update('user-1', {
      email: 'new@example.com', firstName: '三', lastName: '张', role: 'manager', tenantId: 't-1', deptId: 'dept-finance', sensitivity: 'internal',
    });
    expect(result.user.role).toBe('manager');
    expect(result.sessionRevoked).toBe(true);
    expect(raw.attributes.custom).toEqual(['keep']);
    expect(raw.attributes.dept_id).toEqual(['dept-finance']);
    expect(logoutCount).toBe(1);
    expect((await service.list()).map((user) => user.username)).toEqual(['zhangsan']);
    expect(calls.some((call) => call.url.includes('/protocol/openid-connect/token'))).toBe(true);
  });

  it('属性写入被丢弃时删除不完整的新账号并报错', async () => {
    let deleted = false;
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.includes('/protocol/openid-connect/token')) return Response.json({ access_token: 'token', expires_in: 300 });
      if (url.endsWith('/users') && method === 'POST') return new Response(null, { status: 201 });
      if (url.includes('/users?username=new-user')) return Response.json([{ id: 'new-id', username: 'new-user', attributes: {} }]);
      if (url.endsWith('/users/new-id') && method === 'DELETE') { deleted = true; return new Response(null, { status: 204 }); }
      throw new Error(`未处理的请求 ${method} ${url}`);
    };
    const service = new KeycloakUserService({ baseUrl: 'http://keycloak', realm: 'enterprise', clientId: 'eap-gateway', clientSecret: 'secret', fetchImpl: fetchImpl as typeof fetch });
    await expect(service.create({
      username: 'new-user', email: 'new@example.com', firstName: '三', lastName: '张', role: 'employee', tenantId: 't-1', deptId: 'dept-general', sensitivity: 'internal',
    })).rejects.toMatchObject({ code: 'attribute_write_mismatch' });
    expect(deleted).toBe(true);
  });

  it('用户列表按页读取全部人员而不是只取前 1000 人', async () => {
    const all = Array.from({ length: 205 }, (_, index) => ({
      id: `user-${index}`,
      username: `user-${String(index).padStart(3, '0')}`,
      enabled: true,
      attributes: {},
    }));
    const offsets: number[] = [];
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes('/protocol/openid-connect/token')) return Response.json({ access_token: 'token', expires_in: 300 });
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/users')) {
        const first = Number(parsed.searchParams.get('first'));
        const max = Number(parsed.searchParams.get('max'));
        offsets.push(first);
        return Response.json(all.slice(first, first + max));
      }
      throw new Error(`未处理的请求 ${url}`);
    };
    const service = new KeycloakUserService({ baseUrl: 'http://keycloak', realm: 'enterprise', clientId: 'eap-gateway', clientSecret: 'secret', fetchImpl: fetchImpl as typeof fetch });
    const users = await service.list();
    expect(users).toHaveLength(205);
    expect(users[0].username).toBe('user-000');
    expect(users.at(-1)?.username).toBe('user-204');
    expect(offsets).toEqual([0, 200]);
  });
});
