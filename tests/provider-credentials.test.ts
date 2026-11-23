import { describe, expect, it, vi } from 'vitest';

// 主密钥必须在 config 模块被求值**之前**注入 —— config 是模块级常量，
// 导入后再设环境变量不会生效，所以这里用 vi.hoisted。
vi.hoisted(() => {
  process.env.EAP_CREDENTIAL_MASTER_KEY = 'unit-test-master-key-0123456789';
});

import express from 'express';
import type { AddressInfo } from 'node:net';
import { SqliteMetadataStore, decryptSecret, encryptSecret, maskSecret } from '@eap/platform-core';
import { CredentialService } from '../packages/gateway/src/llm/credentials.js';
import { CredentialResolver, ProviderRegistry } from '../packages/gateway/src/llm/providers.js';
import { adminRoutes } from '../packages/gateway/src/routes/admin.js';
import type { Identity } from '@eap/platform-core';

const MASTER_KEY = 'unit-test-master-key-0123456789';

describe('凭证加解密', () => {
  it('加解密可逆，且密文不含明文', () => {
    const plain = 'sk-test-abcdefghijklmnop';
    const cipher = encryptSecret(plain, MASTER_KEY);
    expect(cipher).not.toContain(plain);
    expect(cipher.startsWith('v1:')).toBe(true);
    expect(decryptSecret(cipher, MASTER_KEY)).toBe(plain);
  });

  it('主密钥不对时解不开（不抛错，返回 undefined）', () => {
    const cipher = encryptSecret('sk-test-abcdefghijklmnop', MASTER_KEY);
    expect(decryptSecret(cipher, 'wrong-master-key')).toBeUndefined();
  });

  it('密文被篡改时解密失败而不是给出垃圾明文', () => {
    const cipher = encryptSecret('sk-test-abcdefghijklmnop', MASTER_KEY);
    const parts = cipher.split(':');
    const tampered = [parts[0], parts[1], parts[2], `${parts[3]}A`].join(':');
    expect(decryptSecret(tampered, MASTER_KEY)).toBeUndefined();
  });

  it('掩码只保留后 4 位', () => {
    expect(maskSecret('sk-example-ABCD1234')).toBe('***1234');
    expect(maskSecret('short')).toBe('***');
    expect(maskSecret('')).toBe('');
  });
});

describe('凭证来源优先级', () => {
  it('控制台凭证优先于环境变量', () => {
    const resolver = new CredentialResolver('', 'auto', [], {}, () => ({ key: 'console-key' }));
    expect(resolver.resolve('openai', 'env-key').key).toBe('console-key');
  });

  it('没有控制台凭证时用环境变量', () => {
    const resolver = new CredentialResolver('', 'auto', [], {}, () => undefined);
    expect(resolver.resolve('openai', 'env-key').key).toBe('env-key');
  });

  it('都没有时返回空凭证（不报越权错）', () => {
    const resolver = new CredentialResolver('', 'auto', [], {}, () => undefined);
    expect(resolver.resolve('openai', '').key).toBe('');
  });

  it('控制台凭证的鉴权方式沿用 provider 规则', () => {
    const resolver = new CredentialResolver('', 'auto', [], {}, () => ({ key: 'sk-public-cloud' }));
    // minimax-public 走 Bearer（公有云 OpenAI 兼容协议）
    expect(resolver.resolve('minimax-public', '').mode).toBe('bearer');
    // minimax 走 x-api-key
    expect(resolver.resolve('minimax', '').mode).toBe('x-api-key');
  });
});

describe('凭证服务（落库 + 视图）', () => {
  it('写入后视图只给掩码，落库的是密文', async () => {
    const store = new SqliteMetadataStore(':memory:');
    await store.init();
    const service = new CredentialService(store);
    await service.start();

    const plain = 'sk-example-PLAINTEXT-VALUE-0001';
    const view = await service.set('minimax-public', plain, 'u-admin');

    expect(view.source).toBe('console');
    expect(view.configured).toBe(true);
    expect(view.masked).toBe(maskSecret(plain));
    expect(view.masked).not.toContain(plain);
    expect(view.updatedBy).toBe('u-admin');

    // 落库的是密文
    const row = await store.getProviderCredential('minimax-public');
    expect(row).toBeDefined();
    expect(row?.secretCipher).not.toContain(plain);
    expect(decryptSecret(row!.secretCipher, MASTER_KEY)).toBe(plain);

    // 内存快照里是明文（网关进程内可用）
    expect(service.peek('minimax-public')?.key).toBe(plain);

    await service.stop();
    await store.close();
  });

  it('删除后回落到环境变量来源', async () => {
    const store = new SqliteMetadataStore(':memory:');
    await store.init();
    const service = new CredentialService(store);
    await service.start();

    await service.set('openai', 'sk-console-value-1234', 'u-admin');
    expect(service.view('openai').source).toBe('console');

    await service.remove('openai');
    expect(service.view('openai').source).toBe('none');
    expect(service.peek('openai')).toBeUndefined();
    expect(await store.getProviderCredential('openai')).toBeUndefined();

    await service.stop();
    await store.close();
  });

  it('没有主密钥时拒绝写入（fail closed）', async () => {
    const store = new SqliteMetadataStore(':memory:');
    await store.init();
    const service = new CredentialService(store);
    const original = process.env.EAP_CREDENTIAL_MASTER_KEY;
    // CredentialService 直接读 config，这里改 config 字段模拟缺主密钥
    const config = (await import('@eap/platform-core')).config;
    const saved = config.gateway.credentialMasterKey;
    config.gateway.credentialMasterKey = '';
    await expect(service.set('openai', 'sk-x', 'u-admin')).rejects.toThrow(/主密钥/);
    config.gateway.credentialMasterKey = saved;
    if (original === undefined) delete process.env.EAP_CREDENTIAL_MASTER_KEY;
    await store.close();
  });
});

