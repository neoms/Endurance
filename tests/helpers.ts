/**
 * 集成测试公共工具
 *
 * 【函数说明】
 * - registerUser：注册一个用户并返回 { token, user }，供测试快速获得登录态；
 * - auth：构造 Bearer 鉴权请求头。
 */
import type { Express } from 'express';
import request from 'supertest';

/**
 * 注册用户并返回登录态
 *
 * @param app      Express 应用实例
 * @param username 注册用户名（测试内需唯一，beforeEach 会清空用户表）
 * @returns { token: string, user: { id: string } }
 */
export async function registerUser(app: Express, username: string) {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ username, password: 'password123', displayName: username });
  return { token: res.body.token as string, user: res.body.user as { id: string } };
}

/**
 * 构造 Bearer 鉴权请求头
 *
 * @param token JWT
 * @returns { Authorization: string } 可直接传给 supertest 的 .set()
 */
export function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}
