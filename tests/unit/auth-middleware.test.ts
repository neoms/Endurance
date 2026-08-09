/**
 * 认证中间件单元测试
 *
 * 覆盖工具函数 requireUser 的防御性分支：当 req.user 缺失时
 * （正常流程不会发生，仅防御性保护）抛出 401 AppError。
 */
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';

import { requireUser } from '../../src/api/middleware/auth.js';
import { AppError } from '../../src/lib/errors.js';

describe('requireUser', () => {
  it('throws 401 when req.user is missing (defensive guard)', () => {
    const req = {} as Request;

    let caught: AppError | undefined;
    try {
      requireUser(req);
    } catch (err) {
      caught = err as AppError;
    }

    expect(caught).toBeInstanceOf(AppError);
    expect(caught?.statusCode).toBe(401);
    expect(caught?.code).toBe('UNAUTHORIZED');
  });
});
