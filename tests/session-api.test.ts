import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { SqliteMetadataStore, type Identity, type SessionRecord } from '@eap/platform-core';
import { sessionRoutes } from '../packages/agent-core/src/session-routes.js';
import { SessionLifecycle } from '../packages/agent-core/src/session-lifecycle.js';

const owner: Identity = {
  tenantId: 't-1', userId: 'u-owner', role: 'employee', deptId: 'd-1',
  sensitivity: 'internal', scopes: [], claims: {},
};
const other: Identity = { ...owner, userId: 'u-other' };

function session(id: string, userId: string): SessionRecord {
  const now = new Date().toISOString();
  return { id, tenantId: 't-1', userId, title: id, createdAt: now, updatedAt: now };
}

describe('会话管理 API', () => {
  let store: SqliteMetadataStore;
  let lifecycle: SessionLifecycle;
  let server: ReturnType<express.Express['listen']>;
  let baseUrl: string;

  beforeEach(async () => {
    store = new SqliteMetadataStore(':memory:');
    lifecycle = new SessionLifecycle();
    await store.init();
    for (const item of [session('s-owner', owner.userId), session('s-other', other.userId)]) {
      await store.createSession(item);
      await store.appendMessage({
        id: `m-${item.id}`, sessionId: item.id, role: 'user', content: '测试消息', createdAt: item.createdAt,
      });
    }

    const app = express();
    app.use((req, _res, next) => {
      req.identity = req.headers['x-test-user'] === 'other' ? other : owner;
      next();
    });
    app.use('/api/sessions', sessionRoutes(store, lifecycle));
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.close();
  });

  function call(path: string, method = 'GET', user = 'owner'): Promise<Response> {
    return fetch(`${baseUrl}${path}`, { method, headers: { 'x-test-user': user } });
  }

  it('本人删除会话会同时删除消息，列表与历史不再返回', async () => {
    const sessions = await (await call('/api/sessions')).json();
    expect(sessions.data.map((item: { id: string }) => item.id)).toEqual(['s-owner']);
    expect((await call('/api/sessions/s-owner/messages')).status).toBe(200);

    expect((await call('/api/sessions/s-owner', 'DELETE')).status).toBe(204);
    expect(await store.getSession('s-owner')).toBeUndefined();
    expect(await store.listMessages('s-owner')).toEqual([]);
    expect((await call('/api/sessions/s-owner/messages')).status).toBe(404);
    expect((await (await call('/api/sessions')).json()).data).toEqual([]);

    expect((await call('/api/sessions/s-owner', 'DELETE')).status).toBe(404);
  });

  it('多个运行全部结束后才允许删除', async () => {
    const releaseFirst = lifecycle.acquireRun('s-owner');
    const releaseSecond = lifecycle.acquireRun('s-owner');

    expect((await call('/api/sessions/s-owner', 'DELETE')).status).toBe(409);
    releaseFirst();
    expect((await call('/api/sessions/s-owner', 'DELETE')).status).toBe(409);
    expect(await store.getSession('s-owner')).toBeDefined();
    expect(await store.listMessages('s-owner')).toHaveLength(1);

    releaseSecond();
    expect((await call('/api/sessions/s-owner', 'DELETE')).status).toBe(204);
    expect(await store.listMessages('s-owner')).toEqual([]);
  });

  it('删除进行中拒绝新运行，释放后可以再次运行', () => {
    const releaseDeletion = lifecycle.acquireDeletion('s-owner');
    expect(() => lifecycle.acquireRun('s-owner')).toThrow('会话正在删除，请稍后重试');
    releaseDeletion();

    const releaseRun = lifecycle.acquireRun('s-owner');
    expect(() => lifecycle.acquireDeletion('s-owner')).toThrow('会话正在运行，请先停止生成后再删除');
    releaseRun();
  });

  it('不能读取或删除其他用户的会话', async () => {
    expect((await call('/api/sessions/s-other/messages', 'GET', 'other')).status).toBe(200);
    expect((await call('/api/sessions/s-other/messages')).status).toBe(404);
    expect((await call('/api/sessions/s-other', 'DELETE')).status).toBe(404);

    expect(await store.getSession('s-other')).toBeDefined();
    expect(await store.listMessages('s-other')).toHaveLength(1);
    expect((await call('/api/sessions/s-other/messages', 'GET', 'other')).status).toBe(200);
  });
});
