/**
 * 认证接口集成测试
 *
 * 覆盖注册/登录/me 的正常与异常路径：
 * - 注册成功返回 token + 脱敏用户信息；
 * - 重复用户名 409、非法入参 422；
 * - 登录成功 / 密码错误 401；
 * - /me 三种场景：有效 token 200、无 token 401、无效 token 401。
 */
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';
import { auth, registerUser } from '../helpers.js';

const app = createApp();

describe('auth API', () => {
  // 每个用例前清空用户表（级联清空其名下所有数据），保证用例相互独立
  beforeEach(async () => {
    await prisma.user.deleteMany();
  });

  it('registers a user and returns token + public user', async () => {
    const res = await request(app).post('/api/auth/register').send({
      username: 'newuser',
      password: 'password123',
      displayName: 'New User',
    });

    expect(res.status).toBe(201);
    expect(res.body.token).toBeTypeOf('string');
    expect(res.body.user).toMatchObject({ username: 'newuser', displayName: 'New User' });
    // 关键安全断言：响应绝不包含密码哈希
    expect(res.body.user).not.toHaveProperty('passwordHash');
  });

  it('rejects duplicate username with 409', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ username: 'dupe', password: 'password123' });
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'dupe', password: 'password123' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('USERNAME_TAKEN');
  });

  it('rejects invalid input with 422', async () => {
    // 用户名过短 + 密码过短，应命中校验规则
    const res = await request(app)
      .post('/api/auth/register')
      .send({ username: 'x', password: 'short' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('logs in with correct credentials', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ username: 'loginuser', password: 'password123' });
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'loginuser', password: 'password123' });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTypeOf('string');
    expect(res.body.user.username).toBe('loginuser');
  });

  it('rejects wrong password with 401', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ username: 'wrongpw', password: 'password123' });
    const res = await request(app)
      .post('/api/auth/login')
      .send({ username: 'wrongpw', password: 'wrong-password' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('returns 401 on /me without a token', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('returns current user on /me with a valid token', async () => {
    const reg = await registerUser(app, 'meuser');
    const res = await request(app).get('/api/auth/me').set(auth(reg.token));

    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe('meuser');
  });

  it('returns 401 on /me with an invalid token', async () => {
    const res = await request(app).get('/api/auth/me').set(auth('not-a-real-token'));
    expect(res.status).toBe(401);
  });
});
