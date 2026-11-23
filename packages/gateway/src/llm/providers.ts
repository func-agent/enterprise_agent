/**
 * Provider 适配层 —— 对接商业大模型 API（见 4.4 商业大模型接入与 Key 管理）。
 *
 * 两种协议：
 *  - anthropic : Anthropic Messages API（x-api-key + anthropic-version）
 *  - openai    : OpenAI Chat Completions 兼容协议
 *
 * 所有出网请求必须经出网代理并通过 SNI 白名单校验（见 8.3）。
 */
import { config, isEgressAllowed, createLogger } from '@eap/platform-core';
import { readFileSync } from 'node:fs';
import type { ChatMessage, ToolCall, ToolSpec } from '@eap/platform-core';
import { egressFetch } from './egress.js';
import type { CredentialService } from './credentials.js';
import { providerEnvPrefix, publicProviderUrl } from './provider-config.js';
import type { MetadataStore, ProviderConnectionView, ProviderDefinition } from '@eap/platform-core';

const log = createLogger('gateway:provider');

function requestSignal(timeoutMs: number, parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

export interface ProviderChatInput {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens: number;
  timeoutMs: number;
  account?: string;
  signal?: AbortSignal;
}

export interface ProviderChatResult {
  content: string;
  toolCalls: ToolCall[];
  promptTokens: number;
  completionTokens: number;
  /** 推理模型返回的思考内容（与正文分离） */
  thinking?: string;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryable: boolean,
    public readonly provider: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** 账号池：每个 Provider 开 2+ 个子账号，应对单 Key RPM/TPM 限制（见 4.4 Key 治理第 1 条） */
export interface ProviderAccount {
  alias: string;
  apiKey: string;
}

/**
 * 凭证解析器 —— 运行时动态读取，支持 OAuth 形态（令牌会轮换/过期）。
 * 鉴权方式：
 *   - 凭证文件 / 以 mmoa 开头的令牌 → Authorization: Bearer
 *   - 普通 sk- 密钥 → x-api-key
 */
export interface ResolvedCredential {
  key: string;
  mode: 'bearer' | 'x-api-key';
}

/**
 * 控制台写入的凭证查询 —— 同步快照（热路径不查库）。
 * 见 llm/credentials.ts。
 */
export type DynamicCredentialLookup = (provider: string, account: string) => { key: string } | undefined;

export class CredentialResolver {
  constructor(
    private readonly credentialFile: string,
    private readonly authMode: 'auto' | 'bearer' | 'x-api-key',
    /** 允许使用该文件的 Provider 白名单 —— 防止令牌外泄到第三方域名 */
    private readonly allowedProviders: string[],
    private readonly providerAuthModes: Record<string, 'auto' | 'bearer' | 'x-api-key'> = {},
    /** 控制台写入的厂商凭证（优先级最高） */
    private readonly dynamic?: DynamicCredentialLookup,
    private readonly dynamicConfig?: (provider: string) => { authMode: 'auto' | 'bearer' | 'x-api-key'; protocol: string } | undefined,
  ) {}

  private modeFor(provider: string, key: string): 'bearer' | 'x-api-key' {
    const dynamic = this.dynamicConfig?.(provider);
    const configured = dynamic?.authMode ?? this.providerAuthModes[provider] ?? this.authMode;
    if (configured !== 'auto') return configured;
    if (key.startsWith('mmoa')) return 'bearer';
    if (dynamic?.protocol === 'anthropic') return 'x-api-key';
    return provider === 'minimax' ? 'x-api-key' : 'bearer';
  }

  /** 从 OAuth 凭证文件读取当前 accessToken */
  private readOAuthToken(): string | undefined {
    if (!this.credentialFile) return undefined;
    try {
      const raw = JSON.parse(readFileSync(this.credentialFile, 'utf8')) as {
        records?: Record<string, unknown>;
      };
      const records = Object.values(raw.records ?? {});
      if (!records.length) return undefined;
      const rec = (typeof records[0] === 'string' ? JSON.parse(records[0] as string) : records[0]) as {
        accessToken?: string;
        expiresAtMs?: number;
      };
      if (!rec.accessToken) return undefined;
      // 过期则不返回，交由上层报错而非用坏令牌
      if (rec.expiresAtMs && rec.expiresAtMs < Date.now()) return undefined;
      return rec.accessToken;
    } catch {
      return undefined;
    }
  }

  /**
   * 解析当前生效的凭证。
   *
   * 优先级：**控制台(DB) > 环境变量 > OAuth 凭证文件**
   * （控制台优先是因为它是运维显式表达的「这把 key 现在作数」；
   *   OAuth 文件放最后是怕它悄悄盖掉运维刚在控制台换的 key。）
   */
  resolve(provider: string, staticKey: string, account = 'default'): ResolvedCredential {
    // 优先级 1：控制台写入的凭证
    const dynamic = this.dynamic?.(provider, account);
    if (dynamic?.key) return { key: dynamic.key, mode: this.modeFor(provider, dynamic.key) };
    // 优先级 2：环境变量
    if (staticKey) return { key: staticKey, mode: this.modeFor(provider, staticKey) };
    // 优先级 3：OAuth 凭证文件（仅限白名单 provider，防止令牌外泄到第三方域名）
    if (account === 'default' && this.allowedProviders.includes(provider)) {
      const oauth = this.readOAuthToken();
      if (oauth) return { key: oauth, mode: 'bearer' };
    }
    return { key: '', mode: 'x-api-key' };
  }
}

export interface ProviderAdapter {
  readonly name: string;
  readonly protocol: 'anthropic' | 'openai';
  chat(input: ProviderChatInput): Promise<ProviderChatResult>;
  /**
   * 可选的流式实现。
   *
   * 不实现时上层自动回退到一次性 `chat()`（拿到完整结果后当成一个大增量吐出），
   * 因此**新增流式不会改变任何既有调用方的行为**。
   */
  chatStream?(
    input: ProviderChatInput,
    onDelta: (delta: ProviderStreamDelta) => void,
  ): Promise<ProviderChatResult>;
  testConnection?(account?: string): Promise<number>;
}

/**
 * 流式增量。
 *
 * `toolCallDelta` 采用 OpenAI 兼容的 `delta.tool_calls` 形态（带 `index` 便于
 * 客户端把分片的函数名/参数拼回同一次调用）。
 */
export interface ProviderStreamDelta {
  /** 文本增量 */
  contentDelta?: string;
  /** 工具调用增量 */
  toolCallDelta?: {
    index: number;
    id?: string;
    type?: string;
    name?: string;
    argumentsDelta?: string;
  };
}

/**
 * 出网分级（见方案 8.1 数据分级与路由）：
 *   - `local`    —— 推理发生在内网/本机（TEI 等），数据不出域
 *   - `external` —— 推理发生在商业 API，数据出网
 *
 * 涉密（confidential）主体只允许走 `local` 目标；
 * 反之普通数据走商业 API 是合规且更经济的路径。
 */
export type EgressClass = 'local' | 'external';

/** 本地推理 provider 名单 —— 不经过出网代理，数据不出域 */
const LOCAL_PROVIDERS = new Set(['tei', 'local', 'vllm', 'ollama']);

/** 判断某个 provider 是否属于本地推理 */
export function isLocalProvider(name: string): boolean {
  return LOCAL_PROVIDERS.has(name.toLowerCase());
}

/** 由目标列表推导本次请求的出网级别 */
export function egressClassOf(providers: string[]): EgressClass {
  return providers.some((p) => isLocalProvider(p)) ? 'local' : 'external';
}

export function strictEgressClassOf(providers: string[]): EgressClass {
  return providers.length > 0 && providers.every((p) => isLocalProvider(p)) ? 'local' : 'external';
}

function assertEgressAllowed(url: string, dynamicHost?: string): void {
  const { hostname } = new URL(url);
  const allowed = dynamicHost ? hostname === dynamicHost : isEgressAllowed(hostname);
  if (!allowed) {
    throw new ProviderError(
      `出网白名单拒绝：${hostname}`,
      403,
      false,
      'egress',
    );
  }
}

/**
 * 内网服务（TEI / Infinity 等）校验。
 *
 * 与商业 API 的出网白名单是**互斥**的两套规则：内网服务只允许环回与私有网段，
 * 绝不放行出网白名单里的域名 —— 否则嵌入请求会把业务数据发到外部（违反 4.2 数据不出域）。
 */
function assertEgressAllowedLocal(url: string): void {
  const { hostname } = new URL(url);
  const local = ['127.0.0.1', 'localhost', '::1', '0.0.0.0'];
  if (local.includes(hostname) || hostname.startsWith('10.') || hostname.startsWith('192.168.')) {
    return;
  }
  // 172.16.0.0/12 私有段
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return;
  throw new ProviderError(
    `内网服务地址不合法（仅允许环回与私有网段）：${hostname}`,
    403,
    false,
    'egress',
  );
}

async function probeProvider(
  name: string,
  protocol: 'openai' | 'anthropic',
  baseUrl: string,
  credential: ResolvedCredential,
  dynamicHost?: string,
): Promise<number> {
  const url = `${baseUrl.replace(/\/$/, '')}/models`;
  assertEgressAllowed(url, dynamicHost);
  const headers: Record<string, string> = {};
  if (protocol === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  if (credential.mode === 'bearer') headers.authorization = `Bearer ${credential.key}`;
  else headers['x-api-key'] = credential.key;
  const response = await egressFetch(url, { headers, signal: requestSignal(10_000) }, dynamicHost !== undefined);
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new ProviderError(
      `${name} 连接测试 HTTP ${response.status}: ${text.slice(0, 300)}`,
      response.status,
      response.status === 429 || response.status >= 500,
      name,
    );
  }
  await response.body?.cancel().catch(() => undefined);
  return response.status;
}

/** Anthropic Messages 协议 —— MiniMax 等兼容厂商 */
export class AnthropicAdapter implements ProviderAdapter {
  readonly protocol = 'anthropic' as const;

  constructor(
    readonly name: string,
    private readonly baseUrl: string,
    private readonly accounts: ProviderAccount[],
    private readonly resolver: CredentialResolver,
    private readonly dynamicHost?: string,
  ) {}

  async testConnection(account?: string): Promise<number> {
    return probeProvider(this.name, this.protocol, this.baseUrl, this.pickCredential(account), this.dynamicHost);
  }

  /** 构造 Anthropic Messages 请求体 —— chat() 与 chatStream() 共用 */
  private buildBody(input: ProviderChatInput): Record<string, unknown> {
    const system = input.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const messages = input.messages
      .filter((m) => m.role !== 'system')
      .map((m) => {
        if (m.role === 'tool') {
          return { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }] };
        }
        if (m.role === 'assistant' && m.tool_calls?.length) {
          const blocks: any[] = [];
          if (m.content) blocks.push({ type: 'text', text: m.content });
          for (const tc of m.tool_calls) {
            let input: unknown = {};
            try {
              input = JSON.parse(tc.function.arguments || '{}');
            } catch {
              input = {};
            }
            blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
          }
          return { role: 'assistant', content: blocks };
        }
        return { role: m.role, content: m.content };
      });

    const body: Record<string, unknown> = {
      model: input.model,
      max_tokens: input.maxTokens,
      messages,
    };
    if (system) body.system = system;
    if (input.temperature !== undefined) body.temperature = input.temperature;
    if (input.tools?.length) {
      body.tools = input.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: toJsonSchema(t.inputSchema),
      }));
    }
    return body;
  }

  chat(input: ProviderChatInput): Promise<ProviderChatResult> {
    const cred = this.pickCredential(input.account);
    const url = `${this.baseUrl.replace(/\/$/, '')}/messages`;
    assertEgressAllowed(url, this.dynamicHost);

    return this.request(url, cred, this.buildBody(input), input.timeoutMs, input.signal);
  }

  /**
   * Anthropic Messages 原生流式。
   *
   * 上游事件序列：
   *   message_start        → input_tokens
   *   content_block_start  → text 块 / tool_use 块（带 id、name）
   *   content_block_delta  → text_delta（正文）/ input_json_delta（工具参数分片）
   *   message_delta        → output_tokens
   *   message_stop
   *
   * 工具参数在 Anthropic 协议里是**裸 JSON 片段**（不是 OpenAI 那种转义字符串），
   * 这里原样透传，由上层按 OpenAI 兼容形态拼接。
   */
  async chatStream(
    input: ProviderChatInput,
    onDelta: (delta: ProviderStreamDelta) => void,
  ): Promise<ProviderChatResult> {
    const cred = this.pickCredential(input.account);
    const url = `${this.baseUrl.replace(/\/$/, '')}/messages`;
    assertEgressAllowed(url, this.dynamicHost);

    const body = this.buildBody(input);
    body.stream = true;

    const signal = requestSignal(input.timeoutMs, input.signal);
    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
      };
      if (cred.mode === 'bearer') headers.authorization = `Bearer ${cred.key}`;
      else headers['x-api-key'] = cred.key;

      const res = await egressFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      }, this.dynamicHost !== undefined);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new ProviderError(
          `${this.name} HTTP ${res.status}: ${text.slice(0, 300)}`,
          res.status,
          res.status === 429 || res.status >= 500,
          this.name,
        );
      }
      if (!res.body) {
        throw new ProviderError(`${this.name} 流式响应无 body`, 502, true, this.name);
      }

      let content = '';
      let thinking = '';
      let promptTokens = 0;
      let completionTokens = 0;
      /** content_block index → 工具调用序号（text 块不占工具序号） */
      const blockToolIndex = new Map<number, number>();
      const toolAcc: { id: string; name: string; args: string }[] = [];

      await readSseStream(res, (payload) => {
        const type = payload?.type;
        if (type === 'message_start') {
          promptTokens = payload?.message?.usage?.input_tokens ?? 0;
          return;
        }
        if (type === 'content_block_start') {
          const block = payload?.content_block;
          if (block?.type === 'tool_use') {
            const idx = toolAcc.length;
            blockToolIndex.set(payload?.index ?? -1, idx);
            toolAcc.push({
              id: block.id ?? `call_${idx}`,
              name: block.name ?? '',
              args: '',
            });
            onDelta({
              toolCallDelta: {
                index: idx,
                id: block.id,
                type: 'function',
                name: block.name,
              },
            });
          }
          return;
        }
        if (type === 'content_block_delta') {
          const d = payload?.delta;
          if (d?.type === 'text_delta' && typeof d.text === 'string' && d.text) {
            content += d.text;
            onDelta({ contentDelta: d.text });
          } else if (d?.type === 'thinking_delta' && typeof d.thinking === 'string') {
            thinking += d.thinking;
          } else if (d?.type === 'input_json_delta' && typeof d.partial_json === 'string') {
            const idx = blockToolIndex.get(payload?.index ?? -1);
            if (idx !== undefined) {
              toolAcc[idx].args += d.partial_json;
              onDelta({
                toolCallDelta: { index: idx, argumentsDelta: d.partial_json },
              });
            }
          }
          return;
        }
        if (type === 'message_delta') {
          completionTokens = payload?.usage?.output_tokens ?? completionTokens;
        }
      });

      const toolCalls: ToolCall[] = toolAcc.map((acc, i) => ({
        id: acc.id || `call_${i}`,
        type: 'function' as const,
        function: { name: acc.name, arguments: acc.args || '{}' },
      }));

      return {
        content,
        toolCalls,
        promptTokens,
        completionTokens,
        thinking: thinking.trim() || undefined,
      };
    } catch (err: any) {
      if (err instanceof ProviderError) throw err;
      const aborted = signal.aborted;
      throw new ProviderError(
        aborted ? `${this.name} 请求超时 ${input.timeoutMs}ms` : `${this.name} 流式请求失败: ${err?.message ?? err}`,
        aborted ? 504 : 502,
        true,
        this.name,
      );
    }
  }

  private async request(
    url: string,
    cred: ResolvedCredential,
    body: unknown,
    timeoutMs: number,
    parentSignal?: AbortSignal,
  ): Promise<ProviderChatResult> {
    const signal = requestSignal(timeoutMs, parentSignal);
    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
      };
      if (cred.mode === 'bearer') headers.authorization = `Bearer ${cred.key}`;
      else headers['x-api-key'] = cred.key;
      const res = await egressFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      }, this.dynamicHost !== undefined);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new ProviderError(
          `${this.name} HTTP ${res.status}: ${text.slice(0, 300)}`,
          res.status,
          res.status === 429 || res.status >= 500,
          this.name,
        );
      }
      const json = (await res.json()) as any;
      const contentBlocks: any[] = json.content ?? [];
      const text = contentBlocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const thinking = contentBlocks
        .filter((b) => b.type === 'thinking')
        .map((b) => b.thinking ?? b.text ?? '')
        .join('\n')
        .trim();
      const toolCalls: ToolCall[] = contentBlocks
        .filter((b) => b.type === 'tool_use')
        .map((b, i) => ({
          id: b.id ?? `call_${i}`,
          type: 'function' as const,
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      return {
        content: text,
        toolCalls,
        promptTokens: json.usage?.input_tokens ?? 0,
        completionTokens: json.usage?.output_tokens ?? 0,
        thinking: thinking || undefined,
      };
    } catch (err: any) {
      if (err instanceof ProviderError) throw err;
      const aborted = signal.aborted;
      throw new ProviderError(
        aborted ? `${this.name} 请求超时 ${timeoutMs}ms` : `${this.name} 请求失败: ${err?.message ?? err}`,
        aborted ? 504 : 502,
        true,
        this.name,
      );
    }
  }

  private pickCredential(preferred?: string): ResolvedCredential {
    if (!this.accounts.length) {
      throw new ProviderError(`${this.name} 未配置凭证来源`, 500, false, this.name);
    }
    const found = preferred ? this.accounts.find((a) => a.alias === preferred) : undefined;
    if (preferred && !found) {
      throw new ProviderError(`${this.name} 账号 ${preferred} 未配置`, 503, false, this.name);
    }
    const chosen = found ?? this.accounts[0];
    const cred = this.resolver.resolve(this.name, chosen.apiKey, chosen.alias);
    if (!cred.key) {
      throw new ProviderError(`${this.name} 账号 ${chosen.alias} 未配置可用凭证`, 500, false, this.name);
    }
    return cred;
  }
}

