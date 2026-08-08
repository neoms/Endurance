/**
 * AiService 重试逻辑单元测试（使用可控制失败次数/时延的 FakeProvider）
 *
 * 覆盖：
 * - 首次调用即成功；
 * - 可重试错误按配置重试并最终成功；
 * - 重试耗尽后抛出最后一次错误；
 * - 不可重试错误不重试；
 * - 慢 Provider 触发超时并按可重试错误重试；
 * - 超时通过 AbortSignal 真正取消底层 Provider 调用。
 */
import { describe, expect, it } from 'vitest';

import { AiService } from '../../src/services/ai/ai.service.js';
import { AiError } from '../../src/services/ai/errors.js';
import type {
  AiGenerateContext,
  AiGenerateOptions,
  AiGenerateResult,
  AiProvider,
} from '../../src/services/ai/types.js';

/**
 * 可控失败的 Fake Provider（测试专用）
 *
 * @param failCount     前 N 次调用失败
 * @param failRetryable 失败是否标记为可重试
 * @param delayMs       失败时的模拟延迟（毫秒）
 */
class FakeProvider implements AiProvider {
  readonly name = 'fake';
  calls = 0;

  constructor(
    private readonly failCount: number,
    private readonly failRetryable = true,
    private readonly delayMs = 0,
  ) {}

  async generate(_context: AiGenerateContext): Promise<AiGenerateResult> {
    this.calls += 1;
    if (this.calls <= this.failCount) {
      if (this.delayMs) {
        await sleep(this.delayMs);
      }
      throw new AiError('fake failure', 'AI_UNAVAILABLE', this.failRetryable);
    }
    return { content: `reply-${this.calls}` };
  }
}

/**
 * 延时工具（测试用）
 *
 * @param ms 毫秒数
 * @returns Promise<void>
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 监听 AbortSignal 的 Provider（验证超时会真正取消底层调用）
 */
class AbortAwareProvider implements AiProvider {
  readonly name = 'abort-aware';
  aborted = false;

  async generate(
    _context: AiGenerateContext,
    options?: AiGenerateOptions,
  ): Promise<AiGenerateResult> {
    return new Promise<AiGenerateResult>((_resolve, reject) => {
      if (!options?.signal) {
        return; // 未提供 signal：永不结束（由超时竞速兜底，正常路径总会提供）
      }
      const onAbort = () => {
        this.aborted = true;
        reject(new AiError('aborted', 'AI_ABORTED', true));
      };
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

describe('AiService.generateWithRetry', () => {
  it('succeeds on the first attempt', async () => {
    const provider = new FakeProvider(0);
    const service = new AiService(provider);

    await expect(service.generateWithRetry({ content: 'hi' })).resolves.toBe('reply-1');
    expect(provider.calls).toBe(1);
  });

  it('retries retryable failures and eventually succeeds', async () => {
    const provider = new FakeProvider(2);
    const service = new AiService(provider);

    await expect(
      service.generateWithRetry({ content: 'hi' }, { maxRetries: 2, baseRetryDelayMs: 1 }),
    ).resolves.toBe('reply-3');
    expect(provider.calls).toBe(3);
  });

  it('gives up after exhausting retries', async () => {
    const provider = new FakeProvider(5);
    const service = new AiService(provider);

    await expect(
      service.generateWithRetry({ content: 'hi' }, { maxRetries: 2, baseRetryDelayMs: 1 }),
    ).rejects.toBeInstanceOf(AiError);
    expect(provider.calls).toBe(3);
  });

  it('does not retry non-retryable errors', async () => {
    const provider = new FakeProvider(1, false);
    const service = new AiService(provider);

    await expect(
      service.generateWithRetry({ content: 'hi' }, { maxRetries: 2, baseRetryDelayMs: 1 }),
    ).rejects.toBeInstanceOf(AiError);
    expect(provider.calls).toBe(1);
  });

  it('times out a slow provider and retries', async () => {
    const provider = new FakeProvider(1, true, 200);
    const service = new AiService(provider);

    await expect(
      service.generateWithRetry(
        { content: 'hi' },
        { maxRetries: 1, timeoutMs: 20, baseRetryDelayMs: 1 },
      ),
    ).resolves.toBe('reply-2');
    expect(provider.calls).toBe(2);
  });

  it('aborts the underlying provider call on timeout', async () => {
    const provider = new AbortAwareProvider();
    const service = new AiService(provider);

    await expect(
      service.generateWithRetry({ content: 'hi' }, { maxRetries: 0, timeoutMs: 20 }),
    ).rejects.toMatchObject({ code: 'AI_TIMEOUT' });
    // 超时后 signal 已 abort，Provider 应感知到取消
    expect(provider.aborted).toBe(true);
  });
});
