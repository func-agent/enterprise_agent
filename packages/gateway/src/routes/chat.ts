/**
 * OpenAI 兼容端口 —— AgentScope 的 ChatModel 全部指向这里，只用虚拟模型名
 * （见 4.1 关键配置：模型名使用网关的虚拟模型名，不感知真实 Provider）。
 */
import { Router, type Request, type Response } from 'express';
import { config, createLogger, type ChatMessage } from '@eap/platform-core';
import type { AppContext } from '../context.js';
import { requireIdentity } from '@eap/auth-middleware';
import { ProviderError } from '../llm/providers.js';

const log = createLogger('gateway:route:chat');

export function chatRoutes(ctx: AppContext): Router {
  const router = Router();

  // 虚拟模型列表（租户白名单过滤）
  router.get('/v1/models', async (req: Request, res: Response) => {
    try {
      const identity = requireIdentity(req);
      const models = await ctx.router.listVirtualModels();
      const tenant = await ctx.store.getTenant(identity.tenantId);
      if (!tenant || !tenant.enabled) {
        res.status(403).json({ error: 'tenant_disabled', message: '租户不存在或已禁用' });
        return;
      }
      const visible = models.filter((m) =>
        m.enabled && (tenant.models.length === 0 || tenant.models.includes(m.name)),
      );
      res.json({
        object: 'list',
        data: visible.map((m) => ({
          id: m.name,
          object: 'model',
          created: 0,
          owned_by: 'agentgateway',
          description: m.description,
          scenarios: m.scenarios,
          targets: m.targets.map((t) => ({ provider: t.provider, model: t.model, role: t.role })),
        })),
      });
    } catch (err: any) {
      res.status(401).json({ error: err?.message });
    }
  });

  router.post('/v1/chat/completions', async (req: Request, res: Response) => {
    const identity = requireIdentity(req);
    const body = req.body ?? {};

    const model = String(body.model ?? config.agent.defaultModel);
    const messages: ChatMessage[] = Array.isArray(body.messages) ? body.messages : [];
    if (!messages.length || messages.some((m) => !m || typeof m.content !== 'string')) {
      res.status(400).json({ error: { message: 'messages 不能为空，且 content 必须为字符串', type: 'invalid_request_error' } });
      return;
    }

    const maxTokens = Number(body.max_tokens ?? 8192);
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 65_536) {
      res.status(400).json({ error: { message: 'max_tokens 必须是 1–65536 的整数', type: 'invalid_request_error' } });
      return;
    }

    // 工具目录：按租户下发（见 4.3 MCP Federation）
    let tools: Awaited<ReturnType<AppContext['mcp']['catalog']>> | undefined;
    if (body.tools !== undefined) {
      tools = await ctx.mcp.catalog(identity);
    }

    const started = Date.now();
    /** SSE 是否已经发出响应头（发出后不能再改状态码，只能用 SSE 错误帧） */
    let sseStarted = false;
    const requestController = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) requestController.abort();
    });
    try {
      /**
       * 流式分支的 SSE 头**延迟到第一个增量才发**。
       *
       * 关键原因：预算超限、护栏拦截、出网白名单拒绝等错误都发生在拿到模型结果
       * **之前** —— 那时响应头还没发出去，才能返回正确的 HTTP 状态码与 JSON 错误体
       * （而不是已经开了 SSE 却只能塞一个 200）。一旦吐出过增量再失败，
       * 则改用 SSE 错误帧告知客户端。
       */
      const streaming = body.stream === true;
      const streamId = `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
      const base = {
        id: streamId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
      };
      const writeFrame = (payload: unknown) => {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };
      const startSse = () => {
        if (sseStarted) return;
        sseStarted = true;
        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders?.();
        writeFrame({ ...base, choices: [{ index: 0, delta: { role: 'assistant' } }] });
      };

      /** 工具调用分片累积器 —— 上游按 index 分片吐，这里合并成完整调用 */
      const toolAcc = new Map<number, { id: string; name: string; args: string }>();
      let sawToolDelta = false;

      const result = await ctx.router.chat(
        {
          model,
          messages,
          tools,
          temperature: body.temperature,
          maxTokens,
          sessionId: body.session_id ?? req.headers['x-session-id'],
          appId: body.app_id ?? req.headers['x-app-id'],
          signal: requestController.signal,
        },
        identity,
        streaming
          ? (delta) => {
              startSse();
              if (delta.contentDelta) {
                writeFrame({ ...base, choices: [{ index: 0, delta: { content: delta.contentDelta } }] });
              }
              if (delta.toolCallDelta) {
                const t = delta.toolCallDelta;
                const acc = toolAcc.get(t.index) ?? { id: '', name: '', args: '' };
                if (t.id) acc.id = t.id;
                if (t.name) acc.name = t.name;
                if (t.argumentsDelta) acc.args += t.argumentsDelta;
                toolAcc.set(t.index, acc);
                sawToolDelta = true;
                writeFrame({
                  ...base,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: t.index,
                            ...(t.id ? { id: t.id } : {}),
                            ...(t.type ? { type: t.type } : {}),
                            function: {
                              ...(t.name ? { name: t.name } : {}),
                              ...(t.argumentsDelta ? { arguments: t.argumentsDelta } : {}),
                            },
                          },
                        ],
                      },
                    },
                  ],
                });
              }
            }
          : undefined,
      );

      // Trace 落库 + OTel 导出
      await ctx.tracing.record({
        traceId: result.traceId,
        sessionId: body.session_id,
        tenantId: identity.tenantId,
        userId: identity.userId,
        name: `chat:${model}`,
        ts: new Date().toISOString(),
        input: ctx.guardrails.maskStructured(messages.map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }))).value,
        output: ctx.guardrails.maskStructured({ content: result.content.slice(0, 4000), toolCalls: result.toolCalls }).value,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        costUsd: result.costUsd,
        model: result.model,
        metadata: {
          provider: result.provider,
          realModel: result.realModel,
          account: result.account,
          failover: result.failover,
          latencyMs: Date.now() - started,
          deptId: identity.deptId,
          role: identity.role,
        },
      });

      const usage = {
        prompt_tokens: result.promptTokens,
        completion_tokens: result.completionTokens,
        total_tokens: result.promptTokens + result.completionTokens,
      };

      if (streaming) {
        startSse();
        // 上游无流式能力时的回退路径：把完整工具调用补在最后一帧
        if (!sawToolDelta && result.toolCalls.length) {
          writeFrame({
            ...base,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: result.toolCalls.map((tc, i) => ({
                    index: i,
                    id: tc.id,
                    type: 'function',
                    function: { name: tc.function.name, arguments: tc.function.arguments || '{}' },
                  })),
                },
              },
            ],
          });
        }
        writeFrame({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: result.toolCalls.length ? 'tool_calls' : 'stop' }],
          usage,
          eap: {
            trace_id: result.traceId,
            provider: result.provider,
            real_model: result.realModel,
            cost_usd: Number(result.costUsd.toFixed(8)),
          },
        });
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      res.json({
        id: result.id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: result.model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: result.content,
              ...(result.toolCalls.length ? { tool_calls: result.toolCalls } : {}),
            },
            finish_reason: result.toolCalls.length ? 'tool_calls' : 'stop',
          },
        ],
        usage,
        // 平台扩展字段 —— 可观测性用
        eap: {
          trace_id: result.traceId,
          provider: result.provider,
          real_model: result.realModel,
          account: result.account,
          cost_usd: Number(result.costUsd.toFixed(8)),
          failover: result.failover,
        },
      });
    } catch (err: any) {
      if (requestController.signal.aborted && res.destroyed) return;
      const status = err instanceof ProviderError ? err.status : 500;
      const message = err?.message ?? '网关内部错误';
      log.warn('请求失败', { model, status, message });
      if (sseStarted) {
        // 响应头已发出，无法再改状态码 —— 用 SSE 错误帧告知客户端
        res.write(
          `data: ${JSON.stringify({
            error: {
              message,
              type: err instanceof ProviderError ? 'provider_error' : 'server_error',
              code: err?.code ?? 'internal_error',
            },
          })}\n\n`,
        );
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.status(status).json({
        error: {
          message,
          type: err instanceof ProviderError ? 'provider_error' : 'server_error',
          code: err?.code ?? 'internal_error',
        },
      });
    }
  });

  /**
   * 嵌入端口 —— OpenAI 兼容（见 4.2 本地 Embedding，数据不出域）。
   * 只走内网 TEI，不经过任何商业大模型 API。
   */
  router.post('/v1/embeddings', async (req: Request, res: Response) => {
    const identity = requireIdentity(req);
    const body = req.body ?? {};
    const model = String(body.model ?? 'embedding-model');
    const input = body.input;
    if (input === undefined || input === null || input === '') {
      res.status(400).json({ error: { message: 'input 不能为空', type: 'invalid_request_error' } });
      return;
    }
    if (typeof input !== 'string' && !Array.isArray(input)) {
      res.status(400).json({ error: { message: 'input 必须是字符串或字符串数组', type: 'invalid_request_error' } });
      return;
    }

    const started = Date.now();
    try {
      const result = await ctx.router.embed(
        {
          model,
          input: Array.isArray(input) ? input.map(String) : String(input),
          sessionId: body.session_id ?? req.headers['x-session-id'],
          appId: body.app_id ?? req.headers['x-app-id'],
        },
        identity,
      );

      await ctx.tracing.record({
        traceId: result.traceId,
        sessionId: body.session_id,
        tenantId: identity.tenantId,
        userId: identity.userId,
        name: `embed:${model}`,
        ts: new Date().toISOString(),
        input: { inputs: Array.isArray(input) ? input.length : 1 },
        output: { dimensions: result.dimensions, vectors: result.embeddings.length },
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
        model: result.model,
        metadata: {
          provider: result.provider,
          realModel: result.realModel,
          latencyMs: Date.now() - started,
          deptId: identity.deptId,
          role: identity.role,
        },
      });

      res.json({
        object: 'list',
        data: result.embeddings.map((embedding, index) => ({
          object: 'embedding',
          index,
          embedding,
        })),
        model: result.model,
        usage: { prompt_tokens: 0, total_tokens: 0 },
        eap: {
          trace_id: result.traceId,
          provider: result.provider,
          real_model: result.realModel,
          dimensions: result.dimensions,
        },
      });
    } catch (err: any) {
      const status = err instanceof ProviderError ? err.status : 500;
      const message = err?.message ?? '网关内部错误';
      log.warn('嵌入请求失败', { model, status, message });
      res.status(status).json({
        error: {
          message,
          type: err instanceof ProviderError ? 'provider_error' : 'server_error',
          code: err?.code ?? 'internal_error',
        },
      });
    }
  });

  return router;
}
