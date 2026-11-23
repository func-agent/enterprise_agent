/**
 * 自研鉴权中间件（见 3.1 身份组件「鉴权中间件（自研）—— JWT 校验，替换 AgentScope 占位身份」）。
 *
 * 身份链路第一段：Keycloak 对接企业 AD/LDAP，通过 OIDC 签发 JWT
 *   （含 tenant_id / user_id / role / dept_id），见 7.1。
 */
import type { NextFunction, Request, Response } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import {
  config,
  createLogger,
  identityFromClaims,
  type Identity,
  type SensitivityLevel,
} from '@eap/platform-core';

const log = createLogger('auth');

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      identity?: Identity;
      rawToken?: string;
    }
  }
}

/** 平台内置角色 —— 与 Keycloak realm 角色一一对应 */
export const PLATFORM_ROLES = ['platform-admin', 'admin', 'manager', 'employee'] as const;
const PLATFORM_ROLE_SET = new Set<string>(PLATFORM_ROLES);

/** Keycloak realm 角色映射 —— 优先取高权限角色 */
function roleFromClaims(claims: JWTPayload): string {
  const direct = claims['role'];
  if (typeof direct === 'string' && PLATFORM_ROLE_SET.has(direct)) return direct;
  const realmAccess = claims['realm_access'] as { roles?: string[] } | undefined;
  const realmRoles = realmAccess?.roles ?? [];
  for (const r of PLATFORM_ROLES) {
    if (realmRoles.includes(r)) return r;
  }
  // 未命中平台角色时一律降级为 employee —— 不能把 offline_access 之类的
  // Keycloak 内置角色当成业务角色下发（否则会越过角色校验）
  return 'employee';
}

function tenantFromClaims(claims: JWTPayload): string {
  const t = nonEmpty(claims['tenant_id']);
  if (t) return t;
  if (config.auth.singleTenantMode) return config.auth.defaultTenantId;
  const realmAccess = claims['realm_access'] as { roles?: string[] } | undefined;
  const tenantRole = (realmAccess?.roles ?? []).find((r) => r.startsWith('tenant:'));
  return tenantRole ? tenantRole.slice('tenant:'.length) : config.auth.defaultTenantId;
}

