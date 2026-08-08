/**
 * 认证与授权中间件
 *
 * 【模块职责】
 * authRequired：保护「需要登录」的路由，流程如下：
 * 1. 从 Authorization 头解析 Bearer token（缺失 → 401）；
 * 2. 验签（JWT 非法/过期 → 401）；
 * 3. 回查数据库确认用户仍存在（用户被删除后 token 立即失效 → 401）；
 * 4. 将用户信息挂载到 req.user，供后续路由与服务使用。
 *
 * requireUser：在受保护路由内安全取回当前用户（类型上消除 undefined）。
 *
 * 【日志说明】
 * 鉴权失败记录 warn 级日志（含失败原因，不记录 token 内容）；
 * 鉴权成功记录 debug 级日志（含用户 id），便于串联请求与用户。
 */
import type { NextFunction, Request, Response } from 'express';

import { AppError } from '../../lib/errors.js';
import { verifyToken } from '../../lib/jwt.js';
import { logger } from '../../lib/logger.js';
import { setContextUserId } from '../../lib/log-context.js';
import { prisma } from '../../lib/prisma.js';
import type { AuthUser } from '../../types/auth.js';

/**
 * 登录鉴权中间件（挂载到受保护路由）
 *
 * @param req  Express 请求对象（鉴权通过后写入 req.user）
 * @param _res Express 响应对象（不使用）
 * @param next 放行回调：鉴权通过后调用 next()
 * @throws AppError(401) 未携带 token / token 无效或过期 / 用户不存在
 */
export async function authRequired(req: Request, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    logger.warn({ method: req.method, url: req.url }, 'auth: missing bearer token');
    throw new AppError(401, 'UNAUTHORIZED', 'Missing or invalid authorization header');
  }

  const token = authHeader.slice('Bearer '.length);
  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    logger.warn({ method: req.method, url: req.url }, 'auth: invalid or expired token');
    throw new AppError(401, 'UNAUTHORIZED', 'Invalid or expired token');
  }

  // 回查数据库：保证 token 对应的用户仍然存在（吊销/删除后立即失效）
  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: { id: true, username: true, displayName: true },
  });
  if (!user) {
    logger.warn({ userId: payload.sub }, 'auth: token subject user not found');
    throw new AppError(401, 'UNAUTHORIZED', 'User no longer exists');
  }

  logger.debug({ userId: user.id, username: user.username }, 'auth: authenticated');
  // 写入请求日志上下文：该请求内随后的业务日志自动携带 userId（问题定位到操作者）
  setContextUserId(user.id);
  req.user = user;
  next();
}

/**
 * 在受保护路由内取回当前登录用户
 *
 * @param req Express 请求对象（应已通过 authRequired）
 * @returns AuthUser 当前登录用户
 * @throws AppError(401) 若 req.user 不存在（防御性保护）
 */
export function requireUser(req: Request): AuthUser {
  if (!req.user) {
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  }
  return req.user;
}
