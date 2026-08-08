/**
 * AI 调用服务：统一封装重试、超时与错误分类
 *
 * 【健壮性设计】
 * - 总尝试次数 = maxRetries + 1（默认 3 次，即首次 + 2 次重试）；
 * - 指数退避（300ms → 600ms …）并附加随机抖动，避免重试风暴；
 * - 每个请求通过 withTimeout 强制超时（默认 10s）：超时触发 AbortController.abort()
 *   真正取消底层调用（Provider 应监听 signal 尽快中断），同时按可重试错误处理；
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
