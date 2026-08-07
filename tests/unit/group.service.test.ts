/**
 * 群组机器人响应策略单元测试
 *
 * 覆盖 selectBotsForRound 的三种策略与边界：
 * - ALL_BOTS：全部机器人回复；
 * - RANDOM_ONE：恰好一个机器人回复；
 * - CONTENT_ROUTED：按关键词命中；无命中时随机兜底一个（保证必有回复）；
 * - maxReplies 上限截断（防循环硬上限）；
 * - 空机器人列表时返回空（防御性）。
 */
import type { Bot } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { selectBotsForRound } from '../../src/services/group.service.js';

/**
 * 构造测试用机器人
 *
 * @param code     稳定标识
 * @param keywords 内容路由关键词（逗号分隔）
 * @returns Bot 满足 Prisma 类型的最小对象
 */
function makeBot(code: string, keywords: string): Bot {
  return {
    id: `bot-${code}`,
    code,
    name: code,
    personality: 'test',
    replyTendency: keywords,
    isActive: true,
    createdAt: new Date(),
  };
}

describe('selectBotsForRound', () => {
  const tech = makeBot('tech', '代码,bug,api');
  const humor = makeBot('humor', '笑话,段子,搞笑');
  const service = makeBot('customer-service', '客服,退款,订单');

  it('ALL_BOTS returns all bots', () => {
    const selected = selectBotsForRound([tech, humor, service], 'ALL_BOTS', '随便说点什么', 10);
    expect(selected.map((b) => b.code).sort()).toEqual(['customer-service', 'humor', 'tech']);
  });

  it('ALL_BOTS respects the maxReplies cap', () => {
    const selected = selectBotsForRound([tech, humor, service], 'ALL_BOTS', '内容', 2);
    expect(selected).toHaveLength(2);
  });

  it('RANDOM_ONE picks exactly one bot', () => {
    for (let i = 0; i < 20; i += 1) {
      const selected = selectBotsForRound([tech, humor], 'RANDOM_ONE', '内容', 10);
      expect(selected).toHaveLength(1);
    }
  });

  it('CONTENT_ROUTED matches the bot whose keywords hit', () => {
    const selected = selectBotsForRound([tech, humor], 'CONTENT_ROUTED', '这个 bug 怎么处理', 10);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.code).toBe('tech');
  });

  it('CONTENT_ROUTED falls back to one bot when nothing matches', () => {
    const selected = selectBotsForRound([tech, humor], 'CONTENT_ROUTED', '今天天气不错', 10);
    expect(selected).toHaveLength(1);
    expect(['tech', 'humor']).toContain(selected[0]?.code);
  });

  it('returns empty list when no bots available', () => {
    expect(selectBotsForRound([], 'ALL_BOTS', '内容', 10)).toEqual([]);
    expect(selectBotsForRound([], 'RANDOM_ONE', '内容', 10)).toEqual([]);
    expect(selectBotsForRound([], 'CONTENT_ROUTED', '内容', 10)).toEqual([]);
  });
});
