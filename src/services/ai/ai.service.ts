/**
 * AI 调用服务：统一封装重试、超时与错误分类
 *
 * 【健壮性设计】
 * - 总尝试次数 = maxRetries + 1（默认 3 次，即首次 + 2 次重试）；
 * - 指数退避（300ms → 600ms …）并附加随机抖动，避免重试风暴；
 * - 每个请求通过 withTimeout 强制超时（默认 10s）：超时触发 AbortController.abort()
 *   真正取消底层调用（Provider 应监听 signal 尽快中断），同时按可重试错误处理；
 * - 流式场景（streamWithRetry）：超时语义改为「空闲超时」——只要还在持续产出
 *   文本就不算超时，停止产出超过阈值才 abort（长回复不会被一刀切）；
 * - 流式重试只发生在「一个字符都没产出之前」：一旦已经向调用方产出过内容，
 *   中途失败直接抛出，避免重试后把重复内容拼接进回复；
 * - 仅对可重试错误（超时/网络/5xx 类）重试，4xx 直接终止；
 * - 每次失败与重试均记录结构化日志（attempt、延迟、错误），便于问题排查。
 */
import { logger } from '../../lib/logger.js';
import { AiError, isRetryableError } from './errors.js';
import type { AiGenerateContext, AiProvider, AiRetryOptions } from './types.js';

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_TIMEOUT_MS = 10_000;
const BASE_RETRY_DELAY_MS = 300;

export class AiService {
  constructor(private readonly provider: AiProvider) {}

  /**
   * 带重试的 AI 生成
   *
   * @param context 生成上下文（用户消息、可选历史等）
   * @param options 重试策略（maxRetries / timeoutMs / baseRetryDelayMs）
   * @returns Promise<string> 最终回复文本
   * @throws 重试耗尽后抛出最后一次错误（由调用方转为 FAILED 消息落库）
   * 主要逻辑：循环尝试 → 超时包装 → 成功即返回；
   * 失败按可重试性决定继续重试或终止，重试前指数退避 + 抖动。
   */
  async generateWithRetry(
    context: AiGenerateContext,
    options: AiRetryOptions = {},
  ): Promise<string> {
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const baseDelay = options.baseRetryDelayMs ?? BASE_RETRY_DELAY_MS;

    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        // 统一超时包装：底层 Provider 超时未返回也按 AI_TIMEOUT 处理
        // 统一超时包装：把 AbortSignal 传给 Provider，超时后真正取消底层调用
        const result = await withTimeout(
          (signal) => this.provider.generate(context, { timeoutMs, signal }),
          timeoutMs,
        );
        logger.debug({ provider: this.provider.name, attempt }, 'ai: generation succeeded');
        return result.content;
      } catch (err) {
        lastError = err;
        // 不可重试错误直接终止，不再浪费重试次数
        if (!isRetryableError(err)) {
          logger.warn({ attempt, err }, 'ai: non-retryable failure');
          break;
        }
        // 指数退避 + 随机抖动后重试（最多 100ms 抖动，错开并发重试）
        if (attempt < maxRetries) {
          const delay = baseDelay * 2 ** attempt + Math.random() * 100;
          logger.warn(
            { attempt, delayMs: Math.round(delay) },
            'ai: retryable failure, scheduling retry',
          );
          await sleep(delay);
        }
      }
    }
    // 重试耗尽：把最后一次错误抛给上层（由消息服务转为 FAILED 落库）
    throw lastError;
  }

  /**
   * 带重试的流式 AI 生成
   *
   * @param context 生成上下文（与 generateWithRetry 一致）
   * @param options 重试策略 + 可选的 clientSignal（客户端断连时中止底层调用）
   * @returns AsyncGenerator<string> 逐块产出回复文本
   * @throws 重试耗尽后抛出最后一次错误；已经产出过内容时中途失败立即抛出（不重试）
   *
   * 主要逻辑：
   * 1. Provider 实现了 stream → 以空闲超时 + 取消信号包装后逐块产出；
   * 2. Provider 未实现 stream → 退化为一次性 generateWithRetry，整段作为单块产出；
   * 3. 每次尝试前新建 AbortController，外部 clientSignal abort 时同步取消本次尝试；
   * 4. 空闲超时：每次产出新块都重置计时器，停止产出超过 timeoutMs 视为超时；
   * 5. 首块之前失败 → 按重试策略退避重试；首块之后失败 → 立即抛出。
   */
  async *streamWithRetry(
    context: AiGenerateContext,
    options: AiRetryOptions & { clientSignal?: AbortSignal } = {},
  ): AsyncGenerator<string> {
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const baseDelay = options.baseRetryDelayMs ?? BASE_RETRY_DELAY_MS;

    let attempt = 0;
    // 记录是否已向调用方产出过内容：产出后再失败不允许重试（避免重复拼接）
    let yieldedAny = false;

    while (attempt <= maxRetries) {
      // 每次尝试独立取消信号：空闲超时 abort 只影响本次尝试
      const controller = new AbortController();
      const onClientAbort = () => controller.abort();
      const clientSignal = options.clientSignal;
      if (clientSignal) {
        if (clientSignal.aborted) {
          controller.abort();
        } else {
          clientSignal.addEventListener('abort', onClientAbort, { once: true });
        }
      }

      try {
        const providerStream = this.provider.stream;
        if (!providerStream) {
          // Provider 未实现流式（未来新增 Provider 的兜底）：退化为一次性生成
          const content = await this.generateWithRetry(context, options);
          yield content;
          return;
        }

        // 空闲超时包装：每产出新块重置计时器；计时器触发则 abort 本次尝试
        const source = withIdleTimeout(
          () => providerStream.call(this.provider, context, { signal: controller.signal }),
          timeoutMs,
          controller,
        );
        for await (const chunk of source) {
          yieldedAny = true;
          yield chunk;
        }
        return;
      } catch (err) {
        // 客户端断连：立即终止，不做无意义重试
        if (clientSignal?.aborted) {
          throw new AiError('AI request cancelled by client', 'AI_ABORTED', true);
        }

        // 空闲超时归一化：本次尝试的 controller 被 abort 且非客户端取消 → AI_TIMEOUT
        const idleTimeout = controller.signal.aborted && !clientSignal?.aborted;
        const normalized =
          idleTimeout && !(err instanceof AiError && err.code === 'AI_TIMEOUT')
            ? new AiError('AI stream idle timeout', 'AI_TIMEOUT', true)
            : err;

        // 已产出内容后失败：无法安全重试（会重复拼接），立即抛出
        if (yieldedAny) {
          throw normalized;
        }
        // 不可重试错误（4xx 等）直接终止
        if (!isRetryableError(normalized)) {
          throw normalized;
        }
        // 重试次数耗尽：抛出最后一次错误（由消息服务转为 FAILED 落库）
        if (attempt >= maxRetries) {
          throw normalized;
        }
        // 指数退避 + 随机抖动后进入下一次尝试
        const delay = baseDelay * 2 ** attempt + Math.random() * 100;
        logger.warn(
          { attempt, delayMs: Math.round(delay), provider: this.provider.name },
          'ai: stream retryable failure, scheduling retry',
        );
        await sleep(delay);
      } finally {
        clientSignal?.removeEventListener('abort', onClientAbort);
      }
      attempt += 1;
    }
  }
}

