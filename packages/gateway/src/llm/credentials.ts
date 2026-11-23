/**
 * 厂商凭证服务 —— 控制台写入的 provider 凭证的唯一入口（见 8.5 凭证安全）。
 *
 * 为什么要单独一层：
 *   · 方案 4.4 要求「商业 API Key 只存在于网关进程内」，所以 key 不能进业务组件、
 *     也不能进配置文件让人反复改 —— 控制台改完必须**不重启网关**就生效；
 *   · 密文入库（见 platform-core/crypto.ts），只有网关持有主密钥才能还原；
 *   · 热路径（每次模型调用）不能查库，所以这里维护一份进程内快照：
 *     写入时主动更新快照（立即生效），同时按 TTL 兜底刷新（多副本场景）。
 *
 * 解析优先级：**控制台(DB) > 环境变量 > OAuth 凭证文件**。
 * 控制台优先级最高，因为它是运维显式表达的「这把 key 现在作数」。
 */
import {
  config,
  createLogger,
  decryptSecret,
  encryptSecret,
  maskSecret,
  type MetadataStore,
  type ProviderCredential,
  type ProviderCredentialView,
} from '@eap/platform-core';

import { credentialStorageKey, providerEnvPrefix } from './provider-config.js';

const log = createLogger('gateway:credentials');

/**
 * 兜底刷新周期。
 *
 * 写入路径会主动刷新快照，所以「改完不重启」是**立即**的；
 * 这个 TTL 只用于兜底：多副本部署时别的副本改了 key，本副本最多 30s 后跟上。
 */
const CACHE_TTL_MS = 30_000;

/** 已加载到内存的控制台凭证（明文只在网关进程内存里） */
export interface LoadedCredential {
  provider: string;
  key: string;
  updatedAt: string;
  updatedBy: string;
}

/** 凭证写入失败（缺主密钥 / 参数非法） */
export class CredentialError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'CredentialError';
  }
}

export class CredentialService {
  /** 控制台凭证快照（provider → 明文）。热路径只读这里，不查库。 */
  private snapshot = new Map<string, LoadedCredential>();
  private timer?: NodeJS.Timeout;
  private providerLookup?: (provider: string) => { baseUrl: string } | undefined;

  constructor(private readonly store: MetadataStore) {}

  setProviderLookup(lookup: (provider: string) => { baseUrl: string } | undefined): void {
    this.providerLookup = lookup;
  }

