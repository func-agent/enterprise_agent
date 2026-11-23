/**
 * 网关全局错误中间件 —— 与 Agent 内核（packages/agent-core/src/error-handler.ts）同构。
 *
 * 两点约束：
 * 1. 5xx 响应不带内部异常细节，详细信息只进日志，避免把数据库地址、
 *    上游厂商报错等内部信息透给浏览器。
 * 2. 请求体解析类错误按 body-parser 的错误类型翻译成稳定的错误码，
 *    前端与验收脚本据此断言。
 */
import type { NextFunction, Request, Response } from 'express';
import { createLogger } from '@eap/platform-core';

const log = createLogger('gateway:http');

const REQUEST_ERRORS = new Map<string, { status: number; error: string; message: string }>([
  ['entity.parse.failed', { status: 400, error: 'invalid_json', message: '请求体 JSON 格式错误' }],
  ['entity.too.large', { status: 413, error: 'payload_too_large', message: '请求体超过大小限制' }],
]);

export function gatewayErrorHandler(err: any, _req: Request, res: Response, _next: NextFunction): void {
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