describe('厂商凭证管理接口', () => {
  const identities: Record<string, Identity> = {
    admin: { tenantId: 't-1', userId: 'u-admin', role: 'platform-admin', deptId: 'd', sensitivity: 'internal', scopes: [], claims: {} },
    employee: { tenantId: 't-1', userId: 'u-emp', role: 'employee', deptId: 'd', sensitivity: 'internal', scopes: [], claims: {} },
  };

  async function withServer(
    run: (call: (path: string, user: string, init?: RequestInit) => Promise<Response>, store: SqliteMetadataStore) => Promise<void>,
  ): Promise<void> {
    const store = new SqliteMetadataStore(':memory:');
    await store.init();
    const credentials = new CredentialService(store);
    await credentials.start();
    const providers = new ProviderRegistry(credentials);
    const audits: { reason: string; detail: Record<string, unknown> }[] = [];

    const ctx = {
      store,
      credentials,
      providers,
      budget: { summary: async () => ({}) },
      audit: {
        record: async (e: { reason: string; detail: Record<string, unknown> }) => {
          audits.push({ reason: e.reason, detail: e.detail });
        },
        list: async () => [],
        reconstruct: async () => ({ events: [], traces: [] }),
      },
      policy: { list: () => [], replaceAll: () => undefined },
      router: { listVirtualModels: async () => [] },
      mcp: { call: async () => ({ ok: true, content: 'ok', traceId: 'trace' }) },
    };

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const identity = identities[String(req.headers['x-test-user'])];
      if (identity) req.identity = identity;
      next();
    });
    app.use(adminRoutes(ctx as never));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const call = (path: string, user: string, init: RequestInit = {}): Promise<Response> =>
      fetch(`${baseUrl}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', 'x-test-user': user, ...(init.headers ?? {}) },
      });

    try {
      await run(call, store);
      // 审计里绝不能出现明文
      const dumped = JSON.stringify(audits);
      if (dumped.includes('sk-api-SECRET-VALUE-0001')) {
        throw new Error('审计流水中出现了凭证明文');
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await credentials.stop();
      await store.close();
    }
  }

  it('普通用户可读（只含掩码），但不能写', async () => {
    await withServer(async (call) => {
      const res = await call('/v1/admin/providers', 'employee');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.data)).toBe(true);
      // 视图里没有明文字段
      expect(JSON.stringify(body)).not.toMatch(/sk-api-[A-Za-z0-9_-]{10,}/);

      const put = await call('/v1/admin/providers/openai', 'employee', {
        method: 'PUT',
        body: JSON.stringify({ apiKey: 'sk-api-SECRET-VALUE-0001' }),
      });
      expect(put.status).toBe(403);

      const del = await call('/v1/admin/providers/openai', 'employee', { method: 'DELETE' });
      expect(del.status).toBe(403);
    });
  });

  it('管理员写入后立即生效，响应只含掩码', async () => {
    await withServer(async (call, store) => {
      const secret = 'sk-api-SECRET-VALUE-0001';
      const put = await call('/v1/admin/providers/openai', 'admin', {
        method: 'PUT',
        body: JSON.stringify({ apiKey: secret }),
      });
      expect(put.status).toBe(200);
      const text = await put.text();
      expect(text).not.toContain(secret);
      const body = JSON.parse(text);
      expect(body.data.source).toBe('console');
      expect(body.data.masked).toBe(maskSecret(secret));

      // 落库是密文
      const row = await store.getProviderCredential('openai');
      expect(row?.secretCipher).not.toContain(secret);

      // 再读一次列表，响应体里依然没有明文
      const list = await call('/v1/admin/providers', 'employee');
      const listText = await list.text();
      expect(listText).not.toContain(secret);
    });
  });

  it('删除后回落到环境变量来源', async () => {
    await withServer(async (call) => {
      await call('/v1/admin/providers/openai', 'admin', {
        method: 'PUT',
        body: JSON.stringify({ apiKey: 'sk-api-SECRET-VALUE-0001' }),
      });
      const del = await call('/v1/admin/providers/openai', 'admin', { method: 'DELETE' });
      expect(del.status).toBe(200);
      const body = await del.json();
      expect(body.data.source).not.toBe('console');
    });
  });

  it('拒绝未知 provider', async () => {
    await withServer(async (call) => {
      const put = await call('/v1/admin/providers/not-a-provider', 'admin', {
        method: 'PUT',
        body: JSON.stringify({ apiKey: 'sk-api-SECRET-VALUE-0001' }),
      });
      expect(put.status).toBe(400);
      const body = await put.json();
      expect(body.error).toBe('unknown_provider_account');
    });
  });
});
