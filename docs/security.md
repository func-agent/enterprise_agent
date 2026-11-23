# 安全与合规设计落地

> 对应方案第 8 章「安全与合规设计」与第 12 章「风险与应对」。

## 8.1 数据分级与路由

| 数据级别 | 处理路径 | 实现位置 |
|---|---|---|
| 涉密 / 敏感 | 强制本地：BGE 嵌入 + 不出网（Cedar 策略强制路由） | `gateway/src/guardrails/index.ts`（`classifyText` + `blockConfidentialEgress`） |
| 内部普通 | 网关内置正则脱敏后出网 | `guardrails/index.ts`（`maskPii`） |
| 公开 | 正常出网 | — |

**强制点**：涉密判定同时看「调用方声明的密级」与「文本中的机密标记」（绝密/机密/涉密/CONFIDENTIAL 等）。
命中任一即**直接阻断请求，不做脱敏后放行**——这是与「先脱敏再出网」的本质区别。

对应策略层还有一条独立防线：`deny-confidential-egress` 策略在 CEL 层面对 `principal.sensitivity == 'confidential'` 的
模型调用一律拒绝。护栏与策略双重保险，即使护栏被绕过，策略仍会拦截。

## 8.2 PII 脱敏（双保险）

**保险一 · 网关侧**（`guardrails/index.ts` 内置正则）：

| 规则 | 说明 | 占位符 |
|---|---|---|
| 身份证号 | 18 位（含校验位） | `{{id_card}}` |
| 手机号 | 中国大陆 11 位 | `{{phone}}` |
| 银行卡号 | 16–19 位 | `{{bank_card}}` |
| 内部工号 | `EMP` + 6–10 位数字 | `{{employee_id}}` |
| 密钥格式 | `sk-` 前缀 | `{{secret_key}}` |
| 邮箱 | 通用邮箱正则 | `{{email}}` |

规则库由平台组以配置文件形式维护（`GUARDRAILS_CUSTOM_RULES_FILE`），持续迭代，无需改代码。

**保险二 · 数据源侧**：DB-GPT 开启内置脱敏；本项目 ChatBI 的工具返回值同样过网关脱敏（`maskOutput`）。

**运营要求**（方案 8.2）：
- 上线前用真实样本回归测试脱敏规则覆盖度 → `tests/guardrails.test.ts` 提供可扩展的回归测试骨架
- 复杂场景靠数据分级路由兜底：敏感部门数据直接禁止出网

## 8.3 出网安全

1. **出网代理是唯一出口**：Envoy 编排见 `deploy/compose/envoy/envoy.yaml`，TLS inspector 监听器 + SNI 白名单，
   白名单外 SNI 直接 403；配置 `access_log` 输出到 stdout 供审计。
2. **网关自身也做白名单校验**：`assertEgressAllowed()` 在每次 Provider 请求发出前校验目标域名是否在
   `EGRESS_ALLOWED_HOSTS` 内，不在则抛 `ProviderError(403)`。这是纵深防御——即使有人绕过代理改配置，
   网关也不会把请求发往未授权域名。
3. **网关脱敏 + 注入防护**：见 8.2 与下节。

### Prompt 注入检测规则

| 规则 | 严重级 |
|---|---|
| 忽略既有指令（中文变体） | high |
| Ignore previous instructions（英文变体） | high |
| 泄露系统提示（reveal/show your system prompt） | high |
| 角色劫持（你现在是 DAN / act as jailbreak） | high |
| 绕过安全（绕过护栏 / disable safety） | high |
| 系统提示词标记（`<system>` / `[SYSTEM]`） | medium |
| 疑似编码载荷（超长 Base64） | medium |

命中 high 级直接阻断请求并记审计；medium 级记录但不阻断。

## 8.4 审计要求

