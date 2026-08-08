/**
 * AI 回复缓存单元测试
 *
 * 覆盖：
 * - 写入/读取命中；
 * - TTL 过期后视为未命中并惰性淘汰；
 * - TTL ≤ 0 时缓存完全禁用；
 * - cacheKey 对相同输入稳定、对顺序敏感（不同场景不误命中）。
 */
import { describe, expect, it } from 'vitest';

import { AiReplyCache, cacheKey } from '../../src/services/ai/cache.js';

/**
 * 延时工具（测试 TTL 过期用）
 *
 * @param ms 毫秒数
 * @returns Promise<void>
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('AiReplyCache', () => {
  it('stores and retrieves values before TTL expiry', () => {
    const cache = new AiReplyCache(1000);
    cache.set('key', '回复内容');

    expect(cache.get<string>('key')).toBe('回复内容');
    expect(cache.size).toBe(1);
  });

  it('treats expired entries as misses and evicts them lazily', async () => {
    const cache = new AiReplyCache(20);
    cache.set('key', 'v');

    // 超过 TTL 后：读取返回 null，并顺手删除过期条目
    await sleep(40);
    expect(cache.get<string>('key')).toBeNull();
    expect(cache.size).toBe(0);
  });

  it('disables caching entirely when ttl <= 0', () => {
    const cache = new AiReplyCache(0);
    cache.set('key', 'v');

    expect(cache.get<string>('key')).toBeNull();
    expect(cache.size).toBe(0);
  });

  it('generates stable keys for identical input and distinct keys for different order', () => {
    // 相同输入 → 相同键（缓存命中依赖这一点）
    expect(cacheKey(['conv-1', '你好'])).toBe(cacheKey(['conv-1', '你好']));
    // 顺序不同 → 不同键（避免「内容+机器人列表」错位误命中）
    expect(cacheKey(['a', 'b'])).not.toBe(cacheKey(['b', 'a']));
  });
});
