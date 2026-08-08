/**
 * 限流端到端集成测试
 *
 * 覆盖（通过 AppOptions.rateLimiters 注入低阈值限流器，NODE_ENV=test 默认关闭不影响其他用例）：
 * - 注册接口按 IP 限流：超过阈值返回 429 RATE_LIMITED + Retry-After；
 * - AI 消息接口按用户限流：超过阈值返回 429。
 */
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';
import { createRateLimiter, ipKey, userKey } from '../../src/lib/rate-limit.js';
import { auth } from '../helpers.js';

describe('rate limiting (integration)', () => {
  // 每个用例前清空用户表，保证独立
  beforeEach(async () => {
    await prisma.user.deleteMany();
  });

  it('blocks excessive registration attempts per IP with 429', async () => {
    // 自定义认证限流器：窗口 1 分钟、每 IP 最多 2 次
    const app = createApp({
      rateLimiters: {
        auth: createRateLimiter({
          windowMs: 60_000,
          max: 2,
          keyPrefix: 'auth',
          keyFrom: ipKey,
        }),
      },
    });

    const register = (username: string) =>
      request(app).post('/api/auth/register').send({ username, password: 'password123' });

    const first = await register('rl_user_1');
    const second = await register('rl_user_2');
    const third = await register('rl_user_3');

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('RATE_LIMITED');
    expect(third.headers['retry-after']).toBeDefined();
  });

  it('blocks excessive AI message sends per user with 429', async () => {
    // 自定义 AI 限流器：窗口 1 分钟、每用户最多 3 次（发送消息）
    const app = createApp({
      rateLimiters: {
        ai: createRateLimiter({
          windowMs: 60_000,
          max: 3,
          keyPrefix: 'ai',
          keyFrom: userKey,
        }),
      },
    });
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ username: 'rl_ai_user', password: 'password123' });
    const token = reg.body.token as string;
    const conv = await request(app).post('/api/conversations').set(auth(token)).send({});
    const id = conv.body.conversation.id as string;

    const results: Array<{ status: number; body: { error?: { code?: string } } }> = [];
    for (let i = 0; i < 4; i += 1) {
      const res = await request(app)
        .post(`/api/conversations/${id}/messages`)
        .set(auth(token))
        .send({ content: `问题 ${i}` });
      results.push(res);
    }

    expect(results[0]!.status).toBe(201);
    expect(results[1]!.status).toBe(201);
    expect(results[2]!.status).toBe(201);
    expect(results[3]!.status).toBe(429);
    expect(results[3]!.body.error?.code).toBe('RATE_LIMITED');
  });
});
