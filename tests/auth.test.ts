/**
 * 鉴权中间件测试 —— Keycloak JWT 校验与身份上下文注入（见 4.1 / 7.1）。
 */
import { describe, expect, it, afterEach } from 'vitest';
import { SignJWT } from 'jose';
import { AuthService } from '../packages/auth-middleware/src/index.js';
import { config, identityFromClaims, signDevToken } from '@eap/platform-core';

const service = new AuthService();

describe('开发态令牌', () => {
  it('签发并校验，注入完整身份上下文', async () => {
    const token = await signDevToken({
      sub: 'u-42',
      tenant_id: 't-east',
      role: 'manager',
      dept_id: 'dept-east',
      sensitivity: 'internal',
      scopes: ['chat'],
    });
    const identity = await service.verify(token);
    expect(identity.userId).toBe('u-42');
    expect(identity.tenantId).toBe('t-east');
    expect(identity.role).toBe('manager');
    expect(identity.deptId).toBe('dept-east');
    expect(identity.sensitivity).toBe('internal');
    expect(identity.scopes).toContain('chat');
  });

  it('错误密钥签发的令牌被拒绝', async () => {
    const wrong = await new SignJWT({ tenant_id: 't', role: 'employee', dept_id: 'd' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject('u-1')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('wrong-secret-entirely'));
    await expect(service.verify(wrong)).rejects.toThrow();
  });

  it('过期令牌被拒绝', async () => {
    const expired = await new SignJWT({ tenant_id: 't', role: 'employee', dept_id: 'd' })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject('u-1')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(new TextEncoder().encode(config.auth.devSecret));
    await expect(service.verify(expired)).rejects.toThrow();
  });
});

describe('身份映射', () => {
  it('从 Keycloak 风格 claims 构造身份', () => {
    const identity = identityFromClaims('sub-1', {
      tenant_id: 't-1',
      role: 'admin',
      dept_id: 'dept-1',
      sensitivity: 'confidential',
      scopes: ['a', 'b'],
    });
    expect(identity.userId).toBe('sub-1');
    expect(identity.tenantId).toBe('t-1');
    expect(identity.role).toBe('admin');
    expect(identity.deptId).toBe('dept-1');
    expect(identity.sensitivity).toBe('confidential');
  });

  it('缺失租户时回落到默认租户', () => {
    const identity = identityFromClaims('sub-2', {});
    expect(identity.tenantId).toBe(config.auth.defaultTenantId);
    expect(identity.role).toBe('employee');
  });
});

describe('Keycloak realm 角色映射', () => {
  async function verifyWith(claims: Record<string, unknown>) {
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject('kc-user')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(config.auth.devSecret));
    return service.verify(token);
  }

  it('realm_access 中优先取高权限平台角色', async () => {
    const identity = await verifyWith({
      realm_access: { roles: ['employee', 'platform-admin'] },
    });
    expect(identity.role).toBe('platform-admin');
  });

  it('只有 Keycloak 内置角色时降级为 employee，不得放行内置角色', async () => {
    const identity = await verifyWith({
      realm_access: { roles: ['offline_access', 'uma_authorization'] },
    });
    expect(identity.role).toBe('employee');
  });

  it('非法 role 声明被拒绝并降级为 employee', async () => {
    const identity = await verifyWith({ role: 'superuser' });
    expect(identity.role).toBe('employee');
  });

  it('realm 角色并入 scopes，但排除 Keycloak 内置角色', async () => {
    const identity = await verifyWith({
      realm_access: { roles: ['employee', 'approver', 'offline_access', 'uma_authorization'] },
    });
    expect(identity.scopes).toContain('approver');
    expect(identity.scopes).toContain('employee');
    expect(identity.scopes).not.toContain('offline_access');
    expect(identity.scopes).not.toContain('uma_authorization');
  });

  it('合法的 role 声明直接生效', async () => {
    const identity = await verifyWith({
      role: 'manager',
      realm_access: { roles: ['employee'] },
    });
    expect(identity.role).toBe('manager');
  });

  it('空串属性（Keycloak 映射器无属性时下发）按缺失处理', async () => {
    const identity = await verifyWith({
      role: '',
      tenant_id: '',
      dept_id: '',
      sensitivity: '',
    });
    expect(identity.role).toBe('employee');
    expect(identity.tenantId).toBe(config.auth.defaultTenantId);
    expect(identity.deptId).toBe('dept-general');
    expect(identity.sensitivity).toBe('internal');
  });
});

describe('服务间静态凭证', () => {
  const originalTokens = config.auth.serviceTokens;

  afterEach(() => {
    config.auth.serviceTokens = originalTokens;
  });

  it('未配置时不接受任何静态凭证', () => {
    config.auth.serviceTokens = [];
    const svc = new AuthService();
    expect(svc.verifyServiceToken('anything')).toBeUndefined();
  });

  it('命中时返回服务身份，且角色受限于平台内置角色', () => {
    config.auth.serviceTokens = ['tok-abc123:manager:t-x:dept-y:confidential'];
    const svc = new AuthService();
    const identity = svc.verifyServiceToken('tok-abc123');
    expect(identity?.role).toBe('manager');
    expect(identity?.tenantId).toBe('t-x');
    expect(identity?.deptId).toBe('dept-y');
    expect(identity?.sensitivity).toBe('confidential');
    expect(identity?.scopes).toContain('service-account');
    // 凭证本身不得出现在身份里，避免进日志/审计
    expect(JSON.stringify(identity)).not.toContain('tok-abc123');
  });

  it('非法角色降级为 employee，不能提权', () => {
    config.auth.serviceTokens = ['tok-xyz:superuser'];
    const svc = new AuthService();
    const identity = svc.verifyServiceToken('tok-xyz');
    expect(identity?.role).toBe('employee');
    expect(identity?.tenantId).toBe(config.auth.defaultTenantId);
  });

  it('未带规格时使用默认身份', () => {
    config.auth.serviceTokens = ['tok-plain'];
    const svc = new AuthService();
    const identity = svc.verifyServiceToken('tok-plain');
    expect(identity?.role).toBe('employee');
    expect(identity?.deptId).toBe('dept-general');
    expect(identity?.sensitivity).toBe('internal');
  });
});

describe('主体标识回退（user_id 不得塌缩）', () => {
  /**
   * sub 是 OIDC 标准主体标识；若 IdP 未下发 sub 而只给用户名，
   * 所有用户会塌缩成同一个 user_id='unknown'，审计日志与审批单将无法区分操作者。
   */
  it('JWT 含 sub 时 userId 取 sub', async () => {
    const token = await signDevToken({ sub: 'uuid-abc', role: 'employee' });
    const identity = await service.verify(token);
    expect(identity.userId).toBe('uuid-abc');
  });

  it('缺 sub 时回退到 preferred_username', async () => {
    const token = await new SignJWT({
      preferred_username: 'eap-demo',
      tenant_id: 't-default',
      role: 'employee',
      dept_id: 'dept-finance',
      sensitivity: 'internal',
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(config.auth.devSecret));
    const identity = await service.verify(token);
    expect(identity.userId).toBe('eap-demo');
  });

  it('sub 为空串时同样回退（Keycloak 会下发空串）', async () => {
    const token = await new SignJWT({
      sub: '',
      preferred_username: 'eap-ops',
      tenant_id: 't-default',
      role: 'employee',
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(config.auth.devSecret));
    const identity = await service.verify(token);
    expect(identity.userId).toBe('eap-ops');
  });
});
