import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { asyncHandler } from '../packages/agent-core/src/async-handler.js';
import { agentErrorHandler } from '../packages/agent-core/src/error-handler.js';

describe('Agent 内核异步错误处理', () => {
  let server: ReturnType<express.Express['listen']>;
  let baseUrl: string;

  beforeEach(async () => {
    const app = express();
    app.use(express.json({ limit: 32 }));
    // 模拟会话删除时的数据库写入失败
    app.delete(
      '/api/sessions/:id',
      asyncHandler(async (_req, res) => {
        throw new Error('数据库写入失败');
      }),
    );
    // 模拟 SSE 已写出头部后失败
    app.get(
      '/ag-ui',
      asyncHandler(async (_req, res) => {
        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream');
        res.flushHeaders?.();
        throw new Error('流式输出中断');
      }),
    );
    app.use(agentErrorHandler);

    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('异步路由抛错返回 500 而不是让请求挂起', async () => {
    const response = await fetch(`${baseUrl}/api/sessions/s-1`, { method: 'DELETE' });
    expect(response.status).toBe(500);
    const payload = await response.json();
    expect(payload).toEqual({ error: 'internal_error', message: '服务内部错误' });
    expect(JSON.stringify(payload)).not.toContain('数据库写入失败');
  });

  it('JSON 格式错误返回 400，不暴露解析器内部信息', async () => {
    const response = await fetch(`${baseUrl}/api/sessions/s-1`, {
      method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{bad',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_json', message: '请求体 JSON 格式错误' });
  });

  it('请求体超限返回 413', async () => {
    const response = await fetch(`${baseUrl}/api/sessions/s-1`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'x'.repeat(100) }),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'payload_too_large', message: '请求体超过大小限制' });
  });

  it('已写出响应头时只中断响应，不重复写状态码', async () => {
    const response = await fetch(`${baseUrl}/ag-ui`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    // 响应必须正常结束（而不是挂起）
    await expect(response.text()).resolves.toBe('');
  });
});
