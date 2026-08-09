/**
 * 环境变量配置模块单元测试
 *
 * 覆盖 env.ts 的 fail-fast 分支：环境变量非法时模块加载即抛出
 * 「Invalid environment configuration」（对应 safeParse 失败路径）。
 *
 * 【隔离说明】
 * env 是模块级单例（import 时完成校验）。本测试通过 vi.resetModules +
 * 动态 import 在独立的模块注册表中重新加载，不影响其他测试文件
 * （Vitest 默认按文件隔离模块注册表）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('env 配置校验', () => {
  const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;

  afterEach(() => {
    // 恢复环境变量，避免污染后续用例
    if (ORIGINAL_JWT_SECRET === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
    }
  });

  it('fails fast when a required env var is invalid', async () => {
    vi.resetModules();
    // JWT_SECRET 的 schema 要求至少 16 个字符：故意给短值触发校验失败
    process.env.JWT_SECRET = 'too-short';

    await expect(import('../../src/config/env.js')).rejects.toThrow(
      /Invalid environment configuration/,
    );
  });
});
