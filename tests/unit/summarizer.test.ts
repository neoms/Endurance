/**
 * 语义摘要器单元测试
 *
 * 覆盖：
 * - 未配置 AI 服务（未配 API Key）→ 降级为确定性摘要；
 * - 配置 AI 服务 → 调用 AI 生成语义摘要，且系统提示词使用摘要器专用提示词；
 * - AI 调用失败 / 返回空文本 → 降级为确定性摘要（不阻断对话）；
 * - 摘要缓存：同一份历史第二次请求直接回放，不再调用 AI；
 * - 超长历史输入被截断并标注（输入预算保护）；
 * - 增量衔接：第二次触发时只把「上次摘要 + 新增消息」送入模型（输入显著变小）；
 * - 无会话作用域 / 衔接不上时走全量压缩。
 */
import { describe, expect, it, vi } from 'vitest';

import { AiReplyCache } from '../../src/services/ai/cache.js';
import { SemanticSummarizer } from '../../src/services/ai/summarizer.js';
import {
  SUMMARY_INCREMENTAL_SYSTEM_PROMPT,
  SUMMARY_SYSTEM_PROMPT,
} from '../../src/services/ai/prompts.js';
import type { AiGenerateContext } from '../../src/services/ai/types.js';
import type { AiService } from '../../src/services/ai/ai.service.js';
import type { AiHistoryMessage } from '../../src/services/ai/context.js';

/**
 * 构造假 AI 服务（记录调用，返回可控结果）
 *
 * @param onCall 每次调用时执行（可返回回复文本或抛错）
 * @returns { aiService, calls } 假 AI 服务与调用记录
 */
function makeFakeAiService(onCall: (context: AiGenerateContext) => Promise<string> | string) {
  const calls: AiGenerateContext[] = [];
  const aiService = {
    generateWithRetry: async (context: AiGenerateContext) => {
      calls.push(context);
      return onCall(context);
    },
  } as unknown as AiService;
  return { aiService, calls };
}

/**
 * 构造测试用历史消息
 *
 * @param count 条数
 * @returns AiHistoryMessage[]
 */
function makeMessages(count: number): AiHistoryMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `alice：第${i + 1}条消息`,
  }));
}

/**
 * 构造带消息 id 的测试用历史消息（增量衔接依赖 id）
 *
 * @param count  条数
 * @param prefix id 前缀（默认 m，用于构造「与上次历史不衔接」的场景）
 * @returns AiHistoryMessage[]（每条带唯一 id，如 m1、m2…）
 */
