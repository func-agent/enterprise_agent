import { randomBytes } from 'node:crypto';
import { config } from '@eap/platform-core';

const ROLES = new Set(['employee', 'manager', 'admin', 'platform-admin']);
const SENSITIVITIES = new Set(['public', 'internal', 'confidential']);
const USERNAME_PATTERN = /^[a-z][a-z0-9._-]{1,62}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ManagedUser {
  id: string;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  enabled: boolean;
  role: string;
  tenantId: string;
  deptId: string;
  sensitivity: string;
  serviceAccount: boolean;
}

export interface ManagedUserInput {
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  tenantId: string;
  deptId: string;
  sensitivity: string;
}

export interface ManagedUserUpdate extends Omit<ManagedUserInput, 'username'> {}
export interface ManagedUserMutation {
  user: ManagedUser;
  password?: string;
  sessionRevoked?: boolean;
}

interface KeycloakUserRepresentation {
  id?: string;
  username?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  enabled?: boolean;
  serviceAccountClientId?: string;
  attributes?: Record<string, unknown>;
  [key: string]: unknown;
}

export class KeycloakUserError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'KeycloakUserError';
  }
}

interface UserAdminOptions {
  baseUrl?: string;
  realm?: string;
  clientId?: string;
  clientSecret?: string;
  fetchImpl?: typeof fetch;
}

function attribute(user: KeycloakUserRepresentation, key: string): string {
  const value = user.attributes?.[key];
  if (Array.isArray(value)) return String(value[0] ?? '');
  return value === undefined || value === null ? '' : String(value);
}

function generatedPassword(): string {
  return randomBytes(24).toString('base64url');
}

function validateProfile(input: ManagedUserInput): void {
  if (!USERNAME_PATTERN.test(input.username)) {
    throw new KeycloakUserError(400, 'invalid_username', '用户名需以小写字母开头，长度 2–63，只能包含小写字母、数字、点、下划线和连字符');
  }
  if (!EMAIL_PATTERN.test(input.email) || input.email.length > 254) {
    throw new KeycloakUserError(400, 'invalid_email', '请输入有效且不超过 254 字符的邮箱');
  }
  if (!input.firstName.trim() || !input.lastName.trim() || input.firstName.length > 80 || input.lastName.length > 80) {
    throw new KeycloakUserError(400, 'invalid_name', '名字和姓氏必填，且均不能超过 80 字符');
  }
  if (!ROLES.has(input.role)) {
    throw new KeycloakUserError(400, 'invalid_role', '不支持的平台角色');
  }
  if (!ID_PATTERN.test(input.tenantId) || !ID_PATTERN.test(input.deptId)) {
    throw new KeycloakUserError(400, 'invalid_context_id', '租户和部门 ID 只能包含字母、数字、点、下划线、冒号和连字符，最长 64 字符');
  }
  if (!SENSITIVITIES.has(input.sensitivity)) {
    throw new KeycloakUserError(400, 'invalid_sensitivity', '不支持的数据密级');
  }
}

export class KeycloakUserService {
  private readonly baseUrl: string;
  private readonly realm: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetchImpl: typeof fetch;
  private cachedToken: { value: string; expiresAt: number } | null = null;
  private tokenInflight: Promise<string> | null = null;

