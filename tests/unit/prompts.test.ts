/**
 * 提示词模块单元测试
 *
 * 覆盖：
 * - 系统提示：群组机器人（含/不含 personality）、个人对话通用提示；
 * - 消息组装：system + 历史 + 当前用户消息（含/不含用户名前缀）；
 * - 滑动窗口摘要（system 角色）按原顺序透传。
 */
import { describe, expect, it } from 'vitest';

import { buildChatMessages, buildSystemPrompt } from '../../src/services/ai/prompts.js';
import { OFF_TOPIC_REPLY } from '../../src/services/ai/topic-guard.js';
import type { AiGenerateContext } from '../../src/services/ai/types.js';

describe('buildSystemPrompt', () => {
  it('injects bot name and personality for group bots', () => {
    const prompt = buildSystemPrompt({
      content: 'hi',
      botName: '技术机器人',
      personality: '严谨、专业，喜欢讲原理',
    });

    expect(prompt).toContain('技术机器人');
    expect(prompt).toContain('严谨、专业，喜欢讲原理');
    expect(prompt).toContain('不要自称是 AI 助手');
    // 防回归：包装层用中性「角色」而非「机器人」——
    // 预设里有人类角色（库珀/布兰德等），写死「你是机器人」会让人物以机械口吻回答
    expect(prompt).toContain('群聊中的角色');
    expect(prompt).not.toContain('你是群组机器人');
    // 群聊沉浸规则：第一人称扮演、口语化对话、不替别人发言
    expect(prompt).toContain('不要替其他角色或用户发言');
    // 防回归：禁止复述他人发言、禁止输出「角色名：」标注（道尔消息混入库珀的话的根因）
    expect(prompt).toContain('不要复述、转述或模仿其他角色');
    expect(prompt).toContain('严禁出现任何角色名字加冒号的写法');
    expect(prompt).toContain('不使用 emoji 或网络流行语');
    // 讨论范围：只讨论《星际穿越》，无关话题只回复固定文案（个人与群组统一注入）
    expect(prompt).toContain('星际穿越');
    expect(prompt).toContain('防越界安全规则');
    expect(prompt).toContain(OFF_TOPIC_REPLY);
  });

  it('falls back to name-only prompt when personality is missing', () => {
    const prompt = buildSystemPrompt({ content: 'hi', botName: '客服机器人' });

    expect(prompt).toContain('客服机器人');
    expect(prompt).not.toContain('性格/回复倾向');
    // 无人设兜底同样必须带讨论范围与固定回复
    expect(prompt).toContain('星际穿越');
    expect(prompt).toContain(OFF_TOPIC_REPLY);
  });

  it('uses the generic assistant prompt for personal chats', () => {
    const prompt = buildSystemPrompt({ content: 'hi' });

    // 个人对话：场景锚定在《星际穿越》世界观（永恒号值班 AI），
    // 不再是现实世界的通用助手——这是「AI 只讨论电影内容」的提示词层基础
    expect(prompt).toContain('永恒号');
    expect(prompt).toContain('星际穿越');
    expect(prompt).toContain('拉撒路任务');
    expect(prompt).toContain(OFF_TOPIC_REPLY);
    expect(prompt).not.toContain('群聊中的角色');
  });
});

describe('buildChatMessages', () => {
  it('assembles system + history + user message with userName prefix', () => {
    const context: AiGenerateContext = {
      content: '你好',
      botName: '技术机器人',
      userName: 'alice',
      history: [{ role: 'user', content: '昨天的问题' }],
    };
    const messages = buildChatMessages(context);

    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({ role: 'system' });
    expect(messages[0]?.content).toContain('技术机器人');
    expect(messages[1]).toEqual({ role: 'user', content: '昨天的问题' });
    // 当前用户消息带「用户名：」前缀
    expect(messages[2]).toEqual({ role: 'user', content: 'alice：你好' });
  });

  it('does not prefix userName when absent (personal chat)', () => {
    const messages = buildChatMessages({ content: '你好' });

    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual({ role: 'user', content: '你好' });
  });

  it('passes the sliding-window summary (system role) through as history', () => {
    const messages = buildChatMessages({
      content: '继续',
      history: [
        { role: 'system', content: '[历史消息摘要 · 共 10 条] …' },
        { role: 'user', content: 'alice：最新一条' },
      ],
    });

    // system(人设) + system(摘要) + user(历史) + user(当前消息)
    expect(messages.map((m) => m.role)).toEqual(['system', 'system', 'user', 'user']);
    expect(messages[1]?.content).toContain('历史消息摘要');
  });
});
