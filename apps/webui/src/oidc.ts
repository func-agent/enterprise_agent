/**
 * OIDC 授权码 + PKCE 登录 —— 控制台的生产登录路径。
 *
 * 设计要点：
 *   · 公开客户端（client_id=eap-webui，无客户端密钥），PKCE S256 —— 符合
 *     OAuth 2.1 对浏览器原生应用的推荐形态，令牌交换全在浏览器侧完成，
 *     网关与前端都不持有任何长期密钥。
 *   · 身份由 Keycloak 下发的 JWT claim 推导（tenant_id / role / dept_id /
 *     sensitivity，见 realm 的 eap-context client scope），与网关鉴权中间件
 *     的解析口径保持一致；真正的权限判定仍以网关侧校验结果为准。
 *   · 令牌保存在 localStorage（与开发态登录同一套持久化逻辑），
 *     过期由网关返回 401 触发重新登录。
 */
import type { Identity } from './types';
import { sha256 } from './sha256';

/** 网关下发的 OIDC 授权配置（GET /v1/auth/config） */
export interface OidcConfig {
  mode: 'dev' | 'oidc';
  clientId: string;
  scope: string;
  authorizationUrl: string;
  tokenUrl: string;
  endSessionUrl: string;
  issuer: string;
  redirectPath: string;
  devMode: boolean;
}

/** Keycloak token 端点响应 */
export interface OidcTokenResponse {
  access_token: string;
  id_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

/** 登录结果 */
export interface OidcLoginResult {
  token: string;
  identity: Identity;
  expiresIn: number;
  refreshToken?: string;
  /** id_token —— RP-initiated 登出时作为 id_token_hint 传给 Keycloak */
  idToken?: string;
}

/** PKCE 临时数据在 sessionStorage 中的键 */
const VERIFIER_KEY = 'eap.oidc.verifier';

/** PKCE 临时数据有效期 —— 授权跳转往返通常在几分钟内完成 */
const VERIFIER_TTL_MS = 10 * 60 * 1000;

/* ------------------------------------------------------------------ *
 * 基础编解码
 * ------------------------------------------------------------------ */

/** base64url 编码（去掉 padding） */
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 随机串（用于 state / nonce / code_verifier） */
function randomString(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/**
 * SHA-256 摘要的 base64url 表示 —— PKCE 的 code_challenge。
 *
 * `crypto.subtle` 只在**安全上下文**可用（HTTPS / localhost / 127.0.0.1）。
 * 通过公网明文 HTTP（http://<公网IP>:5173）访问控制台时不是安全上下文，
 * `crypto.subtle` 为 undefined，直接调用会抛 TypeError 导致登录按钮点了没反应。
 * 因此：有 subtle 走原生，没有则退回纯 JS 实现（见 sha256.ts）。
 */
async function sha256Base64Url(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return base64UrlEncode(new Uint8Array(digest));
  }
  return base64UrlEncode(sha256(bytes));
}

/** 解码 JWT 载荷段（不校验签名 —— 令牌有效性由网关用 JWKS 校验） */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('令牌格式不正确');
  const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
  const json = atob(padded);
  const parsed: unknown = JSON.parse(decodeURIComponent(escape(json)));
  if (!parsed || typeof parsed !== 'object') throw new Error('令牌载荷格式不正确');
  return parsed as Record<string, unknown>;
}

/* ------------------------------------------------------------------ *
 * claim → 平台身份
 * ------------------------------------------------------------------ */

const PLATFORM_ROLES = new Set(['platform-admin', 'admin', 'manager', 'employee']);

/** 取非空字符串；Keycloak 属性映射器在属性缺失时会下发空串 */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * 由 JWT claim 推导平台身份。
 * 口径与 packages/auth-middleware/src/index.ts 的 toIdentity 保持一致：
 * role 优先取 `role` claim，其次 realm_access.roles 命中平台角色，最后降级 employee。
 */
export function identityFromClaims(claims: Record<string, unknown>): Identity {
  const realmAccess = (claims.realm_access ?? {}) as { roles?: string[] };
  const realmRoles = realmAccess.roles ?? [];

  let role = nonEmpty(claims.role);
  if (!role || !PLATFORM_ROLES.has(role)) {
    const hit = ['platform-admin', 'admin', 'manager', 'employee'].find((r) => realmRoles.includes(r));
    role = hit ?? 'employee';
  }

  const userId =
    nonEmpty(claims.sub) ?? nonEmpty(claims.preferred_username) ?? nonEmpty(claims.oid) ?? 'unknown';

  return {
    tenant_id: nonEmpty(claims.tenant_id) ?? 't-default',
    user_id: userId,
    role,
    dept_id: nonEmpty(claims.dept_id) ?? 'dept-general',
    sensitivity: nonEmpty(claims.sensitivity) ?? 'internal',
    // 展示用登录名 —— user_id 保持稳定主体标识，审计口径与网关一致
    username: nonEmpty(claims.preferred_username) ?? userId,
  };
}

/* ------------------------------------------------------------------ *
 * 授权跳转与回调
 * ------------------------------------------------------------------ */

/** 当前页面在 Keycloak 侧登记的回调地址 */
export function redirectUriOf(config: OidcConfig): string {
  return `${window.location.origin}${config.redirectPath}`;
}

