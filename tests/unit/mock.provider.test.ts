/**
 * Mock AI Provider 单元测试
 *
 * 覆盖：
 * - 默认 echo 模式与 random 模式（随机话术库内）；
 * - 流式 stream：分块产出，拼接结果与 generate 完全一致；
 * - 流式中途被 abort：立即抛出可重试错误（不悬挂）。
 */
import { describe, expect, it } from 'vitest';

import { AiError } from '../../src/services/ai/errors.js';
import { MockAiProvider } from '../../src/services/ai/mock.provider.js';

describe('MockAiProvider', () => {
  it('echoes the user message with the sender name prefix', async () => {
    const provider = new MockAiProvider();
    const result = await provider.generate({ content: '你好', userName: 'alice' });

    expect(result.content).toContain('alice说：');
    expect(result.content).toContain('你好');
  });

  it('does not embed the NPC name prefix in group content', async () => {
    const provider = new MockAiProvider();
    const result = await provider.generate({ content: 'hi', botName: '库珀', userName: 'alice' });

    // 内容不应带 NPC 自己的名字前缀（发言者由前端标签与历史前缀逻辑负责，
    // 避免与历史上下文前缀叠加成双重前缀）
    expect(result.content.startsWith('库珀')).toBe(false);
    expect(result.content).toContain('alice说：');
  });
});

describe('MockAiProvider stream', () => {
  it('streams chunks that join to the same reply as generate', async () => {
    // 关闭块间延迟：测试不依赖真实计时
    const provider = new MockAiProvider({ streamChunkDelayMs: 0 });
    const context = { content: '这是一个较长的测试消息', userName: 'alice' };

    const full = await provider.generate(context, {});
    const chunks: string[] = [];
    for await (const chunk of provider.stream(context, {})) {
      chunks.push(chunk);
    }

    // 回复被切成多个块，且拼接结果与 generate 完全一致
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(full.content);
  });

  it('throws a retryable error when aborted mid-stream', async () => {
    const provider = new MockAiProvider({ streamChunkDelayMs: 20 });
    const controller = new AbortController();
    // 长文本保证有多个块，便于在流中途取消
    const iterator = provider
      .stream({ content: 'x'.repeat(200) }, { signal: controller.signal })
      [Symbol.asyncIterator]();

    await iterator.next();
    controller.abort();

    await expect(iterator.next()).rejects.toBeInstanceOf(AiError);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    // 进入流之前 signal 已 abort：不应挂起等待，应立刻抛出可重试错误
    const provider = new MockAiProvider({ streamChunkDelayMs: 1000 });
    const controller = new AbortController();
    controller.abort();

    const iterator = provider
      .stream({ content: '提前取消' }, { signal: controller.signal })
      [Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toThrow(/aborted/i);
  });

  it('does not hang when delaying chunks without a cancel signal', async () => {
    // 有块间延迟但未传 signal：sleep 应跳过信号监听，正常产出全部块
    const provider = new MockAiProvider({ streamChunkDelayMs: 5 });
    const chunks: string[] = [];
    for await (const chunk of provider.stream({ content: '无信号延迟' }, {})) {
      chunks.push(chunk);
    }

    expect(chunks.join('')).toContain('无信号延迟');
  });

  it('rejects when the signal is aborted during the simulated delay', async () => {
    // 模拟延迟期间被取消：sleep 的信号监听应主动中断等待并抛出 AI_ABORTED
    const provider = new MockAiProvider({ delayMs: 50 });
    const controller = new AbortController();
    const promise = provider.generate({ content: '慢请求' }, { signal: controller.signal });

    setTimeout(() => controller.abort(), 5);

    await expect(promise).rejects.toMatchObject({ code: 'AI_ABORTED', retryable: true });
  });

  it('returns one of the fixed random replies in random mode', async () => {
    // random 模式：回复必须来自预设话术库，而不是回显用户输入
    const RANDOM_REPLIES = [
      '这个想法很有意思，能展开讲讲吗？',
      '收到！让我想想怎么帮你。',
      '嗯嗯，我在听，继续说～',
      '好的，已记录。这是一条模拟回复。',
    ];
    const provider = new MockAiProvider({ mode: 'random' });

    for (let i = 0; i < 20; i += 1) {
      const result = await provider.generate({ content: '任意输入' });
      expect(RANDOM_REPLIES).toContain(result.content);
    }
  });
});
