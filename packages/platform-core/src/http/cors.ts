/**
 * 跨域中间件 —— 单一前端（AgentScope Web UI）访问网关与 Agent 服务。
 * 仅开发/内网 POC 使用；生产建议由出网代理或 Ingress 统一处理。
 */
import type { NextFunction, Request, Response } from 'express';
import { config } from '@eap/platform-core';

const ALLOWED_ORIGINS = (
  process.env.CORS_ALLOWED_ORIGINS ??
  `http://localhost:${config.webui.port},http://127.0.0.1:${config.webui.port},http://localhost:5173,http://127.0.0.1:5173`
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export function corsMiddleware(req: Request, res: Response, next: NextFunction) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else if (!origin) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Session-Id,X-App-Id');
  res.setHeader('Access-Control-Max-Age', '600');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}
