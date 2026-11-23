/**
 * 全局错误中间件 —— 与网关同构。
 *
 * 异步路由抛出（如会话删除时的数据库写入失败）若没有它，Express 4 不会
 * 接管 rejected promise，请求会一直挂起直到客户端超时。
 */
import type { NextFunction, Request, Response } from 'express';
import { createLogger } from '@eap/platform-core';

const log = createLogger('agent:http');

const REQUEST_ERRORS = new Map<string, { status: number; error: string; message: string }>([
  ['entity.parse.failed', { status: 400, error: 'invalid_json', message: '请求体 JSON 格式错误' }],
  ['entity.too.large', { status: 413, error: 'payload_too_large', message: '请求体超过大小限制' }],
]);

export function agentErrorHandler(err: any, _req: Request, res: Response, _next: NextFunction): void {
  const requestError = REQUEST_ERRORS.get(err?.type);
  if (requestError) {
    log.warn('请求体校验失败', { type: err.type, status: requestError.status });
  } else {
    log.error('未捕获异常', { error: String(err?.stack ?? err) });
  }
  if (res.headersSent) {
    // SSE 等已写出头部的场景只能中断响应，不能再改状态码
    res.end();
    return;
  }
  if (requestError) {
    res.status(requestError.status).json({ error: requestError.error, message: requestError.message });
    return;
  }
  res.status(500).json({ error: 'internal_error', message: '服务内部错误' });
}
