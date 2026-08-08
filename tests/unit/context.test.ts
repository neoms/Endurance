/**
 * AI 上下文滑动窗口单元测试
 *
 * 覆盖：
 * - 阈值以下：原样返回（窗口上限 20）；
 * - 达到阈值（15）：最早部分折叠为摘要放在头部，保留最新 5 条原文；
 * - 超过 20 条时的防御性截断/总结；
 * - 摘要算法：空白压缩、单条截断、总量预算、条数标注；
 * - 不修改输入数组（纯函数）。
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
  it('keeps all messages when below the summary threshold', () => {
    const history = makeMessages(SUMMARY_THRESHOLD - 1);
    const result = buildContextHistory(history);

    expect(result).toHaveLength(SUMMARY_THRESHOLD - 1);
    expect(result.map((m) => m.content)).toEqual(history.map((m) => m.content));
  });

  it('triggers summary at the threshold: summary head + latest 5 raw messages', () => {
    const history = makeMessages(SUMMARY_THRESHOLD);
    const result = buildContextHistory(history);

    expect(result).toHaveLength(1 + KEEP_RECENT_MESSAGES);
    // 头部是摘要（system 角色），覆盖最早 (15-5)=10 条
    expect(result[0]?.role).toBe('system');
    expect(result[0]?.content).toContain(`共 ${SUMMARY_THRESHOLD - KEEP_RECENT_MESSAGES} 条`);
    // 尾部保留最新 5 条原文（msg11 ~ msg15）
    expect(result.slice(1).map((m) => m.content)).toEqual(
      history.slice(-KEEP_RECENT_MESSAGES).map((m) => m.content),
    );
  });

  it('summarizes older messages even beyond 20 and keeps the latest 5', () => {
    const history = makeMessages(MAX_CONTEXT_HISTORY + 5);
    const result = buildContextHistory(history);

    expect(result).toHaveLength(1 + KEEP_RECENT_MESSAGES);
    expect(result[0]?.content).toContain(`共 ${MAX_CONTEXT_HISTORY} 条`);
    expect(result.slice(1).map((m) => m.content)).toEqual(
      history.slice(-KEEP_RECENT_MESSAGES).map((m) => m.content),
    );
  });

  it('does not mutate the input array', () => {
    const history = makeMessages(SUMMARY_THRESHOLD);
    const snapshot = [...history];
    buildContextHistory(history);

    expect(history).toEqual(snapshot);
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
});
