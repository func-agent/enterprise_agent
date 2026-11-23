/**
 * OIDC 身份映射单测 —— 前端 `apps/webui/src/oidc.ts` 的 claim 解析口径。
 *
 * 口径必须与 `packages/auth-middleware/src/index.ts` 的 toIdentity 一致，
 * 否则控制台展示的身份会与网关实际判定的身份对不上（审计与权限判定以网关为准）。
 */
import { describe, expect, it } from 'vitest';
import { identityFromClaims } from '../apps/webui/src/oidc';

describe('OIDC claim → 平台身份', () => {
  it('优先取 sub 作为 user_id（稳定主体标识）', () => {
    const identity = identityFromClaims({
      sub: 'uuid-123',
      preferred_username: 'eap-demo',
    });
    expect(identity.user_id).toBe('uuid-123');
  });

  it('展示用登录名取 preferred_username', () => {
    const identity = identityFromClaims({ sub: 'uuid-123', preferred_username: 'eap-demo' });
    expect(identity.username).toBe('eap-demo');
  });

  it('sub 缺失时回退到 preferred_username（不得塌缩成 unknown）', () => {
    const identity = identityFromClaims({ preferred_username: 'eap-ops' });
    expect(identity.user_id).toBe('eap-ops');
    expect(identity.username).toBe('eap-ops');
  });

  it('sub 与 preferred_username 都缺失时回退到 oid', () => {
    const identity = identityFromClaims({ oid: 'ad-77' });
    expect(identity.user_id).toBe('ad-77');
  });

  it('完全无主体标识时降级为 unknown', () => {
    expect(identityFromClaims({}).user_id).toBe('unknown');
  });

  it('role claim 直接生效', () => {
    const identity = identityFromClaims({ sub: 'u1', role: 'manager' });
    expect(identity.role).toBe('manager');
  });

  it('role claim 非法时按 realm_access.roles 命中平台角色', () => {
    const identity = identityFromClaims({
      sub: 'u1',
      role: 'offline_access',
      realm_access: { roles: ['employee', 'admin'] },
    });
    expect(identity.role).toBe('admin');
  });

  it('role claim 与 realm 角色都无平台角色时降级为 employee', () => {
    const identity = identityFromClaims({
      sub: 'u1',
      realm_access: { roles: ['offline_access', 'uma_authorization'] },
    });
    expect(identity.role).toBe('employee');
  });

  it('租户 / 部门 / 密级来自 eap-context 映射的 claim', () => {
    const identity = identityFromClaims({
      sub: 'u1',
      tenant_id: 't-default',
      dept_id: 'dept-finance',
      sensitivity: 'confidential',
    });
    expect(identity.tenant_id).toBe('t-default');
    expect(identity.dept_id).toBe('dept-finance');
    expect(identity.sensitivity).toBe('confidential');
  });

  it('空串 claim 按缺失处理（Keycloak 属性映射器会下发空串）', () => {
    const identity = identityFromClaims({
      sub: 'u1',
      tenant_id: '',
      dept_id: '',
      sensitivity: '',
    });
    expect(identity.tenant_id).toBe('t-default');
    expect(identity.dept_id).toBe('dept-general');
    expect(identity.sensitivity).toBe('internal');
  });
});