| 审计项 | 存储要求 | 实现 |
|---|---|---|
| 全链路 Trace | Langfuse + ClickHouse，含 tenant/user/session/trace_id | `gateway/src/observability/tracing.ts`；本地降级落 `traces` 表 |
| 请求与响应留痕 | 脱敏后存 MinIO（版本化），保留 90 天以上 | `gateway/src/audit/service.ts` → `ObjectStore`；归档路径 `audit/{tenant}/{date}/{id}.json` |
| 工具调用与数据范围 | 每次 MCP 调用记录 user + tool + data_scope | `audit/service.ts` 的 `detail.dataScope` 字段 |
| 管理操作 | 租户开通 / 配额变更 / Key 轮换全记录 | `routes/admin.ts` 的 `auditAdmin()` 包装所有写操作 |

**可还原性**：`GET /v1/admin/audit/:traceId` 返回该 trace 下全部审计事件与 Trace 记录，可完整还原任一次调用。

## 8.5 凭证安全

| 要求 | 实现 |
|---|---|
| 商业 API Key 仅在网关侧托管，可由 K8s Secret / 环境变量或控制台加密落库 | 凭证解析集中在 `CredentialResolver`，只有 `ProviderAdapter` 引用；Agent / MCP Server 拿不到 |
| 数据库凭证由 MCP Server 内部持有最小权限只读账号，不下发模型 | ChatBI 沙箱以 `readonly: true` + `query_only = ON` 打开数据库 |
| 网关日志 Authorization Header 强制脱敏 | `platform-core/src/logger.ts` 对 `authorization / apiKey / token / secret / cookie` 等键统一替换为 `***REDACTED***` |
| 季度人工轮换 | 凭证文件形态（`LLM_CREDENTIAL_FILE`）支持运行时动态读取，令牌轮换无需改配置重启 |
| 轮换操作记录到受控文档 | 由运维流程保证；代码侧提供 `.env.example` 占位符模板 |

### 控制台托管的厂商凭证（新增）

控制台「模型」页可以直接粘贴商业大模型 Key，**不再依赖改配置文件 + 重启网关**：

| 维度 | 做法 |
|---|---|
| 落库 | AES-256-GCM 加密（`platform-core/src/crypto.ts`），密文格式 `v1:<iv>:<tag>:<ct>`；库里没有明文 |
| 主密钥 | `EAP_CREDENTIAL_MASTER_KEY` 只在网关进程环境变量里，不入库、不进版本库；**没配就禁写**（fail closed） |
| 谁能写 | 只有 `admin` / `platform-admin` 能写删；普通登录用户只能读视图 |
| 视图返回 | 只回掩码（`***xxxx`）+ 来源 + 更新时间，**明文永不回传浏览器** |
| 生效 | 写入时网关当场刷新进程内快照，**不重启即生效**；多副本靠 30s TTL 兜底刷新 |
| 审计 | `provider.credential.set` / `.delete` 事件只记掩码，**明文不进审计流水** |
| 来源优先级 | 控制台(DB) > 环境变量 > OAuth 凭证文件；删控制台凭证自动回落下一级 |
| 组件边界 | 不变 —— 厂商 key 仍然只有网关进程可见，RAGFlow / DB-GPT 只拿网关服务间令牌 |

自定义 Provider 的连接配置不含密钥，保存在 `provider_definitions` 表。每个账号使用独立的 `provider#account` 凭证记录；缩减账号池或删除厂商前，网关会检查虚拟模型引用，被移除账号的控制台密钥同步清理。公网 BASE_URL 必须使用 HTTPS，HTTP 仅限环回、私有地址或单标签内网服务名，禁止 URL 内嵌凭证、查询参数、链路本地及组播地址。自定义 Provider 只允许访问配置中的确切主机；公网域名仍须同步进入部署侧 Envoy 白名单，页面配置不构成网络层绕过。

严格性细节：base64 解码做了**回环校验**（解码后再编码必须与原文逐字节相同）——
Node 的 base64 解码器会静默吞掉尾部多余字符，不加这层校验，「密文被篡改」会漏检。

