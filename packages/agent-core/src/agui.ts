/**
 * AG-UI 协议端点 —— 控制台流式对话（标准事件流）。
 *
 * 为什么用 AG-UI 而不是私有协议：前端用 `@ag-ui/client` 的 HttpAgent 直接消费，
 * 前后端都遵循 ag-ui-protocol/ag-ui 规范，后续换任何 AG-UI 前端都能直接对接。
 *
 * 不引入第二套运行时：复用 AgentRuntime 的同一套 ReAct 循环，
 * 治理链（预算 / 护栏 / 脱敏 / 审计 / HITL）仍然在网关与中间件里生效，
 * 这里只做「运行时事件 → AG-UI 标准事件」的映射。
 *
 * 事件映射（字段对齐 @ag-ui/core 0.0.54）：
 *   iteration          → TEXT_MESSAGE_START（每轮 ReAct 迭代开一条 assistant 消息）
 *   text_delta         → TEXT_MESSAGE_CONTENT
 *   tool_call_start    → TOOL_CALL_START（parentMessageId 指向本轮 assistant 消息）
 *   tool_call_args     → TOOL_CALL_ARGS
 *   tool_call_end      → TOOL_CALL_END
 *   tool_result        → TOOL_CALL_RESULT（messageId = <父消息id>:<toolCallId>）
 *   approval_pending   → CUSTOM eap.approval_pending（等待人工审批）
 *   approval_decided   → CUSTOM eap.approval_decided（审批结论）
 *   正常结束           → RUN_FINISHED；异常 → RUN_ERROR
 */
import type { Request, Response } from 'express';
import { createLogger, uuid, type Identity, type MetadataStore } from '@eap/platform-core';
import { requireIdentity } from '@eap/auth-middleware';
import type { AgentRunEvent, AgentRuntime } from './runtime.js';
import { hasSessionAccess } from './session-auth.js';
import { SessionConflictError, SessionLifecycle } from './session-lifecycle.js';

const log = createLogger('agent:agui');

/** 工具结果正文上限 —— 单帧过大会把浏览器撑爆，超出部分截断 */
const MAX_TOOL_RESULT_CHARS = 20000;

/** AG-UI 标准事件（字段与 @ag-ui/core 0.0.54 对齐） */
export type AguiEvent =
  | { type: 'RUN_STARTED'; threadId: string; runId: string }
  | { type: 'RUN_FINISHED'; threadId: string; runId: string; result?: unknown }
  | { type: 'RUN_ERROR'; message: string; code?: string }
  | { type: 'TEXT_MESSAGE_START'; messageId: string; role: 'assistant' }
  | { type: 'TEXT_MESSAGE_CONTENT'; messageId: string; delta: string }
  | { type: 'TEXT_MESSAGE_END'; messageId: string }
  | { type: 'TOOL_CALL_START'; toolCallId: string; toolCallName: string; parentMessageId?: string }
  | { type: 'TOOL_CALL_ARGS'; toolCallId: string; delta: string }
  | { type: 'TOOL_CALL_END'; toolCallId: string }
  | { type: 'TOOL_CALL_RESULT'; messageId: string; toolCallId: string; content: string; role?: 'tool' }
  | { type: 'CUSTOM'; name: string; value: unknown };

/** AG-UI 运行输入（RunAgentInput）—— 只保留本平台用得到的字段 */
export interface AguiRunInput {
  threadId: string;
  runId: string;
  messages: { id?: string; role?: string; content?: string }[];
  forwardedProps: Record<string, unknown>;
}

/** 解析 RunAgentInput（容忍缺字段 / 多余字段） */
export function parseRunInput(body: unknown): AguiRunInput {
  const b = (body ?? {}) as Record<string, any>;
  return {
    threadId: typeof b.threadId === 'string' ? b.threadId : '',
    runId: typeof b.runId === 'string' ? b.runId : '',
    messages: Array.isArray(b.messages) ? b.messages : [],
    forwardedProps:
      b.forwardedProps && typeof b.forwardedProps === 'object'
        ? (b.forwardedProps as Record<string, unknown>)
        : {},
  };
}

