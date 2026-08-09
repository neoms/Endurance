/**
 * JWT 签发与校验单元测试
 *
 * 覆盖：签发后可正确解析；非法 token 校验抛错；
 * payload 形状非法（字符串载荷 / 缺少 username 声明）时防御性抛错。
 */
import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';

import { env } from '../../src/config/env.js';
import { signToken, verifyToken } from '../../src/lib/jwt.js';

describe('jwt', () => {
  it('signs and verifies a token roundtrip', () => {
    const token = signToken({ sub: 'user-1', username: 'alice' });
    expect(verifyToken(token)).toEqual({ sub: 'user-1', username: 'alice' });
  });

  it('rejects an invalid token', () => {
    expect(() => verifyToken('not-a-real-token')).toThrow();
  });

  it('rejects a token whose payload is a string (defensive check)', () => {
    // jsonwebtoken 允许字符串载荷；verifyToken 必须拒绝这种非对象载荷
    const token = jwt.sign('not-an-object', env.JWT_SECRET);
    expect(() => verifyToken(token)).toThrow('Invalid token payload');
  });

  it('rejects a token missing the username claim', () => {
    const token = jwt.sign({ sub: 'user-1' }, env.JWT_SECRET);
    expect(() => verifyToken(token)).toThrow('Invalid token payload');
  });
});
