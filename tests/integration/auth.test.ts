/**
 * 认证接口集成测试
 *
 * 覆盖注册/登录/me 的正常与异常路径：
 * - 注册成功返回 token + 脱敏用户信息；
 * - 重复用户名 409、非法入参 422；
 * - 登录成功 / 密码错误 401；
 * - /me 三种场景：有效 token 200、无 token 401、无效 token 401；
 * - 并发注册竞态：唯一约束冲突归一化为 409，不返回 500。
 */
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';
import { register } from '../../src/services/auth.service.js';
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

  it('treats usernames as case-sensitive and globally unique', async () => {
    // 注册小写用户名（登录名按用户输入原样存储，不做小写归一化）
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ username: 'caseuser', password: 'password123' });
    expect(reg.status).toBe(201);
    expect(reg.body.user.username).toBe('caseuser');

    // 登录必须精确匹配大小写：大小写变体 'CaseUser' 不是 'caseuser' → 401
    const wrongCase = await request(app)
      .post('/api/auth/login')
      .send({ username: 'CaseUser', password: 'password123' });
    expect(wrongCase.status).toBe(401);

    // 精确大小写匹配 → 登录成功
    const exactCase = await request(app)
      .post('/api/auth/login')
      .send({ username: 'caseuser', password: 'password123' });
    expect(exactCase.status).toBe(200);
    expect(exactCase.body.user.username).toBe('caseuser');

    // 全局唯一 + 大小写敏感：'CaseUser' 与 'caseuser' 是两个不同账号，可并存注册
    const second = await request(app)
      .post('/api/auth/register')
      .send({ username: 'CaseUser', password: 'password123' });
    expect(second.status).toBe(201);
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

  it('rejects a token whose user was deleted (401)', async () => {
    // 注册后直接从数据库删除用户，模拟账号注销后 token 仍被使用
    const { token } = await registerUser(app, 'ghostuser');
    await prisma.user.delete({ where: { username: 'ghostuser' } });

    const res = await request(app).get('/api/auth/me').set(auth(token));

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.body.error.message).toBe('User no longer exists');
  });

  it('converts unique-constraint race to 409 (no 500)', async () => {
    // 直接插入同名用户，模拟「另一个并发请求已经创建成功」的中间状态
    await prisma.user.create({
      data: { username: 'raceuser', passwordHash: 'x', displayName: 'x' },
    });
    // 模拟竞态：findUnique 查重返回 null（检查通过，但数据已存在）
    const spy = vi.spyOn(prisma.user, 'findUnique').mockResolvedValue(null);
    try {
      await expect(
        register({ username: 'raceuser', password: 'password123' }),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'USERNAME_TAKEN',
      });
    } finally {
      spy.mockRestore();
    }
  });
});