/** OpenAI Chat Completions 兼容协议 —— 通义 / DeepSeek / 智谱 / OpenAI */
export class OpenAIAdapter implements ProviderAdapter {
  readonly protocol = 'openai' as const;

  constructor(
    readonly name: string,
    private readonly baseUrl: string,
    private readonly accounts: ProviderAccount[],
    private readonly resolver: CredentialResolver,
    private readonly dynamicHost?: string,
  ) {}

  async testConnection(account?: string): Promise<number> {
    return probeProvider(this.name, this.protocol, this.baseUrl, this.pickCredential(account), this.dynamicHost);
  }

  /** 构造 OpenAI 兼容请求体 —— chat() 与 chatStream() 共用 */
  private buildBody(input: ProviderChatInput): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: input.model,
      max_tokens: input.maxTokens,
      messages: input.messages.map((m) => {
        if (m.role === 'tool') {
          return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
        }
        if (m.role === 'assistant' && m.tool_calls?.length) {
          return {
            role: 'assistant',
            content: m.content || null,
            tool_calls: m.tool_calls.map((tc) => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.function.name, arguments: tc.function.arguments || '{}' },
            })),
          };
        }
        return { role: m.role, content: m.content };
      }),
    };
    if (input.temperature !== undefined) body.temperature = input.temperature;
    if (input.tools?.length) {
      body.tools = input.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: toJsonSchema(t.inputSchema),
        },
      }));
    }
    return body;
  }

  chat(input: ProviderChatInput): Promise<ProviderChatResult> {
    const cred = this.pickCredential(input.account);
    const url = `${this.baseUrl.replace(/\/$/, '')}/chat/completions`;
    assertEgressAllowed(url, this.dynamicHost);

    const body = this.buildBody(input);

    const signal = requestSignal(input.timeoutMs, input.signal);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (cred.mode === 'bearer') headers.authorization = `Bearer ${cred.key}`;
    else headers['x-api-key'] = cred.key;
    return egressFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    }, this.dynamicHost !== undefined)
      .then(async (res) => {
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new ProviderError(
            `${this.name} HTTP ${res.status}: ${text.slice(0, 300)}`,
            res.status,
            res.status === 429 || res.status >= 500,
            this.name,
          );
        }
        const json = (await res.json()) as any;
        const msg = json.choices?.[0]?.message ?? {};
        const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc: any, i: number) => ({
          id: tc.id ?? `call_${i}`,
          type: 'function' as const,
          function: { name: tc.function?.name, arguments: tc.function?.arguments || '{}' },
        }));
        return {
          content: msg.content ?? '',
          toolCalls,
          promptTokens: json.usage?.prompt_tokens ?? 0,
          completionTokens: json.usage?.completion_tokens ?? 0,
        };
      })
      .catch((err: any) => {
        if (err instanceof ProviderError) throw err;
        const aborted = signal.aborted;
        throw new ProviderError(
          aborted ? `${this.name} 请求超时 ${input.timeoutMs}ms` : `${this.name} 请求失败: ${err?.message ?? err}`,
          aborted ? 504 : 502,
          true,
          this.name,
        );
      });
  }

  /**
   * 真实流式：上游 `stream: true`，逐块吐出文本与工具调用分片。
   *
   * 失败语义与一次性 `chat()` 一致（HTTP 非 2xx → ProviderError；中途断流 → 502/504）。
   * 已经吐给上层的增量不会回滚 —— 这与所有 OpenAI 兼容流式实现的惯例一致。
   */
  async chatStream(
    input: ProviderChatInput,
    onDelta: (delta: ProviderStreamDelta) => void,
  ): Promise<ProviderChatResult> {
    const cred = this.pickCredential(input.account);
    const url = `${this.baseUrl.replace(/\/$/, '')}/chat/completions`;
    assertEgressAllowed(url, this.dynamicHost);

    const body = this.buildBody(input);
    body.stream = true;
    // 部分兼容实现忽略该字段，但带上更稳（用于回传 usage）
    body.stream_options = { include_usage: true };

    const signal = requestSignal(input.timeoutMs, input.signal);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (cred.mode === 'bearer') headers.authorization = `Bearer ${cred.key}`;
      else headers['x-api-key'] = cred.key;

      const res = await egressFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      }, this.dynamicHost !== undefined);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new ProviderError(
          `${this.name} HTTP ${res.status}: ${text.slice(0, 300)}`,
          res.status,
          res.status === 429 || res.status >= 500,
          this.name,
        );
      }
      if (!res.body) {
        throw new ProviderError(`${this.name} 流式响应无 body`, 502, true, this.name);
      }

      let content = '';
      const toolAcc = new Map<number, { id: string; name: string; args: string }>();
      let promptTokens = 0;
      let completionTokens = 0;

      await readSseStream(res, (payload) => {
        const choice = payload?.choices?.[0];
        const delta = choice?.delta;
        if (typeof delta?.content === 'string' && delta.content) {
          content += delta.content;
          onDelta({ contentDelta: delta.content });
        }
        for (const tc of delta?.tool_calls ?? []) {
          const index = Number.isInteger(tc?.index) ? tc.index : 0;
          const acc = toolAcc.get(index) ?? { id: '', name: '', args: '' };
          if (tc?.id) acc.id = tc.id;
          if (tc?.function?.name) acc.name = tc.function.name;
          if (tc?.function?.arguments) acc.args += tc.function.arguments;
          toolAcc.set(index, acc);
          onDelta({
            toolCallDelta: {
              index,
              id: tc?.id,
              type: tc?.type,
              name: tc?.function?.name,
              argumentsDelta: tc?.function?.arguments,
            },
          });
        }
        if (payload?.usage) {
          promptTokens = payload.usage.prompt_tokens ?? promptTokens;
          completionTokens = payload.usage.completion_tokens ?? completionTokens;
        }
      });

      const toolCalls: ToolCall[] = [...toolAcc.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([index, acc]) => ({
          id: acc.id || `call_${index}`,
          type: 'function' as const,
          function: { name: acc.name, arguments: acc.args || '{}' },
        }));

      return { content, toolCalls, promptTokens, completionTokens };
    } catch (err: any) {
      if (err instanceof ProviderError) throw err;
      const aborted = signal.aborted;
      throw new ProviderError(
        aborted ? `${this.name} 请求超时 ${input.timeoutMs}ms` : `${this.name} 流式请求失败: ${err?.message ?? err}`,
        aborted ? 504 : 502,
        true,
        this.name,
      );
    }
  }

  private pickCredential(preferred?: string): ResolvedCredential {
    if (!this.accounts.length) {
      throw new ProviderError(`${this.name} 未配置凭证来源`, 500, false, this.name);
    }
    const found = preferred ? this.accounts.find((a) => a.alias === preferred) : undefined;
    if (preferred && !found) {
      throw new ProviderError(`${this.name} 账号 ${preferred} 未配置`, 503, false, this.name);
    }
    const chosen = found ?? this.accounts[0];
    const cred = this.resolver.resolve(this.name, chosen.apiKey, chosen.alias);
    if (!cred.key) {
      throw new ProviderError(`${this.name} 账号 ${chosen.alias} 未配置可用凭证`, 500, false, this.name);
    }
    return cred;
  }
}

