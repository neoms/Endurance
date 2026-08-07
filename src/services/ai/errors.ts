/**
 * AI 调用错误模型
 *
 * 【设计说明】
 * retryable 标记决定 AiService 是否对该错误进行重试：
 * - true：超时、网络错误、上游 5xx 等可重试错误；
 * - false：4xx 等不可重试错误（重试无意义，直接终止）。
 */

/**
 * AI 调用错误
 *
 * @param message   错误描述
 * @param code      错误码（如 AI_TIMEOUT / AI_UNAVAILABLE），持久化到 FAILED 消息
 * @param retryable 是否可重试
 */
export class AiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

/**
 * 判断错误是否可重试
 *
 * @param err 任意错误
 * @returns boolean 仅 AiError 且 retryable=true 时返回 true
 */
export function isRetryableError(err: unknown): boolean {
  return err instanceof AiError && err.retryable;
}

/**
 * 将任意错误规范化为可持久化的错误信息
 *
 * @param err 任意错误
 * @returns { code, message } 用于写入 FAILED 消息的 errorCode / errorMessage
 */
export function toAiErrorInfo(err: unknown): { code: string; message: string } {
  if (err instanceof AiError) {
    return { code: err.code, message: err.message };
  }
  return {
    code: 'AI_UNKNOWN_ERROR',
    message: err instanceof Error ? err.message : 'Unknown AI error',
  };
}
