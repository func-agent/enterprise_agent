/**
 * AG-UI 协议端点测试（控制台流式对话）。
 *
 * 关键断言：
 *   ① 事件映射与 @ag-ui/core 0.0.54 的字段名、语义完全一致；
 *   ② SSE 帧格式为 `data: {json}\n\n`（@ag-ui/client 的 parseSSEStream 依赖它）；
 *   ③ 每次工具调用都有对应的 TOOL_CALL_RESULT —— 缺一个前端就会一直挂在
 *      「等待工具返回」态（react-ag-ui 在 RUN_FINISHED 时按未收口工具判定 requires-action）；
 *   ④ 鉴权与输入校验在 SSE 头发出前完成，能返回正确的 HTTP 状态码。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { SqliteMetadataStore, type MetadataStore } from '@eap/platform-core';
import {
  AguiEventMapper,
  AguiSseWriter,
  createAguiHandler,
  parseRunInput,
  pickUserMessage,
  type AguiEvent,
} from '../packages/agent-core/src/agui.js';
import type { AgentRunEvent } from '../packages/agent-core/src/runtime.js';
import { SessionLifecycle } from '../packages/agent-core/src/session-lifecycle.js';
import { sessionRoutes } from '../packages/agent-core/src/session-routes.js';

// —— 事件映射

describe('AG-UI 事件映射', () => {
  it('iteration 开启一条 assistant 消息，下一轮先关闭上一条', () => {
    const m = new AguiEventMapper('r1');
    const first = m.map({ type: 'iteration', iteration: 1 });
    expect(first).toEqual([
      { type: 'TEXT_MESSAGE_START', messageId: 'r1-msg1', role: 'assistant' },
    ]);

    const second = m.map({ type: 'iteration', iteration: 2 });
    expect(second[0]).toEqual({ type: 'TEXT_MESSAGE_END', messageId: 'r1-msg1' });
    expect(second[1]).toEqual({
      type: 'TEXT_MESSAGE_START',
      messageId: 'r1-msg2',
      role: 'assistant',
    });
  });

  it('text_delta 映射为 TEXT_MESSAGE_CONTENT，且复用当前消息 id', () => {
    const m = new AguiEventMapper('r1');
    m.map({ type: 'iteration', iteration: 1 });
    const out = m.map({ type: 'text_delta', delta: '你好' });
    expect(out).toEqual([
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'r1-msg1', delta: '你好' },
    ]);
  });

  it('空增量不产出事件', () => {
    const m = new AguiEventMapper('r1');
    m.map({ type: 'iteration', iteration: 1 });
    expect(m.map({ type: 'text_delta', delta: '' })).toEqual([]);
  });

  it('工具调用三件套：START 带 parentMessageId，ARGS 透传分片，END 收口', () => {
    const m = new AguiEventMapper('r1');
    m.map({ type: 'iteration', iteration: 1 });

    expect(m.map({ type: 'tool_call_start', toolCallId: 'c1', name: 'knowledge.search', args: {} })).toEqual([
      {
        type: 'TOOL_CALL_START',
        toolCallId: 'c1',
        toolCallName: 'knowledge.search',
        parentMessageId: 'r1-msg1',
      },
    ]);

    expect(m.map({ type: 'tool_call_args', toolCallId: 'c1', delta: '{"query"' })).toEqual([
      { type: 'TOOL_CALL_ARGS', toolCallId: 'c1', delta: '{"query"' },
    ]);

    expect(m.map({ type: 'tool_call_end', toolCallId: 'c1' })).toEqual([
      { type: 'TOOL_CALL_END', toolCallId: 'c1' },
    ]);
  });

  it('工具结果的 messageId 为 <父消息id>:<toolCallId>', () => {
    const m = new AguiEventMapper('r1');
    m.map({ type: 'iteration', iteration: 1 });
    const out = m.map({ type: 'tool_result', toolCallId: 'c1', ok: true, output: '命中 3 条' });
    expect(out).toEqual([
      {
        type: 'TOOL_CALL_RESULT',
        messageId: 'r1-msg1:c1',
        toolCallId: 'c1',
        content: '命中 3 条',
        role: 'tool',
      },
    ]);
  });

  it('工具结果超长时截断，避免单帧撑爆浏览器', () => {
    const m = new AguiEventMapper('r1');
    m.map({ type: 'iteration', iteration: 1 });
    const out = m.map({
      type: 'tool_result',
      toolCallId: 'c1',
      ok: true,
      output: 'x'.repeat(30000),
    }) as Extract<AguiEvent, { type: 'TOOL_CALL_RESULT' }>[];
    expect(out[0].content.length).toBeLessThan(30000);
    expect(out[0].content).toContain('已截断');
  });

  it('HITL 事件映射为 CUSTOM，携带审批单号与工具名', () => {
    const m = new AguiEventMapper('r1');
    m.map({ type: 'iteration', iteration: 1 });

    const pending = m.map({
      type: 'approval_pending',
      toolCallId: 'c1',
      approvalId: 'a1',
      tool: 'business.write.submit_expense',
      args: { amount: 120 },
    });
    expect(pending[0].type).toBe('CUSTOM');
    expect((pending[0] as { name: string }).name).toBe('eap.approval_pending');
    expect((pending[0] as { value: { approvalId: string; tool: string } }).value).toMatchObject({
      approvalId: 'a1',
      tool: 'business.write.submit_expense',
    });

    const decided = m.map({
      type: 'approval_decided',
      toolCallId: 'c1',
      decision: 'approved',
    });
    expect((decided[0] as { name: string }).name).toBe('eap.approval_decided');
    expect((decided[0] as { value: { decision: string } }).value.decision).toBe('approved');
  });

  it('finish 关闭最后一条消息，且重复调用不重复关闭', () => {
    const m = new AguiEventMapper('r1');
    m.map({ type: 'iteration', iteration: 1 });
    expect(m.finish()).toEqual([{ type: 'TEXT_MESSAGE_END', messageId: 'r1-msg1' }]);
    expect(m.finish()).toEqual([]);
  });
});

// —— 运行输入解析

describe('RunAgentInput 解析', () => {
  it('缺字段时给出安全默认值', () => {
    const input = parseRunInput(undefined);
    expect(input.threadId).toBe('');
    expect(input.runId).toBe('');
    expect(input.messages).toEqual([]);
    expect(input.forwardedProps).toEqual({});
  });

  it('取最后一条 user 消息作为本轮输入', () => {
    const input = parseRunInput({
      threadId: 't1',
      messages: [
        { role: 'user', content: '第一句' },
        { role: 'assistant', content: '回答' },
        { role: 'user', content: '第二句' },
      ],
    });
    expect(pickUserMessage(input)).toBe('第二句');
  });

  it('没有 user 消息时返回空串', () => {
    const input = parseRunInput({ messages: [{ role: 'assistant', content: 'x' }] });
    expect(pickUserMessage(input)).toBe('');
  });
});

// —— SSE 帧格式

describe('SSE 帧格式', () => {
  it('帧为 data: {json}\\n\\n，可被 @ag-ui/client 的 parseSSEStream 解析', () => {
    const chunks: string[] = [];
    const fake = {
      writableEnded: false,
      writableFinished: false,
      on: () => fake,
      write: (s: string) => {
        chunks.push(s);
        return true;
      },
      end: () => {
        fake.writableEnded = true;
      },
    };
    const writer = new AguiSseWriter(fake as never);
    writer.write({ type: 'RUN_STARTED', threadId: 't1', runId: 'r1' });
    writer.end();

    expect(chunks).toHaveLength(1);
    expect(chunks[0].endsWith('\n\n')).toBe(true);
    expect(chunks[0].startsWith('data: ')).toBe(true);
    const payload = JSON.parse(chunks[0].slice(6));
    expect(payload).toEqual({ type: 'RUN_STARTED', threadId: 't1', runId: 'r1' });
  });
});

// —— 端点级测试

/** 假运行时：按预设事件序列吐事件 */
function fakeRuntime(events: AgentRunEvent[], result = { content: 'ok', iterations: 1, toolCalls: [], traceId: 'trace-1' }) {
  return {
    loadTools: async () => [],
    refreshTools: async () => 0,
    runStream: async (_opts: unknown, emit: (e: AgentRunEvent) => void) => {
      for (const e of events) emit(e);
      return result;
    },
  };
}