/**
 * TEI /embed 响应解析。
 *
 * 实测 TEI（text-embeddings-inference 1.8）返回的是**裸数组**：
 *   多条输入 → [[v1], [v2]]      单条输入 → [v1]（扁平向量）
 * 而 OpenAI 风格 / 其它 TEI 版本返回 {"embeddings": [[...]]}。
 * 这里两种形态都认，避免版本差异导致解析成空。
 */
export function parseEmbeddings(payload: unknown): number[][] {
  if (Array.isArray(payload)) {
    // 扁平向量（单条输入）→ 包一层
    if (payload.length > 0 && typeof payload[0] === 'number') {
      return [payload as number[]];
    }
    // 二维数组
    return payload.filter((v): v is number[] => Array.isArray(v));
  }
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    const list = (obj.embeddings ?? obj.data ?? obj.vectors) as unknown;
    if (Array.isArray(list)) {
      if (list.length > 0 && typeof list[0] === 'number') return [list as number[]];
      return list.filter((v): v is number[] => Array.isArray(v));
    }
    // OpenAI 风格 data: [{embedding: [...]}]
    if (Array.isArray(obj.data)) {
      return (obj.data as any[]).map((d) => d?.embedding ?? []).filter(Array.isArray);
    }
  }
  return [];
}

