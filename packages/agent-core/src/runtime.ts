/**
 * Agent 内核 —— ReAct 推理循环 + Toolkit + Middleware + HITL（对应 3.1 的 AgentScope Core 2.x：
 * ReAct + Toolkit + Middleware）。
 *
 * 循环：思考 → 工具调用 → 观察 → 再思考，直至得出结论或达到最大迭代数。
 */
import { createLogger, uuid, type Identity, type MessageRecord, type MetadataStore, type ToolSpec } from '@eap/platform-core';
import type { GatewayClient } from './gateway-client.js';
import { Toolkit } from './toolkit.js';
import type { HitlManager } from './hitl.js';
import { MiddlewareChain, metricsMiddleware, type AgentContext, type AgentResult } from './middleware.js';

const log = createLogger('agent:runtime');

/**
 * Agent 系统提示词 —— 固化 PDF 6.3 路由规则与 5.2 语义层治理要求。
 */
export const AGENT_SYSTEM_PROMPT = `你是企业 AI Agent 助手，服务于企业内部员工。请按以下规则工作：

## 能力路由
1. 制度、合同、手册等文档问题 → 调用 knowledge.search 检索知识库，回答时注明文档名与来源。
2. 业务数据问题（销量、销售额、订单数、报表）→ 调用 chatbi.query。
3. 业务办理（查待办、查合同、提交报销、审批）→ 调用 business.* 工具。
4. 混合问题（如"查上月销售数据并结合合同条款分析风险"）→ 自主编排：先查数，再检索合同条款，最后综合分析。

## 口径治理（强制）
- 涉及金额、销量等指标时，若用户未指定口径，先调用 chatbi.list_metrics 确认口径并在回答中明确说明使用了哪种口径。
- 默认口径为「下单口径」。同名指标存在下单/开票/回款三种口径时，必须在结论中标明口径，避免同一问题三个答案。

## 工具使用规范
- 需要调用工具才能回答的问题不要凭空作答；工具返回为空时要如实说明"未检索到"，并给出可能原因。
- 涉及写操作（提交报销、审批、写入文档等）时，工具会进入人工确认流程，若被拒绝或超时，不要声称操作已完成。
- 工具调用失败时说明失败原因并尝试降级路径（例如换检索关键词），不要反复重试同一失败调用。

## 输出要求
- 先给结论，再给依据。
- 涉及数据的结论必须附上具体数值与口径；涉及文档的结论必须附上来源。
- 使用中文回答。`;

export interface RunOptions {
  identity: Identity;
  token: string;
  sessionId: string;
  message: string;
  appId?: string;
  model?: string;
  tools?: ToolSpec[];
  maxIterations?: number;
  /** 客户端断开时中断本次运行（仅流式路径使用） */
  signal?: AbortSignal;
}

/**
 * Agent 运行过程事件 —— 流式路径（`/ag-ui`）逐个抛出。
 *
 * 与 AG-UI 协议一一对应（在 `agui.ts` 里做映射）：
 *   text_delta        → TEXT_MESSAGE_CONTENT
 *   tool_call_start  → TOOL_CALL_START
 *   tool_call_args   → TOOL_CALL_ARGS
 *   tool_call_end    → TOOL_CALL_END
 *   tool_result      → TOOL_CALL_RESULT
 *   approval_pending / approval_decided → 自定义事件（HITL 等待态）
 */
export type AgentRunEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call_start'; toolCallId: string; name: string; args: unknown }
  | { type: 'tool_call_args'; toolCallId: string; delta: string }
  | { type: 'tool_call_end'; toolCallId: string }
  | { type: 'tool_result'; toolCallId: string; ok: boolean; output: string }
  | { type: 'approval_pending'; toolCallId: string; approvalId: string; tool: string; args: unknown }
  | { type: 'approval_decided'; toolCallId: string; decision: string }
  | { type: 'iteration'; iteration: number }
  | { type: 'done'; result: AgentResult }
  | { type: 'error'; error: string };

export type AgentEventEmitter = (event: AgentRunEvent) => void;

export function selectHistoryWindow(
  history: MessageRecord[],
  maxMessages: number,
  maxChars: number,
): MessageRecord[] {
  const candidates = history.filter((message) => message.role !== 'system');
  const selected: MessageRecord[] = [];
  let chars = 0;
  for (let i = candidates.length - 1; i >= 0 && selected.length < maxMessages; i--) {
    const message = candidates[i];
    const size = message.content.length + (message.toolCalls ? JSON.stringify(message.toolCalls).length : 0);
    if (selected.length > 0 && chars + size > maxChars) break;
    if (selected.length === 0 && size > maxChars) {
      selected.unshift({
        ...message,
        content: `…${message.content.slice(-maxChars)}`,
        toolCalls: undefined,
        toolCallId: undefined,
      });
      break;
    }
    selected.unshift(message);
    chars += size;
  }
  while (selected[0]?.role === 'tool') selected.shift();
  return selected;
}

export class AgentRuntime {
  readonly middleware: MiddlewareChain;