/**
 * 空闲超时包装：把异步迭代器包装成「停止产出超过阈值即失败」的流
 *
 * @param create    创建异步迭代器的工厂（每次调用创建新的底层流）
 * @param timeoutMs 空闲阈值（毫秒）：距上次产出超过该时长则 abort
 * @param controller 本次尝试的取消控制器（超时触发 abort，由调用方监听结果）
 * @returns AsyncGenerator<string> 透传底层流的文本块
 * 说明：计时器每次产出新块都会重置；底层流因 abort 抛出的错误原样向上传播，
 * 由 streamWithRetry 统一归类（空闲超时 → AI_TIMEOUT）。
 */
async function* withIdleTimeout(
  create: () => AsyncIterable<string>,
  timeoutMs: number,
  controller: AbortController,
): AsyncGenerator<string> {
  let timer: NodeJS.Timeout | undefined;

  // 重置空闲计时器：触发时 abort 本次尝试（底层 fetch 监听 signal 立即中断）
  const resetTimer = () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => controller.abort(), timeoutMs);
  };

  resetTimer();
  try {
    for await (const chunk of create()) {
      resetTimer();
      yield chunk;
    }
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * 超时包装
 *
 * @param call      接收 AbortSignal 的底层调用工厂
 * @param timeoutMs 超时阈值（毫秒）
 * @returns Promise<T> 结果；超时则以 AI_TIMEOUT（可重试）拒绝
 * 说明：超时后立即 abort 底层调用（Provider 应监听 signal 中断），
 * 同时通过 Promise 竞速兜底：即使 Provider 不监听 signal 也不会挂起，
 * 只会忽略迟到的结果（不会产生未处理拒绝）。
 */
function withTimeout<T>(call: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new AiError('AI request timed out', 'AI_TIMEOUT', true));
    }, timeoutMs);
    call(controller.signal).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * 延时工具
 *
 * @param ms 毫秒数
 * @returns Promise<void> 到点后 resolve
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
