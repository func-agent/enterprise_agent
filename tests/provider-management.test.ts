import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.EAP_CREDENTIAL_MASTER_KEY = 'provider-management-test-master-key';
});

import express from 'express';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { decryptSecret, SqliteMetadataStore, type Identity, type ProviderDefinition } from '@eap/platform-core';
import { CredentialService } from '../packages/gateway/src/llm/credentials.js';
import { ProviderRegistry } from '../packages/gateway/src/llm/providers.js';
import {
  ProviderConfigError,
  parseProviderDefinition,
  normalizeProviderBaseUrl,
} from '../packages/gateway/src/llm/provider-config.js';
import { adminRoutes } from '../packages/gateway/src/routes/admin.js';

const identity: Identity = {
  tenantId: 't-test', userId: 'admin', role: 'platform-admin', deptId: 'd-test',
  sensitivity: 'internal', scopes: [], claims: {},
};
const requests: { url: string; authorization?: string; apiKey?: string; body?: string }[] = [];
const vendor = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    requests.push({
      url: req.url ?? '',
      authorization: typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
      apiKey: typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : undefined,
      body: body || undefined,
    });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') {
      res.end(JSON.stringify({ data: [{ id: 'acme-chat' }] }));
      return;
    }
    if (req.url === '/v1/chat/completions') {
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });
});
let vendorBaseUrl = '';