/**
 * 读取 SSE 响应体，逐帧回调 JSON 负载。
 *
 * 兼容 `data: {...}` 逐行格式（OpenAI / Anthropic 都用它）；`[DONE]` 哨兵忽略；
 * 非 JSON 帧（心跳等）跳过而不中断整条流。
 */
async function readSseStream(
  res: Response,
  onPayload: (payload: any) => void,
): Promise<void> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line || line.startsWith(':')) continue; // 空行 / 心跳注释
      if (!line.startsWith('data:')) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === '[DONE]') continue;
      let payload: any;
      try {
        payload = JSON.parse(raw);
      } catch {
        continue;
      }
      onPayload(payload);
    }
  }
}

/** 统一 JsonSchema 转换 */
function toJsonSchema(schema: ToolSpec['inputSchema']): Record<string, unknown> {
  return {
    type: schema.type,
    ...(schema.properties
      ? {
          properties: Object.fromEntries(
            Object.entries(schema.properties).map(([k, v]) => [k, toJsonSchema(v)]),
          ),
        }
      : {}),
    ...(schema.items ? { items: toJsonSchema(schema.items) } : {}),
    ...(schema.required ? { required: schema.required } : {}),
    ...(schema.description ? { description: schema.description } : {}),
    ...(schema.enum ? { enum: schema.enum } : {}),
  };
}