  constructor(
    private readonly gateway: GatewayClient,
    private readonly toolkit: Toolkit,
    private readonly hitl: HitlManager,
    private readonly store: MetadataStore,
    private readonly opts: {
      maxIterations: number;
      maxHistoryMessages?: number;
      maxHistoryChars?: number;
      maxToolResultChars?: number;
      approvalTimeoutMs: number;
      defaultModel: string;
    },
  ) {
    this.middleware = new MiddlewareChain();
    this.middleware.use(metricsMiddleware());
  }

  async loadTools(token: string): Promise<ToolSpec[]> {
    return this.gateway.listTools(token);
  }

  /** 兼容工具管理接口；对话运行使用 loadTools 返回的独立快照。 */
  async refreshTools(token: string): Promise<number> {
    const specs = await this.loadTools(token);
    this.toolkit.replaceAll(specs);
    return specs.length;
  }

  /** 非流式运行（保持既有 `/api/chat` 行为不变） */
  async run(opts: RunOptions): Promise<AgentResult> {
    return this.execute(opts);
  }

  /**
   * 流式运行 —— 逐事件回调，供 `/ag-ui` 的 SSE 端点消费。
   *
   * 与 `run()` 共用同一套 ReAct 循环，区别只在模型调用走网关的流式端口。
   */
  async runStream(opts: RunOptions, emit: AgentEventEmitter): Promise<AgentResult> {
    return this.execute(opts, emit);
  }

  private async execute(opts: RunOptions, emit?: AgentEventEmitter): Promise<AgentResult> {
    const traceId = uuid().replace(/-/g, '');
    const maxIterations = opts.maxIterations ?? this.opts.maxIterations;

    // —— 组装上下文
    const history = selectHistoryWindow(
      await this.store.listMessages(opts.sessionId),
      this.opts.maxHistoryMessages ?? 32,
      this.opts.maxHistoryChars ?? 32_000,
    );
    const messages: any[] = [
      { role: 'system', content: AGENT_SYSTEM_PROMPT },
      ...history
        .filter((m) => m.role !== 'system')
        .map((m) => ({
          role: m.role,
          content: m.content,
          ...(m.toolCalls ? { tool_calls: m.toolCalls } : {}),
          ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
        })),
      { role: 'user', content: opts.message },
    ];

    await this.store.appendMessage({
      id: uuid(),
      sessionId: opts.sessionId,
      role: 'user',
      content: opts.message,
      createdAt: new Date().toISOString(),
      traceId,
    });

    const ctx: AgentContext = {
      identity: opts.identity,
      sessionId: opts.sessionId,
      traceId,
      appId: opts.appId,
      iteration: 0,
      messages,
    };

    const toolCallTrace: AgentResult['toolCalls'] = [];
    const runToolkit = new Toolkit();
    runToolkit.replaceAll(opts.tools ?? this.toolkit.specs());
    const toolSchemas = runToolkit.toFunctionSchemas();
    /** 流式路径的工具调用分片累积（按 index） */
    const toolCallAcc = new Map<number, { id: string; name: string; args: string; announced: boolean }>();

    try {
      for (let iteration = 1; iteration <= maxIterations; iteration++) {
        ctx.iteration = iteration;
        // 客户端断开时立刻停下，避免继续消耗模型额度
        if (opts.signal?.aborted) throw new Error('请求已取消（客户端已断开）');
        emit?.({ type: 'iteration', iteration });
        await this.middleware.before(ctx);

        const chatArgs = {
          model: opts.model ?? this.opts.defaultModel,
          messages,
          tools: toolSchemas.length ? toolSchemas : undefined,
          sessionId: opts.sessionId,
          appId: opts.appId,
          signal: opts.signal,
        };
        const resp = emit
          ? await this.gateway.streamChat(opts.token, chatArgs, (d) => {
              if (d.contentDelta) {
                emit({ type: 'text_delta', delta: d.contentDelta });
              }
              if (d.toolCallDelta) {
                const t = d.toolCallDelta;
                const acc = toolCallAcc.get(t.index);
                if (!acc) {
                  toolCallAcc.set(t.index, {
                    id: t.id ?? `call_${t.index}`,
                    name: t.name ?? '',
                    args: '',
                    announced: false,
                  });
                } else {
                  if (t.name && !acc.name) acc.name = t.name;
                  if (t.argumentsDelta) acc.args += t.argumentsDelta;
                }
                const cur = toolCallAcc.get(t.index)!;
                if (t.name && !cur.announced) {
                  cur.announced = true;
                  emit({
                    type: 'tool_call_start',
                    toolCallId: cur.id,
                    name: cur.name,
                    args: {},
                  });
                }
                if (t.argumentsDelta) {
                  emit({ type: 'tool_call_args', toolCallId: cur.id, delta: t.argumentsDelta });
                }
              }
            })
          : await this.gateway.chat(opts.token, chatArgs);

        // 工具调用分片收口：逐个发 TOOL_CALL_END
        if (emit) {
          for (const acc of toolCallAcc.values()) {
            emit({ type: 'tool_call_end', toolCallId: acc.id });
          }
          toolCallAcc.clear();
        }

        // —— 无工具调用 → 最终答案
        if (!resp.toolCalls.length) {
          const result: AgentResult = {
            content: resp.content,
            iterations: iteration,
            toolCalls: toolCallTrace,
            traceId,
          };
          await this.store.appendMessage({
            id: uuid(),
            sessionId: opts.sessionId,
            role: 'assistant',
            content: resp.content,
            createdAt: new Date().toISOString(),
            traceId,
          });
          await this.middleware.after(ctx, result);
          return result;
        }

        // —— 记录 assistant 的工具调用
        messages.push({
          role: 'assistant',
          content: resp.content ?? '',
          tool_calls: resp.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          })),
        });

