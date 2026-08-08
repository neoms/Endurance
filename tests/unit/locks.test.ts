/**
 * 键级互斥锁工具单元测试
 *
 * 覆盖：
 * - 同一键的任务串行执行（并发高峰时最大并发数 = 1）；
 * - 不同键的任务互不阻塞（可并行）；
 * - 任务失败不阻塞队列中的后续任务。
 */
import { describe, expect, it } from 'vitest';

import { createKeyedLock } from '../../src/lib/locks.js';

describe('createKeyedLock', () => {
  it('serializes tasks with the same key', async () => {
    const lock = createKeyedLock();
    let active = 0;
    let maxActive = 0;

    const run = (ms: number) =>
      lock('k', async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, ms));
        active -= 1;
      });

    await Promise.all([run(20), run(10), run(5)]);
    // 同一键的任务必须严格串行
    expect(maxActive).toBe(1);
  });

  it('runs tasks with different keys in parallel', async () => {
    const lock = createKeyedLock();
    let active = 0;
    let maxActive = 0;

    const run = (key: string) =>
      lock(key, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
      });

    await Promise.all([run('a'), run('b'), run('c')]);
    // 不同键的任务互不阻塞
    expect(maxActive).toBe(3);
  });

  it('does not block the queue when a task fails', async () => {
    const lock = createKeyedLock();

    await expect(
      lock('k', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // 失败后同一键的下一个任务仍能正常执行（锁已释放）
    await expect(lock('k', async () => 'after-failure')).resolves.toBe('after-failure');
  });
});
