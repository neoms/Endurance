/**
 * AI 上下文滑动窗口单元测试
 *
 * 覆盖：
 * - 阈值以下：原样返回（窗口上限 20）；
 * - 达到阈值（20，窗口满）：最早 15 条折叠为摘要放在头部，保留最新 5 条原文；
 * - 超过 20 条时的防御性截断：先收敛到最近 20 条，再压缩前 15 条、保留最新 5 条；
 * - 摘要算法：空白压缩、单条截断、总量预算、条数标注；
 * - 注入语义摘要器时使用 AI 摘要（并透传会话作用域），未注入时使用确定性摘要；
 * - 不修改输入数组。
 */
import { describe, expect, it } from 'vitest';

import {
  buildContextHistory,
  KEEP_RECENT_MESSAGES,
  MAX_CONTEXT_HISTORY,
  summarizeMessages,
  SUMMARY_THRESHOLD,
  type AiHistoryMessage,
} from '../../src/services/ai/context.js';

/**
 * 构造测试用历史消息（时间升序，user/assistant 交替）
 *
 * @param count  条数
 * @param prefix 内容前缀（默认 msg，便于断言第几条）
 * @returns AiHistoryMessage[]
 */
function makeMessages(count: number, prefix = 'msg'): AiHistoryMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `${prefix}${i + 1}`,
  }));
}

describe('buildContextHistory (滑动窗口)', () => {
  it('keeps all messages when below the summary threshold', async () => {
    const history = makeMessages(SUMMARY_THRESHOLD - 1);
    const result = await buildContextHistory(history);

    expect(result).toHaveLength(SUMMARY_THRESHOLD - 1);
    expect(result.map((m) => m.content)).toEqual(history.map((m) => m.content));
  });

  it('triggers summary at the threshold: summary head + latest 5 raw messages', async () => {
    const history = makeMessages(SUMMARY_THRESHOLD);
    const result = await buildContextHistory(history);

    expect(result).toHaveLength(1 + KEEP_RECENT_MESSAGES);
    // 头部是摘要（system 角色），覆盖最早的 (20-5)=15 条
    expect(result[0]?.role).toBe('system');
    expect(result[0]?.content).toContain(`共 ${SUMMARY_THRESHOLD - KEEP_RECENT_MESSAGES} 条`);
    // 尾部保留最新 5 条原文（msg11 ~ msg15）
    expect(result.slice(1).map((m) => m.content)).toEqual(
      history.slice(-KEEP_RECENT_MESSAGES).map((m) => m.content),
    );
  });

  it('summarizes older messages even beyond 20 and keeps the latest 5', async () => {
    const history = makeMessages(MAX_CONTEXT_HISTORY + 5);
    const result = await buildContextHistory(history);

    expect(result).toHaveLength(1 + KEEP_RECENT_MESSAGES);
    // 防御性截断：先收敛到最近 20 条，再压缩前 15 条（不是全部 20 条）
    expect(result[0]?.content).toContain(`共 ${MAX_CONTEXT_HISTORY - KEEP_RECENT_MESSAGES} 条`);
    expect(result.slice(1).map((m) => m.content)).toEqual(
      history.slice(-KEEP_RECENT_MESSAGES).map((m) => m.content),
    );
  });

  it('does not mutate the input array', async () => {
    const history = makeMessages(SUMMARY_THRESHOLD);
    const snapshot = [...history];
    await buildContextHistory(history);

    expect(history).toEqual(snapshot);
  });

  it('uses the semantic summarizer result when one is injected', async () => {
    const history = makeMessages(SUMMARY_THRESHOLD);
    // 注入假摘要器：断言 buildContextHistory 把「最早 15 条」交给它、
    // 透传会话作用域，并采用其返回值
    let receivedScopeId: string | undefined;
    const fakeSummarizer = {
      summarize: async (older: AiHistoryMessage[], scopeId?: string) => {
        receivedScopeId = scopeId;
        return `AI摘要（${older.length} 条）`;
      },
    };

    const result = await buildContextHistory(history, fakeSummarizer, 'conversation-1');

    expect(result[0]?.role).toBe('system');
    expect(result[0]?.content).toBe(`AI摘要（${SUMMARY_THRESHOLD - KEEP_RECENT_MESSAGES} 条）`);
    expect(result.slice(1).map((m) => m.content)).toEqual(
      history.slice(-KEEP_RECENT_MESSAGES).map((m) => m.content),
    );
    expect(receivedScopeId).toBe('conversation-1');
  });
});

describe('summarizeMessages (确定性摘要)', () => {
  it('marks the folded count and joins contents', () => {
    const summary = summarizeMessages([
      { role: 'user', content: 'alice：你好' },
      { role: 'assistant', content: '技术机器人：你好，有什么可以帮你？' },
    ]);

    expect(summary).toContain('共 2 条');
    expect(summary).toContain('alice：你好');
    expect(summary).toContain('技术机器人：你好，有什么可以帮你？');
  });

  it('collapses whitespace to a single space', () => {
    const summary = summarizeMessages([{ role: 'user', content: '第一行\n\n  第二行\t内容' }]);
    expect(summary).toContain('第一行 第二行 内容');
    expect(summary).not.toContain('\n');
  });

  it('truncates long messages and respects the total budget', () => {
    const long = '长'.repeat(200);
    const summary = summarizeMessages([
      { role: 'user', content: long },
      { role: 'user', content: long },
      { role: 'user', content: long },
    ]);

    // 单条截断：第一条应被截到 120 字符并带省略号
    expect(summary).toContain('…');
    // 总量预算：摘要总长度不超过 800 + 头部长度（约 25 字符）
    expect(summary.length).toBeLessThanOrEqual(850);
  });

  it('returns a marked empty summary for empty input', () => {
    expect(summarizeMessages([])).toBe('[历史消息摘要 · 共 0 条] ');
  });

  it('skips messages containing only whitespace', () => {
    const summary = summarizeMessages([
      { role: 'user', content: '   \n\t ' },
      { role: 'user', content: '有效内容' },
    ]);

    expect(summary).toContain('有效内容');
    expect(summary).not.toContain('\n');
  });

  it('stops adding parts once the total budget is exceeded', () => {
    // 20 条长消息：前几条就会超出总量预算，循环应提前 break
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: 'user' as const,
      content: `消息${i}:${'长'.repeat(100)}`,
    }));

    const summary = summarizeMessages(messages);

    // 头部仍统计全部 20 条，但正文只保留预算内的部分
    expect(summary).toContain('共 20 条');
    expect(summary.length).toBeLessThanOrEqual(850);
  });
});