function makeMessagesWithIds(count: number, prefix = 'm'): AiHistoryMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${i + 1}`,
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `alice：第${i + 1}条消息`,
  }));
}

describe('SemanticSummarizer', () => {
  it('falls back to deterministic summary when no AI service (no API key)', async () => {
    const summarizer = new SemanticSummarizer(null);
    const messages = makeMessages(3);

    const summary = await summarizer.summarize(messages);

    expect(summary).toContain('共 3 条');
    expect(summary).toContain('alice：第1条消息');
  });

  it('calls AI with the summary system prompt and returns the semantic summary', async () => {
    const { aiService, calls } = makeFakeAiService(() => '这是语义压缩后的摘要。');
    const summarizer = new SemanticSummarizer(aiService);

    const summary = await summarizer.summarize(makeMessages(5));

    expect(summary).toBe('这是语义压缩后的摘要。');
    // 关键断言：系统提示词必须用摘要器专用提示词（而非闲聊人设）
    expect(calls[0]?.systemPromptOverride).toBe(SUMMARY_SYSTEM_PROMPT);
    // 历史消息以 [user]/[assistant] 角色标记拼入单段用户内容
    expect(calls[0]?.content).toContain('[user] alice：第1条消息');
    expect(calls[0]?.content).toContain('[assistant] alice：第2条消息');
    expect(calls[0]?.history).toEqual([]);
  });

  it('falls back to deterministic summary when the AI call fails', async () => {
    const { aiService } = makeFakeAiService(() => {
      throw new Error('simulated AI outage');
    });
    // 传入缓存实例：第三次调用应命中缓存直接回放（不重复调用 AI）
    const summarizer = new SemanticSummarizer(aiService);

    const summary = await summarizer.summarize(makeMessages(4));

    expect(summary).toContain('共 4 条');
  });

  it('falls back to deterministic summary when AI returns empty text', async () => {
    const { aiService } = makeFakeAiService(() => '   ');
    const summarizer = new SemanticSummarizer(aiService);

    const summary = await summarizer.summarize(makeMessages(2));

    expect(summary).toContain('共 2 条');
  });

  it('replays cached summary without calling AI again for the same history', async () => {
    const generate = vi.fn(async () => '缓存的语义摘要');
    const aiService = {
      generateWithRetry: generate,
    } as unknown as AiService;
    const cache = new AiReplyCache(3_600_000);
    const summarizer = new SemanticSummarizer(aiService, cache);
    const messages = makeMessages(6);

    const first = await summarizer.summarize(messages);
    const second = await summarizer.summarize(messages);

    expect(first).toBe('缓存的语义摘要');
    expect(second).toBe(first);
    // 同一份历史只调用一次 AI（第二次命中缓存）
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('truncates overly long history input with a marker', async () => {
    const { aiService, calls } = makeFakeAiService(() => '摘要');
    const summarizer = new SemanticSummarizer(aiService);
    // 单条超长消息：拼装后超过 8000 字符输入预算，应被截断并标注
    const messages = [{ role: 'user' as const, content: '长'.repeat(10_000) }];

    await summarizer.summarize(messages);

    expect(calls[0]?.content.length).toBeLessThanOrEqual(8000 + 50);
    expect(calls[0]?.content).toContain('已截断');
  });

  it('uses incremental compression on the second trigger within the same scope', async () => {
    // 记录每次调用的提示词与输入，验证第二次走增量路径
    const prompts: string[] = [];
    const inputs: string[] = [];
    const { aiService } = makeFakeAiService((context) => {
      prompts.push(context.systemPromptOverride ?? '');
      inputs.push(context.content);
      return `摘要${prompts.length}`;
    });
    // 传入缓存实例：第三次调用应命中缓存直接回放（不重复调用 AI）
    const summarizer = new SemanticSummarizer(aiService, new AiReplyCache(3_600_000));

    // 第一次触发：15 条历史（模拟满 20 条时的前 15 条），全量压缩
    const firstMessages = makeMessagesWithIds(15);
    await summarizer.summarize(firstMessages, 'group-1');

    // 第二次触发：20 条历史（前 15 条相同 + 5 条新增），应走增量路径
    const secondMessages = makeMessagesWithIds(20);
    await summarizer.summarize(secondMessages, 'group-1');

    // 第一次：全量提示词，输入包含全部 15 条消息
    expect(prompts[0]).toBe(SUMMARY_SYSTEM_PROMPT);
    expect(inputs[0]).toContain('alice：第15条消息');
    // 第二次：增量提示词，输入只含「已有摘要 + 新增的 5 条」，不含旧消息全文
    expect(prompts[1]).toBe(SUMMARY_INCREMENTAL_SYSTEM_PROMPT);
    expect(inputs[1]).toContain('已有摘要');
    expect(inputs[1]).toContain('alice：第16条消息');
    expect(inputs[1]).toContain('alice：第20条消息');
    expect(inputs[1]).not.toContain('alice：第1条消息');
    // 返回第二次的增量摘要
    expect(await summarizer.summarize(secondMessages, 'group-1')).toBe('摘要2');
  });

  it('falls back to full compression when the previous summary cannot be chained', async () => {
    const prompts: string[] = [];
    const { aiService } = makeFakeAiService((context) => {
      prompts.push(context.systemPromptOverride ?? '');
      return '摘要';
    });
    const summarizer = new SemanticSummarizer(aiService);

    // 第一次：记录覆盖到 m15 的摘要状态
    await summarizer.summarize(makeMessagesWithIds(15), 'group-1');
    // 第二次：历史完全不衔接（id 前缀不同，找不到 m15 锚点）→ 应走全量压缩
    await summarizer.summarize(makeMessagesWithIds(20, 'x'), 'group-1');

    expect(prompts).toEqual([SUMMARY_SYSTEM_PROMPT, SUMMARY_SYSTEM_PROMPT]);
  });

  it('always uses full compression when no scope id is provided', async () => {
    const prompts: string[] = [];
    const { aiService } = makeFakeAiService((context) => {
      prompts.push(context.systemPromptOverride ?? '');
      return '摘要';
    });
    const summarizer = new SemanticSummarizer(aiService);

    await summarizer.summarize(makeMessagesWithIds(15));
    await summarizer.summarize(makeMessagesWithIds(20));

    // 无会话作用域 → 两次都是全量压缩（不做增量衔接）
    expect(prompts).toEqual([SUMMARY_SYSTEM_PROMPT, SUMMARY_SYSTEM_PROMPT]);
  });

  it('deletes incremental state when the full compression input has no message ids', async () => {
    // scopeId 存在但消息无 id：语义摘要成功后必须清理旧状态，避免下次误衔接
    const { aiService, calls } = makeFakeAiService(async () => '语义摘要结果');
    const summarizer = new SemanticSummarizer(aiService);

    const summary = await summarizer.summarize(makeMessages(3), 'scope-no-ids');

    expect(summary).toBe('语义摘要结果');
    expect(calls).toHaveLength(1);
  });

  it('evicts the oldest scope state when the state map exceeds its cap', async () => {
    // 超过容量上限（500）后应淘汰最早一条会话状态，防止长期运行内存膨胀
    const { aiService, calls } = makeFakeAiService(async () => '摘要');
    const summarizer = new SemanticSummarizer(aiService);

    // 连续为 501 个不同会话生成摘要：最后一次触发淘汰分支（不抛错即可）
    for (let i = 0; i < 501; i += 1) {
      await summarizer.summarize(makeMessagesWithIds(3, `scope-${i}`), `scope-${i}`);
    }

    expect(calls).toHaveLength(501);
  });

  it('returns a deterministic empty summary without calling AI for empty input', async () => {
    const { aiService, calls } = makeFakeAiService(async () => '不应被调用');
    const summarizer = new SemanticSummarizer(aiService);

    const summary = await summarizer.summarize([]);

    expect(summary).toContain('共 0 条');
    expect(calls).toHaveLength(0);
  });

  it('falls back to full compression when incremental compression fails', async () => {
    // 增量调用失败：不直接降级确定性摘要，而是再尝试一次全量压缩（质量优先）
    const prompts: string[] = [];
    const { aiService } = makeFakeAiService((context) => {
      prompts.push(context.systemPromptOverride ?? '');
      if (context.systemPromptOverride === SUMMARY_INCREMENTAL_SYSTEM_PROMPT) {
        throw new Error('incremental AI failure');
      }
      return '全量摘要';
    });
    const summarizer = new SemanticSummarizer(aiService);

    await summarizer.summarize(makeMessagesWithIds(15), 'group-1');
    const summary = await summarizer.summarize(makeMessagesWithIds(20), 'group-1');

    expect(summary).toBe('全量摘要');
    // 第一次全量 → 第二次先增量（失败）→ 再全量
    expect(prompts).toEqual([
      SUMMARY_SYSTEM_PROMPT,
      SUMMARY_INCREMENTAL_SYSTEM_PROMPT,
      SUMMARY_SYSTEM_PROMPT,
    ]);
  });
});
