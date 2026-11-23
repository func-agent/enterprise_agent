import express, { type NextFunction, type Request, type Response } from 'express';
import { config, corsMiddleware, createLogger } from '@eap/platform-core';
import { authMiddleware } from '@eap/auth-middleware';
import type { AppContext } from './context.js';
import { chatRoutes } from './routes/chat.js';
import { mcpRoutes } from './routes/mcp.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { knowledgeRoutes } from './routes/knowledge.js';
import { gatewayErrorHandler } from './error-handler.js';

const log = createLogger('gateway:server');

export function createServer(ctx: AppContext) {
  const app = express();
  app.disable('x-powered-by');
  app.use(corsMiddleware);
  app.use(express.json({ limit: config.security.maxBodyBytes }));

  // 统一访问日志（Authorization 由 logger 自动脱敏）
  app.use((req: Request, res: Response, next: NextFunction) => {
    const started = Date.now();
    res.on('finish', () => {
      log.info('http', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - started,
        tenant: req.identity?.tenantId,
        user: req.identity?.userId,
      });
    });
    next();
  });

  // 健康检查不鉴权（暴露鉴权模式，便于验收脚本判定令牌来源）
  app.get('/healthz', (_req, res) => {
    res.json({
      ok: true,
      service: 'agentgateway',
      ts: new Date().toISOString(),
      eap: {
        authMode: config.auth.devMode ? 'dev' : 'oidc',
        issuer: config.auth.issuer.length > 0 ? config.auth.issuer : null,
      },
    });
  });

  // 其余全部走鉴权中间件（见 4.1 自研鉴权中间件）
  const auth = authMiddleware(ctx.auth);
  app.use(authRoutes());
  app.use(auth);

  app.use(chatRoutes(ctx));
  app.use(mcpRoutes(ctx));
  app.use(adminRoutes(ctx));
  app.use(knowledgeRoutes(ctx));

  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found', path: req.path });
  });

  app.use(gatewayErrorHandler);

  return app;
}