/** 是否处于 OIDC 回调（带 code 或 error 参数） */
export function isOidcCallback(): boolean {
  const params = new URLSearchParams(window.location.search);
  return params.has('code') || params.has('error');
}

/**
 * 发起授权跳转 —— 生成 code_verifier / state / nonce 后跳到 Keycloak。
 * PKCE 的 code_challenge 使用 S256，与 realm 中 eap-webui 的配置一致。
 */
export async function startOidcLogin(config: OidcConfig): Promise<void> {
  const verifier = randomString(48);
  const state = randomString(16);
  const nonce = randomString(16);
  const challenge = await sha256Base64Url(verifier);

  try {
    window.sessionStorage.setItem(
      VERIFIER_KEY,
      JSON.stringify({ verifier, state, nonce, createdAt: Date.now() }),
    );
  } catch {
    /* 隐私模式下 sessionStorage 不可用 —— 登录会失败，交给回调处报错 */
  }

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUriOf(config),
    response_type: 'code',
    scope: config.scope,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  window.location.assign(`${config.authorizationUrl}?${params.toString()}`);
}

interface StoredVerifier {
  verifier: string;
  state: string;
  nonce: string;
  createdAt: number;
}

function readStoredVerifier(): StoredVerifier | null {
  try {
    const raw = window.sessionStorage.getItem(VERIFIER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredVerifier;
    if (!parsed?.verifier || !parsed?.state) return null;
    if (Date.now() - Number(parsed.createdAt ?? 0) > VERIFIER_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function clearStoredVerifier(): void {
  try {
    window.sessionStorage.removeItem(VERIFIER_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * 处理授权回调 —— 校验 state、换取令牌、解析身份。
 * 令牌交换失败时抛出可展示的错误信息。
 */
export async function finishOidcLogin(config: OidcConfig): Promise<OidcLoginResult> {
  const params = new URLSearchParams(window.location.search);
  const error = params.get('error');
  if (error) {
    const detail = params.get('error_description') ?? '';
    clearStoredVerifier();
    throw new Error(detail ? `${error}: ${detail}` : `授权失败（${error}）`);
  }

  const code = params.get('code');
  if (!code) throw new Error('回调缺少授权码');

  const stored = readStoredVerifier();
  if (!stored) {
    throw new Error('登录会话已过期，请重新发起登录');
  }
  if (params.get('state') !== stored.state) {
    clearStoredVerifier();
    throw new Error('登录状态校验失败，请重新发起登录');
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUriOf(config),
    client_id: config.clientId,
    code_verifier: stored.verifier,
  });

  let payload: OidcTokenResponse;
  try {
    const response = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const text = await response.text();
    try {
      payload = JSON.parse(text) as OidcTokenResponse;
    } catch {
      throw new Error(`令牌交换失败（HTTP ${response.status}）`);
    }
    if (!response.ok || !payload.access_token) {
      throw new Error(
        payload.error_description || payload.error || `令牌交换失败（HTTP ${response.status}）`,
      );
    }
  } catch (err) {
    clearStoredVerifier();
    if (err instanceof Error) throw err;
    throw new Error('令牌交换失败');
  }

  clearStoredVerifier();

  const claims = decodeJwtPayload(payload.access_token);
  return {
    token: payload.access_token,
    identity: identityFromClaims(claims),
    expiresIn: Number(payload.expires_in ?? 1800),
    refreshToken: payload.refresh_token,
    idToken: payload.id_token,
  };
}

/**
 * 用 refresh_token 续期 —— 访问令牌过期但刷新令牌仍在时静默续签。
 * 失败时返回 null，由调用方走重新登录。
 */
export async function refreshOidcToken(config: OidcConfig, refreshToken: string): Promise<OidcLoginResult | null> {
  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: config.clientId,
    });
    const response = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as OidcTokenResponse;
    if (!payload.access_token) return null;
    const claims = decodeJwtPayload(payload.access_token);
    return {
      token: payload.access_token,
      identity: identityFromClaims(claims),
      expiresIn: Number(payload.expires_in ?? 1800),
      refreshToken: payload.refresh_token ?? refreshToken,
      idToken: payload.id_token,
    };
  } catch {
    return null;
  }
}

/**
 * 结束 Keycloak 侧会话（RP-initiated 登出）。
 *
 * 只发 `client_id` + `id_token_hint`，**不发** `post_logout_redirect_uri`：
 * Keycloak 26.0.8 对该属性的多值形式（`+` / 换行 / 逗号）一律按整串匹配，
 * 未登记的回调地址直接返回 400（`invalid_redirect_uri`）。
 * 不带回调地址时 Keycloak 正常结束会话并返回 200，
 * 控制台留在自己的页面展示登录框 —— 也不会闪一下 Keycloak 登录页。
 */
export async function endOidcSession(
  config: OidcConfig,
  _redirectUri: string,
  idToken?: string,
): Promise<void> {
  try {
    const params = new URLSearchParams({ client_id: config.clientId });
    if (idToken) params.set('id_token_hint', idToken);
    await fetch(`${config.endSessionUrl}?${params.toString()}`, { mode: 'no-cors' });
  } catch {
    /* ignore */
  }
}
