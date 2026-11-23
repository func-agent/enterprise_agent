/**
 * Agent 服务入口（对应 3.1 的 AgentScope Service —— 多租户注册 / 会话管理 / 分布式协调）。
 *
 * 对外提供 Chat、会话、工具目录接口；所有模型与工具调用经 agentgateway。
 */
import express, { type Request, type Response } from 'express';
import {
  config,
  corsMiddleware,
  createLogger,
  PgMetadataStore,
  SqliteMetadataStore,
  uuid,
  type MetadataStore,
} from '@eap/platform-core';
import { authMiddleware, requireIdentity, AuthService } from '@eap/auth-middleware';
import { GatewayClient } from './gateway-client.js';
import { Toolkit } from './toolkit.js';
import { HitlManager } from './hitl.js';
import { AgentRuntime } from './runtime.js';
import { createAguiHandler } from './agui.js';
import { hasSessionAccess } from './session-auth.js';
import { sessionRoutes } from './session-routes.js';
import { SessionConflictError, SessionLifecycle } from './session-lifecycle.js';
import { asyncHandler } from './async-handler.js';
import { agentErrorHandler } from './error-handler.js';

const log = createLogger('agent:main');

async function main() {
  const store: MetadataStore =
    config.store.kind === 'postgres' && config.store.postgresUrl
      ? new PgMetadataStore(config.store.postgresUrl)
      : new SqliteMetadataStore(config.store.sqlitePath);
  await store.init();

  const gateway = new GatewayClient(config.gateway.apiRoot);
  const toolkit = new Toolkit();
  const hitl = new HitlManager(store);
  const runtime = new AgentRuntime(gateway, toolkit, hitl, store, {
    maxIterations: config.agent.maxIterations,
    maxHistoryMessages: config.agent.maxHistoryMessages,
    maxHistoryChars: config.agent.maxHistoryChars,
    maxToolResultChars: config.agent.maxToolResultChars,
    approvalTimeoutMs: config.agent.approvalTimeoutMs,
    defaultModel: config.agent.defaultModel,
  });

  const auth = new AuthService();
  const lifecycle = new SessionLifecycle();
  const app = express();
  app.disable('x-powered-by');
  app.use(corsMiddleware);
  app.use(express.json({ limit: config.security.maxBodyBytes }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, service: 'agent-core', ts: new Date().toISOString() });
  });

  app.use(authMiddleware(auth));

  /** 工具目录 */
  app.get('/api/tools', asyncHandler(async (req: Request, res: Response) => {
    try {
      const specs = await runtime.loadTools(req.rawToken!);
      res.json({ data: specs, count: specs.length });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? '拉取工具目录失败' });
    }
  }));

  /** 会话列表、历史与删除 */
  app.use('/api/sessions', sessionRoutes(store, lifecycle));

  /** 对话 —— ReAct 循环 */
  app.post('/api/chat', asyncHandler(async (req: Request, res: Response) => {
    const identity = requireIdentity(req);
    const body = req.body ?? {};
    const message = String(body.message ?? '').trim();
    if (!message) {
      res.status(400).json({ error: 'message 不能为空' });
      return;
    }

    // 会话：不存在则创建
    let sessionId = body.sessionId ? String(body.sessionId) : '';
    if (sessionId) {
      const session = await store.getSession(sessionId);
      if (!session || !hasSessionAccess(session, identity)) {
        res.status(404).json({ error: '会话不存在' });
        return;
      }
    } else {
      sessionId = uuid();
      const now = new Date().toISOString();
      await store.createSession({
        id: sessionId,
        tenantId: identity.tenantId,
        userId: identity.userId,
        title: message.slice(0, 40),
        createdAt: now,
        updatedAt: now,
        appId: body.appId,
      });
    }

    let releaseRun: () => void;
    try {
      releaseRun = lifecycle.acquireRun(sessionId);
    } catch (err) {
      if (err instanceof SessionConflictError) {
        res.status(409).json({ error: err.message, session_id: sessionId });
        return;
      }
      throw err;
    }

    try {
      // 每次对话加载本次运行专属的工具快照，避免并发会话互相覆盖。
      const tools = await runtime.loadTools(req.rawToken!);

      const result = await runtime.run({
        identity,
        token: req.rawToken!,
        sessionId,
        message,
        appId: body.appId,
        model: body.model,
        tools,
      });

      await store.updateSession(sessionId, { updatedAt: new Date().toISOString() });
      res.json({
        session_id: sessionId,
        content: result.content,
        iterations: result.iterations,
        tool_calls: result.toolCalls,
        trace_id: result.traceId,
      });
    } catch (err: any) {
      log.error('对话失败', { sessionId, error: String(err?.stack ?? err) });
      res.status(500).json({ error: err?.message ?? '对话失败', session_id: sessionId });
    } finally {
      releaseRun();
    }
  }));

  /** AG-UI 标准事件流（控制台流式对话） */
  app.post('/ag-ui', asyncHandler(createAguiHandler({ runtime, store, lifecycle })));

  /** 未捕获异常兜底 —— 异步路由的 rejected promise 必须有出口 */
  app.use(agentErrorHandler);

  app.listen(config.agent.port, config.agent.host, () => {
    log.info('agent-core 已启动', {
      url: `http://${config.agent.host}:${config.agent.port}`,
      gateway: config.gateway.openaiBaseUrl,
    });
  });

  const shutdown = async () => {
    await store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  log.error('agent-core 启动失败', { error: String(err?.stack ?? err) });
  process.exit(1);
});
