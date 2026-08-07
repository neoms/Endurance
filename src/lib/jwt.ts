/**
 * JWT 签发与校验工具模块
 *
 * 【模块职责】
 * 封装 jsonwebtoken 的签名与验签：
 * - signToken：登录/注册成功后为用户签发 JWT；
 * - verifyToken：鉴权中间件中校验并解析 JWT。
 *
 * 【设计说明】
 * - payload 固定携带 sub（用户 id）与 username；
 * - 密钥与有效期来自环境变量（JWT_SECRET / JWT_EXPIRES_IN），便于部署时调整。
 */
import jwt from 'jsonwebtoken';

import { env } from '../config/env.js';

/**
 * JWT payload 结构
 *
 * @property sub 用户 id（jwt 标准字段，用于查找用户）
 * @property username 用户名（便于日志与排查，不承担鉴权主逻辑）
 */
export interface JwtPayload {
  sub: string;
  username: string;
}

/**
 * 为用户签发 JWT
 *
 * @param payload { sub: 用户 id, username: 用户名 }
 * @returns string JWT 字符串（携带过期时间，默认 24h）
 */
export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });
}

/**
 * 校验并解析 JWT
 *
 * @param token 请求头中的 JWT 字符串
 * @returns JwtPayload 解析出的 payload（sub + username）
 * @throws 当 token 非法、过期或 payload 缺少关键字段时抛出错误（由调用方转为 401）
 */
export function verifyToken(token: string): JwtPayload {
  const decoded = jwt.verify(token, env.JWT_SECRET);
  // 防御性校验：拒绝字符串型 token 或缺失关键字段的 payload
  if (
    typeof decoded === 'string' ||
    typeof decoded.sub !== 'string' ||
    typeof decoded.username !== 'string'
  ) {
    throw new Error('Invalid token payload');
  }
  return { sub: decoded.sub, username: decoded.username };
}
