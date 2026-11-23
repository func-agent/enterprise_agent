/**
 * 异步路由包装 —— Express 4 不会接管 async handler 抛出的 rejected promise，
 * 未捕获时请求会一直挂起直到客户端超时。
 *
 * 这里把异常转交给全局错误中间件（见 main.ts），保证任何异步故障都能
 * 返回明确的 500 而不是无声挂起。
 */
import type { NextFunction, Request, Response } from 'express';

export function asyncHandler(
  handler: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}
