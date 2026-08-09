/**
 * 认证服务异常路径单元测试
 *
 * 覆盖：
 * - 注册时数据库抛出的非唯一约束错误必须原样上抛（不能误判为 409）；
 * - getCurrentUser 在用户已被删除时返回 401（token 有效但账号不存在的兜底）。
 */
import { describe, expect, it, vi } from 'vitest';

import { prisma } from '../../src/lib/prisma.js';
import { getCurrentUser, register } from '../../src/services/auth.service.js';

describe('auth.service 异常路径', () => {
  it('rethrows non-unique errors from user creation (does not mask as 409)', async () => {
    // 模拟数据库故障：非 P2002 的错误必须透传，避免把真实故障伪装成「用户名已存在」
    const spy = vi.spyOn(prisma.user, 'create').mockRejectedValue(new Error('db down'));

    await expect(register({ username: 'freshuser', password: 'password123' })).rejects.toThrow(
      'db down',
    );

    spy.mockRestore();
  });

  it('throws 401 when the current user no longer exists', async () => {
    await expect(getCurrentUser('not-a-real-user')).rejects.toMatchObject({
      statusCode: 401,
      code: 'UNAUTHORIZED',
    });
  });
});