        for (const tc of resp.toolCalls) {
          const spec = runToolkit.get(tc.name)?.spec;
          let confirmationId: string | undefined;

          // —— HITL：需人工确认的工具
          if (spec?.requiresConfirmation) {
            const approval = await this.hitl.request({
              identity: opts.identity,
              sessionId: opts.sessionId,
              traceId,
              tool: tc.name,
              args: tc.arguments,
              reason: `工具 ${tc.name} 属于敏感写操作，按平台规则需人工确认后执行`,
            });
            emit?.({
              type: 'approval_pending',
              toolCallId: tc.id,
              approvalId: approval.id,
              tool: tc.name,
              args: tc.arguments,
            });
            const decision = await this.hitl.wait(approval.id, this.opts.approvalTimeoutMs, opts.signal);
            emit?.({ type: 'approval_decided', toolCallId: tc.id, decision });
            if (decision !== 'approved') {
              const msg =
                decision === 'rejected'
                  ? `工具 ${tc.name} 已被人工审批驳回，未执行。请根据该结果继续回答。`
                  : `工具 ${tc.name} 的人工审批超时，未执行。请根据该结果继续回答。`;
              // 工具已被否决同样要回一个结果事件 —— 否则前端会一直挂在「等待工具返回」态
              emit?.({ type: 'tool_result', toolCallId: tc.id, ok: false, output: msg });
              messages.push({ role: 'tool', tool_call_id: tc.id, content: msg });
              toolCallTrace.push({ name: tc.name, args: tc.arguments, ok: false, output: msg });
              continue;
            }
            confirmationId = approval.id;
          }

          // —— 经网关调用工具
          const outcome = await this.gateway.callTool(opts.token, {
            serverId: spec?.serverId ?? 'unknown',
            tool: tc.name,
            args: tc.arguments,
            traceId,
            approvalId: confirmationId,
            sessionId: opts.sessionId,
            appId: opts.appId,
            signal: opts.signal,
          });

          const rawToolMessage = outcome.ok
            ? outcome.content
            : `工具 ${tc.name} 调用失败：${outcome.content}`;
          const maxToolChars = this.opts.maxToolResultChars ?? 20_000;
          const toolMessage = rawToolMessage.length > maxToolChars
            ? `${rawToolMessage.slice(0, maxToolChars)}\n…（工具结果过长，已截断）`
            : rawToolMessage;
          emit?.({ type: 'tool_result', toolCallId: tc.id, ok: outcome.ok, output: toolMessage });
          messages.push({ role: 'tool', tool_call_id: tc.id, content: toolMessage });
          toolCallTrace.push({
            name: tc.name,
            args: tc.arguments,
            ok: outcome.ok,
            output: outcome.content.slice(0, 2000),
          });
        }
      }

      // —— 达到最大迭代：强制收尾
      const finalResp = await this.gateway.chat(opts.token, {
        model: opts.model ?? this.opts.defaultModel,
        messages: [
          ...messages,
          {
            role: 'user',
            content:
              '已达最大工具调用轮次，请立即基于目前已有信息给出最终结论。' +
              '要求：① 先给结论；② 列出已核实的数据与来源；③ 明确说明哪些部分未能完成及原因。' +
              '不要再调用任何工具，直接输出答案。',
          },
        ],
        maxTokens: 8192,
        sessionId: opts.sessionId,
        appId: opts.appId,
        signal: opts.signal,
      });

      const finalContent =
        finalResp.content.trim() ||
        '已达到最大工具调用轮次，但模型未输出最终答案。已完成的工具调用结果：\n' +
          toolCallTrace
            .filter((t) => t.ok)
            .map((t, i) => `${i + 1}. ${t.name}：${(t.output ?? '').slice(0, 300)}`)
            .join('\n');

      await this.store.appendMessage({
        id: uuid(),
        sessionId: opts.sessionId,
        role: 'assistant',
        content: finalContent,
        createdAt: new Date().toISOString(),
        traceId,
      });

      const result: AgentResult = {
        content: finalContent,
        iterations: maxIterations,
        toolCalls: toolCallTrace,
        traceId,
      };
      await this.middleware.after(ctx, result);
      return result;
    } catch (err) {
      await this.middleware.onError(ctx, err);
      throw err;
    }
  }
}
