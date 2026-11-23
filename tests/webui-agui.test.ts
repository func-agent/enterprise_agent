import { describe, expect, it, vi } from 'vitest';
import { createAguiHttpAgent } from '../apps/webui/src/api/agui';

function sseResponse(events: Record<string, unknown>[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
}

function agentWithResponse(response: Response) {
  return createAguiHttpAgent({
    threadId: 'thread-1',
    fetch: async () => response,
  });
}

describe('Web AG-UI 错误状态适配', () => {
  it('RUN_ERROR 转为运行失败，且不再合成 RUN_FINISHED 覆盖错误', async () => {
    const onRunFailed = vi.fn();
    const onRunFinalized = vi.fn();
    const agent = agentWithResponse(sseResponse([
      { type: 'RUN_STARTED', threadId: 'thread-1', runId: 'run-1' },
      { type: 'RUN_ERROR', message: '涉密数据禁止出网', code: 'agent_error' },
    ]));

    await agent.runAgent({}, { onRunFailed, onRunFinalized });

    expect(onRunFailed).toHaveBeenCalledOnce();
    expect(onRunFailed.mock.calls[0][0].error.message).toBe('涉密数据禁止出网');
    expect(onRunFailed.mock.calls[0][0].error.code).toBe('agent_error');
    expect(onRunFinalized).not.toHaveBeenCalled();
  });

  it('正常完成时仍执行原有收尾逻辑', async () => {
    const onRunFailed = vi.fn();
    const onRunFinalized = vi.fn();
    const agent = agentWithResponse(sseResponse([
      { type: 'RUN_STARTED', threadId: 'thread-1', runId: 'run-2' },
      { type: 'RUN_FINISHED', threadId: 'thread-1', runId: 'run-2' },
    ]));

    await agent.runAgent({}, { onRunFailed, onRunFinalized });

    expect(onRunFailed).not.toHaveBeenCalled();
    expect(onRunFinalized).toHaveBeenCalledOnce();
  });

  it('每次运行读取动态模型，恢复默认后不再传 model', async () => {
    const bodies: Record<string, any>[] = [];
    let selectedModel: string | undefined = 'fast-model';
    const agent = createAguiHttpAgent({
      threadId: () => 'thread-model',
      forwardedProps: () => ({
        sessionId: 'thread-model',
        ...(selectedModel ? { model: selectedModel } : {}),
      }),
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        return sseResponse([
          { type: 'RUN_STARTED', threadId: body.threadId, runId: body.runId },
          { type: 'RUN_FINISHED', threadId: body.threadId, runId: body.runId },
        ]);
      },
    });

    await agent.runAgent({});
    selectedModel = undefined;
    await agent.runAgent({});

    expect(bodies[0].forwardedProps).toMatchObject({ sessionId: 'thread-model', model: 'fast-model' });
    expect(bodies[1].forwardedProps).toEqual({ sessionId: 'thread-model' });
  });

  it('HTTP 失败同样保留失败状态并抑制伪正常收尾', async () => {
    const onRunFailed = vi.fn();
    const onRunFinalized = vi.fn();
    const agent = agentWithResponse(new Response('provider unavailable', { status: 503 }));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await expect(agent.runAgent({}, { onRunFailed, onRunFinalized })).rejects.toThrow('HTTP 503');
      expect(onRunFailed).toHaveBeenCalledOnce();
      expect(onRunFinalized).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});
