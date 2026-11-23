import type { ProviderDefinition } from '@eap/platform-core';

export class ProviderConfigError extends Error {
  /**
   * 全部校验问题。
   *
   * 为什么要收集而不是「遇到第一个错就抛」：
   *   逐字段短路意味着用户提交一次只能看到一个问题，改一个再提交又看到下一个 ——
   *   字段多的时候要来回试好几轮。一次性把**所有**问题列出来，
   *   用户改一轮就能改对。
   */
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    const list = issues.length ? issues : [message];
    // 多个问题时加个抬头，界面上才知道这是一份清单而不是一句话
    super(list.length > 1 ? `以下 ${list.length} 项需要修正：\n${list.join('\n')}` : message);
    this.name = 'ProviderConfigError';
    this.issues = list;
  }
}

const NAME_PATTERN = /^[a-z][a-z0-9._-]{0,62}$/;
const ACCOUNT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function providerEnvPrefix(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

export function credentialStorageKey(provider: string, account = 'default'): string {
  return account === 'default' ? provider : `${provider}#${account}`;
}

export function isPrivateProviderHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1') return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (/^10(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (/^192\.168(?:\.\d{1,3}){2}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}$/.test(host)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true;
  return /^[a-z0-9](?:[a-z0-9-]{0,62})?$/.test(host);
}

function assertSafeHost(hostname: string): void {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === '0.0.0.0' || host === '::' || host === '255.255.255.255' ||
    /^169\.254\./.test(host) || /^fe80:/i.test(host) || /^ff[0-9a-f]{2}:/i.test(host) ||
    /^2(?:2[4-9]|[3-9]\d)\./.test(host)
  ) {
    throw new ProviderConfigError(`BASE_URL 不允许使用保留、链路本地或组播地址：${hostname}`);
  }
}

export function normalizeProviderBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new ProviderConfigError('BASE_URL 不能为空');
  if (value.length > 500) throw new ProviderConfigError('BASE_URL 不能超过 500 个字符');
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ProviderConfigError('BASE_URL 不是合法 URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ProviderConfigError('BASE_URL 仅支持 HTTP / HTTPS');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new ProviderConfigError('BASE_URL 不能包含用户名、密码、查询参数或片段');
  }
  assertSafeHost(url.hostname);
  if (url.protocol === 'http:' && !isPrivateProviderHost(url.hostname)) {
    throw new ProviderConfigError('BASE_URL 公网地址必须使用 HTTPS；HTTP 仅允许环回、私有地址或单标签内网服务名');
  }
  return url.toString().replace(/\/$/, '');
}

export function publicProviderUrl(value: string): string {
  try {
    return normalizeProviderBaseUrl(value);
  } catch {
    return '';
  }
}

export function parseProviderDefinition(
  value: unknown,
  fixedName?: string,
): Omit<ProviderDefinition, 'createdAt' | 'updatedAt' | 'updatedBy'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProviderConfigError('请求体必须是 Provider 配置对象');
  }
  const input = value as Record<string, unknown>;
  // 收集**全部**问题再一次性抛出 —— 避免用户一轮只改一个字段
  const issues: string[] = [];

  const name = fixedName ?? (typeof input.name === 'string' ? input.name.trim() : '');
  if (!name) {
    issues.push('Provider 名不能为空');
  } else if (!NAME_PATTERN.test(name)) {
    issues.push('Provider 名须以小写字母开头，仅含小写字母、数字、点、下划线和连字符，最长 63 字符');
  }
  if (fixedName && input.name !== undefined && input.name !== fixedName) {
    issues.push('Provider 名创建后不可修改');
  }
  if (input.protocol !== 'openai' && input.protocol !== 'anthropic') {
    issues.push('协议必须为 openai 或 anthropic');
  }
  if (input.authMode !== 'auto' && input.authMode !== 'bearer' && input.authMode !== 'x-api-key') {
    issues.push('认证方式必须为 auto、bearer 或 x-api-key');
  }
  if (typeof input.enabled !== 'boolean') issues.push('enabled 必须为布尔值');

  let accounts: string[] = [];
  if (!Array.isArray(input.accounts) || input.accounts.length < 1 || input.accounts.length > 8) {
    issues.push('账号池必须包含 1–8 个账号别名');
  } else {
    const aliases: string[] = [];
    input.accounts.forEach((account, index) => {
      if (typeof account !== 'string' || !ACCOUNT_PATTERN.test(account.trim())) {
        issues.push(`第 ${index + 1} 个账号别名仅支持字母、数字、点、下划线和连字符，最长 64 字符`);
        return;
      }
      aliases.push(account.trim());
    });
    if (aliases.length === input.accounts.length) {
      if (!aliases.includes('default')) issues.push('账号池必须包含 default 默认账号');
      if (new Set(aliases).size !== aliases.length) issues.push('账号别名不能重复');
      accounts = aliases;
    }
  }

  let baseUrl = '';
  try {
    baseUrl = normalizeProviderBaseUrl(input.baseUrl);
  } catch (err) {
    issues.push(err instanceof Error ? err.message : String(err));
  }

  if (issues.length) {
    throw new ProviderConfigError(issues.join('\n'), issues);
  }
  return {
    name,
    baseUrl,
    protocol: input.protocol as 'openai' | 'anthropic',
    authMode: input.authMode as 'auto' | 'bearer' | 'x-api-key',
    accounts,
    enabled: input.enabled as boolean,
  };
}
