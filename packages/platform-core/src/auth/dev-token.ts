/**
 * 开发模式令牌 —— 仅在 AUTH_DEV_MODE=true 时启用，生产必须关闭（见 8.5 凭证安全）。
 * 真实环境下所有令牌由 Keycloak 签发（见 7.1 身份链路第一段）。
 */
import { SignJWT } from 'jose';
import { config } from '../config.js';
import type { Identity, SensitivityLevel } from '../types.js';

export interface DevTokenClaims {
  sub: string;
  tenant_id: string;
  role: string;
  dept_id: string;
  sensitivity: SensitivityLevel;
  scopes?: string[];
  realm_access?: { roles: string[] };
  resource_access?: Record<string, { roles: string[] }>;
}

export async function signDevToken(
  claims: DevTokenClaims,
  ttlSeconds = 3600,
): Promise<string> {
  const secret = new TextEncoder().encode(config.auth.devSecret);
  return new SignJWT({
    tenant_id: claims.tenant_id,
    role: claims.role,
    dept_id: claims.dept_id,
    sensitivity: claims.sensitivity,
    scopes: claims.scopes ?? [],
    realm_access: claims.realm_access,
    resource_access: claims.resource_access,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuer('eap-dev')
    .setAudience('eap-gateway')
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(secret);
}

/** 便捷构造：普通业务用户 / 管理员 */
export async function devTokenFor(
  sub: string,
  opts: { tenantId?: string; role?: string; deptId?: string; sensitivity?: SensitivityLevel } = {},
): Promise<string> {
  return signDevToken({
    sub,
    tenant_id: opts.tenantId ?? config.auth.defaultTenantId,
    role: opts.role ?? 'employee',
    dept_id: opts.deptId ?? 'dept-general',
    sensitivity: opts.sensitivity ?? 'internal',
  });
}

/** 从 claims 构造平台身份 */
export function identityFromClaims(
  sub: string,
  claims: Record<string, unknown>,
): Identity {
  const tenantId = (claims.tenant_id as string) ?? config.auth.defaultTenantId;
  const role = (claims.role as string) ?? 'employee';
  const deptId = (claims.dept_id as string) ?? 'dept-general';
  const sensitivity = ((claims.sensitivity as SensitivityLevel) ?? 'internal') as SensitivityLevel;
  const scopes = Array.isArray(claims.scopes) ? (claims.scopes as string[]) : [];
  return { tenantId, userId: sub, role, deptId, sensitivity, scopes, claims };
}
