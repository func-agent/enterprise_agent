/**
 * Middleware 链 —— AgentScope Core 的 Middleware 机制。
 *
 * 用于横切关注点：日志、成本统计、护栏、租户上下文注入、HITL 前置检查。
 */
import { createLogger } from '@eap/platform-core';
import type { Identity } from '@eap/platform-core';

const log = createLogger('agent:middleware');

export interface AgentContext {
  identity: Identity;
  sessionId: string;
  traceId: string;
  appId?: string;
  iteration: number;
  /** 追加到上下文的消息 */
  messages: { role: string; content: string }[];
}

export interface AgentResult {
  content: string;
  iterations: number;
  toolCalls: { name: string; args: unknown; ok: boolean; output?: string }[];
  traceId: string;
  pendingApproval?: { id: string; tool: string };
}

export interface Middleware {
  name: string;
  before?(ctx: AgentContext): Promise<void> | void;
  after?(ctx: AgentContext, result: AgentResult): Promise<void> | void;
  onError?(ctx: AgentContext, err: unknown): Promise<void> | void;
}

export class MiddlewareChain {
  private middlewares: Middleware[] = [];

  use(mw: Middleware): this {
    this.middlewares.push(mw);
    return this;
  }

  list(): string[] {
    return this.middlewares.map((m) => m.name);
  }

  async before(ctx: AgentContext): Promise<void> {
    for (const mw of this.middlewares) {
      try {
        await mw.before?.(ctx);
      } catch (err) {
        log.error('middleware before 异常', { middleware: mw.name, error: String(err) });
        throw err;
      }
    }
  }

  async after(ctx: AgentContext, result: AgentResult): Promise<void> {
    for (const mw of [...this.middlewares].reverse()) {
      try {
        await mw.after?.(ctx, result);
      } catch (err) {
        log.error('middleware after 异常', { middleware: mw.name, error: String(err) });
      }
    }
  }

  async onError(ctx: AgentContext, err: unknown): Promise<void> {
    for (const mw of [...this.middlewares].reverse()) {
      try {
        await mw.onError?.(ctx, err);
      } catch (e) {
        log.error('middleware onError 异常', { middleware: mw.name, error: String(e) });
      }
    }
  }
}

/** 内置中间件：成本与耗时统计 */
export function metricsMiddleware(): Middleware {
  return {
    name: 'metrics',
    async after(ctx, result) {
      log.info('agent 运行完成', {
        sessionId: ctx.sessionId,
        traceId: ctx.traceId,
        iterations: result.iterations,
        toolCalls: result.toolCalls.length,
        tenant: ctx.identity.tenantId,
        user: ctx.identity.userId,
      });
    },
    async onError(ctx, err) {
      log.error('agent 运行失败', {
        sessionId: ctx.sessionId,
        traceId: ctx.traceId,
        error: String(err),
      });
    },
  };
}