**额外加固**：OAuth 凭证文件只对 `LLM_CREDENTIAL_PROVIDERS` 白名单内的 Provider 生效
（默认仅 `minimax`）。这是必要的——否则同一个 OAuth 令牌可能被发往 `api.openai.com` 等第三方域名，
造成令牌泄漏。该约束在 `CredentialResolver.resolve()` 中强制。

### 控制台托管的 Keycloak 用户管理

「用户与权限」页面只允许 `platform-admin` 使用，管理接口独立于普通模型管理权限。浏览器只访问网关 `/v1/admin/users/*`；网关使用独立的 `eap-gateway` 服务账号及 `view-users / manage-users` 最小权限访问 enterprise realm，不下发 `kc-admin`，也不给 Agent 的 `eap-agent` 服务账号增加用户管理权限。部署时通过 `python3 scripts/keycloak-admin.py ensure-user-admin enterprise` 幂等配置角色。

Keycloak 是人员身份的唯一事实来源，平台数据库不保存人员密码。新建和重置密码使用加密安全随机数，只在当前响应中返回一次；密码不得进入日志、审计、Trace 或平台数据库。修改用户采用完整用户表示合并写入并回读平台属性，避免全量 PUT 清空档案和属性被静默丢弃。用户列表按 200 人一页累计读取，全部页面加载后再排除服务账号，不会因人数超过 1000 而漏人。邮箱在审计中继续按 PII 口径掩码，额外记录 `emailChanged` 布尔标记，用于判断是否发生邮箱变更，不保存可回溯的明文邮箱历史。

当前账号不能删除、停用或修改自身角色与租户；最后一个启用中的平台管理员不能被降级、停用或删除。编辑、停用和重置密码会尝试注销目标用户的现有会话，已签发 access token 仍可能在剩余有效期内使用。删除操作有二次确认，历史会话和审计保留原 `sub`，不得以删除重建代替权限调整。

## 7.2 租户/部门/用户三级隔离

| 层级 | 隔离项 | 实现 |
|---|---|---|
| 租户 | 模型白名单 / 工具白名单 / 知识库 / 预算配额 | `Tenant` 表 + `McpRegistry.catalog()` + `router.chat()` + `BudgetService` |
| 部门 | 文档可见范围 / 数据行级权限 | 文档按 `dept_id` 召回前过滤；业务工具按 `role` / `dept_id` 行级过滤 |
| 用户 | 会话 / 个人配置 / 操作记录 | 会话按 `tenant_id + user_id` 隔离；审计含 `user_id` |

## 越权防护（方案风险 4：权限过滤失效）

四道防线，任何一道单独失效都不会造成越权：

1. **目录层**：`knowledge.search` 在打分前按 tenant/dept/sensitivity 裁剪候选集
2. **网关层**：CEL 策略 `deny-confidential-egress` + 租户工具白名单
3. **MCP 层**：网关注入 `__ctx`，MCP Server 据此做行级过滤；无权限的工具直接返回错误
4. **数据层**：只读连接 + `query_only`，物理上无法写库

上线前应执行渗透测试，重点覆盖「跨部门文档召回」「跨租户工具调用」「越权审批」三类用例。

---

## 已知局限

| 局限 | 影响 | 后续动作 |
|---|---|---|
| Infinity / TEI 不可用时自动降级为纯 BM25 | 降级期间语义类问题召回率低于混合检索 | 监控实际检索引擎并恢复依赖；权限过滤语义保持一致 |
| 脱敏为正则规则，覆盖度有限（方案风险 2 已列明） | 新型 PII 格式可能漏网 | 上线前用真实样本回归测试；敏感部门直接禁出网兜底 |
| 开发态登录接口默认开启 | 生产环境存在绕过 Keycloak 的风险 | 生产务必 `AUTH_DEV_MODE=false`，并接入 Keycloak realm |
| 无 GPU | 大规模嵌入与文档解析较慢 | 方案 9.1：文档量极大时再评估加 1 张 GPU |