/** 取最后一条 user 消息的正文作为本轮输入 */
export function pickUserMessage(input: AguiRunInput): string {
  for (let i = input.messages.length - 1; i >= 0; i--) {
    const m = input.messages[i];
    if (m?.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
      return m.content.trim();
    }
  }
  return '';
}

/**
 * SSE 帧写出器 —— 客户端断开后自动停写。
 *
 * AG-UI 的 SSE 帧格式为 `data: {json}\n\n`（`@ag-ui/client` 的 parseSSEStream 按此解析）。
 */
export class AguiSseWriter {
  private closed = false;

  constructor(private readonly res: Response) {
    res.on('close', () => {
      // 正常收尾也会触发 close，只有「没写完就关闭」才算客户端断开
      if (!res.writableFinished) this.closed = true;
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  write(ev: AguiEvent): boolean {
    if (this.closed || this.res.writableEnded) {
      this.closed = true;
      return false;
    }
    try {
      this.res.write(`data: ${JSON.stringify(ev)}\n\n`);
      return true;
    } catch {
      this.closed = true;
      return false;
    }
  }

  ping(): boolean {
    if (this.closed || this.res.writableEnded) return false;
    try {
      this.res.write(': keepalive\n\n');
      return true;
    } catch {
      this.closed = true;
      return false;
    }
  }

  end(): void {
    if (this.res.writableEnded) return;
    try {
      this.res.end();
    } catch {
      /* 客户端已断开，忽略 */
    }
  }
}

/**
 * 运行时事件 → AG-UI 事件 映射器。
 *
 * 维护「当前 assistant 消息」：每轮 ReAct 迭代开一条新消息，
 * 本轮的工具调用挂在同一条消息下（与官方 AgentScope 转换器的 reply_id 语义一致）。
 */
export class AguiEventMapper {
  private seq = 0;
  private messageId: string | null = null;
  private messageOpen = false;

  constructor(private readonly runId: string) {}

  /** 当前 assistant 消息 id（工具调用的父消息） */
  currentMessageId(): string {
    return this.messageId ?? `${this.runId}-msg0`;
  }

  map(ev: AgentRunEvent): AguiEvent[] {
    switch (ev.type) {
      case 'iteration': {
        const out: AguiEvent[] = [];
        const closed = this.closeMessage();
        if (closed) out.push(closed);
        this.messageId = `${this.runId}-msg${++this.seq}`;
        this.messageOpen = true;
        out.push({ type: 'TEXT_MESSAGE_START', messageId: this.messageId, role: 'assistant' });
        return out;
      }
      case 'text_delta': {
        if (!ev.delta) return [];
        const out: AguiEvent[] = [];
        const opened = this.ensureMessage();
        if (opened) out.push(opened);
        out.push({ type: 'TEXT_MESSAGE_CONTENT', messageId: this.currentMessageId(), delta: ev.delta });
        return out;
      }
      case 'tool_call_start': {
        const out: AguiEvent[] = [];
        const opened = this.ensureMessage();
        if (opened) out.push(opened);
        out.push({
          type: 'TOOL_CALL_START',
          toolCallId: ev.toolCallId,
          toolCallName: ev.name || 'tool',
          parentMessageId: this.currentMessageId(),
        });
        return out;
      }
      case 'tool_call_args':
        return [{ type: 'TOOL_CALL_ARGS', toolCallId: ev.toolCallId, delta: ev.delta }];
      case 'tool_call_end':
        return [{ type: 'TOOL_CALL_END', toolCallId: ev.toolCallId }];
      case 'tool_result':
        return [
          {
            type: 'TOOL_CALL_RESULT',
            messageId: `${this.currentMessageId()}:${ev.toolCallId}`,
            toolCallId: ev.toolCallId,
            content: truncate(ev.output, MAX_TOOL_RESULT_CHARS),
            role: 'tool',
          },
        ];
      case 'approval_pending':
        return [
          {
            type: 'CUSTOM',
            name: 'eap.approval_pending',
            value: {
              approvalId: ev.approvalId,
              toolCallId: ev.toolCallId,
              tool: ev.tool,
              args: ev.args,
            },
          },
        ];
      case 'approval_decided':
        return [
          {
            type: 'CUSTOM',
            name: 'eap.approval_decided',
            value: { toolCallId: ev.toolCallId, decision: ev.decision },
          },
        ];
      case 'error':
        return [{ type: 'RUN_ERROR', message: ev.error, code: 'agent_error' }];
      case 'done':
      default:
        return [];
    }
  }

  /** 收尾：关闭当前 assistant 消息 */
  finish(): AguiEvent[] {
    const closed = this.closeMessage();
    return closed ? [closed] : [];
  }

  private closeMessage(): AguiEvent | null {
    if (!this.messageOpen || !this.messageId) return null;
    this.messageOpen = false;
    return { type: 'TEXT_MESSAGE_END', messageId: this.messageId };
  }

  /** 兜底：万一没收到 iteration 事件，先开一条消息再挂内容 */
  private ensureMessage(): AguiEvent | null {
    if (this.messageOpen) return null;
    this.messageId = `${this.runId}-msg${++this.seq}`;
    this.messageOpen = true;
    return { type: 'TEXT_MESSAGE_START', messageId: this.messageId, role: 'assistant' };
  }
}

/** 输入校验失败 —— 在 SSE 头发出前返回 4xx */
class AguiInputError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * 解析会话。
 *
 * 会话 id 由**客户端生成**（AG-UI 的 threadId 即平台 sessionId），
 * 服务端按需创建：
 *   - `forwardedProps.sessionId` 命中已有会话 → 沿用（跨租户则拒绝）
 *   - 未命中 → 以该 id 新建会话（客户端生成 uuid 的约定）
 *   - 未传 sessionId → 先拿 threadId 试一次，再退回服务端新建
 */
async function resolveSession(
  store: MetadataStore,
  identity: Identity,
  params: { sessionId?: string; threadId?: string; message: string; appId?: string },
): Promise<string> {
  const create = async (id: string): Promise<string> => {
    const now = new Date().toISOString();
    await store.createSession({
      id,
      tenantId: identity.tenantId,
      userId: identity.userId,
      title: params.message.slice(0, 40),
      createdAt: now,
      updatedAt: now,
      appId: params.appId,
    });
    return id;
  };

  if (params.sessionId) {
    const session = await store.getSession(params.sessionId);
    if (session) {
      if (!hasSessionAccess(session, identity)) throw new AguiInputError('无权访问该会话', 403);
      return session.id;
    }
    return create(params.sessionId);
  }

  if (params.threadId) {
    const session = await store.getSession(params.threadId);
    if (session) {
      if (!hasSessionAccess(session, identity)) throw new AguiInputError('无权访问该会话', 403);
      return session.id;
    }
    return create(params.threadId);
  }

  return create(uuid());
}

export interface AguiDeps {
  runtime: AgentRuntime;
  store: MetadataStore;
  /**
   * 会话运行与删除的互斥状态。**必填** —— 漏传会造出与对话路由互不相连的
   * 实例，互斥形同虚设（运行中的会话可能被删掉）。
   */
  lifecycle: SessionLifecycle;
}

/**
 * 生成 `POST /ag-ui` 处理器。
 *
 * 鉴权沿用 `/api/chat` 的同款链路：`authMiddleware` 解析 Bearer 令牌，
 * 这里取 `requireIdentity(req)` 与 `req.rawToken`。
 */
export function createAguiHandler(deps: AguiDeps) {
  const lifecycle = deps.lifecycle;
  return async function handleAgui(req: Request, res: Response): Promise<void> {
    let identity: Identity;
    try {
      identity = requireIdentity(req);
    } catch {
      res.status(401).json({ error: 'unauthenticated', message: '缺少有效身份' });
      return;
    }

    const token = req.rawToken;
    if (!token) {
      res.status(401).json({ error: 'missing_token', message: '缺少 Authorization: Bearer <token>' });
      return;
    }
    const input = parseRunInput(req.body);
    const message = pickUserMessage(input);
    if (!message) {
      res.status(400).json({
        error: 'missing_user_message',
        message: 'RunAgentInput.messages 中需包含至少一条 role=user 的消息',
      });
      return;
    }

    const forwarded = input.forwardedProps;
    const requestedSessionId = typeof forwarded.sessionId === 'string' ? forwarded.sessionId : undefined;
    const appId = typeof forwarded.appId === 'string' ? forwarded.appId : undefined;
    const model = typeof forwarded.model === 'string' ? forwarded.model : undefined;

    let sessionId: string;
    try {
      sessionId = await resolveSession(deps.store, identity, {
        sessionId: requestedSessionId,
        threadId: input.threadId,
        message,
        appId,
      });
    } catch (err: any) {
      const status = err instanceof AguiInputError ? err.status : 500;
      res.status(status).json({ error: err?.message ?? '会话解析失败' });
      return;
    }

    let releaseRun: () => void;
    try {
      releaseRun = lifecycle.acquireRun(sessionId);
    } catch (err) {
      if (err instanceof SessionConflictError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }

    // 运行占用必须**一定**被归还：SSE 头写出、首帧写入等准备动作若抛错，
    // 会话会被永久标记为「运行中」，之后既不能删除也不能再运行。
    // 因此从占用的那一刻起就用 try/finally 兜住整段处理。
    try {
      const threadId = input.threadId || sessionId;
      const runId = input.runId || uuid();

      // —— SSE 头：先落 header 再 flush，保证首帧尽快到达
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();
      res.setTimeout?.(0);

      const writer = new AguiSseWriter(res);
      const mapper = new AguiEventMapper(runId);
      const controller = new AbortController();
      // 客户端中途断开 → 中断运行，避免继续消耗模型额度
      res.on('close', () => {
        if (!res.writableFinished) controller.abort();
      });

      writer.write({ type: 'RUN_STARTED', threadId, runId });
      // 把平台会话号回传前端，前端据此后续沿用同一会话
      writer.write({ type: 'CUSTOM', name: 'eap.session', value: { sessionId, threadId, runId } });
      const heartbeat = setInterval(() => writer.ping(), 15_000);
      heartbeat.unref();

      const emit = (ev: AgentRunEvent) => {
        if (writer.isClosed) return;
        for (const out of mapper.map(ev)) {
          if (!writer.write(out)) return;
        }
      };

      try {
        // 每次对话加载本次运行专属的工具快照，避免并发会话互相覆盖。
        const tools = await deps.runtime.loadTools(token);
        const result = await deps.runtime.runStream(
          { identity, token, sessionId, message, appId, model, tools, signal: controller.signal },
          emit,
        );
        for (const ev of mapper.finish()) writer.write(ev);
        await deps.store.updateSession(sessionId, { updatedAt: new Date().toISOString() });
        writer.write({
          type: 'RUN_FINISHED',
          threadId,
          runId,
          result: {
            sessionId,
            content: result.content,
            iterations: result.iterations,
            toolCalls: result.toolCalls,
            traceId: result.traceId,
          },
        });
      } catch (err: any) {
        for (const ev of mapper.finish()) writer.write(ev);
        const msg = err?.message ?? String(err);
        if (controller.signal.aborted) {
          log.info('AG-UI 运行被客户端中断', { sessionId, runId });
        } else {
          log.error('AG-UI 运行失败', { sessionId, runId, error: msg });
          writer.write({ type: 'RUN_ERROR', message: msg, code: 'agent_error' });
        }
      } finally {
        clearInterval(heartbeat);
        writer.end();
      }
    } finally {
      // 无论 SSE 准备阶段还是运行阶段出错，都必须归还运行占用
      releaseRun();
    }
  };
}

function truncate(text: string | undefined, max: number): string {
  const s = typeof text === 'string' ? text : '';
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…（内容过长，已截断，共 ${s.length} 字符）`;
}
