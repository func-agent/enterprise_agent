/**
 * 网关回调客户端 —— MCP Server 内部调用 LLM 时统一走 agentgateway 的 OpenAI 兼容端口
 * （见 6.2 关键配置：LLM 来源指向 agentgateway，不直连商业 API）。
 */
import { config, serviceToken } from '@eap/platform-core';

export interface GatewayChatResult {
  content: string;
  toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[];
  promptTokens: number;
  completionTokens: number;
  model: string;
}

export async function callGateway(opts: {
  model?: string;
  system?: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  tenantId?: string;
  role?: string;
  deptId?: string;
}): Promise<GatewayChatResult> {
  const base = config.gateway.openaiBaseUrl.replace(/\/$/, '');
  // 服务账号令牌：生产模式走 Keycloak client_credentials，
  // 开发模式由 serviceToken() 退回本地自签 token（见 platform-core/auth/service-token.ts）
  const token = await serviceToken({
    clientId: config.auth.serviceClientId || undefined,
    clientSecret: config.auth.serviceClientSecret || undefined,
  });

  const messages: { role: string; content: string }[] = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: opts.user });

  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      model: opts.model ?? 'smart-model',
      messages,
      max_tokens: opts.maxTokens ?? 1024,
      temperature: opts.temperature ?? 0,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
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
    model: json.model ?? '',
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
