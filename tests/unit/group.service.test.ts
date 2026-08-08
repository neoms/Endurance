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

import {
  createLeadingNameStripper,
  selectBotsForRound,
  stripSpeakerNameMarkers,
  stripLeadingSpeakerName,
} from '../../src/services/group.service.js';

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

describe('stripLeadingSpeakerName', () => {
  it('strips a single leading name prefix (with colon / 说 / space variants)', () => {
    expect(stripLeadingSpeakerName('库珀：你好', ['库珀'])).toBe('你好');
    expect(stripLeadingSpeakerName('库珀说：你好', ['库珀'])).toBe('你好');
    expect(stripLeadingSpeakerName('库珀 你好', ['库珀'])).toBe('你好');
  });

  it('strips multiple consecutive name prefixes', () => {
    // 真实模型可能模仿历史格式输出「库珀：库珀：…」的多重前缀
    expect(stripLeadingSpeakerName('库珀：库珀：你好', ['库珀'])).toBe('你好');
    expect(stripLeadingSpeakerName('库珀说：库珀：你好', ['库珀'])).toBe('你好');
  });

  it('strips another character name that the model mimicked', () => {
    // 核心修复点：模型可能模仿历史里的「别人名字」，
    // 如道尔回复开头写「库珀：…」——只要传入全部名字集合就能剥掉
    expect(stripLeadingSpeakerName('库珀：我觉得应该飞', ['道尔', '库珀'])).toBe('我觉得应该飞');
    // 连续多个不同角色名前缀也一并剥掉
    expect(stripLeadingSpeakerName('道尔：库珀：你好', ['库珀', '道尔'])).toBe('你好');
  });

  it('matches longer names first to avoid partial-name mis-stripping', () => {
    // 长名「艾米莉亚·布兰德」必须以整体匹配，不能被短名候选吃掉前缀
    expect(stripLeadingSpeakerName('艾米莉亚·布兰德：你好', ['库珀', '艾米莉亚·布兰德'])).toBe(
      '你好',
    );
  });

  it('keeps content that does not actually start with the name', () => {
    expect(stripLeadingSpeakerName('你好，库珀', ['库珀'])).toBe('你好，库珀');
    // 名字后跟普通汉字不算前缀（避免误伤正常开头）
    expect(stripLeadingSpeakerName('库珀的想法很有趣', ['库珀'])).toBe('库珀的想法很有趣');
  });
});

describe('stripSpeakerNameMarkers (全局剔除角色名标注)', () => {
  it('strips name markers anywhere in the content (self and others)', () => {
    // 内容中间出现「道尔：」自标（模型自报家门）应被剔除
    expect(
      stripSpeakerNameMarkers('数据上确实是最优解。\n\n道尔：（点头）我也这么认为。', [
        '道尔',
        '库珀',
      ]),
    ).toBe('数据上确实是最优解。\n\n（点头）我也这么认为。');
    // 内容开头/中间出现「库珀：」他名标注也应被剔除（模型替别人发言）
    expect(
      stripSpeakerNameMarkers('库珀：塔斯，把参数调出来。我建议先减速。', ['道尔', '库珀']),
    ).toBe('塔斯，把参数调出来。我建议先减速。');
  });

  it('strips both 名字： and 名字说： variants', () => {
    expect(stripSpeakerNameMarkers('库珀说：你好', ['库珀'])).toBe('你好');
    expect(stripSpeakerNameMarkers('道尔：库珀说：你好', ['道尔', '库珀'])).toBe('你好');
  });

  it('does not touch mentions/calls without a colon after the name', () => {
    // 「塔斯，把参数调出来」是呼唤塔斯（逗号），不是标注，不应被剔除
    expect(stripSpeakerNameMarkers('塔斯，把参数调出来。', ['塔斯', '库珀'])).toBe(
      '塔斯，把参数调出来。',
    );
    // 「库珀说得很对」是评价，不是标注
    expect(stripSpeakerNameMarkers('库珀说得很对。', ['库珀'])).toBe('库珀说得很对。');
  });
});

describe('createLeadingNameStripper', () => {
  it('strips a prefix that is split across stream chunks', () => {
    const strip = createLeadingNameStripper(['库珀']);

    expect(strip('库')).toBe('');
    expect(strip('珀：')).toBe('');
    expect(strip('你好')).toBe('你好');
    expect(strip('，请讲')).toBe('，请讲');
  });

  it('strips multiple consecutive prefixes across chunks', () => {
    const strip = createLeadingNameStripper(['库珀']);

    expect(strip('库珀：')).toBe('');
    expect(strip('库珀：你好')).toBe('你好');
  });

  it('strips a name that arrives one character per chunk', () => {
    const strip = createLeadingNameStripper(['库珀']);

    // 模型可能把前缀切成「库」「珀」「：」三个独立增量
    expect(strip('库')).toBe('');
    expect(strip('珀')).toBe('');
    expect(strip('：')).toBe('');
    expect(strip('你好')).toBe('你好');
  });

  it('strips prefixes that arrive complete but without delimiter yet', () => {
    const strip = createLeadingNameStripper(['库珀']);

    expect(strip('库珀')).toBe('');
    expect(strip('：库珀：')).toBe('');
    expect(strip('你好')).toBe('你好');
  });

  it('passes through content whose start only resembles the name', () => {
    const strip = createLeadingNameStripper(['库珀']);

    expect(strip('库')).toBe('');
    expect(strip('珀的想法')).toBe('库珀的想法');
  });

  it('passes through chunks unchanged after the prefix is resolved', () => {
    const strip = createLeadingNameStripper(['库珀']);

    expect(strip('库珀：')).toBe('');
    expect(strip('你好')).toBe('你好');
    expect(strip('世界')).toBe('世界');
  });

  it('strips another character name mimicked at the start (multi-name set)', () => {
    const strip = createLeadingNameStripper(['道尔', '库珀']);

    // 模型以别人名字开头（如道尔回「库珀：…」）也要剥掉
    expect(strip('库')).toBe('');
    expect(strip('珀：')).toBe('');
    expect(strip('我觉得应该飞')).toBe('我觉得应该飞');
  });
});
