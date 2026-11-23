/**
 * 平台配置 —— 全部来自环境变量，便于 K8s Secret / 环境变量托管（见 8.5 凭证安全）。
 * 商业模型 API Key 只在 gateway 进程内可见。
 */

function env(key: string): string | undefined;
function env(key: string, fallback: string): string;
function env(key: string, fallback?: string): string | undefined {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

function num(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function list(key: string, fallback: string[]): string[] {
  const v = process.env[key];
  if (!v) return fallback;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

export const config = {
  /** 平台级标识，用于平台级预算与 Trace */
  platformId: env('EAP_PLATFORM_ID', 'eap-main'),

  gateway: {
    port: num('GATEWAY_PORT', 8080),
    /**
     * 监听地址 —— 默认只绑回环，避免管理面直接暴露在局域网/公网。
     * 容器化部署时 compose 显式设为 0.0.0.0，供同网络容器按服务名互访。
     */
    host: env('GATEWAY_HOST', '127.0.0.1'),
    /** 网关服务根地址（不带 /v1） */
    apiRoot: env('GATEWAY_API_ROOT', 'http://127.0.0.1:8080'),
    /** 对外暴露的 OpenAI 兼容端口，AgentScope 的 ChatModel 指向这里（见 4.1） */
    openaiBaseUrl: env('GATEWAY_OPENAI_BASE_URL', 'http://127.0.0.1:8080/v1'),
    /** 出网代理 —— 唯一出口（见 8.3 出网安全） */
    egressProxyUrl: env('EGRESS_PROXY_URL', ''),
    /** SNI 白名单：仅允许商业 API 域名出网 */
    egressAllowedHosts: list('EGRESS_ALLOWED_HOSTS', [
      'agent.minimaxi.com',
      // MiniMax 公有云（开放平台）—— 与 Mavis 端点并列的另一套服务
      'api.minimax.cn',
      'api.openai.com',
      'dashscope.aliyuncs.com',
      'api.deepseek.com',
      'open.bigmodel.cn',
    ]),
    /** 日志中强制脱敏 Authorization Header（见 4.4 第 4 条） */
    redactAuthorization: bool('GATEWAY_REDACT_AUTHORIZATION', true),
    /**
     * 凭证主密钥 —— 加密控制台写入的 provider 凭证（见 8.5 凭证安全）。
     * 不入库、不进版本库；为空时禁止通过控制台写入凭证（fail closed）。
     */
    credentialMasterKey: env('EAP_CREDENTIAL_MASTER_KEY', ''),
  },

  auth: {
    /** Keycloak realm（见 3.1 身份组件） */
    realm: env('KEYCLOAK_REALM', 'enterprise'),
    /** Keycloak base URL */
    baseUrl: env('KEYCLOAK_BASE_URL', 'http://127.0.0.1:8081'),
    /**
     * 浏览器可达的 Keycloak 地址 —— 控制台 OIDC 授权跳转用。
     * 留空则回落到 baseUrl。生产环境里 Keycloak 往往有独立域名，
     * 与网关容器内地址不同，必须单独配置，否则浏览器拿到的授权地址不可达。
     *
     * 支持 `{host}` 占位符：运行时按**请求的 Host 头**替换主机名（不含端口）。
     * 例如 `http://{host}:8082` —— 同一份配置既能服务本机访问（Host=127.0.0.1），
     * 也能服务公网访问（Host=公网 IP），不必为两种入口各配一套。
     */
    publicBaseUrl: env('KEYCLOAK_PUBLIC_URL', ''),
    /** 控制台 OIDC 客户端 ID（公开客户端 + PKCE，无密钥） */
    webClientId: env('KEYCLOAK_WEB_CLIENT_ID', 'eap-webui'),
    /** 控制台 OIDC 请求的 scope —— 必须含 openid */
    webScope: env('KEYCLOAK_WEB_SCOPE', 'openid profile email'),
    /** JWKS 端点 */
    jwksUri: env('KEYCLOAK_JWKS_URI', ''),
    /**
     * 允许的 issuer 列表（逗号分隔）。
     *
     * Keycloak 默认按**请求的 Host 头**生成 issuer，所以同一个 realm 在不同入口
     * （本机 127.0.0.1 / 公网 IP / 容器网络名）签出的 `iss` 各不相同。
     * 这些入口都要能验签通过，就必须把它们的 issuer 全部列入白名单 ——
     * 漏一个，外网登录拿到的令牌就会被判为「issuer 不匹配」而 401。
     *
     * 留空表示不校验 issuer（仅建议开发环境）。
     */
    issuer: list('KEYCLOAK_ISSUER', []),
    audience: env('KEYCLOAK_AUDIENCE', ''),
    /**
     * 开发模式：允许使用本地 HS256 签发的 dev token。
     * 生产必须为 false —— 真实凭证只允许来自 Keycloak。
     */
    devMode: bool('AUTH_DEV_MODE', true),
    devSecret: env('AUTH_DEV_SECRET', 'dev-only-insecure-secret-change-me'),
    /**
     * 服务账号客户端凭据 —— 组件间内部调用（agent-core / MCP Hub 回调网关）用。
     * 生产模式（AUTH_DEV_MODE=false）下必须配置，否则内部回调会被网关 401。
     */
    serviceClientId: env('KEYCLOAK_SERVICE_CLIENT_ID', ''),
    serviceClientSecret: env('KEYCLOAK_SERVICE_CLIENT_SECRET', ''),
    /** 网关用户管理面专用客户端；演示值与 realm-eap.json 一致，生产必须通过 Secret 替换。 */
    userAdminClientId: env('KEYCLOAK_USER_ADMIN_CLIENT_ID', 'eap-gateway'),
    userAdminClientSecret: env('KEYCLOAK_USER_ADMIN_CLIENT_SECRET', 'eap-gateway-local-secret-2026'),
    /**
     * 服务间静态凭证（逗号分隔）—— 给无法走 OIDC 流程的组件用。
     * 格式：`<token>[:<role>[:<tenantId>[:<deptId>[:<sensitivity>]]]]`
     * 例：`eap-dbgpt-local-key:employee:t-default:dept-general:internal`
     *
     * 注意：服务身份**不旁路任何治理** —— 策略、预算、护栏、审计照常生效；
     * 只把角色限制在平台内置角色内，且默认 employee。
     * 默认留空（不启用）。
     */
    serviceTokens: list('AUTH_SERVICE_TOKENS', []),
    /** 单租户 + 部门隔离模式（见 7.3 首期简化建议） */
    singleTenantMode: bool('AUTH_SINGLE_TENANT_MODE', true),
    defaultTenantId: env('AUTH_DEFAULT_TENANT_ID', 't-default'),
  },

  llm: {
    /**
     * Provider 凭证。仅 gateway 进程可见，业务组件一律不可见（见 4.4 Key 治理第 2 条）。
     * 格式：MINIMAX_API_KEY / OPENAI_API_KEY / ...
     */
    apiKeys: {
      minimax: env('MINIMAX_API_KEY', ''),
      /**
       * MiniMax **公有云**（开放平台 api.minimax.cn）的密钥 ——
       * 与上面 Mavis 端点（agent.minimaxi.com）是两套服务、两把 key，不可混用。
       */
      'minimax-public': env('MINIMAX_PUBLIC_API_KEY', ''),
      openai: env('OPENAI_API_KEY', ''),
      qwen: env('QWEN_API_KEY', ''),
      deepseek: env('DEEPSEEK_API_KEY', ''),
      zhipu: env('ZHIPU_API_KEY', ''),
    },
    baseUrls: {
      minimax: env('MINIMAX_BASE_URL', 'https://agent.minimaxi.com/mavis/api/v1/llm/v1'),
      'minimax-public': env('MINIMAX_PUBLIC_BASE_URL', 'https://api.minimax.cn/v1'),
      openai: env('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
      qwen: env('QWEN_BASE_URL', 'https://dashscope.aliyuncs.com/compatible-mode/v1'),
      deepseek: env('DEEPSEEK_BASE_URL', 'https://api.deepseek.com/v1'),
      zhipu: env('ZHIPU_BASE_URL', 'https://open.bigmodel.cn/api/paas/v4'),
    },
    /** Provider 协议：anthropic = Anthropic Messages，openai = OpenAI Chat Completions */
    protocols: {
      minimax: env('MINIMAX_PROTOCOL', 'anthropic') as 'anthropic' | 'openai',
      'minimax-public': env('MINIMAX_PUBLIC_PROTOCOL', 'openai') as 'anthropic' | 'openai',
      openai: 'openai' as const,
      qwen: 'openai' as const,
      deepseek: 'openai' as const,
      zhipu: 'openai' as const,
      tei: 'tei' as const,
    },
    /** TEI（本地嵌入服务）地址 —— 见 4.2 本地 Embedding */
    teiBaseUrl: env('TEI_BASE_URL', 'http://127.0.0.1:6380'),
    /** TEI 实际加载的模型标识（用于虚拟模型与审计展示） */
    teiModel: env('TEI_MODEL', 'intfloat/multilingual-e5-small'),
    /** Infinity 检索引擎 HTTP 地址 */
    infinityBaseUrl: env('INFINITY_BASE_URL', 'http://127.0.0.1:23821'),
    /** 单次请求超时 */
    timeoutMs: num('LLM_TIMEOUT_MS', 120_000),
    /** 重试次数（同一 target 内部重试，不同 target 之间走 Failover） */
    maxRetries: num('LLM_MAX_RETRIES', 1),
    /** 全局 QPS 限流 */
    defaultQpsLimit: num('LLM_DEFAULT_QPS', 20),
    /**
     * 凭证文件（OAuth 形态）。文件内含 records → accessToken，
     * 运行时动态读取，避免令牌过期后需人工更换。
     */
    credentialFile: env('LLM_CREDENTIAL_FILE', ''),
    /**
     * 允许使用该凭证文件的 Provider 白名单。
     * 必须显式限定 —— 否则 OAuth 令牌可能被发往第三方模型域名。
     */
    credentialProviders: list('LLM_CREDENTIAL_PROVIDERS', ['minimax']),
    /** 鉴权方式：auto（按令牌前缀自动判断）/ bearer / x-api-key */
    authMode: env('LLM_AUTH_MODE', 'auto') as 'auto' | 'bearer' | 'x-api-key',
    authModes: {
      minimax: env('MINIMAX_AUTH_MODE', env('LLM_AUTH_MODE', 'auto')) as 'auto' | 'bearer' | 'x-api-key',
      openai: env('OPENAI_AUTH_MODE', env('LLM_AUTH_MODE', 'bearer')) as 'auto' | 'bearer' | 'x-api-key',
      qwen: env('QWEN_AUTH_MODE', env('LLM_AUTH_MODE', 'bearer')) as 'auto' | 'bearer' | 'x-api-key',
      deepseek: env('DEEPSEEK_AUTH_MODE', env('LLM_AUTH_MODE', 'bearer')) as 'auto' | 'bearer' | 'x-api-key',
      zhipu: env('ZHIPU_AUTH_MODE', env('LLM_AUTH_MODE', 'bearer')) as 'auto' | 'bearer' | 'x-api-key',
    },
  },

  budget: {
    /** 平台级月度预算（USD） */
    platformMonthlyUsd: num('BUDGET_PLATFORM_MONTHLY_USD', 500),
    platformMonthlyTokens: num('BUDGET_PLATFORM_MONTHLY_TOKENS', 100_000_000),
    /** 租户超限后的动作：alert / throttle / circuit_break（见 4.3） */
    tenantOverrunAction: env('BUDGET_TENANT_OVERRUN_ACTION', 'circuit_break') as 'alert' | 'throttle' | 'circuit_break',
    /** 平台级超限只告警不熔断 */
    platformOverrunAction: 'alert' as const,
    /** 预算预警阈值（已用比例） */
    alertRatio: num('BUDGET_ALERT_RATIO', 0.8),
  },

  guardrails: {
    /** 是否启用内置正则脱敏（见 8.2 PII 脱敏） */
    piiMaskingEnabled: bool('GUARDRAILS_PII_MASKING', true),
    /** 是否启用 Prompt 注入检测 */
    injectionDetectionEnabled: bool('GUARDRAILS_INJECTION_DETECTION', true),
    /** 涉密数据强制不出网（见 8.1 / 12 风险 1） */
    blockConfidentialEgress: bool('GUARDRAILS_BLOCK_CONFIDENTIAL_EGRESS', true),
    /** 自定义脱敏规则文件（JSON），由平台组维护（见 8.2 运营要求） */
    customRulesFile: env('GUARDRAILS_CUSTOM_RULES_FILE', ''),
  },

  policy: {
    /** Cedar/CEL 策略文件路径 */
    policyFile: env('POLICY_FILE', ''),
    /** 策略求值模式：enforce（默认拒绝）/ permissive */
    defaultDecision: env('POLICY_DEFAULT_DECISION', 'enforce') as 'enforce' | 'permissive',
  },

  mcp: {
    /** MCP Server 注册表，格式 serverId=url[,url2] */
    servers: list('MCP_SERVERS', [
      'knowledge=http://127.0.0.1:8091/mcp',
      'chatbi=http://127.0.0.1:8092/mcp',
      'business=http://127.0.0.1:8093/mcp',
    ]),
    /** MCP 调用超时 */
    timeoutMs: num('MCP_TIMEOUT_MS', 60_000),
  },

  store: {
    /** metadata | postgres */
    kind: env('STORE_KIND', 'metadata') as 'metadata' | 'postgres',
    sqlitePath: env('STORE_SQLITE_PATH', './data/platform.db'),
    postgresUrl: env('POSTGRES_URL', ''),
  },

  cache: {
    /** memory | redis */
    kind: env('CACHE_KIND', 'memory') as 'memory' | 'redis',
    redisUrl: env('REDIS_URL', 'redis://127.0.0.1:6379'),
    /** 工具目录缓存 TTL（秒） */
    toolCatalogTtlSeconds: num('CACHE_TOOL_CATALOG_TTL', 30),
    /** 会话热数据 TTL（秒） */
    sessionTtlSeconds: num('CACHE_SESSION_TTL', 300),
  },

  objectStore: {
    /** fs | minio */
    kind: env('OBJECT_STORE_KIND', 'fs') as 'fs' | 'minio',
    fsRoot: env('OBJECT_STORE_FS_ROOT', './data/objects'),
    minioEndPoint: env('MINIO_ENDPOINT', '127.0.0.1'),
    minioPort: num('MINIO_PORT', 9000),
    minioAccessKey: env('MINIO_ACCESS_KEY', ''),
    minioSecretKey: env('MINIO_SECRET_KEY', ''),
    minioBucket: env('MINIO_BUCKET', 'eap-audit'),
    /** 版本化（见 3.1 存储组件说明） */
    versioning: bool('OBJECT_STORE_VERSIONING', true),
  },

  observability: {
    /** OTLP 导出目标（Langfuse，见 3.1 观测组件）。需含 /api/public/otel 前缀 */
    otlpEndpoint: env('OTEL_EXPORTER_OTLP_ENDPOINT', ''),
    serviceName: env('OTEL_SERVICE_NAME', 'agentgateway'),
    /** Langfuse 凭证 —— OTLP 用 Basic 鉴权 */
    langfusePublicKey: env('LANGFUSE_PUBLIC_KEY', ''),
    langfuseSecretKey: env('LANGFUSE_SECRET_KEY', ''),
    /** 即时入库版本头（4 = v4 数据模型实时可见） */
    langfuseIngestionVersion: env('LANGFUSE_INGESTION_VERSION', '4'),
    /** 平台环境标识（Langfuse environment） */
    environment: env('EAP_ENVIRONMENT', 'local'),
    /** OTLP 导出超时，避免观测服务阻塞主请求 */
    exportTimeoutMs: num('OTEL_EXPORT_TIMEOUT_MS', 3_000),
    /** 本地 trace 落库（Langfuse 不可用时的降级） */
    localTraceDir: env('LOCAL_TRACE_DIR', './data/traces'),
  },

  agent: {
    port: num('AGENT_PORT', 8090),
    /** 监听地址 —— 默认只绑回环；容器化部署时由 compose 显式设为 0.0.0.0 */
    host: env('AGENT_HOST', '127.0.0.1'),
    /** ReAct 最大迭代轮数 */
    maxIterations: num('AGENT_MAX_ITERATIONS', 12),
    /** RAG 检索 Top-K，控制 Token 成本（见 11.2 上下文压缩） */
    ragTopK: num('AGENT_RAG_TOP_K', 5),
    /** 送入模型的历史消息数量与字符预算 */
    maxHistoryMessages: num('AGENT_MAX_HISTORY_MESSAGES', 32),
    maxHistoryChars: num('AGENT_MAX_HISTORY_CHARS', 32_000),
    /** 单次工具结果回灌模型的字符上限 */
    maxToolResultChars: num('AGENT_MAX_TOOL_RESULT_CHARS', 20_000),
    /** HITL 审批超时 */
    approvalTimeoutMs: num('AGENT_APPROVAL_TIMEOUT_MS', 300_000),
    /** 未显式指定模型时，Agent 与 OpenAI 兼容接口共用的虚拟模型 */
    defaultModel: env('AGENT_DEFAULT_MODEL', 'smart-model'),
  },

  webui: {
    port: num('WEBUI_PORT', 5173),
    apiBaseUrl: env('WEBUI_API_BASE_URL', 'http://127.0.0.1:8080'),
  },

  security: {
    /** 单次请求最大体量（字节） */
    maxBodyBytes: num('SECURITY_MAX_BODY_BYTES', 8 * 1024 * 1024),
    /** 审计归档保留天数（见 8.4） */
    auditRetentionDays: num('AUDIT_RETENTION_DAYS', 90),
  },
} as const;

export type PlatformConfig = typeof config;
