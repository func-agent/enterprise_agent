/**
 * MCP 工具治理接口 —— 网关下发工具目录并代理工具调用。
 */
import { Router, type Request, type Response } from 'express';
import { createLogger } from '@eap/platform-core';
import type { AppContext } from '../context.js';
import { requireIdentity } from '@eap/auth-middleware';

const log = createLogger('gateway:route:mcp');

export function mcpRoutes(ctx: AppContext): Router {
  const router = Router();

  /** 租户工具目录（MCP Federation） */
  router.get('/v1/mcp/tools', async (req: Request, res: Response) => {
    try {
      const identity = requireIdentity(req);
      const tools = await ctx.mcp.catalog(identity);
      res.json({
        object: 'list',
        data: tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
          server_id: t.serverId,
          requires_confirmation: t.requiresConfirmation,
          sensitivity: t.sensitivity,
          data_scope: t.dataScope,
        })),
      });
    } catch (err: any) {
      res.status(401).json({ error: err?.message });
    }
  });

  /** 工具调用（受治理） */
  router.post('/v1/mcp/call', async (req: Request, res: Response) => {
    const identity = requireIdentity(req);
    const body = req.body ?? {};
    const serverId = String(body.server_id ?? body.serverId ?? '');
    const toolName = String(body.tool ?? body.name ?? '');
    const args = (body.arguments ?? body.args ?? {}) as Record<string, unknown>;
    const traceId = String(body.trace_id ?? `trace-${Date.now().toString(16)}`);

    if (!serverId || !toolName) {
      res.status(400).json({ error: 'server_id 与 tool 均为必填' });
      return;
    }

    try {
      const outcome = await ctx.mcp.call({
        identity,
        serverId,
        toolName,
        args,
        traceId,
        approvalId: body.approval_id ?? body.approvalId,
        sessionId: body.session_id,
        appId: body.app_id,
      });
      res.status(outcome.ok ? 200 : 400).json({
        ok: outcome.ok,
        content: outcome.content,
        structured: outcome.structured,
        reason: outcome.reason,
        trace_id: outcome.traceId,
      });
    } catch (err: any) {
      log.error('工具调用异常', { serverId, toolName, error: String(err) });
      res.status(500).json({ error: err?.message ?? '工具调用异常' });
    }
  });

  /** MCP Server 健康检查 */
  router.get('/v1/mcp/health', async (_req: Request, res: Response) => {
    const health = await ctx.clients.health();
    res.json({ servers: health });
  });

  return router;
}