/** 空串 / 非字符串一律视为缺失（Keycloak 属性映射器在无属性时会下发空串） */
function nonEmpty(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * 取用户主体标识。
 *
 * `sub` 是 OIDC 标准主体标识，优先使用。但若 IdP 未下发 sub
 * （部分企业 IdP / 自建目录只给用户名），必须回退到用户名 ——
 * 否则所有用户会塌缩成同一个 user_id='unknown'，
 * 审计日志与审批单将无法区分操作者，属于必须堵住的身份混淆。
 */
function subjectFromClaims(claims: JWTPayload): string {
  return (
    nonEmpty(claims['sub']) ?? nonEmpty(claims['preferred_username']) ?? nonEmpty(claims['oid']) ?? 'unknown'
  );
}

/**
 * 服务间静态凭证的规格串。
 * 格式：`<token>[:<role>[:<tenantId>[:<deptId>[:<sensitivity>]]]]`
 * 例：`eap-dbgpt-local-key:employee:t-default:dept-general:internal`
 */
export interface ServiceTokenSpec {
  role: string;
  tenantId: string;
  deptId: string;
  sensitivity: SensitivityLevel;
}

/** 拆解服务凭证条目；token 里不含冒号，故以第一个冒号为分隔点 */
function splitServiceToken(entry: string): [string, ServiceTokenSpec] {
  const idx = entry.indexOf(':');
  const token = (idx >= 0 ? entry.slice(0, idx) : entry).trim();
  const rest = idx >= 0 ? entry.slice(idx + 1).split(':') : [];
  const role = rest[0] && PLATFORM_ROLE_SET.has(rest[0]) ? rest[0] : 'employee';
  return [
    token,
    {
      role,
      tenantId: rest[1]?.trim() || config.auth.defaultTenantId,
      deptId: rest[2]?.trim() || 'dept-general',
      sensitivity: (rest[3]?.trim() as SensitivityLevel) || 'internal',
    },
  ];
}

/**
 * 由服务凭证构造身份。
 * 重要：服务身份**不走任何治理旁路** —— 策略、预算、护栏、审计照常生效，
 * 只是身份来源不同（静态凭证 vs Keycloak JWT）。
 */
function serviceIdentity(token: string, spec: ServiceTokenSpec): Identity {
  // 只保留 token 前 8 位做标识，日志/审计里不出现完整凭证
  const id = `svc-${token.slice(0, 8)}`;
  return {
    tenantId: spec.tenantId,
    userId: id,
    role: spec.role,
    deptId: spec.deptId,
    sensitivity: spec.sensitivity,
    scopes: ['service-account'],
    claims: { service_account: true, role: spec.role, tenant_id: spec.tenantId },
  };
}

export class AuthService {
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
  /** 服务间静态凭证 → 身份（见 config.auth.serviceTokens） */
  private readonly serviceIdentities = new Map<string, Identity>();

  constructor() {
    const jwksUri = config.auth.jwksUri || `${config.auth.baseUrl}/realms/${config.auth.realm}/protocol/openid-connect/certs`;
    this.jwks = createRemoteJWKSet(new URL(jwksUri));
    // 服务间静态凭证：无法走 OIDC 流程的组件（如 DB-GPT 的 proxy/openai 客户端）
    // 用它访问网关。凭证本身不落日志，只在鉴权失败时提示。
    for (const entry of config.auth.serviceTokens) {
      const [token, spec] = splitServiceToken(entry);
      if (!token) continue;
      this.serviceIdentities.set(token, serviceIdentity(token, spec));
    }
    log.info('鉴权服务初始化', {
      jwksUri,
      devMode: config.auth.devMode,
      serviceTokens: this.serviceIdentities.size,
    });
  }

  /** 校验服务间静态凭证；未配置或未命中返回 undefined */
  verifyServiceToken(token: string): Identity | undefined {
    return this.serviceIdentities.get(token);
  }

  /** 校验 Bearer Token，返回平台身份 */
  async verify(token: string): Promise<Identity> {
    const parts = token.split('.');
    const isJwt = parts.length === 3;

    if (config.auth.devMode && isJwt) {
      const header = decodeSegment(parts[0]);
      if (header?.alg === 'HS256') {
        const payload = await jwtVerify(token, new TextEncoder().encode(config.auth.devSecret), {
          algorithms: ['HS256'],
        });
        return this.toIdentity(payload.payload);
      }
    }

    if (!this.jwks) throw new Error('JWKS 未配置');
    const { payload } = await jwtVerify(token, this.jwks, {
      // issuer 允许是数组：Keycloak 按请求 Host 生成 iss，本机 / 公网 / 容器网络
      // 三个入口签出的 iss 不同，必须全部列入白名单（见 config.auth.issuer）。
      issuer: config.auth.issuer.length > 0 ? config.auth.issuer : undefined,
      audience: config.auth.audience || undefined,
    });
    return this.toIdentity(payload);
  }

  private toIdentity(claims: JWTPayload): Identity {
    const sub = subjectFromClaims(claims);
    const tenantId = tenantFromClaims(claims);
    // Keycloak 的 user-attribute 映射器在用户没有该属性时会下发空串 ——
    // 空串必须按「缺失」处理，否则会得到空部门 / 空密级的畸形身份
    const deptId = nonEmpty(claims['dept_id']) ?? 'dept-general';
    const sensitivity = (nonEmpty(claims['sensitivity']) ?? 'internal') as SensitivityLevel;
    const role = roleFromClaims(claims);
    // scopes 既支持标准 OAuth scope 字符串，也支持平台自定义的 scopes 数组
    const scopeList: string[] = [];
    if (Array.isArray(claims['scopes'])) {
      scopeList.push(...(claims['scopes'] as unknown[]).map((s) => String(s)));
    }
    if (Array.isArray(claims['scope'])) {
      scopeList.push(...(claims['scope'] as unknown[]).map((s) => String(s).split(' ').join('')));
    } else if (typeof claims['scope'] === 'string') {
      scopeList.push(...claims['scope'].split(' ').filter(Boolean));
    }
    // Keycloak realm 角色并入 scopes —— 让 approver / auditor 之类能力位可直接被策略引用
    const realmAccess = claims['realm_access'] as { roles?: string[] } | undefined;
    for (const r of realmAccess?.roles ?? []) {
      if (r && !['offline_access', 'uma_authorization', 'default-roles'].includes(r)) {
        scopeList.push(r);
      }
    }
    const scopes = [...new Set(scopeList)];

    const enriched: Record<string, unknown> = {
      ...claims,
      tenant_id: tenantId,
      role,
      dept_id: deptId,
      sensitivity,
      scopes,
    };
    return { ...identityFromClaims(sub, enriched), tenantId, role, deptId, sensitivity, scopes };
  }
}

function decodeSegment(seg: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
}

/** Express 中间件 —— 解析并注入身份上下文 */
export function authMiddleware(service: AuthService) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header || !header.toLowerCase().startsWith('bearer ')) {
      res.status(401).json({ error: 'missing_token', message: '缺少 Authorization: Bearer <token>' });
      return;
    }
    const token = header.slice(7).trim();
    try {
      // 1) 服务间静态凭证（组件场景）
      const svc = service.verifyServiceToken(token);
      if (svc) {
        req.identity = svc;
        req.rawToken = token;
        next();
        return;
      }
      // 2) Keycloak JWT / 开发态令牌
      req.identity = await service.verify(token);
      req.rawToken = token;
      next();
    } catch (err: any) {
      log.warn('令牌校验失败', { error: err?.message });
      res.status(401).json({ error: 'invalid_token', message: '令牌无效或已过期' });
    }
  };
}

/** 取身份，未认证则抛错 */
export function requireIdentity(req: Request): Identity {
  if (!req.identity) throw new Error('未认证请求');
  return req.identity;
}