/**
 * TEI 适配器 —— 本地嵌入服务（见 3.1 / 4.2：本地 Embedding，数据不出域，CPU 可跑）。
 * 对应 HuggingFace Text Embeddings Inference 的 /embed 端点。
 */
export class TeiAdapter {
  readonly name = 'tei';
  readonly protocol = 'tei' as const;

  constructor(private readonly baseUrl: string) {}

  async embed(inputs: string[], timeoutMs = 60_000): Promise<number[][]> {
    if (!inputs.length) return [];
    const url = `${this.baseUrl.replace(/\/$/, '')}/embed`;
    assertEgressAllowedLocal(url);
    const signal = requestSignal(timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inputs }),
        signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new ProviderError(
          `TEI HTTP ${res.status}: ${text.slice(0, 200)}`,
          res.status,
          res.status === 429 || res.status >= 500,
          'tei',
        );
      }
      const json = (await res.json()) as any;
      return parseEmbeddings(json);
    } catch (err: any) {
      if (err instanceof ProviderError) throw err;
      const aborted = signal.aborted;
      throw new ProviderError(
        aborted
          ? `TEI 请求超时 ${timeoutMs}ms`
          : `TEI 嵌入服务不可达（TEI_BASE_URL=${this.baseUrl}）：${err?.message ?? err}`,
        aborted ? 504 : 502,
        true,
        'tei',
      );
    }
  }
}

