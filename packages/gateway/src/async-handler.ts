/**
 * 异步路由包装 —— Express 4 不会接管 async handler 抛出的 rejected promise。
 *
 * 未捕获时会出现两个后果：请求一直挂起直到客户端超时；Node ≥15 默认
 * 以 throw 模式处理未处理 rejection，网关进程直接退出。
 *
 * 这里把异常转交给全局错误中间件（见 error-handler.ts），保证任何异步故障
 * 都能返回明确的 500 而不是无声挂起或拖垮整个网关。
 */
import type { NextFunction, Request, Response } from 'express';

export function asyncHandler(
  handler: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}
