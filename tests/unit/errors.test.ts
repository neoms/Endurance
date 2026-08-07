/**
 * 全局错误处理单元测试
 *
 * 验证 errorHandler 对 AppError（业务错误）与未知错误的响应映射：
 * - AppError → 对应状态码与错误码；
 * - 未知错误 → 500 且不泄露内部细节。
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { AppError, errorHandler } from '../../src/lib/errors.js';

function buildApp() {
  const app = express();
  app.get('/app-error', () => {
    throw new AppError(403, 'FORBIDDEN', 'no access');
  });
  app.get('/unknown-error', () => {
    throw new Error('oops');
  });
  app.use(errorHandler);
  return app;
}

describe('errorHandler', () => {
  it('maps AppError to its status code and error body', async () => {
    const res = await request(buildApp()).get('/app-error');

    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'FORBIDDEN', message: 'no access' });
  });

  it('maps unknown errors to 500 INTERNAL_ERROR without leaking details', async () => {
    const res = await request(buildApp()).get('/unknown-error');

    expect(res.status).toBe(500);
    expect(res.body.error).toEqual({ code: 'INTERNAL_ERROR', message: 'Internal server error' });
  });
});
