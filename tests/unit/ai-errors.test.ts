/**
 * AI 错误归一化工具单元测试
 *
 * 覆盖：
 * - isRetryableError：仅对「AiError 且 retryable=true」返回 true；
 * - toAiErrorInfo：AiError 透出 code/message；未知错误统一归一化为
 *   AI_UNKNOWN_ERROR（避免把任意异常细节写入消息表）。
 */
import { describe, expect, it } from 'vitest';

import { AiError, isRetryableError, toAiErrorInfo } from '../../src/services/ai/errors.js';

describe('isRetryableError', () => {
  it('returns false for non-AiError values', () => {
    expect(isRetryableError(new Error('boom'))).toBe(false);
    expect(isRetryableError('string')).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
  });

  it('returns true only for AiError with retryable flag', () => {
    expect(isRetryableError(new AiError('超时', 'AI_TIMEOUT', true))).toBe(true);
    expect(isRetryableError(new AiError('参数错', 'AI_INVALID_REQUEST', false))).toBe(false);
  });
});

describe('toAiErrorInfo', () => {
  it('maps AiError to its code and message', () => {
    expect(toAiErrorInfo(new AiError('模型限流', 'AI_RATE_LIMITED', true))).toEqual({
      code: 'AI_RATE_LIMITED',
      message: '模型限流',
    });
  });

  it('maps unknown errors to AI_UNKNOWN_ERROR', () => {
    expect(toAiErrorInfo(new Error('boom'))).toEqual({
      code: 'AI_UNKNOWN_ERROR',
      message: 'boom',
    });
    expect(toAiErrorInfo('just-a-string')).toEqual({
      code: 'AI_UNKNOWN_ERROR',
      message: 'Unknown AI error',
    });
  });
});
