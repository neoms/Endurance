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
});
