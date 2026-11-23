import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import {
  SqliteMetadataStore,
  corsMiddleware,
  type Identity,
  type Tenant,
  type VirtualModel,
} from '@eap/platform-core';
import { LlmRouter } from '../packages/gateway/src/llm/router.js';
import { ModelConfigError, orderRouteTargets, parseVirtualModel } from '../packages/gateway/src/llm/model-config.js';
import { ProviderError, type ProviderChatInput } from '../packages/gateway/src/llm/providers.js';
import { adminRoutes } from '../packages/gateway/src/routes/admin.js';
import { chatRoutes } from '../packages/gateway/src/routes/chat.js';

const identity: Identity = {
  tenantId: 't-test', userId: 'admin', role: 'platform-admin', deptId: 'd-test',
  sensitivity: 'internal', scopes: [], claims: {},
};

const tenant: Tenant = {
  id: 't-test', name: '测试租户', models: [], tools: [], knowledgeBases: [],
  monthlyBudgetUsd: 0, monthlyTokenBudget: 0, enabled: true,
};

function model(name = 'weighted-model'): VirtualModel {
  return {
    name,
    description: '加权路由测试',
    scenarios: ['测试'],
    enabled: true,
    targets: [
      { provider: 'minimax', model: 'model-a', account: 'default', role: 'primary', weight: 80 },
      { provider: 'minimax', model: 'model-b', account: 'acct-2', role: 'primary', weight: 20, maxTokens: 2048 },
      { provider: 'deepseek', model: 'model-c', role: 'fallback' },
    ],
  };
}