beforeAll(async () => {
  vendor.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => vendor.once('listening', resolve));
  vendorBaseUrl = `http://127.0.0.1:${(vendor.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => vendor.close(() => resolve()));
});

beforeEach(() => {
  requests.length = 0;
});

function definition(name = 'acme'): ProviderDefinition {
  const now = new Date().toISOString();
  return {
    name, baseUrl: vendorBaseUrl, protocol: 'openai', authMode: 'x-api-key',
    accounts: ['default', 'acct-2'], enabled: true,
    createdAt: now, updatedAt: now, updatedBy: 'admin',
  };
}

describe('自定义 Provider 参数校验', () => {
  it('接受公网 HTTPS 与内网 HTTP 地址', () => {
    expect(normalizeProviderBaseUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1');
    expect(normalizeProviderBaseUrl('http://127.0.0.1:8000/v1')).toBe('http://127.0.0.1:8000/v1');
    expect(normalizeProviderBaseUrl('http://vllm:8000/v1')).toBe('http://vllm:8000/v1');
  });

  it.each([
    'http://api.example.com/v1',
    'ftp://api.example.com/v1',
    'https://user:password@api.example.com/v1',
    'https://api.example.com/v1?apiKey=secret',
    'http://169.254.169.254/latest/meta-data',
    'http://0.0.0.0:8000/v1',
  ])('拒绝不安全地址 %s', (value) => {
    expect(() => normalizeProviderBaseUrl(value)).toThrow();
  });

  it('校验协议、认证方式和账号池', () => {
    const parsed = parseProviderDefinition(definition());
    expect(parsed.accounts).toEqual(['default', 'acct-2']);
    expect(() => parseProviderDefinition({ ...definition(), protocol: 'custom' })).toThrow('协议');
    expect(() => parseProviderDefinition({ ...definition(), accounts: ['acct-2'] })).toThrow('default');
    expect(() => parseProviderDefinition({ ...definition(), accounts: ['default', 'default'] })).toThrow('重复');
  });

  it('一次列出全部校验问题，而不是只报第一个', () => {
    // 一次性提交多个非法字段 —— 应当一次把所有问题都列出来，
    // 避免用户改一个提交一次、来回试好几轮。
    let caught: unknown;
    try {
      parseProviderDefinition({
        name: '',
        protocol: 'custom',
        authMode: 'nope',
        enabled: 'yes',
        accounts: [],
        baseUrl: 'http://api.example.com/v1',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderConfigError);
    const issues = (caught as ProviderConfigError).issues;
    expect(issues.length).toBeGreaterThanOrEqual(5);
    const joined = issues.join('；');
    expect(joined).toContain('Provider 名');
    expect(joined).toContain('协议');
    expect(joined).toContain('认证方式');
    expect(joined).toContain('enabled');
    expect(joined).toContain('账号池');
    expect(joined).toContain('BASE_URL');
    // message 里带抬头 + 换行分隔，界面能一行一条地展示
    expect((caught as ProviderConfigError).message).toContain('项需要修正');
    expect((caught as ProviderConfigError).message.split('\n').length).toBeGreaterThan(1);
  });
});

describe('动态 Provider 注册表与账号池', () => {
  it('热加载配置，按账号使用独立密钥，并在重启后恢复', async () => {
    const store = new SqliteMetadataStore(':memory:');
    await store.init();
    const credentials = new CredentialService(store);
    await credentials.start();
    const providers = new ProviderRegistry(credentials, store);
    const restarted = new ProviderRegistry(credentials, store);
    try {
      await providers.saveDefinition(definition());
      expect(providers.get('acme')).toBeDefined();
      expect(providers.getDefinition('acme')?.source).toBe('console');
      await credentials.set('acme', 'test-key-default', 'admin');
      await credentials.set('acme', 'test-key-second', 'admin', 'acct-2');
      expect(credentials.view('acme#acct-2').account).toBe('acct-2');
      const stored = await store.getProviderCredential('acme#acct-2');
      expect(stored?.secretCipher).not.toContain('test-key-second');
      expect(decryptSecret(stored!.secretCipher, 'provider-management-test-master-key')).toBe('test-key-second');

      const result = await providers.get('acme')!.chat({
        model: 'acme-chat', messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 128, timeoutMs: 2_000, account: 'default',
      });
      expect(result.content).toBe('ok');
      expect(requests[0]).toMatchObject({ url: '/v1/chat/completions', apiKey: 'test-key-default' });
      const probe = await providers.test('acme', 'acct-2');
      expect(probe.ok).toBe(true);
      expect(requests[1]).toMatchObject({ url: '/v1/models', apiKey: 'test-key-second' });

      await restarted.start();
      expect(restarted.get('acme')).toBeDefined();
      expect(restarted.getDefinition('acme')?.accounts).toEqual(['default', 'acct-2']);
      await providers.saveDefinition({ ...definition(), enabled: false });
      expect(providers.get('acme')).toBeUndefined();
      expect((await providers.test('acme')).ok).toBe(false);
      expect(await providers.removeDefinition('acme')).toBe(true);
      expect(providers.has('acme')).toBe(false);
    } finally {
      providers.stop();
      restarted.stop();
      await credentials.stop();
      await store.close();
    }
  });

  it('环境变量备用账号显示正确来源，且没有默认 Key 时仍优先使用备用账号', async () => {
    process.env.MINIMAX_PUBLIC_API_KEY_2 = 'env-second-key';
    const store = new SqliteMetadataStore(':memory:');
    await store.init();
    const credentials = new CredentialService(store);
    const providers = new ProviderRegistry(credentials);
    try {
      await credentials.start();
      const account = credentials.list().find((item) => item.provider === 'minimax-public' && item.account === 'acct-2');
      expect(account).toMatchObject({ source: 'env', configured: true });
      expect(providers.getDefinition('minimax-public')?.accounts[0]).toBe('acct-2');
    } finally {
      delete process.env.MINIMAX_PUBLIC_API_KEY_2;
      await credentials.stop();
      await store.close();
    }
  });
});

describe('自定义 Provider 管理 API', () => {
  async function withServer(run: (call: (path: string, init?: RequestInit, user?: string) => Promise<Response>, store: SqliteMetadataStore) => Promise<void>): Promise<void> {
    const store = new SqliteMetadataStore(':memory:');
    await store.init();
    const credentials = new CredentialService(store);
    await credentials.start();
    const providers = new ProviderRegistry(credentials, store);
    await providers.start();
    const audits: { reason: string; detail: Record<string, unknown> }[] = [];
    const ctx = {
      store, credentials, providers,
      budget: { summary: async () => ({}) },
      audit: { record: async (event: { reason: string; detail: Record<string, unknown> }) => { audits.push(event); }, list: async () => [], reconstruct: async () => ({}) },
      policy: { list: () => [], replaceAll: () => undefined },
      router: { listVirtualModels: () => store.listVirtualModels() },
      mcp: { call: async () => ({ ok: true }) },
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (req.headers['x-test-user'] === 'admin') req.identity = identity;
      if (req.headers['x-test-user'] === 'employee') req.identity = { ...identity, role: 'employee' };
      next();
    });
    app.use(adminRoutes(ctx as never));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = (path: string, init: RequestInit = {}, user = 'admin') => fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-test-user': user, ...(init.headers ?? {}) },
    });
    try {
      await run(call, store);
      expect(JSON.stringify(audits)).not.toContain('test-key-second');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      providers.stop();
      await credentials.stop();
      await store.close();
    }
  }

  it('支持新增、密钥、测试、启停、引用保护和删除', async () => {
    await withServer(async (call, store) => {
      const input = definition();
      expect((await call('/v1/admin/provider-definitions', { method: 'POST', body: JSON.stringify(input) }, 'employee')).status).toBe(403);
      expect((await call('/v1/admin/provider-definitions', { method: 'POST', body: JSON.stringify(input) })).status).toBe(201);
      expect((await call('/v1/admin/provider-definitions', { method: 'POST', body: JSON.stringify(input) })).status).toBe(409);
      expect((await call('/v1/admin/provider-definitions/openai', { method: 'DELETE' })).status).toBe(400);

      expect((await call('/v1/admin/providers/acme', { method: 'PUT', body: JSON.stringify({ account: 'default', apiKey: 'test-key-default' }) })).status).toBe(200);
      expect((await call('/v1/admin/providers/acme', { method: 'PUT', body: JSON.stringify({ account: 'acct-2', apiKey: 'test-key-second' }) })).status).toBe(200);
      const tested = await call('/v1/admin/provider-definitions/acme/test', { method: 'POST', body: JSON.stringify({ account: 'acct-2' }) });
      expect(tested.status).toBe(200);
      expect((await tested.json()).data.ok).toBe(true);

      const model = {
        name: 'acme-model', description: 'test', scenarios: [], enabled: true,
        targets: [{ provider: 'acme', model: 'acme-chat', account: 'acct-2', role: 'primary' }],
      };
      expect((await call('/v1/admin/models', { method: 'POST', body: JSON.stringify(model) })).status).toBe(201);
      expect((await call('/v1/admin/provider-definitions/acme', { method: 'PUT', body: JSON.stringify({ ...input, accounts: ['default'] }) })).status).toBe(409);
      expect((await call('/v1/admin/provider-definitions/acme', { method: 'DELETE' })).status).toBe(409);

      expect((await call('/v1/admin/provider-definitions/acme', { method: 'PATCH', body: JSON.stringify({ enabled: false }) })).status).toBe(200);
      expect((await call('/v1/admin/provider-definitions/acme', { method: 'PATCH', body: JSON.stringify({ enabled: true }) })).status).toBe(200);
      const defaultModel = { ...model, targets: [{ ...model.targets[0], account: undefined }] };
      expect((await call('/v1/admin/models/acme-model', { method: 'PUT', body: JSON.stringify(defaultModel) })).status).toBe(200);
      expect((await call('/v1/admin/provider-definitions/acme', { method: 'PUT', body: JSON.stringify({ ...input, accounts: ['default'] }) })).status).toBe(200);
      expect(await store.getProviderCredential('acme#acct-2')).toBeUndefined();
      expect((await call('/v1/admin/models/acme-model', { method: 'DELETE' })).status).toBe(200);
      const removed = await call('/v1/admin/provider-definitions/acme', { method: 'DELETE' });
      expect(removed.status).toBe(200);
      expect((await removed.json()).data.removedCredentials).toBe(1);
      expect(await store.getProviderCredential('acme')).toBeUndefined();
    });
  });
});