  constructor(options: UserAdminOptions = {}) {
    this.baseUrl = (options.baseUrl ?? config.auth.baseUrl).replace(/\/+$/, '');
    this.realm = options.realm ?? config.auth.realm;
    this.clientId = options.clientId ?? config.auth.userAdminClientId;
    this.clientSecret = options.clientSecret ?? config.auth.userAdminClientSecret;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async token(forceRefresh = false): Promise<string> {
    if (!this.clientId || !this.clientSecret) {
      throw new KeycloakUserError(503, 'user_admin_not_configured', '未配置 KEYCLOAK_USER_ADMIN_CLIENT_ID / KEYCLOAK_USER_ADMIN_CLIENT_SECRET');
    }
    if (!forceRefresh && this.cachedToken && this.cachedToken.expiresAt - 30_000 > Date.now()) {
      return this.cachedToken.value;
    }
    if (this.tokenInflight) return this.tokenInflight;
    this.tokenInflight = (async () => {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}/realms/${encodeURIComponent(this.realm)}/protocol/openid-connect/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: this.clientId,
            client_secret: this.clientSecret,
          }).toString(),
        });
      } catch {
        throw new KeycloakUserError(502, 'keycloak_unavailable', '无法连接 Keycloak，请检查服务地址和网络');
      }
      const payload = await response.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error_description?: string };
      if (!response.ok || !payload.access_token) {
        this.cachedToken = null;
        throw new KeycloakUserError(503, 'keycloak_admin_auth_failed', payload.error_description || '用户管理服务账号认证失败，请检查客户端凭据');
      }
      this.cachedToken = {
        value: payload.access_token,
        expiresAt: Date.now() + (payload.expires_in ?? 300) * 1000,
      };
      return payload.access_token;
    })();
    try {
      return await this.tokenInflight;
    } finally {
      this.tokenInflight = null;
    }
  }

  private async request<T>(method: string, path: string, body?: unknown, retry = true): Promise<T> {
    const token = await this.token();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/admin/realms/${encodeURIComponent(this.realm)}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new KeycloakUserError(502, 'keycloak_unavailable', '无法连接 Keycloak，请检查服务地址和网络');
    }
    if (response.status === 401 && retry) {
      this.cachedToken = null;
      await this.token(true);
      return this.request<T>(method, path, body, false);
    }
    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }
    if (!response.ok) {
      const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
      const message = String(record.errorMessage ?? record.error_description ?? record.error ?? `Keycloak 请求失败 HTTP ${response.status}`);
      if (response.status === 404) throw new KeycloakUserError(404, 'user_not_found', '用户不存在');
      if (response.status === 409) throw new KeycloakUserError(409, 'user_conflict', message);
      if (response.status === 400) throw new KeycloakUserError(400, 'invalid_user', message);
      if (response.status === 401 || response.status === 403) {
        throw new KeycloakUserError(503, 'keycloak_admin_forbidden', '用户管理服务账号权限不足，请执行 keycloak-admin.py ensure-user-admin enterprise');
      }
      throw new KeycloakUserError(502, 'keycloak_request_failed', message);
    }
    return payload as T;
  }

  private toManaged(user: KeycloakUserRepresentation): ManagedUser {
    return {
      id: String(user.id ?? ''),
      username: String(user.username ?? ''),
      email: String(user.email ?? ''),
      firstName: String(user.firstName ?? ''),
      lastName: String(user.lastName ?? ''),
      enabled: user.enabled !== false,
      role: attribute(user, 'role') || 'employee',
      tenantId: attribute(user, 'tenant_id') || config.auth.defaultTenantId,
      deptId: attribute(user, 'dept_id') || 'dept-general',
      sensitivity: attribute(user, 'sensitivity') || 'internal',
      serviceAccount: Boolean(user.serviceAccountClientId) || String(user.username ?? '').startsWith('service-account-'),
    };
  }

  private assertHuman(user: KeycloakUserRepresentation): void {
    if (this.toManaged(user).serviceAccount) {
      throw new KeycloakUserError(403, 'protected_user', '服务账号不能通过人员用户页面管理');
    }
  }

  private async byUsername(username: string): Promise<KeycloakUserRepresentation> {
    const users = await this.request<KeycloakUserRepresentation[]>('GET', `/users?username=${encodeURIComponent(username)}&exact=true`);
    const user = users.find((item) => item.username === username);
    if (!user) throw new KeycloakUserError(404, 'user_not_found', '用户不存在');
    return user;
  }

  private verifyAttributes(user: KeycloakUserRepresentation, input: ManagedUserInput): void {
    const expected: Record<string, string> = {
      role: input.role,
      tenant_id: input.tenantId,
      dept_id: input.deptId,
      sensitivity: input.sensitivity,
    };
    for (const [key, value] of Object.entries(expected)) {
      if (attribute(user, key) !== value) {
        throw new KeycloakUserError(502, 'attribute_write_mismatch', `Keycloak 未保存属性 ${key}，请检查 unmanagedAttributePolicy 是否为 ENABLED`);
      }
    }
  }

  async list(): Promise<ManagedUser[]> {
    const pageSize = 200;
    const users: KeycloakUserRepresentation[] = [];
    const seen = new Set<string>();
    for (let first = 0; ; first += pageSize) {
      const page = await this.request<KeycloakUserRepresentation[]>('GET', `/users?first=${first}&max=${pageSize}`);
      let added = 0;
      for (const user of page) {
        const key = String(user.id ?? user.username ?? '');
        if (seen.has(key)) continue;
        seen.add(key);
        users.push(user);
        added++;
      }
      if (page.length < pageSize || added === 0) break;
    }
    return users.map((user) => this.toManaged(user))
      .filter((user) => !user.serviceAccount)
      .sort((a, b) => a.username.localeCompare(b.username));
  }

  async get(id: string): Promise<ManagedUser> {
    const current = await this.request<KeycloakUserRepresentation>('GET', `/users/${encodeURIComponent(id)}`);
    if (!current.username) throw new KeycloakUserError(404, 'user_not_found', '用户不存在');
    const full = await this.byUsername(current.username);
    this.assertHuman(full);
    return this.toManaged(full);
  }

  async create(input: ManagedUserInput): Promise<ManagedUserMutation> {
    validateProfile(input);
    const password = generatedPassword();
    const body = {
      username: input.username,
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      enabled: true,
      emailVerified: true,
      attributes: {
        role: [input.role],
        tenant_id: [input.tenantId],
        dept_id: [input.deptId],
        sensitivity: [input.sensitivity],
      },
      credentials: [{ type: 'password', value: password, temporary: false }],
    };
    await this.request('POST', '/users', body);
    const created = await this.byUsername(input.username);
    try {
      this.verifyAttributes(created, input);
    } catch (err) {
      if (created.id) await this.request('DELETE', `/users/${encodeURIComponent(created.id)}`).catch(() => undefined);
      throw err;
    }
    return { user: this.toManaged(created), password };
  }

  private async logout(id: string): Promise<boolean> {
    try {
      await this.request('POST', `/users/${encodeURIComponent(id)}/logout`);
      return true;
    } catch {
      return false;
    }
  }

  async update(id: string, input: ManagedUserUpdate): Promise<ManagedUserMutation> {
    const summary = await this.request<KeycloakUserRepresentation>('GET', `/users/${encodeURIComponent(id)}`);
    const current = await this.byUsername(String(summary.username ?? ''));
    this.assertHuman(current);
    const profile: ManagedUserInput = { ...input, username: String(current.username ?? '') };
    validateProfile(profile);
    const body = {
      ...current,
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      attributes: {
        ...(current.attributes ?? {}),
        role: [input.role],
        tenant_id: [input.tenantId],
        dept_id: [input.deptId],
        sensitivity: [input.sensitivity],
      },
    };
    await this.request('PUT', `/users/${encodeURIComponent(id)}`, body);
    const updated = await this.byUsername(profile.username);
    this.verifyAttributes(updated, profile);
    const sessionRevoked = await this.logout(id);
    return { user: this.toManaged(updated), sessionRevoked };
  }

  async setEnabled(id: string, enabled: boolean): Promise<ManagedUserMutation> {
    const summary = await this.request<KeycloakUserRepresentation>('GET', `/users/${encodeURIComponent(id)}`);
    const current = await this.byUsername(String(summary.username ?? ''));
    this.assertHuman(current);
    await this.request('PUT', `/users/${encodeURIComponent(id)}`, { ...current, enabled });
    const updated = await this.byUsername(String(current.username ?? ''));
    const sessionRevoked = enabled ? false : await this.logout(id);
    return { user: this.toManaged(updated), sessionRevoked };
  }

  async resetPassword(id: string): Promise<{ password: string; sessionRevoked: boolean }> {
    const current = await this.request<KeycloakUserRepresentation>('GET', `/users/${encodeURIComponent(id)}`);
    this.assertHuman(current);
    const password = generatedPassword();
    await this.request('PUT', `/users/${encodeURIComponent(id)}/reset-password`, {
      type: 'password', value: password, temporary: false,
    });
    const sessionRevoked = await this.logout(id);
    return { password, sessionRevoked };
  }

  async remove(id: string): Promise<void> {
    const current = await this.request<KeycloakUserRepresentation>('GET', `/users/${encodeURIComponent(id)}`);
    this.assertHuman(current);
    await this.request('DELETE', `/users/${encodeURIComponent(id)}`);
  }
}
