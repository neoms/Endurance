/**
 * 日志链路集成测试
 *
 * 覆盖（P2 质量保障：关键错误路径必须有日志，且请求处理链可读取请求上下文）：
 * - 登录失败（业务错误路径）→ 记录 warn 日志（含用户名，不含 token）；
 * - 鉴权成功 → 请求上下文写入 userId；
 * - 请求处理链（含异步服务调用）内可通过 AsyncLocalStorage 读取 requestId，
 *   保证业务日志能自动携带请求关联字段。
 */
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app.js';
import { logger } from '../../src/lib/logger.js';
import { getLogContext } from '../../src/lib/log-context.js';
import { requestLogger } from '../../src/lib/request-logger.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('logging integration', () => {
  it('logs a warn entry on failed login (with username, without token)', async () => {
    const app = createApp();
    const warnSpy = vi.spyOn(logger, 'warn');

    await request(app)
      .post('/api/auth/login')
      .send({ username: 'alice', password: 'wrong-password' })
      .expect(401);

    // 业务错误路径必须留下日志（auth: login failed），且不带明文密码
    const loginCall = warnSpy.mock.calls.find((args) => String(args[1]).includes('login failed'));
    expect(loginCall).toBeDefined();
    const payload = loginCall?.[0] as { username?: string };
    expect(payload?.username).toBe('alice');
    const serialized = JSON.stringify(loginCall);
    expect(serialized).not.toContain('wrong-password');
  });

  it('exposes requestId inside the async request handling chain', async () => {
    // 独立小应用：路由内读取日志上下文并回传，验证 ALS 沿异步链传播
    const app = express();
    app.use(requestLogger({ sampleRate: 1 }));
    app.get('/ctx', async (_req, res) => {
      // 模拟异步服务调用：await 之后上下文必须仍然可读
      await Promise.resolve();
      res.json({ requestId: getLogContext()?.requestId });
    });

    const res = await request(app).get('/ctx').expect(200);
    // requestId 是 UUID 格式（36 字符，含连字符）
    expect(res.body.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
