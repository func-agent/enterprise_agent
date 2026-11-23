import { describe, expect, it } from 'vitest';
import type { Identity, MetadataStore, ToolSpec } from '@eap/platform-core';
import { AgentRuntime, selectHistoryWindow } from '../packages/agent-core/src/runtime.js';
import { Toolkit } from '../packages/agent-core/src/toolkit.js';

const identity: Identity = {
  tenantId: 't-1', userId: 'u-1', role: 'employee', deptId: 'd', sensitivity: 'internal', scopes: [], claims: {},
};

function tool(name: string): ToolSpec {
  return { name, description: name, inputSchema: { type: 'object' }, serverId: 'test', requiresConfirmation: false, sensitivity: 'internal' };
}

describe('Agent 工具目录运行隔离', () => {
  it('并发运行使用各自工具快照，不读取被后续请求修改的全局目录', async () => {
    const shared = new Toolkit();
    shared.replaceAll([tool('shared.old')]);
    const seen = new Map<string, string[]>();
    const gateway = {
      chat: async (_token: string, opts: { sessionId: string; tools?: { function: { name: string } }[] }) => {
        seen.set(opts.sessionId, (opts.tools ?? []).map((item) => item.function.name));
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { content: 'ok', toolCalls: [], promptTokens: 0, completionTokens: 0 };
      },
    };
    const store = {
      listMessages: async () => [],
      appendMessage: async () => undefined,
    } as unknown as MetadataStore;
    const runtime = new AgentRuntime(gateway as never, shared, {} as never, store, {
      maxIterations: 2,
      approvalTimeoutMs: 10,
      defaultModel: 'smart-model',
    });

    const first = runtime.run({ identity, token: 't', sessionId: 'first', message: 'a', tools: [tool('tenant.a')] });
    shared.replaceAll([tool('shared.new')]);
    const second = runtime.run({ identity, token: 't', sessionId: 'second', message: 'b', tools: [tool('tenant.b')] });
    await Promise.all([first, second]);

    expect(seen.get('first')).toEqual(['tenant.a']);
    expect(seen.get('second')).toEqual(['tenant.b']);
  });
});


describe('Agent 历史窗口', () => {
  it('限制消息数量并移除窗口开头的孤立工具消息', () => {
    const history = Array.from({ length: 8 }, (_, i) => ({
      id: String(i), sessionId: 's', role: i === 4 ? 'tool' as const : i % 2 ? 'assistant' as const : 'user' as const,
      content: `message-${i}`, createdAt: new Date(i).toISOString(),
    }));
    const window = selectHistoryWindow(history, 4, 1000);
    expect(window.length).toBeLessThanOrEqual(3);
    expect(window[0].role).not.toBe('tool');
    expect(window.at(-1)?.content).toBe('message-7');
  });

  it('单条超长历史也会截断到字符预算', () => {
    const window = selectHistoryWindow([{
      id: '1', sessionId: 's', role: 'assistant', content: 'x'.repeat(1000), createdAt: '',
    }], 10, 100);
    expect(window).toHaveLength(1);
    expect(window[0].content.length).toBeLessThanOrEqual(101);
  });
});


describe('Agent 审批号传递', () => {
  it('HITL 批准后将审批号、会话和 trace 传给网关注销', async () => {
    const write = { ...tool('business.write.submit_expense'), requiresConfirmation: true };
    let chatCalls = 0;
    let toolParams: Record<string, unknown> = {};
    const gateway = {
      chat: async () => {
        chatCalls++;
        return chatCalls === 1
          ? { content: '', toolCalls: [{ id: 'call-1', name: write.name, arguments: { amount: 100 } }], promptTokens: 0, completionTokens: 0 }
          : { content: '已完成', toolCalls: [], promptTokens: 0, completionTokens: 0 };
      },
      callTool: async (_token: string, params: Record<string, unknown>) => {
        toolParams = params;
        return { ok: true, content: 'written' };
      },
    };
    const hitl = {
      request: async () => ({ id: 'approval-1' }),
      wait: async () => 'approved',
    };
    const store = { listMessages: async () => [], appendMessage: async () => undefined } as unknown as MetadataStore;
    const runtime = new AgentRuntime(gateway as never, new Toolkit(), hitl as never, store, {
      maxIterations: 3, approvalTimeoutMs: 100, defaultModel: 'smart-model',
    });
    const result = await runtime.run({ identity, token: 't', sessionId: 'approval-session', message: 'submit', tools: [write] });
    expect(result.content).toBe('已完成');
    expect(toolParams.approvalId).toBe('approval-1');
    expect(toolParams.sessionId).toBe('approval-session');
    expect(toolParams.traceId).toBe(result.traceId);
  });
});
