/**
 * Agent → 网关客户端。所有模型调用与工具调用都必须经过 agentgateway（单一收口，见 2.2 设计原则）。
 */
import { createLogger, type ToolSpec } from '@eap/platform-core';

const log = createLogger('agent:gateway-client');

export interface AgentToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AgentChatResponse {
  content: string;
  toolCalls: AgentToolCall[];
  promptTokens: number;
  completionTokens: number;
  traceId?: string;
}

export class GatewayClient {
  constructor(private readonly apiRoot: string) {}

  private url(path: string): string {
    return `${this.apiRoot.replace(/\/$/, '')}${path}`;
  }

  private headers(token: string): Record<string, string> {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    };
  }

  /** 拉取租户工具目录 */
  async listTools(token: string): Promise<ToolSpec[]> {
    const res = await fetch(this.url('/v1/mcp/tools'), {
      headers: this.headers(token),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`拉取工具目录失败 HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as any;
    return (json.data ?? []).map((t: any) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.input_schema ?? { type: 'object', properties: {} },
      serverId: t.server_id,
      requiresConfirmation: !!t.requires_confirmation,
      sensitivity: t.sensitivity ?? 'internal',
      dataScope: t.data_scope,
    }));
  }

  /** 模型调用（虚拟模型名） */
  async chat(
    token: string,
    opts: {
      model: string;
      messages: { role: string; content: string; tool_calls?: any[]; tool_call_id?: string }[];
      tools?: unknown[];
      temperature?: number;
      maxTokens?: number;
      sessionId?: string;
      appId?: string;
      signal?: AbortSignal;
    },
  ): Promise<AgentChatResponse> {
    const res = await fetch(this.url('/v1/chat/completions'), {
      method: 'POST',
      headers: this.headers(token),
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        tools: opts.tools,
        temperature: opts.temperature,
        max_tokens: opts.maxTokens,
        session_id: opts.sessionId,
        app_id: opts.appId,
      }),
      signal: opts.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log.warn('网关拒绝请求', { status: res.status, body: text.slice(0, 300) });
      throw new Error(`网关调用失败 HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as any;
    const msg = json.choices?.[0]?.message ?? {};
    return {
      content: msg.content ?? '',
      toolCalls: (msg.tool_calls ?? []).map((tc: any) => ({
        id: tc.id,
        name: tc.function?.name,
        arguments: safeParse(tc.function?.arguments),
      })),
      promptTokens: json.usage?.prompt_tokens ?? 0,
      completionTokens: json.usage?.completion_tokens ?? 0,
      traceId: json.eap?.trace_id,
    };
  }

  /** 工具调用（经网关治理） */
  async callTool(
    token: string,
    params: { serverId: string; tool: string; args: Record<string, unknown>; traceId: string; sessionId?: string; appId?: string; signal?: AbortSignal; approvalId?: string },
  ): Promise<{ ok: boolean; content: string; structured?: unknown; reason?: string }> {
    const res = await fetch(this.url('/v1/mcp/call'), {
      method: 'POST',
      headers: this.headers(token),
      body: JSON.stringify({
        server_id: params.serverId,
        tool: params.tool,
        arguments: params.args,
        trace_id: params.traceId,
        approval_id: params.approvalId,
        session_id: params.sessionId,
        app_id: params.appId,
      }),
      signal: params.signal,
    });
    const json = (await res.json().catch(() => ({}))) as any;
    return {
      ok: json.ok === true,
      content: json.content ?? '',
      structured: json.structured,
      reason: json.reason,
    };
  }

  /**
   * 模型调用（流式）—— 逐块回调增量。
   *
   * 走网关的 `stream: true` 端口，网关内部已完成预算核算、护栏、脱敏与故障转移，
   * 这里只负责把 OpenAI 兼容的分片还原成「正文增量」与「工具调用增量」。
   *
   * 工具调用按 `index` 累积：上游把函数名与参数拆成多片到达，
   * 必须按 index 合并回同一次调用（OpenAI 兼容客户端的标准做法）。
   */
  async streamChat(
    token: string,
    opts: {
      model: string;
      messages: { role: string; content: string; tool_calls?: any[]; tool_call_id?: string }[];
      tools?: unknown[];
      temperature?: number;
      maxTokens?: number;
      sessionId?: string;
      appId?: string;
      signal?: AbortSignal;
    },
    onDelta: (delta: AgentStreamDelta) => void,
  ): Promise<AgentChatResponse> {
    const res = await fetch(this.url('/v1/chat/completions'), {
      method: 'POST',
      headers: this.headers(token),
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        tools: opts.tools,
        temperature: opts.temperature,
        max_tokens: opts.maxTokens,
        session_id: opts.sessionId,
        app_id: opts.appId,
        stream: true,
      }),
      signal: opts.signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      log.warn('网关拒绝流式请求', { status: res.status, body: text.slice(0, 300) });
      throw new Error(`网关流式调用失败 HTTP ${res.status}: ${text.slice(0, 300)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let promptTokens = 0;
    let completionTokens = 0;
    let traceId: string | undefined;
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();

    const handle = (payload: any) => {
      if (payload?.error) {
        const message = typeof payload.error === 'string'
          ? payload.error
          : payload.error.message ?? JSON.stringify(payload.error);
        throw new Error(`网关流式调用失败：${message}`);
      }
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
            name: tc?.function?.name,
            argumentsDelta: tc?.function?.arguments,
          },
        });
      }
      if (payload?.usage) {
        promptTokens = payload.usage.prompt_tokens ?? promptTokens;
        completionTokens = payload.usage.completion_tokens ?? completionTokens;
      }
      if (payload?.eap?.trace_id) traceId = payload.eap.trace_id;
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        let payload: any;
        try {
          payload = JSON.parse(raw);
        } catch {
          continue;
        }
        handle(payload);
      }
    }

    const toolCalls: AgentToolCall[] = [...toolAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, acc]) => ({
        id: acc.id || `call_${index}`,
        name: acc.name,
        arguments: safeParse(acc.args),
      }));

    return {
      content,
      toolCalls,
      promptTokens,
      completionTokens,
      traceId,
    };
  }
}

/** 流式增量 */
export interface AgentStreamDelta {
  /** 正文增量 */
  contentDelta?: string;
  /** 工具调用增量（按 index 累积） */
  toolCallDelta?: {
    index: number;
    id?: string;
    name?: string;
    argumentsDelta?: string;
  };
}

function safeParse(s: unknown): Record<string, unknown> {
  if (typeof s !== 'string') return {};
  try {
    return JSON.parse(s) ?? {};
  } catch {
    return {};
  }
}
