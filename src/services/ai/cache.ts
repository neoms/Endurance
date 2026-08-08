/**
 * AI 回复缓存模块（进程内 TTL 缓存）
 *
 * 【模块职责】
 * 为「相同问题重复提问」提供回复回放，避免重复调用外部 AI API（省钱、省时）：
 * - 个人对话：以「conversationId + 规范化内容」为键缓存完整回复；
 * - 群组对话：以「groupId + 规范化内容 + 本轮选中 NPC id 列表」为键缓存
 *   **整轮回复**（`{ botId, content }[]`）——一次提问多人回答时，
 *   命中后能按原顺序回放全部 NPC 的回复；
 * - 只缓存成功回复：AI 失败/兜底文案不写缓存（避免把故障结果当正确答案回放）；
 * - 重试（retry）接口不读缓存：保证「再试一次」真正重新调用 AI。
 *
 * 【实现说明】
 * - 进程内 Map + 过期时间戳（惰性淘汰：读取时发现过期立即删除）；
 * - TTL 可配置（默认 1 小时）；TTL ≤ 0 表示关闭缓存；
 * - 缓存键用 MD5 哈希，避免超长内容直接作为 Map 键；日志只记录哈希不记录原文。
 */
import { createHash } from 'node:crypto';

/**
 * 缓存条目
 *
 * @property value     缓存值（个人=string，群组={ botId, content }[]）
 * @property expiresAt 过期时间戳（毫秒），读取时据此判断是否失效
 */
interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

/**
 * 进程内 TTL 缓存实现
 *
 * @param ttlMs 有效期（毫秒，默认 3600_000 = 1 小时；≤0 表示禁用缓存）
 */
export class AiReplyCache {
  private readonly store = new Map<string, CacheEntry>();

  constructor(private readonly ttlMs: number = 3600_000) {}

  /**
   * 读取缓存
   *
   * @param key 缓存键（cacheKey() 生成的哈希）
   * @returns T | null 命中返回缓存值；未命中/已过期/缓存禁用返回 null
   * 说明：读取时惰性淘汰过期条目（删除并视为未命中）。
   */
  get<T>(key: string): T | null {
    if (this.ttlMs <= 0) {
      return null;
    }
    const entry = this.store.get(key);
    if (!entry) {
      return null;
    }
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value as T;
  }

  /**
   * 写入缓存
   *
   * @param key   缓存键
   * @param value 缓存值（成功回复内容；群组为整轮回复列表）
   * @returns void
   * 说明：覆盖同名旧值并重置过期时间；缓存禁用时为空操作。
   */
  set(key: string, value: unknown): void {
    if (this.ttlMs <= 0) {
      return;
    }
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /**
   * 清空全部缓存（测试与调试用）
   *
   * @returns void
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * 当前缓存条目数（测试断言用）
   */
  get size(): number {
    return this.store.size;
  }
}

/**
 * 生成缓存键（MD5 哈希）
 *
 * @param parts 参与键的片段（如 [conversationId, content] 或 [groupId, content, botIds]）
 * @returns string 32 位十六进制哈希，作为 Map 键
 * 说明：join('|') 先拼接再哈希；片段顺序敏感，保证「同内容不同场景」不会误命中。
 */
export function cacheKey(parts: string[]): string {
  return createHash('md5').update(parts.join('|')).digest('hex');
}
