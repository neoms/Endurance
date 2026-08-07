/**
 * Express 全局类型增强
 *
 * 【作用】
 * 为 Express 的 Request 增加可选的 user 字段：
 * 经过 authRequired 中间件后，路由处理函数内即可通过 req.user
 * 拿到当前登录用户（类型安全，无需自行断言）。
 */
import type { AuthUser } from './auth.js';

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export {};
