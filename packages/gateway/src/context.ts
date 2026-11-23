/**
 * 服务容器 —— 组装网关全部依赖（见 2.1 总体架构分层）。
 */
import {
  config,
  createLogger,
  FsObjectStore,
  MemoryCache,
  MinioObjectStore,
  PgMetadataStore,
  RedisCache,
  SqliteMetadataStore,
  type Cache,
  type MetadataStore,
  type ObjectStore,
} from '@eap/platform-core';
import { AuthService } from '@eap/auth-middleware';
import { McpClientManager } from '@eap/mcp-hub';
import { ProviderRegistry } from './llm/providers.js';
import { CredentialService } from './llm/credentials.js';
import { BudgetService } from './llm/budget.js';
import { LlmRouter } from './llm/router.js';
import { PolicyEngine } from './policy/engine.js';
import { GuardrailService } from './guardrails/index.js';
import { AuditService } from './audit/service.js';
import { McpRegistry } from './mcp/registry.js';
import { TracingService } from './observability/tracing.js';
import { KeycloakUserService } from './identity/user-admin.js';

const log = createLogger('gateway');

export interface AppContext {
  store: MetadataStore;
  objects: ObjectStore;
  cache: Cache;
  providers: ProviderRegistry;
  /** 厂商凭证服务 —— 控制台写入的 key 在这里解密、缓存、审计 */
  credentials: CredentialService;
  budget: BudgetService;
  policy: PolicyEngine;
  guardrails: GuardrailService;
  audit: AuditService;
  router: LlmRouter;
  mcp: McpRegistry;
  clients: McpClientManager;
  auth: AuthService;
  tracing: TracingService;
  userAdmin: KeycloakUserService;
}

export async function createContext(): Promise<AppContext> {
  // —— 存储（生产 PostgreSQL 16，开发 SQLite，接口一致）
  const store: MetadataStore =
    config.store.kind === 'postgres' && config.store.postgresUrl
      ? new PgMetadataStore(config.store.postgresUrl)
      : new SqliteMetadataStore(config.store.sqlitePath);
  await store.init();

  const objects: ObjectStore =
    config.objectStore.kind === 'minio'
      ? new MinioObjectStore(
          {
            endPoint: config.objectStore.minioEndPoint,
            port: config.objectStore.minioPort,
            accessKey: config.objectStore.minioAccessKey,
            secretKey: config.objectStore.minioSecretKey,
            bucket: config.objectStore.minioBucket,
          },
          config.security.auditRetentionDays,
        )
      : new FsObjectStore(config.objectStore.fsRoot, config.security.auditRetentionDays);
  await objects.init();

  // —— 缓存（生产 Redis 7，多副本共享；单机用进程内）
  let cache: Cache =
    config.cache.kind === 'redis'
      ? new RedisCache(config.cache.redisUrl)
      : new MemoryCache();
  try {
    await cache.init();
  } catch (err) {
    log.warn('缓存初始化失败，降级为进程内缓存', { error: String(err) });
    cache = new MemoryCache();
    await cache.init();
  }

  // —— 治理组件
  // 厂商凭证服务先于 provider 注册表启动：控制台写入的 key 要在注册时就可见，
  // 否则「启动后才配 key」的 provider 不会被注册（见 llm/credentials.ts）
  const credentials = new CredentialService(store);
  await credentials.start();

  const providers = new ProviderRegistry(credentials, store);
  await providers.start();
  const policy = new PolicyEngine();
  const guardrails = new GuardrailService();
  const budget = new BudgetService(store, cache);
  const audit = new AuditService(store, objects, guardrails);
  const tracing = new TracingService(store, {
    otlpEndpoint: config.observability.otlpEndpoint,
    publicKey: config.observability.langfusePublicKey,
    secretKey: config.observability.langfuseSecretKey,
    ingestionVersion: config.observability.langfuseIngestionVersion,
    environment: config.observability.environment,
    serviceName: config.observability.serviceName,
    timeoutMs: config.observability.exportTimeoutMs,
  });

  // —— MCP
  const clients = new McpClientManager(
    McpClientManager.parseServers(config.mcp.servers),
    cache,
  );
  const mcp = new McpRegistry(clients, store, policy, guardrails, audit, budget);

  // —— 路由
  const router = new LlmRouter(providers, budget, policy, guardrails, audit, store);
  await router.seedVirtualModels();

  // —— 鉴权
  const auth = new AuthService();

  log.info('网关上下文就绪', {
    store: config.store.kind,
    objectStore: objects.kind,
    cache: cache.kind,
    providers: providers.list(),
    mcpServers: clients.listServers().map((s) => s.id),
  });

  return {
    store, objects, cache, providers, credentials, budget, policy, guardrails, audit,
    router, mcp, clients, auth, tracing, userAdmin: new KeycloakUserService(),
  };
}
