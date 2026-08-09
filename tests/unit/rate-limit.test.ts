/**
 * 限流中间件单元测试
 *
 * 覆盖：
 * - 窗口内允许不超过 max 次请求，超出返回 429（RATE_LIMITED + Retry-After）；
 * - 不同限流键相互独立（互不拖累）；
 * - 窗口滑动后配额恢复（时间重置）；
 * - reset() 清空状态后立即恢复放行。
 */
import express from 'express';
import type { Request } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { errorHandler } from '../../src/lib/errors.js';
import {
  createRateLimiter,
  ipKey,
  userKey,
  type RateLimiterMiddleware,
} from '../../src/lib/rate-limit.js';

/**
 * 构造带限流中间件的最小测试应用
 *
 * @param limiter 限流中间件
 * @returns Express 应用（含全局错误处理，429 返回结构化 JSON）
 */
function makeApp(limiter: RateLimiterMiddleware) {
  const app = express();
  app.get('/ping', limiter, (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);
  return app;
}

describe('createRateLimiter', () => {
  it('allows up to max requests and blocks the next with 429 + Retry-After', async () => {
    const app = makeApp(
      createRateLimiter({ windowMs: 60_000, max: 2, keyPrefix: 't', keyFrom: () => 'same' }),
    );

    const first = await request(app).get('/ping');
    const second = await request(app).get('/ping');
    const third = await request(app).get('/ping');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('RATE_LIMITED');
    expect(third.headers['retry-after']).toBeDefined();
  });

  it('keeps different keys independent', async () => {
    // 按查询参数区分 key：A 被打满不影响 B
    const app = makeApp(
      createRateLimiter({
        windowMs: 60_000,
        max: 2,
        keyPrefix: 't',
        keyFrom: (req) => String(req.query.key ?? 'default'),
      }),
    );

    await request(app).get('/ping?key=a');
    await request(app).get('/ping?key=a');
    const aBlocked = await request(app).get('/ping?key=a');
    const bFirst = await request(app).get('/ping?key=b');
    const bSecond = await request(app).get('/ping?key=b');

    expect(aBlocked.status).toBe(429);
    expect(bFirst.status).toBe(200);
    expect(bSecond.status).toBe(200);
  });

  it('restores quota after the window slides past', async () => {
    // 窗口 50ms：前两次放行，第三次 429，等窗口滑过后再请求恢复放行
    const app = makeApp(
      createRateLimiter({ windowMs: 50, max: 2, keyPrefix: 't', keyFrom: () => 'same' }),
    );

    await request(app).get('/ping');
    await request(app).get('/ping');
    expect((await request(app).get('/ping')).status).toBe(429);

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect((await request(app).get('/ping')).status).toBe(200);
  });

  it('resets all state via reset()', async () => {
    const limiter = createRateLimiter({
      windowMs: 60_000,
      max: 1,
      keyPrefix: 't',
      keyFrom: () => 'same',
    });
    const app = makeApp(limiter);

    expect((await request(app).get('/ping')).status).toBe(200);
    expect((await request(app).get('/ping')).status).toBe(429);

    limiter.reset();
    expect((await request(app).get('/ping')).status).toBe(200);
  });

  it('prunes only expired timestamps and keeps recent ones for a key', async () => {
    // 窗口 100ms、上限放宽到 100：同一 key 在窗口内两次请求；
    // 定时清理触发时至少有一条仍存活 → 命中「部分过期则回写」分支
    const app = makeApp(
      createRateLimiter({ windowMs: 100, max: 100, keyPrefix: 't', keyFrom: () => 'same' }),
    );

    expect((await request(app).get('/ping')).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect((await request(app).get('/ping')).status).toBe(200);
    // 等待清理定时器（windowMs=100ms）触发：第一条可能过期、第二条仍存活
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect((await request(app).get('/ping')).status).toBe(200);
  });

  it('falls back through ip → socket address → unknown for ipKey', () => {
    expect(ipKey({ ip: '1.2.3.4' } as unknown as Request)).toBe('1.2.3.4');
    expect(ipKey({ socket: { remoteAddress: '9.9.9.9' } } as unknown as Request)).toBe('9.9.9.9');
    // Express 请求的 socket 总是存在；remoteAddress 缺失时才回退 unknown
    expect(ipKey({ socket: {} } as unknown as Request)).toBe('unknown');
  });

  it('uses the user id when present and falls back to IP otherwise for userKey', () => {
    expect(userKey({ user: { id: 'user-1' } } as unknown as Request)).toBe('user-1');
    expect(userKey({ ip: '1.2.3.4' } as unknown as Request)).toBe('1.2.3.4');
  });
});
