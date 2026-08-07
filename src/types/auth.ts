/**
 * 认证相关类型定义
 *
 * 【字段说明】
 * - PublicUser：对外暴露的用户信息（脱敏，绝不包含 passwordHash）；
 * - AuthUser：鉴权中间件挂载到 req.user 的轻量用户信息；
 * - RegisterInput / LoginInput：注册与登录入参；
 * - AuthResult：登录/注册成功后的返回结构（JWT + 用户信息）。
 */

// 对外可见的用户信息（不含任何敏感字段）
export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  createdAt: Date;
}

// 挂载到 req.user 的认证用户信息（供受保护路由使用）
export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
}

// 注册入参
export interface RegisterInput {
  username: string;
  password: string;
  displayName?: string;
}

// 登录入参
export interface LoginInput {
  username: string;
  password: string;
}

// 登录/注册成功后的返回结构
export interface AuthResult {
  token: string;
  user: PublicUser;
}