  /** 启动时加载 + 周期兜底刷新 */
  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, CACHE_TTL_MS);
    // 不阻止进程退出
    this.timer.unref?.();
    log.info('厂商凭证服务就绪', {
      providers: [...this.snapshot.keys()],
      masterKeyConfigured: !!config.gateway.credentialMasterKey,
    });
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * 从库里重新加载全部控制台凭证。
   *
   * 解密失败（主密钥不对 / 密文被篡改）的记录会被跳过并告警 ——
   * 宁可回落到环境变量，也不要拿一把错误的 key 去打厂商接口。
   */
  async refresh(): Promise<void> {
    if (!config.gateway.credentialMasterKey) {
      // 没有主密钥 = 读不出任何控制台凭证（fail closed）。
      // 不清空快照会让旧明文继续被使用，主密钥缺失时必须立刻失效。
      if (this.snapshot.size) {
        log.warn('凭证主密钥缺失，已缓存的控制台凭证全部失效', { count: this.snapshot.size });
      }
      this.snapshot.clear();
      return;
    }
    const next = new Map<string, LoadedCredential>();
    try {
      const rows = await this.store.listProviderCredentials();
      for (const row of rows) {
        const plain = decryptSecret(row.secretCipher, config.gateway.credentialMasterKey);
        if (!plain) {
          log.warn('控制台凭证解密失败，已忽略', { provider: row.provider });
          continue;
        }
        next.set(row.provider, {
          provider: row.provider,
          key: plain,
          updatedAt: row.updatedAt,
          updatedBy: row.updatedBy,
        });
      }
    } catch (err) {
      // 读库失败时沿用既有快照，避免一次抖动就让所有 key 失效
      log.warn('加载控制台凭证失败，沿用既有缓存', { error: String(err) });
      return;
    }
    this.snapshot = next;
  }

  /** 同步查询当前生效的控制台凭证（热路径用） */
  peek(provider: string, account = 'default'): LoadedCredential | undefined {
    return this.snapshot.get(credentialStorageKey(provider, account));
  }

  /** 该 provider 是否已有控制台凭证 */
  has(provider: string, account = 'default'): boolean {
    return this.snapshot.has(credentialStorageKey(provider, account));
  }

  /**
   * 写入（控制台）—— 加密落库 + 立即刷新快照。
   *
   * 写入后**不需要重启网关**：快照当场更新，后续请求立刻用新 key。
   */
  async set(provider: string, plainKey: string, updatedBy: string, account = 'default'): Promise<ProviderCredentialView> {
    const masterKey = config.gateway.credentialMasterKey;
    if (!masterKey) {
      throw new CredentialError(
        '未配置凭证主密钥 EAP_CREDENTIAL_MASTER_KEY，禁止通过控制台写入厂商凭证',
        503,
      );
    }
    const storageKey = credentialStorageKey(provider, account);
    const row: ProviderCredential = {
      provider: storageKey,
      secretCipher: encryptSecret(plainKey, masterKey),
      source: 'console',
      updatedAt: new Date().toISOString(),
      updatedBy,
    };
    await this.store.upsertProviderCredential(row);
    this.snapshot.set(storageKey, {
      provider: storageKey,
      key: plainKey,
      updatedAt: row.updatedAt,
      updatedBy,
    });
    log.info('厂商凭证已更新', { provider, account, updatedBy });
    return this.view(storageKey);
  }

  /** 删除（回落到环境变量 / OAuth 凭证文件） */
  async remove(provider: string, account = 'default'): Promise<boolean> {
    const storageKey = credentialStorageKey(provider, account);
    const removed = await this.store.deleteProviderCredential(storageKey);
    this.snapshot.delete(storageKey);
    if (removed) log.info('厂商凭证已删除', { provider, account });
    return removed;
  }

  /**
   * 全部 provider 的对外视图 —— **永不返回明文**。
   *
   * 列表范围 = 网关认识的所有 provider（配置过 key / baseUrl 的）
   *           + 已在控制台写入过的（即便环境变量里没配地址）。
   */
  list(): ProviderCredentialView[] {
    const providers = new Set<string>([
      ...Object.keys(config.llm.apiKeys),
      ...Object.keys(config.llm.baseUrls),
      ...this.snapshot.keys(),
    ]);
    for (const provider of Object.keys(config.llm.baseUrls)) {
      for (let index = 2; index <= 4; index++) {
        if (process.env[`${providerEnvPrefix(provider)}_API_KEY_${index}`]) {
          providers.add(credentialStorageKey(provider, `acct-${index}`));
        }
      }
    }
    return [...providers].sort().map((p) => this.view(p));
  }

  /** 单个 provider 的对外视图 —— 同样永不返回明文 */
  view(storageKey: string): ProviderCredentialView {
    const separator = storageKey.indexOf('#');
    const provider = separator < 0 ? storageKey : storageKey.slice(0, separator);
    const account = separator < 0 ? 'default' : storageKey.slice(separator + 1);
    const baseUrlConfigured = !!(
      (config.llm.baseUrls as Record<string, string>)[provider] ?? this.providerLookup?.(provider)?.baseUrl ?? ''
    );
    const accountField = account === 'default' ? {} : { account };
    const c = this.snapshot.get(storageKey);
    if (c) {
      return {
        provider,
        ...accountField,
        configured: true,
        masked: maskSecret(c.key),
        source: 'console',
        updatedAt: c.updatedAt,
        updatedBy: c.updatedBy,
        baseUrlConfigured,
      };
    }
    const accountNumber = /^acct-([2-4])$/.exec(account)?.[1];
    const envKey = account === 'default'
      ? ((config.llm.apiKeys as Record<string, string>)[provider] ?? '')
      : accountNumber
        ? (process.env[`${providerEnvPrefix(provider)}_API_KEY_${accountNumber}`] ?? '')
        : '';
    if (envKey) {
      return {
        provider,
        ...accountField,
        configured: true,
        masked: maskSecret(envKey),
        source: 'env',
        updatedAt: '',
        updatedBy: '环境变量',
        baseUrlConfigured,
      };
    }
    if (account === 'default' && config.llm.credentialFile && config.llm.credentialProviders.includes(provider)) {
      return {
        provider,
        configured: true,
        masked: '***',
        source: 'credential-file',
        updatedAt: '',
        updatedBy: 'OAuth 凭证文件',
        baseUrlConfigured,
      };
    }
    return {
      provider,
      ...accountField,
      configured: false,
      masked: '',
      source: 'none',
      updatedAt: '',
      updatedBy: '',
      baseUrlConfigured,
    };
  }
}