/**
 * Provider 注册表 —— 单一收口：所有商业 API Key 只存在于网关进程内（见 4.4 Key 治理第 2 条）。
 * 账号池支持多子账号 + 权重分流。
 */
export class ProviderRegistry {
  private adapters = new Map<string, ProviderAdapter>();
  private teiAdapter?: TeiAdapter;
  private readonly resolver: CredentialResolver;

  private definitions = new Map<string, ProviderConnectionView>();
  private customDefinitions = new Map<string, ProviderDefinition>();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly credentials?: CredentialService,
    private readonly store?: MetadataStore,
  ) {
    this.resolver = new CredentialResolver(
      config.llm.credentialFile,
      config.llm.authMode,
      config.llm.credentialProviders,
      config.llm.authModes,
      (provider, account) => this.credentials?.peek(provider, account),
      (provider) => {
        const definition = this.definitions.get(provider);
        return definition?.source === 'console'
          ? { authMode: definition.authMode ?? 'auto', protocol: definition.protocol }
          : undefined;
      },
    );
    this.rebuild([]);
    this.credentials?.setProviderLookup((provider) => this.getDefinition(provider));
    if (config.llm.teiBaseUrl) {
      this.teiAdapter = new TeiAdapter(config.llm.teiBaseUrl);
      log.info('provider 已注册', { name: 'tei', protocol: 'tei', baseUrl: config.llm.teiBaseUrl });
    }
  }

  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), 30_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async refresh(): Promise<void> {
    if (!this.store) return;
    try {
      const definitions = await this.store.listProviderDefinitions();
      this.customDefinitions = new Map(definitions.map((definition) => [definition.name, definition]));
      this.rebuild(definitions);
    } catch (err) {
      log.warn('自定义 Provider 加载失败，沿用现有配置', { error: String(err) });
    }
  }

  private rebuild(custom: ProviderDefinition[]): void {
    const adapters = new Map<string, ProviderAdapter>();
    const definitions = new Map<string, ProviderConnectionView>();
    for (const name of ['minimax', 'minimax-public', 'openai', 'qwen', 'deepseek', 'zhipu']) {
      const baseUrl = (config.llm.baseUrls as Record<string, string>)[name];
      if (!baseUrl) continue;
      const protocol = (config.llm.protocols as Record<string, string>)[name] === 'anthropic' ? 'anthropic' : 'openai';
      const defaultKey = (config.llm.apiKeys as Record<string, string>)[name] ?? '';
      const accounts: ProviderAccount[] = defaultKey ? [{ alias: 'default', apiKey: defaultKey }] : [];
      for (let index = 2; index <= 4; index++) {
        const apiKey = process.env[`${providerEnvPrefix(name)}_API_KEY_${index}`];
        if (apiKey) accounts.push({ alias: `acct-${index}`, apiKey });
      }
      if (!defaultKey) accounts.push({ alias: 'default', apiKey: '' });
      definitions.set(name, {
        name, protocol, baseUrl: publicProviderUrl(baseUrl), accounts: accounts.map((account) => account.alias),
        enabled: true, source: 'env',
      });
      adapters.set(name, protocol === 'anthropic'
        ? new AnthropicAdapter(name, baseUrl, accounts, this.resolver)
        : new OpenAIAdapter(name, baseUrl, accounts, this.resolver));
    }
    for (const definition of custom) {
      const accounts = definition.accounts.map((alias) => ({ alias, apiKey: '' }));
      definitions.set(definition.name, {
        name: definition.name, protocol: definition.protocol, authMode: definition.authMode, baseUrl: definition.baseUrl,
        accounts: definition.accounts, enabled: definition.enabled, source: 'console',
        createdAt: definition.createdAt, updatedAt: definition.updatedAt, updatedBy: definition.updatedBy,
      });
      if (!definition.enabled) continue;
      adapters.set(definition.name, definition.protocol === 'anthropic'
        ? new AnthropicAdapter(definition.name, definition.baseUrl, accounts, this.resolver, new URL(definition.baseUrl).hostname)
        : new OpenAIAdapter(definition.name, definition.baseUrl, accounts, this.resolver, new URL(definition.baseUrl).hostname));
    }
    this.adapters = adapters;
    this.definitions = definitions;
  }

  async saveDefinition(definition: ProviderDefinition): Promise<void> {
    if (!this.store) throw new Error('Provider 配置存储不可用');
    await this.store.upsertProviderDefinition(definition);
    this.customDefinitions.set(definition.name, definition);
    this.rebuild([...this.customDefinitions.values()]);
    log.info('自定义 Provider 已生效', { name: definition.name, protocol: definition.protocol, enabled: definition.enabled });
  }

  async removeDefinition(name: string): Promise<boolean> {
    if (!this.store) return false;
    const removed = await this.store.deleteProviderDefinition(name);
    if (removed) {
      this.customDefinitions.delete(name);
      this.rebuild([...this.customDefinitions.values()]);
    }
    return removed;
  }

  getDefinition(name: string): ProviderConnectionView | undefined {
    return this.definitions.get(name);
  }

  has(name: string): boolean {
    return this.definitions.has(name);
  }

  async test(name: string, account = 'default'): Promise<{ ok: boolean; status?: number; latencyMs: number; message: string }> {
    const started = Date.now();
    const adapter = this.adapters.get(name);
    if (!adapter?.testConnection) {
      return { ok: false, status: 503, latencyMs: Date.now() - started, message: `Provider '${name}' 未启用或不存在` };
    }
    try {
      const status = await adapter.testConnection(account);
      return { ok: true, status, latencyMs: Date.now() - started, message: `连接成功（HTTP ${status}）` };
    } catch (err) {
      return {
        ok: false,
        status: err instanceof ProviderError ? err.status : 502,
        latencyMs: Date.now() - started,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  get(name: string): ProviderAdapter | undefined {
    return this.adapters.get(name);
  }

  /** TEI 嵌入适配器 —— 仅在配置了 TEI_BASE_URL 时存在 */
  getTei(): TeiAdapter | undefined {
    return this.teiAdapter;
  }

  list(): string[] {
    return [...this.adapters.keys()];
  }

  /** 管理面只读取连接元数据，不包含任何凭证。 */
  describe(): ProviderConnectionView[] {
    const providers = [...this.definitions.values()];
    if (this.teiAdapter) {
      providers.push({
        name: 'tei', protocol: 'tei', baseUrl: publicProviderUrl(config.llm.teiBaseUrl),
        accounts: ['default'], enabled: true, source: 'env',
      });
    }
    return providers.sort((left, right) => left.name.localeCompare(right.name));
  }
}