describe('模型配置校验与加权路由', () => {
  it('规范化目标并保留输出上限', () => {
    expect(parseVirtualModel(model())).toEqual(model());
  });

  it.each([
    [{ ...model(), name: 'Invalid Name' }, '虚拟模型名'],
    [{ ...model(), targets: [] }, '路由目标数量'],
    [{ ...model(), targets: [{ provider: 'tei', model: 'embed', role: 'primary' }, ...model().targets] }, '不能与对话目标混用'],
    [{ ...model(), targets: [{ ...model().targets[0], weight: -1 }] }, '权重'],
    [{ ...model(), targets: [{ ...model().targets[0], maxTokens: 0 }] }, 'maxTokens'],
  ])('拒绝非法模型配置 %#', (input, message) => {
    expect(() => parseVirtualModel(input)).toThrow(message ?? undefined);
  });

  it('一次列出全部校验问题，而不是只报第一个', () => {
    let caught: unknown;
    try {
      parseVirtualModel({
        name: 'Invalid Name',
        targets: [],
        scenarios: 'not-an-array',
        enabled: 'not-a-boolean',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ModelConfigError);
    const issues = (caught as ModelConfigError).issues;
    expect(issues.length).toBeGreaterThanOrEqual(4);
    const joined = issues.join('；');
    expect(joined).toContain('虚拟模型名');
    expect(joined).toContain('路由目标数量');
    expect(joined).toContain('适用场景');
    expect(joined).toContain('enabled');
    expect((caught as ModelConfigError).message).toContain('项需要修正');
  });

  it('主用目标按相对权重选取，其余目标仍用于故障转移', () => {
    expect(orderRouteTargets(model().targets, () => 0).map((target) => target.model))
      .toEqual(['model-a', 'model-b', 'model-c']);
    expect(orderRouteTargets(model().targets, () => 0.85).map((target) => target.model))
      .toEqual(['model-b', 'model-a', 'model-c']);
    expect(orderRouteTargets(model().targets, () => 0.99).map((target) => target.model))
      .toEqual(['model-b', 'model-a', 'model-c']);
  });

  it('未设置权重的主用目标保持固定顺序', () => {
    const targets = model().targets.map(({ weight: _weight, ...target }) => target);
    expect(orderRouteTargets(targets, () => 0.99)).toEqual(targets);
  });

  it('实际路由使用加权目标，并在失败时继续尝试', async () => {
    const store = new SqliteMetadataStore(':memory:');
    await store.init();
    await store.upsertTenant(tenant);
    await store.upsertVirtualModel(model());
    const attempts: { model: string; account?: string; maxTokens: number }[] = [];
    const adapter = {
      name: 'minimax',
      protocol: 'openai',
      chat: async (input: ProviderChatInput) => {
        attempts.push({ model: input.model, account: input.account, maxTokens: input.maxTokens });
        if (input.account === 'acct-2') throw new ProviderError('账号故障', 503, false, 'minimax');
        return { content: 'ok', toolCalls: [], promptTokens: 1, completionTokens: 1 };
      },
    };
    const router = new LlmRouter(
      { get: () => adapter } as never,
      { check: async () => ({ allowed: true, action: 'none' }), record: async () => undefined } as never,
      { evaluate: () => ({ allowed: true, matched: [] }) } as never,
      {
        apply: ({ text }: { text: string }) => ({ text, blocked: false, piiHits: [] }),
        maskOutput: (text: string) => ({ text }),
      } as never,
      { record: async () => undefined } as never,
      store,
      () => 0.85,
    );
    try {
      const result = await router.chat({ model: model().name, messages: [{ role: 'user', content: 'hello' }] }, identity);
      expect(result.account).toBe('default');
      expect(result.failover).toHaveLength(1);
      expect(attempts).toEqual([
        { model: 'model-b', account: 'acct-2', maxTokens: 2048 },
        { model: 'model-a', account: 'default', maxTokens: 4096 },
      ]);
    } finally {
      await store.close();
    }
  });
});

describe('模型管理 API', () => {
  let store: SqliteMetadataStore;
  let server: ReturnType<express.Express['listen']>;
  let baseUrl: string;
  let audits: string[];

  beforeEach(async () => {
    store = new SqliteMetadataStore(':memory:');
    await store.init();
    audits = [];
    const providers = [
      { name: 'minimax', protocol: 'openai', baseUrl: 'https://example.test/v1', accounts: ['default', 'acct-2'] },
      { name: 'deepseek', protocol: 'openai', baseUrl: 'https://example.test/v1', accounts: ['default'] },
      { name: 'tei', protocol: 'tei', baseUrl: 'http://127.0.0.1:6380', accounts: ['default'] },
    ];
    const ctx = {
      store,
      providers: { describe: () => providers },
      budget: { summary: async () => ({}) },
      audit: {
        record: async (event: { reason: string }) => { audits.push(event.reason); },
        list: async () => [], reconstruct: async () => ({}),
      },
      policy: { list: () => [], replaceAll: () => undefined },
      router: { listVirtualModels: () => store.listVirtualModels() },
      mcp: { call: async () => ({ ok: true }) },
    };
    const app = express();
    app.use(corsMiddleware);
    app.use(express.json());
    app.use((req, _res, next) => {
      if (req.headers['x-test-user'] === 'admin') req.identity = identity;
      if (req.headers['x-test-user'] === 'employee') req.identity = { ...identity, role: 'employee' };
      next();
    });
    app.use(adminRoutes(ctx as never));
    app.use(chatRoutes(ctx as never));
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.close();
  });

  function call(path: string, init: RequestInit = {}, user = 'admin'): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-test-user': user, ...(init.headers ?? {}) },
    });
  }

  it('支持新增、查询、修改、启停和删除，并记录审计', async () => {
    const created = await call('/v1/admin/models', { method: 'POST', body: JSON.stringify(model()) });
    expect(created.status).toBe(201);
    expect((await created.json()).data).toEqual(model());
    expect((await call('/v1/admin/models', { method: 'POST', body: JSON.stringify(model()) })).status).toBe(409);

    const listing = await (await call('/v1/admin/models')).json();
    expect(listing.data).toHaveLength(1);
    expect(listing.providers).toHaveLength(3);
    expect(listing.defaultModel).toBe('smart-model');
    expect(JSON.stringify(listing)).not.toContain('apiKey');

    const changed = { ...model(), description: '已修改', targets: [...model().targets].reverse() };
    expect((await call(`/v1/admin/models/${model().name}`, { method: 'PUT', body: JSON.stringify(changed) })).status).toBe(200);
    expect((await store.getVirtualModel(model().name))?.description).toBe('已修改');

    const disabled = await call(`/v1/admin/models/${model().name}`, { method: 'PATCH', body: JSON.stringify({ enabled: false }) });
    expect((await disabled.json()).data.enabled).toBe(false);
    expect((await call(`/v1/admin/models/${model().name}`, { method: 'DELETE' })).status).toBe(200);
    expect(await store.getVirtualModel(model().name)).toBeUndefined();
    expect(audits).toEqual(['model.create', 'model.update', 'model.disable', 'model.delete']);
  });

  it('OpenAI 模型列表不包含禁用或租户白名单外的模型', async () => {
    await store.upsertTenant({ ...tenant, models: [model().name] });
    await store.upsertVirtualModel({ ...model(), enabled: false });
    await store.upsertVirtualModel(model('other-model'));
    expect((await (await call('/v1/models')).json()).data).toEqual([]);
    await store.upsertVirtualModel(model());
    const visible = await (await call('/v1/models')).json();
    expect(visible.data.map((item: { id: string }) => item.id)).toEqual([model().name]);
  });

  it('跨域预检允许模型启停使用的 PATCH 方法', async () => {
    const response = await call(`/v1/admin/models/${model().name}`, {
      method: 'OPTIONS',
      headers: { origin: 'http://127.0.0.1:5173', 'access-control-request-method': 'PATCH' },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-methods')).toContain('PATCH');
  });

  it('拒绝越权写入、未知 Provider 和账号别名', async () => {
    expect((await call('/v1/admin/models', { method: 'POST', body: JSON.stringify(model()) }, 'employee')).status).toBe(403);
    const unknown = { ...model(), targets: [{ provider: 'unknown', model: 'x', role: 'primary' }] };
    expect((await call('/v1/admin/models', { method: 'POST', body: JSON.stringify(unknown) })).status).toBe(400);
    const account = { ...model(), targets: [{ ...model().targets[0], account: 'acct-9' }] };
    const response = await call('/v1/admin/models', { method: 'POST', body: JSON.stringify(account) });
    expect(response.status).toBe(400);
    expect((await response.json()).message).toContain('acct-9');
  });

  it('默认模型不能通过编辑、启停或删除操作变为不可用', async () => {
    const current = model('smart-model');
    await store.upsertVirtualModel(current);

    const edited = await call('/v1/admin/models/smart-model', {
      method: 'PUT', body: JSON.stringify({ ...current, enabled: false }),
    });
    const disabled = await call('/v1/admin/models/smart-model', {
      method: 'PATCH', body: JSON.stringify({ enabled: false }),
    });
    const deleted = await call('/v1/admin/models/smart-model', { method: 'DELETE' });

    for (const response of [edited, disabled, deleted]) {
      expect(response.status).toBe(409);
      expect((await response.json()).error).toBe('default_model_in_use');
    }
    expect((await store.getVirtualModel('smart-model'))?.enabled).toBe(true);
    expect(audits).toEqual([]);
  });

  it('默认模型不存在时也不允许以禁用状态创建', async () => {
    const created = await call('/v1/admin/models', {
      method: 'POST', body: JSON.stringify({ ...model('smart-model'), enabled: false }),
    });
    expect(created.status).toBe(409);
    expect((await created.json()).error).toBe('default_model_in_use');
    expect(await store.getVirtualModel('smart-model')).toBeUndefined();
  });

  it('删除前检查租户白名单引用', async () => {
    await store.upsertVirtualModel(model());
    await store.upsertTenant({ ...tenant, models: [model().name] });
    const blocked = await call(`/v1/admin/models/${model().name}`, { method: 'DELETE' });
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).tenants).toEqual([tenant.id]);
    await store.upsertTenant(tenant);
    expect((await call(`/v1/admin/models/${model().name}`, { method: 'DELETE' })).status).toBe(200);
  });
});
