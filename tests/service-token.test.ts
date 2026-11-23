/**
 * 服务账号令牌测试 —— 组件间内部调用的身份凭证（见 7.1 身份链路第一段）。
 *
 * 生产模式（AUTH_DEV_MODE=false）下 MCP Hub / agent-core 回调网关必须用
 * Keycloak client_credentials 换来的真令牌，不能用本地自签 dev token。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
// 与被测模块同源（service-token.ts 从 '../config.js' 取 config），
// 否则测试改的是 dist 里的另一份 config 对象，断言不会生效
import { config } from '../packages/platform-core/src/config.js';
import { serviceToken, resetServiceTokenCache } from '../packages/platform-core/src/auth/service-token.js';

const originalDevMode = config.auth.devMode;
const originalClientId = config.auth.serviceClientId;
const originalClientSecret = config.auth.serviceClientSecret;
const originalBaseUrl = config.auth.baseUrl;

let fetchCalls: { url: string; body: string }[] = [];
let nextResponse: { status: number; body: string } = { status: 200, body: '{}' };
const realFetch = globalThis.fetch;

beforeEach(() => {
  fetchCalls = [];
  nextResponse = {
    status: 200,
    body: JSON.stringify({ access_token: 'svc-token-1', expires_in: 300 }),
  };
  globalThis.fetch = (async (input: any, init: any) => {
    fetchCalls.push({ url: String(input), body: String(init?.body ?? '') });
    return new Response(nextResponse.body, { status: nextResponse.status });
  }) as typeof fetch;
  resetServiceTokenCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  config.auth.devMode = originalDevMode;
  config.auth.serviceClientId = originalClientId;
  config.auth.serviceClientSecret = originalClientSecret;
  config.auth.baseUrl = originalBaseUrl;
  resetServiceTokenCache();
});

describe('服务账号令牌', () => {
  it('生产模式走 client_credentials 换取真令牌', async () => {
    config.auth.devMode = false;
    config.auth.serviceClientId = 'eap-agent';
    config.auth.serviceClientSecret = 'secret-xyz';
    config.auth.baseUrl = 'http://127.0.0.1:8082';

    const token = await serviceToken();
    expect(token).toBe('svc-token-1');
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain('/realms/enterprise/protocol/openid-connect/token');
    expect(fetchCalls[0].body).toContain('grant_type=client_credentials');
    expect(fetchCalls[0].body).toContain('client_id=eap-agent');
    expect(fetchCalls[0].body).toContain('client_secret=secret-xyz');
  });

  it('令牌在有效期内被缓存，不重复申请', async () => {
    config.auth.devMode = false;
    config.auth.serviceClientId = 'eap-agent';
    config.auth.serviceClientSecret = 'secret-xyz';

    const a = await serviceToken();
    const b = await serviceToken();
    expect(a).toBe(b);
    expect(fetchCalls).toHaveLength(1);
  });

  it('并发调用只触发一次令牌申请', async () => {
    config.auth.devMode = false;
    config.auth.serviceClientId = 'eap-agent';
    config.auth.serviceClientSecret = 'secret-xyz';

    const [a, b, c] = await Promise.all([serviceToken(), serviceToken(), serviceToken()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(fetchCalls).toHaveLength(1);
  });

  it('未配置服务账号凭据时明确报错（不做静默降级）', async () => {
    config.auth.devMode = false;
    config.auth.serviceClientId = '';
    config.auth.serviceClientSecret = '';
    await expect(serviceToken()).rejects.toThrow(/KEYCLOAK_SERVICE_CLIENT_ID/);
  });

  it('Keycloak 返回错误时抛出可诊断的异常', async () => {
    config.auth.devMode = false;
    config.auth.serviceClientId = 'eap-agent';
    config.auth.serviceClientSecret = 'bad';
    nextResponse = { status: 401, body: '{"error":"invalid_client"}' };
    await expect(serviceToken()).rejects.toThrow(/HTTP 401/);
  });

  it('开发模式退回本地自签令牌，不打 Keycloak', async () => {
    config.auth.devMode = true;
    const token = await serviceToken();
    expect(token.split('.')).toHaveLength(3);
    expect(fetchCalls).toHaveLength(0);
  });
});
