/**
 * JWT 签发与校验单元测试
 *
 * 覆盖：签发后可正确解析；非法 token 校验抛错。
 */
import { describe, expect, it } from 'vitest';

import { signToken, verifyToken } from '../../src/lib/jwt.js';

describe('jwt', () => {
  it('signs and verifies a token roundtrip', () => {
    const token = signToken({ sub: 'user-1', username: 'alice' });
    expect(verifyToken(token)).toEqual({ sub: 'user-1', username: 'alice' });
  });

  it('rejects an invalid token', () => {
    expect(() => verifyToken('not-a-real-token')).toThrow();
  });
});
