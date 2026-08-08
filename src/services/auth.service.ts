/**
 * 认证服务：注册 / 登录 / 获取当前用户
 *
 * 【安全要点】
 * - 用户名全局唯一且大小写敏感：只做 trim 去首尾空格，不归一化大小写，
 *   因此「Alice」与「alice」是两个不同用户（数据库唯一约束按大小写敏感比较）；
 * - 密码使用 bcrypt 哈希后入库，绝不落明文；
 * - 登录失败统一返回 401 INVALID_CREDENTIALS，不区分「用户不存在」与「密码错误」，
 *   防止用户枚举；
 * - 注册做「先查重再创建」，并发下仍可能撞唯一约束（P2002），统一转换为 409，
 *   避免竞态返回 500；
 * - 日志只记录用户名/用户 id，绝不记录密码或 token。
 */
import { Prisma, type User } from '@prisma/client';

import { AppError } from '../lib/errors.js';
import { signToken } from '../lib/jwt.js';
import { logger } from '../lib/logger.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { prisma } from '../lib/prisma.js';
import type { AuthResult, LoginInput, PublicUser, RegisterInput } from '../types/auth.js';

/**
 * 用户脱敏：只暴露安全字段
 *
 * @param user 数据库用户记录（含 passwordHash）
 * @returns PublicUser 不含任何敏感字段的用户信息
 */
function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    createdAt: user.createdAt,
  };
}

/**
 * 为指定用户签发 JWT
 *
 * @param user 数据库用户记录
 * @returns string JWT 字符串
 */
function issueToken(user: User): string {
  return signToken({ sub: user.id, username: user.username });
}

/**
 * 用户注册
 *
 * @param input { username, password, displayName? }
 * @returns Promise<AuthResult> { token, user }，注册成功后直接签发 token 免二次登录
 * @throws AppError(409 USERNAME_TAKEN) 用户名已存在
 * 主要逻辑：trim 用户名 → 查重（大小写敏感）→ bcrypt 哈希 → 创建用户 → 签发 token。
 */
export async function register(input: RegisterInput): Promise<AuthResult> {
  // 用户名全局唯一、大小写敏感：仅去除首尾空格，保留用户输入的大小写原样存储。
  // 数据库 unique 约束按精确字符串比较（SQLite 默认大小写敏感），
  // 因此 'Alice' 与 'alice' 可共存，登录时也必须输入完全一致的用户名。
  const username = input.username.trim();
  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) {
    logger.warn({ username }, 'auth: register failed, username taken');
    throw new AppError(409, 'USERNAME_TAKEN', 'Username is already taken');
  }

  const passwordHash = await hashPassword(input.password);
  let user: User;
  try {
    user = await prisma.user.create({
      data: {
        username,
        passwordHash,
        displayName: input.displayName?.trim() || username,
      },
    });
  } catch (err) {
    // 并发竞态：两个请求同时通过查重后都执行 create，后到者撞唯一约束（P2002）。
    // 这里把它归一化为 409，与前置查重返回的错误保持一致，避免客户端收到 500。
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      logger.warn({ username }, 'auth: register race, username taken (unique constraint)');
      throw new AppError(409, 'USERNAME_TAKEN', 'Username is already taken');
    }
    throw err;
  }

  logger.info({ userId: user.id, username }, 'auth: user registered');
  return { token: issueToken(user), user: toPublicUser(user) };
}

/**
 * 用户登录
 *
 * @param input { username, password }
 * @returns Promise<AuthResult> { token, user }
 * @throws AppError(401 INVALID_CREDENTIALS) 用户名或密码错误（统一提示，防枚举）
 * 主要逻辑：按精确用户名（大小写敏感）查用户 → bcrypt 校验密码 → 签发 token。
 */
export async function login(input: LoginInput): Promise<AuthResult> {
  // 与注册一致：按用户输入的原样用户名精确查询（大小写敏感），
  // 避免把「大小写不同」误判为同一账号，也避免引入新的枚举面。
  const username = input.username.trim();
  const user = await prisma.user.findUnique({ where: { username } });
  const passwordValid = user ? await verifyPassword(input.password, user.passwordHash) : false;
  if (!user || !passwordValid) {
    logger.warn({ username }, 'auth: login failed, invalid credentials');
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid username or password');
  }

  logger.info({ userId: user.id, username }, 'auth: login succeeded');
  return { token: issueToken(user), user: toPublicUser(user) };
}

/**
 * 获取当前用户信息
 *
 * @param userId 用户 id（来自 token）
 * @returns Promise<PublicUser> 脱敏后的用户信息
 * @throws AppError(401) 用户不存在（token 有效但账户已被删除）
 */
export async function getCurrentUser(userId: string): Promise<PublicUser> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new AppError(401, 'UNAUTHORIZED', 'User no longer exists');
  }
  return toPublicUser(user);
}
