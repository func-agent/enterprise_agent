/**
 * 服务账号令牌 —— 组件间内部调用的身份凭证（见 7.1 身份链路第一段）。
 *
 * MCP Hub 的 Text2SQL 等能力需要回调 agentgateway。生产形态下不能用本地
 * 自签的 dev token（AUTH_DEV_MODE=false 时网关直接 401），必须向 Keycloak
 * 用 client_credentials 换取真正的 RS256 令牌。
 *
 * 令牌按到期时间缓存，过期前 30 秒自动续期，避免每次调用都打 Keycloak。
 */
import { config } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('platform:service-token');

export interface ServiceTokenOptions {
  /** 覆盖默认 client id */
  clientId?: string;
  /** 覆盖默认 client secret */
  clientSecret?: string;
}

interface CachedToken {
  token: string;
  /** 到期时间戳（毫秒） */
  expiresAt: number;
}

let cached: CachedToken | null = null;
let inflight: Promise<string> | null = null;

/** 提前 30 秒视为过期，避免边界抖动 */
const REFRESH_SKEW_MS = 30_000;

function tokenEndpoint(): string {
  const base = config.auth.baseUrl.replace(/\/$/, '');
  return `${base}/realms/${config.auth.realm}/protocol/openid-connect/token`;
}

/**
 * 取服务账号令牌。
 * 开发模式（AUTH_DEV_MODE=true）下返回本地自签 token，便于无 Keycloak 时联调；
 * 生产模式下走 Keycloak client_credentials。
 */
export async function serviceToken(opts: ServiceTokenOptions = {}): Promise<string> {
  if (config.auth.devMode) {
    const { devTokenFor } = await import('./dev-token.js');
    return devTokenFor(opts.clientId ?? config.auth.serviceClientId ?? 'svc-platform', {
      tenantId: config.auth.defaultTenantId,
      role: 'service-account',
      deptId: 'dept-general',
      sensitivity: 'internal',
    });
  }

  const clientId = opts.clientId ?? config.auth.serviceClientId;
  const clientSecret = opts.clientSecret ?? config.auth.serviceClientSecret;
  if (!clientId || !clientSecret) {
    throw new Error(
      '服务账号凭证缺失：生产模式（AUTH_DEV_MODE=false）下必须配置 KEYCLOAK_SERVICE_CLIENT_ID / KEYCLOAK_SERVICE_CLIENT_SECRET',
    );
  }

  if (cached && cached.expiresAt - REFRESH_SKEW_MS > Date.now()) {
    return cached.token;
  }
  // 并发调用复用同一次请求，避免令牌风暴
  if (inflight) return inflight;

  inflight = (async () => {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    });
    const res = await fetch(tokenEndpoint(), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`服务账号令牌申请失败 HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    let json: { access_token?: string; expires_in?: number };
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`服务账号令牌响应不是合法 JSON：${text.slice(0, 200)}`);
    }
    if (!json.access_token) {
      throw new Error('服务账号令牌响应缺少 access_token');
    }
    const ttlMs = (json.expires_in ?? 300) * 1000;
    cached = { token: json.access_token, expiresAt: Date.now() + ttlMs };
    log.info('服务账号令牌已获取', { clientId, expiresInSec: Math.round(ttlMs / 1000) });
    return json.access_token;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** 清空缓存（测试用） */
export function resetServiceTokenCache(): void {
  cached = null;
  inflight = null;
}