describe('POST /ag-ui 端点', () => {
  let store: MetadataStore;
  let server: ReturnType<typeof express.prototype.listen> | null = null;
  let baseUrl = '';

  const identity = {
    tenantId: 't-1',
    userId: 'u-1',
    role: 'employee',
    deptId: 'dept-general',
    sensitivity: 'internal' as const,
    scopes: [],
    claims: {},
  };

  beforeEach(async () => {
    store = new SqliteMetadataStore(':memory:');
    await store.init();
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((r) => server!.close(() => r()));
      server = null;
    }
    await store.close();
  });

  async function listen(runtime: unknown) {
    const app = express();
    app.use(express.json());
    // 模拟 authMiddleware：注入身份与原始令牌
    app.use((req, _res, next) => {
      const auth = req.headers.authorization;
      if (auth?.startsWith('Bearer ')) {
        req.identity = identity;
        req.rawToken = auth.slice(7).trim();
      }
      next();
    });
    const lifecycle = new SessionLifecycle();
    app.post('/ag-ui', createAguiHandler({ runtime: runtime as never, store, lifecycle }));
    app.use('/api/sessions', sessionRoutes(store, lifecycle));
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server!.once('listening', () => r()));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }

  it('缺少令牌返回 401', async () => {
    await listen(fakeRuntime([]));
    const res = await fetch(`${baseUrl}/ag-ui`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(401);
  });

  it('缺少 user 消息返回 400（且未发出 SSE 头）', async () => {
    await listen(fakeRuntime([]));
    const res = await fetch(`${baseUrl}/ag-ui`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
      body: JSON.stringify({ messages: [] }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('missing_user_message');
  });

  it('会话不存在时按客户端 id 新建（会话 id 由客户端生成）', async () => {
    await listen(fakeRuntime([]));
    const res = await fetch(`${baseUrl}/ag-ui`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hi' }],
        forwardedProps: { sessionId: 'client-generated-id' },
      }),
    });
    expect(res.status).toBe(200);
    const created = await store.getSession('client-generated-id');
    expect(created).toBeTruthy();
    expect(created!.tenantId).toBe('t-1');
  });

  it('同租户不同用户访问他人会话返回 403', async () => {
    await store.createSession({
      id: 'other-user',
      tenantId: 't-1',
      userId: 'u-2',
      title: '同租户其他用户的会话',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await listen(fakeRuntime([]));
    const res = await fetch(`${baseUrl}/ag-ui`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hi' }],
        forwardedProps: { sessionId: 'other-user' },
      }),
    });
    expect(res.status).toBe(403);
  });

  it('跨租户访问他人会话返回 403', async () => {
    await store.createSession({
      id: 'other-tenant',
      tenantId: 't-other',
      userId: 'u-x',
      title: '别人的会话',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await listen(fakeRuntime([]));
    const res = await fetch(`${baseUrl}/ag-ui`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'hi' }],
        forwardedProps: { sessionId: 'other-tenant' },
      }),
    });
    expect(res.status).toBe(403);
  });

  it('正常返回 AG-UI 事件流，并回传平台会话号', async () => {
    await listen(
      fakeRuntime([
        { type: 'iteration', iteration: 1 },
        { type: 'text_delta', delta: '答' },
        { type: 'text_delta', delta: '案' },
        { type: 'tool_call_start', toolCallId: 'c1', name: 'knowledge.search', args: {} },
        { type: 'tool_call_args', toolCallId: 'c1', delta: '{}' },
        { type: 'tool_call_end', toolCallId: 'c1' },
        { type: 'tool_result', toolCallId: 'c1', ok: true, output: '命中' },
      ]),
    );

    const res = await fetch(`${baseUrl}/ag-ui`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
      body: JSON.stringify({
        threadId: 'th-1',
        runId: 'rn-1',
        messages: [{ role: 'user', content: '你好' }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const text = await res.text();
    const frames = text
      .split('\n\n')
      .filter(Boolean)
      .map((f) => JSON.parse(f.replace(/^data: /, '')) as AguiEvent);

    expect(frames[0]).toEqual({ type: 'RUN_STARTED', threadId: 'th-1', runId: 'rn-1' });

    // 会话号回传，前端据此续用同一会话
    const session = frames.find((f) => f.type === 'CUSTOM' && f.name === 'eap.session');
    expect(session).toBeTruthy();
    const sessionId = (session as { value: { sessionId: string } }).value.sessionId;
    expect(sessionId).toBeTruthy();

    // 文本增量
    const contents = frames.filter((f) => f.type === 'TEXT_MESSAGE_CONTENT');
    expect(contents).toHaveLength(2);

    // 工具调用三件套 + 结果齐全
    expect(frames.filter((f) => f.type === 'TOOL_CALL_START')).toHaveLength(1);
    expect(frames.filter((f) => f.type === 'TOOL_CALL_ARGS')).toHaveLength(1);
    expect(frames.filter((f) => f.type === 'TOOL_CALL_END')).toHaveLength(1);
    expect(frames.filter((f) => f.type === 'TOOL_CALL_RESULT')).toHaveLength(1);

    // 收尾
    const last = frames[frames.length - 1];
    expect(last.type).toBe('RUN_FINISHED');
    expect((last as { threadId: string }).threadId).toBe('th-1');

    // 会话已落库
    const saved = await store.getSession(sessionId);
    expect(saved).toBeTruthy();
    expect(saved!.tenantId).toBe('t-1');
  });

  it('forwardedProps.sessionId 命中已有会话时复用，不新建', async () => {
    await store.createSession({
      id: 'sess-1',
      tenantId: 't-1',
      userId: 'u-1',
      title: '旧会话',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await listen(fakeRuntime([]));

    const res = await fetch(`${baseUrl}/ag-ui`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
      body: JSON.stringify({
        threadId: 'th-2',
        messages: [{ role: 'user', content: '继续' }],
        forwardedProps: { sessionId: 'sess-1' },
      }),
    });
    const text = await res.text();
    expect(text).toContain('"sessionId":"sess-1"');

    const sessions = await store.listSessions('t-1');
    expect(sessions).toHaveLength(1);
  });

  it('forwardedProps.model 传递到 Agent 运行时', async () => {
    let receivedModel = '';
    const runtime = {
      loadTools: async () => [],
      runStream: async (opts: { model?: string }) => {
        receivedModel = opts.model ?? '';
        return { content: 'ok', iterations: 1, toolCalls: [], traceId: 'trace-model' };
      },
    };
    await listen(runtime);

    const res = await fetch(`${baseUrl}/ag-ui`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
      body: JSON.stringify({
        threadId: 'th-model', messages: [{ role: 'user', content: '验证模型' }],
        forwardedProps: { sessionId: 'th-model', model: 'fast-model' },
      }),
    });
    await res.text();
    expect(receivedModel).toBe('fast-model');
  });

  it('运行时异常映射为 RUN_ERROR 并正常收流', async () => {
    const boom = {
      loadTools: async () => [],
      runStream: async () => {
        throw new Error('网关不可用');
      },
    };
    await listen(boom);

    const res = await fetch(`${baseUrl}/ag-ui`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
      body: JSON.stringify({ threadId: 'th-3', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"type":"RUN_ERROR"');
    expect(text).toContain('网关不可用');
    const deleted = await fetch(`${baseUrl}/api/sessions/th-3`, {
      method: 'DELETE', headers: { authorization: 'Bearer t' },
    });
    expect(deleted.status).toBe(204);
  });

  it('流式运行中拒绝删除，结束后删除会清理全部消息', async () => {
    let announceStarted!: () => void;
    let releaseRuntime!: () => void;
    const started = new Promise<void>((resolve) => { announceStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseRuntime = resolve; });
    const runtime = {
      loadTools: async () => [],
      runStream: async () => {
        await store.appendMessage({
          id: 'running-user', sessionId: 'th-running', role: 'user', content: 'hi',
          createdAt: new Date().toISOString(),
        });
        announceStarted();
        await blocked;
        await store.appendMessage({
          id: 'running-assistant', sessionId: 'th-running', role: 'assistant', content: 'late answer',
          createdAt: new Date().toISOString(),
        });
        return { content: 'late answer', iterations: 1, toolCalls: [], traceId: 'trace-running' };
      },
    };
    await listen(runtime);

    const running = await fetch(`${baseUrl}/ag-ui`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
      body: JSON.stringify({ threadId: 'th-running', runId: 'run-running', messages: [{ role: 'user', content: 'hi' }] }),
    });
    await started;
    try {
      const rejected = await fetch(`${baseUrl}/api/sessions/th-running`, {
        method: 'DELETE', headers: { authorization: 'Bearer t' },
      });
      expect(rejected.status).toBe(409);
      expect(await rejected.json()).toEqual({ error: '会话正在运行，请先停止生成后再删除' });
      expect(await store.getSession('th-running')).toBeDefined();
      expect(await store.listMessages('th-running')).toHaveLength(1);
    } finally {
      releaseRuntime();
    }

    expect(await running.text()).toContain('"type":"RUN_FINISHED"');
    expect(await store.listMessages('th-running')).toHaveLength(2);
    const deleted = await fetch(`${baseUrl}/api/sessions/th-running`, {
      method: 'DELETE', headers: { authorization: 'Bearer t' },
    });
    expect(deleted.status).toBe(204);
    expect(await store.getSession('th-running')).toBeUndefined();
    expect(await store.listMessages('th-running')).toEqual([]);
  });
});
