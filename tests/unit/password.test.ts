/**
 * 密码哈希与校验单元测试
 *
 * 覆盖：哈希不保存明文；正确密码校验通过；错误密码校验失败。
 */
import { describe, expect, it } from 'vitest';

import { hashPassword, verifyPassword } from '../../src/lib/password.js';

describe('password', () => {
  it('hashes and verifies a password', async () => {
    const hash = await hashPassword('secret123');
    expect(hash).not.toBe('secret123');
    await expect(verifyPassword('secret123', hash)).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('secret123');
    await expect(verifyPassword('wrong-password', hash)).resolves.toBe(false);
  });
});
