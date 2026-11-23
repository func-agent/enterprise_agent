/**
 * 会话管理接口 —— 列表、历史与运行结束后的永久删除。
 *
 * 隔离语义与既有会话读取一致：只允许本人访问自己的会话（见 session-auth.ts），
 * 租户管理员也不能删除他人会话，避免越权操作他人对话数据。
 * 删除只清理会话本身与其消息；审批、审计与 Trace 记录按留痕要求保留。
 */
import { Router, type Request, type Response } from 'express';
import { requireIdentity } from '@eap/auth-middleware';
import type { MetadataStore } from '@eap/platform-core';
import { hasSessionAccess } from './session-auth.js';
import { asyncHandler } from './async-handler.js';
import { SessionConflictError, SessionLifecycle } from './session-lifecycle.js';

export function sessionRoutes(store: MetadataStore, lifecycle: SessionLifecycle): Router {
  const router = Router();

  /** 会话列表 —— 仅当前用户的会话 */
  router.get('/', asyncHandler(async (req: Request, res: Response) => {
    const identity = requireIdentity(req);
    const sessions = await store.listSessions(identity.tenantId, identity.userId);
    res.json({ data: sessions });
  }));

  /** 会话消息历史 */
  router.get('/:id/messages', asyncHandler(async (req: Request, res: Response) => {
    const identity = requireIdentity(req);
    const session = await store.getSession(String(req.params.id));
    if (!session || !hasSessionAccess(session, identity)) {
      res.status(404).json({ error: '会话不存在' });
      return;
    }
    res.json({ data: await store.listMessages(session.id) });
  }));

  /** 永久删除会话及其消息 —— 不存在或无权访问统一返回 404，不泄露存在性 */
  router.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
    const identity = requireIdentity(req);
    const id = String(req.params.id);
    const session = await store.getSession(id);
    if (!session || !hasSessionAccess(session, identity)) {
      res.status(404).json({ error: '会话不存在' });
      return;
    }

    let releaseDeletion: () => void;
    try {
      releaseDeletion = lifecycle.acquireDeletion(id);
    } catch (err) {
      if (err instanceof SessionConflictError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
    try {
      await store.deleteSession(id);
      res.status(204).end();
    } finally {
      releaseDeletion();
    }
  }));

  return router;
}
