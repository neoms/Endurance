/**
 * AiService 重试逻辑单元测试（使用可控制失败次数/时延的 FakeProvider）
 *
 * 覆盖：
 * - 首次调用即成功；
 * - 可重试错误按配置重试并最终成功；
 * - 重试耗尽后抛出最后一次错误；
 * - 不可重试错误不重试；
 * - 慢 Provider 触发超时并按可重试错误重试；
 * - 超时通过 AbortSignal 真正取消底层 Provider 调用；
 * - streamWithRetry：首块前失败可重试、首块后失败不重试、
 *   空闲超时中止、客户端断连中止。
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

/**
 * 流式 Fake Provider（测试 streamWithRetry）
 *
 * @param failBeforeFirstChunk 前 N 次尝试在产出任何内容前失败
 * @param failAfterFirstChunk  首块产出后立即失败（用于验证「已产出则不重试」）
 */
class StreamFakeProvider implements AiProvider {
  readonly name = 'stream-fake';
  calls = 0;

  constructor(
    private readonly failBeforeFirstChunk: number,
    private readonly failAfterFirstChunk = false,
  ) {}

  async *stream(_context: AiGenerateContext, _options?: AiGenerateOptions): AsyncIterable<string> {
    this.calls += 1;
    if (this.calls <= this.failBeforeFirstChunk) {
      throw new AiError('stream fail before first chunk', 'AI_UNAVAILABLE', true);
    }
    yield '第一段';
    if (this.failAfterFirstChunk) {
      throw new AiError('stream fail after first chunk', 'AI_UNAVAILABLE', true);
    }
    yield '第二段';
    yield '第三段';
  }

  // 流式测试不使用一次性生成接口，占位即可（永不走到）
  async generate(): Promise<AiGenerateResult> {
    throw new Error('generate is not used in stream tests');
  }
}

/**
 * 空闲挂起 Provider：产出首块后不再产出，直到 signal 中止
 * （用于验证 AiService 的空闲超时会主动 abort 底层流）
 */
class HangingStreamProvider implements AiProvider {
  readonly name = 'hanging-stream';

  async *stream(_context: AiGenerateContext, options?: AiGenerateOptions): AsyncIterable<string> {
    yield '开头';
    // 挂起等待：只有 signal 被 abort（空闲超时/客户端断连）才会结束
    await new Promise<void>((_resolve, reject) => {
      if (options?.signal?.aborted) {
        reject(new AiError('aborted', 'AI_ABORTED', true));
        return;
      }
      options?.signal?.addEventListener(
        'abort',
        () => reject(new AiError('aborted', 'AI_ABORTED', true)),
        { once: true },
      );
    });
  }

  // 流式测试不使用一次性生成接口，占位即可（永不走到）
  async generate(): Promise<AiGenerateResult> {
    throw new Error('generate is not used in stream tests');
  }
}

/**
 * 慢速流式 Provider：每次产出之间有小延迟，配合客户端断连测试
 */
class SlowStreamProvider implements AiProvider {
  readonly name = 'slow-stream';

  async *stream(_context: AiGenerateContext, options?: AiGenerateOptions): AsyncIterable<string> {
    for (let i = 0; i < 100; i += 1) {
      if (options?.signal?.aborted) {
        throw new AiError('aborted', 'AI_ABORTED', true);
      }
      yield `块${i}`;
      await sleep(10);
    }
  }

  // 流式测试不使用一次性生成接口，占位即可（永不走到）
  async generate(): Promise<AiGenerateResult> {
    throw new Error('generate is not used in stream tests');
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

describe('AiService.streamWithRetry', () => {
  it('streams all chunks from the provider', async () => {
    const service = new AiService(new StreamFakeProvider(0));

    const chunks: string[] = [];
    for await (const chunk of service.streamWithRetry({ content: 'hi' })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(['第一段', '第二段', '第三段']);
  });

  it('retries failures that happen before the first chunk', async () => {
    const provider = new StreamFakeProvider(2);
    const service = new AiService(provider);

    const chunks: string[] = [];
    for await (const chunk of service.streamWithRetry(
      { content: 'hi' },
      { maxRetries: 2, baseRetryDelayMs: 1 },
    )) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(['第一段', '第二段', '第三段']);
    expect(provider.calls).toBe(3);
  });

  it('does not retry after content has already been yielded', async () => {
    const provider = new StreamFakeProvider(0, true);
    const service = new AiService(provider);

    const chunks: string[] = [];
    await expect(async () => {
      for await (const chunk of service.streamWithRetry(
        { content: 'hi' },
        { maxRetries: 2, baseRetryDelayMs: 1 },
      )) {
        chunks.push(chunk);
      }
    }).rejects.toMatchObject({ code: 'AI_UNAVAILABLE', retryable: true });

    // 已产出内容后失败：不重试（重试会重复拼接首段），调用次数保持 1
    expect(chunks).toEqual(['第一段']);
    expect(provider.calls).toBe(1);
  });

  it('aborts the stream on idle timeout after yielding content', async () => {
    const service = new AiService(new HangingStreamProvider());

    const chunks: string[] = [];
    await expect(async () => {
      for await (const chunk of service.streamWithRetry(
        { content: 'hi' },
        { maxRetries: 0, timeoutMs: 30 },
      )) {
        chunks.push(chunk);
      }
    }).rejects.toMatchObject({ code: 'AI_TIMEOUT', retryable: true });

    // 首块已产出，空闲超时后立即失败且不再重试
    expect(chunks).toEqual(['开头']);
  });

  it('stops immediately when the client signal aborts mid-stream', async () => {
    const service = new AiService(new SlowStreamProvider());
    const controller = new AbortController();

    const chunks: string[] = [];
    await expect(
      (async () => {
        for await (const chunk of service.streamWithRetry(
          { content: 'hi' },
          { clientSignal: controller.signal },
        )) {
          chunks.push(chunk);
          // 收到两个块后模拟客户端断连
          if (chunks.length === 2) {
            controller.abort();
          }
        }
      })(),
    ).rejects.toMatchObject({ code: 'AI_ABORTED', retryable: true });

    expect(chunks).toHaveLength(2);
  });
});
