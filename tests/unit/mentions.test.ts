/**
 * @提及解析与解析逻辑单元测试
 *
 * 覆盖：
 * - parseMentionNames：切词规则（空白/中文标点边界、重复出现、无 @）；
 * - resolveMentions：机器人命中、@ 顺序保持、重复去重、
 *   真实成员（用户名/昵称）合法、非法名称收集、空内容。
 */
import type { Bot } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { parseMentionNames, resolveMentions } from '../../src/services/group.service.js';

/**
 * 构造一个测试用机器人对象（补齐 Bot 类型必填字段）
 *
 * @param id   机器人 id
 * @param name 机器人名称
 * @returns Bot
 */
function makeBot(id: string, name: string): Bot {
  return {
    id,
    code: id,
    name,
    personality: '',
    replyTendency: '',
    isActive: true,
    createdAt: new Date(),
  };
}

describe('parseMentionNames', () => {
  it('extracts mention names in order, separated by whitespace', () => {
    expect(parseMentionNames('@技术机器人 帮我看下 bug')).toEqual(['技术机器人']);
    expect(parseMentionNames('你好 @alice 和 @bob 请回复')).toEqual(['alice', 'bob']);
  });

  it('stops at common Chinese/English punctuation', () => {
    expect(parseMentionNames('@客服机器人，你好')).toEqual(['客服机器人']);
    expect(parseMentionNames('@技术机器人。谢谢')).toEqual(['技术机器人']);
    expect(parseMentionNames('@humor! hi')).toEqual(['humor']);
  });

  it('keeps duplicates for resolution (dedup happens at resolve stage)', () => {
    expect(parseMentionNames('@技术机器人 @技术机器人')).toEqual(['技术机器人', '技术机器人']);
  });

  it('returns empty array when there is no mention', () => {
    expect(parseMentionNames('普通消息，没有提及')).toEqual([]);
    expect(parseMentionNames('')).toEqual([]);
    // 邮箱里的 @ 不是提及（前面是字母，不满足后行断言）
    expect(parseMentionNames('邮箱 a@b.com 不算提及')).toEqual([]);
  });

  it('matches mentions attached to Chinese text without a space', () => {
    // 中文「请」紧贴 @ 也应识别（前面不是字母/数字/下划线）
    expect(parseMentionNames('请@技术机器人 看看这个 bug')).toEqual(['技术机器人']);
  });
});

describe('resolveMentions', () => {
  const bots = [makeBot('bot-tech', '技术机器人'), makeBot('bot-humor', '幽默机器人')];
  const members = [
    { username: 'alice', displayName: 'Alice' },
    { username: 'bob', displayName: 'Bob' },
  ];

  it('returns mentioned bots in @ order and deduplicates repeats', () => {
    const result = resolveMentions(
      '@幽默机器人 先来 @技术机器人 后来 @幽默机器人 再来',
      bots,
      members,
    );
    expect(result.mentionedBots.map((b) => b.id)).toEqual(['bot-humor', 'bot-tech']);
    expect(result.unresolved).toEqual([]);
  });

  it('treats real group members (username or displayName) as valid mentions', () => {
    const byUsername = resolveMentions('@alice 帮我看看', bots, members);
    const byDisplayName = resolveMentions('@Alice 帮我看看', bots, members);
    expect(byUsername.mentionedBots).toEqual([]);
    expect(byUsername.mentionedMembers).toEqual(['alice']);
    expect(byUsername.unresolved).toEqual([]);
    expect(byDisplayName.mentionedMembers).toEqual(['Alice']);
    expect(byDisplayName.unresolved).toEqual([]);
  });

  it('collects unresolved names that are neither bots nor members', () => {
    const result = resolveMentions('@技术机器人 @外星人 @alice @幽灵', bots, members);
    expect(result.mentionedBots.map((b) => b.id)).toEqual(['bot-tech']);
    expect(result.mentionedMembers).toEqual(['alice']);
    // 非法名称去重后列出（顺序按首次出现）
    expect(result.unresolved).toEqual(['外星人', '幽灵']);
  });

  it('is case-sensitive for member usernames', () => {
    const result = resolveMentions('@Alice 大写昵称合法 @ALICE 大写用户名不合法', bots, members);
    // 'Alice' 是昵称（合法）；'ALICE' 既不是用户名 'alice' 也不是昵称 'Alice' → 非法
    expect(result.unresolved).toEqual(['ALICE']);
  });

  it('returns empty result when there are no mentions', () => {
    expect(resolveMentions('普通消息', bots, members)).toEqual({
      mentionedBots: [],
      mentionedMembers: [],
      unresolved: [],
    });
  });
});
