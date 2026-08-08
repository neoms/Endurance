/**
 * 请求日志中间件单元测试
 *
 * 覆盖：
 * - 200 → info 级别，携带请求 id / method / responseTime；
 * - 404 → warn 级别（客户端/业务问题）；
 * - 500 → error 级别（需要关注）；
 * - 慢请求标记 slow: true（阈值 0 时所有请求都算慢）；
 * - 成功请求采样：sampleRate=0 时不记录成功请求；
 * - 4xx/5xx 不受采样影响：sampleRate=0 时 404 仍记录。
 */
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { errorHandler, notFoundHandler } from '../../src/lib/errors.js';
import { logger } from '../../src/lib/logger.js';
import { requestLogger, type RequestLoggerOptions } from '../../src/lib/request-logger.js';

/**
 * 构造带请求日志中间件的最小 Express 应用
 *
 * @param options 请求日志配置（阈值/采样率）
 * @returns Express 应用：含正常路由、抛错路由、404 兜底与全局错误处理
 */
function makeApp(options: RequestLoggerOptions) {
  const app = express();
  app.use(requestLogger(options));
  app.get('/ok', (_req, res) => res.json({ ok: true }));
  app.get('/error', () => {
    throw new Error('boom');
  });
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('requestLogger', () => {
  it('logs 200 as info with request id, method and responseTime', async () => {
    const infoSpy = vi.spyOn(logger, 'info');
    const app = makeApp({ sampleRate: 1, slowThresholdMs: 10_000 });

    await request(app).get('/ok').expect(200);

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const payload = infoSpy.mock.calls[0]?.[0] as {
      req?: { id?: string; method?: string };
      responseTime?: number;
    };
    expect(payload?.req?.id).toBeTruthy();
    expect(payload?.req?.method).toBe('GET');
    expect(payload?.responseTime).toBeGreaterThanOrEqual(0);
  });

  it('logs 404 as warn', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    const app = makeApp({ sampleRate: 1 });

    await request(app).get('/missing').expect(404);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const payload = warnSpy.mock.calls[0]?.[0] as { res?: { statusCode?: number } };
    expect(payload?.res?.statusCode).toBe(404);
  });

  it('logs 500 as error', async () => {
    const errorSpy = vi.spyOn(logger, 'error');
    const app = makeApp({ sampleRate: 1 });

    await request(app).get('/error').expect(500);

    // 至少一条 error 日志（请求日志 500 标记；errorHandler 的 unhandled error 也会记录）
    expect(errorSpy).toHaveBeenCalled();
  });

  it('marks slow requests with slow: true', async () => {
    const infoSpy = vi.spyOn(logger, 'info');
    // 阈值 0：任何请求都算慢，验证标记字段
    const app = makeApp({ sampleRate: 1, slowThresholdMs: 0 });

    await request(app).get('/ok').expect(200);

    const payload = infoSpy.mock.calls[0]?.[0] as { slow?: boolean };
    expect(payload?.slow).toBe(true);
  });

  it('samples successful requests out when sampleRate is 0', async () => {
    const infoSpy = vi.spyOn(logger, 'info');
    const app = makeApp({ sampleRate: 0, slowThresholdMs: 10_000 });

    await request(app).get('/ok').expect(200);

    expect(infoSpy).not.toHaveBeenCalled();
  });

  it('keeps 4xx logs even when sampleRate is 0', async () => {
    const warnSpy = vi.spyOn(logger, 'warn');
    const app = makeApp({ sampleRate: 0 });

    await request(app).get('/missing').expect(404);

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
