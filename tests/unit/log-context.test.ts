/**
 * 请求日志上下文单元测试
 *
 * 覆盖：
 * - runWithLogContext 内可读取 requestId；
 * - logMixin 把上下文注入为日志字段（requestId / userId）；
 * - setContextUserId 写入后 userId 出现在后续日志字段；
 * - 非请求处理期间 mixin 返回空对象；
 * - 嵌套上下文结束后恢复外层上下文（不串扰）。
 */
import { describe, expect, it } from 'vitest';

import { getLogContext, runWithLogContext, setContextUserId } from '../../src/lib/log-context.js';
import { logMixin } from '../../src/lib/logger.js';

describe('log context (AsyncLocalStorage)', () => {
  it('exposes requestId inside the run scope', () => {
    runWithLogContext({ requestId: 'req-1' }, () => {
      expect(getLogContext()).toEqual({ requestId: 'req-1' });
    });
  });

  it('injects requestId into log fields via logMixin', () => {
    runWithLogContext({ requestId: 'req-1' }, () => {
      expect(logMixin()).toEqual({ requestId: 'req-1' });
    });
  });

  it('injects userId after setContextUserId', () => {
    runWithLogContext({ requestId: 'req-1' }, () => {
      setContextUserId('user-1');
      expect(logMixin()).toEqual({ requestId: 'req-1', userId: 'user-1' });
    });
  });

  it('returns an empty object outside a request scope', () => {
    expect(logMixin()).toEqual({});
  });

  it('restores the outer context after an inner scope ends', () => {
    runWithLogContext({ requestId: 'outer' }, () => {
      runWithLogContext({ requestId: 'inner' }, () => {
        expect(getLogContext()?.requestId).toBe('inner');
      });
      expect(getLogContext()?.requestId).toBe('outer');
    });
  });
});
