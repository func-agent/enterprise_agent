/**
 * 缓存抽象 —— 对应 3.1 存储组件 Redis 7（会话 / 队列 / 缓存）。
 *
 * 生产用 Redis（多网关副本共享缓存），单机开发用进程内实现，接口一致。
 */
import { createLogger } from './logger.js';

const log = createLogger('platform:cache');

export interface Cache {
  readonly kind: string;
  init(): Promise<void>;
  close(): Promise<void>;
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  /** 计数型原子操作，用于 QPS 限流等场景 */
  incr(key: string, ttlSeconds?: number): Promise<number>;
}

/** 进程内缓存（单机开发 / 降级） */
export class MemoryCache implements Cache {
  readonly kind = 'memory';
  private store = new Map<string, { value: unknown; expiresAt: number }>();

  async init(): Promise<void> {}

  async close(): Promise<void> {
    this.store.clear();
  }

  async get<T>(key: string): Promise<T | undefined> {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt && hit.expiresAt < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value as T;
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : 0,
    });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async incr(key: string, ttlSeconds?: number): Promise<number> {
    const cur = (await this.get<number>(key)) ?? 0;
    const next = cur + 1;
    const hit = this.store.get(key);
    await this.set(key, next, ttlSeconds ?? (hit?.expiresAt ? Math.ceil((hit.expiresAt - Date.now()) / 1000) : undefined));
    return next;
  }
}

/** Redis 缓存（生产） */
export class RedisCache implements Cache {
  readonly kind = 'redis';
  private client: any = null;

  constructor(private readonly url: string) {}

  async init(): Promise<void> {
    const { createClient } = await import('redis');
    const client = createClient({ url: this.url });
    client.on('error', (err: unknown) => log.warn('Redis 连接错误', { error: String(err) }));
    await client.connect();
    this.client = client;
    log.info('Redis 缓存已连接', { url: this.url.replace(/\/\/[^@]*@/, '//***@') });
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.quit().catch(() => undefined);
      this.client = null;
    }
  }

  async get<T>(key: string): Promise<T | undefined> {
    if (!this.client) return undefined;
    const raw = await this.client.get(key);
    if (raw === null || raw === undefined) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    if (!this.client) return;
    const raw = JSON.stringify(value);
    if (ttlSeconds && ttlSeconds > 0) {
      await this.client.set(key, raw, { EX: ttlSeconds });
    } else {
      await this.client.set(key, raw);
    }
  }

  async del(key: string): Promise<void> {
    if (!this.client) return;
    await this.client.del(key);
  }

  async incr(key: string, ttlSeconds?: number): Promise<number> {
    if (!this.client) throw new Error('Redis 未连接');
    if (!ttlSeconds) return this.client.incr(key);
    return Number(await this.client.eval(
      `local n = redis.call('INCR', KEYS[1])
       if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
       return n`,
      { keys: [key], arguments: [String(ttlSeconds)] },
    ));
  }
}

/** 缓存键命名规范：{层}:{实体}:{标识} */
export const CacheKeys = {
  /** MCP 工具目录（多网关副本共享） */
  toolCatalog: (serverId: string) => `eap:mcp:catalog:${serverId}`,
  /** 会话摘要 */
  session: (sessionId: string) => `eap:session:${sessionId}`,
  /** 虚拟模型定义 */
  virtualModel: (name: string) => `eap:model:${name}`,
  /** 租户配置 */
  tenant: (tenantId: string) => `eap:tenant:${tenantId}`,
  /** 应用级 QPS 滑窗 */
  qps: (appId: string) => `eap:qps:${appId}`,
};
