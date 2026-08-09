/**
 * SSE 辅助模块单元测试
 *
 * 覆盖：
 * - startSse 正确设置事件流响应头并 flushHeaders；
 * - sendSseEvent 写出标准 SSE 帧并返回 true；
 * - 响应已结束 / 连接已销毁时 sendSseEvent 返回 false（不再写入）；
 * - sendSseError 对 AppError 透出业务 code/message/details；
 * - sendSseError 对未知错误统一返回 INTERNAL_ERROR（避免泄露内部信息）；
 * - 响应已结束时 sendSseError 直接返回（不抛错）。
 */
import type { Response } from 'express';
import { describe, expect, it } from 'vitest';

import { sendSseError, sendSseEvent, startSse } from '../../src/api/sse.js';
import { AppError } from '../../src/lib/errors.js';

/**
 * 最小可用的 Express Response 替身（记录调用痕迹）
 *
 * 说明：sse.ts 只依赖 status/setHeader/flushHeaders/write/end 与
 * writableEnded/destroyed 两个只读属性，用对象替身即可隔离测试，
 * 无需真正启动 HTTP 服务。
 */
interface FakeRes {
  statusCode: number;
  headers: Record<string, string>;
  chunks: string[];
  flushed: boolean;
  writableEnded: boolean;
  destroyed: boolean;
  status(code: number): FakeRes;
  setHeader(key: string, value: string): FakeRes;
  flushHeaders(): void;
  write(chunk: string): boolean;
  end(): void;
}

/**
 * 构造假 Response
 *
 * @param overrides 可覆盖 writableEnded/destroyed 等状态，模拟连接断开场景
 * @returns FakeRes 假响应对象
 */
function makeFakeRes(overrides: Partial<FakeRes> = {}): FakeRes {
  const res: FakeRes = {
    statusCode: 200,
    headers: {},
    chunks: [],
    flushed: false,
    writableEnded: false,
    destroyed: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    setHeader(key: string, value: string) {
      this.headers[key] = value;
      return this;
    },
    flushHeaders() {
      this.flushed = true;
    },
    write(chunk: string) {
      this.chunks.push(chunk);
      return true;
    },
    end() {
      this.writableEnded = true;
    },
    ...overrides,
  };
  return res;
}

describe('startSse', () => {
  it('sets event-stream headers and flushes them immediately', () => {
    const res = makeFakeRes();
    startSse(res as unknown as Response);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('text/event-stream; charset=utf-8');
    expect(res.headers['Cache-Control']).toBe('no-cache, no-transform');
    expect(res.headers['Connection']).toBe('keep-alive');
    expect(res.headers['X-Accel-Buffering']).toBe('no');
    expect(res.flushed).toBe(true);
  });
});

describe('sendSseEvent', () => {
  it('writes a standard SSE frame and returns true', () => {
    const res = makeFakeRes();
    const ok = sendSseEvent(res as unknown as Response, 'bot_delta', { text: '你好' });

    expect(ok).toBe(true);
    expect(res.chunks.join('')).toBe('event: bot_delta\ndata: {"text":"你好"}\n\n');
  });

  it('returns false without writing when the response has ended', () => {
    const res = makeFakeRes({ writableEnded: true });
    expect(sendSseEvent(res as unknown as Response, 'x', {})).toBe(false);
    expect(res.chunks).toHaveLength(0);
  });

  it('returns false without writing when the connection is destroyed', () => {
    const res = makeFakeRes({ destroyed: true });
    expect(sendSseEvent(res as unknown as Response, 'x', {})).toBe(false);
    expect(res.chunks).toHaveLength(0);
  });
});

describe('sendSseError', () => {
  it('emits business error details for AppError and ends the response', () => {
    const res = makeFakeRes();
    sendSseError(
      res as unknown as Response,
      new AppError(429, 'RATE_LIMITED', '请求过于频繁', { retryAfter: 10 }),
    );

    expect(res.writableEnded).toBe(true);
    const payload = JSON.parse(res.chunks.join('').split('data: ')[1]!) as {
      error: { code: string; message: string; details: unknown };
    };
    expect(payload.error.code).toBe('RATE_LIMITED');
    expect(payload.error.message).toBe('请求过于频繁');
    expect(payload.error.details).toEqual({ retryAfter: 10 });
  });

  it('masks unknown errors as INTERNAL_ERROR without leaking details', () => {
    const res = makeFakeRes();
    sendSseError(res as unknown as Response, new Error('数据库连接字符串泄露'));

    expect(res.writableEnded).toBe(true);
    const payload = JSON.parse(res.chunks.join('').split('data: ')[1]!) as {
      error: { code: string; message: string };
    };
    expect(payload.error.code).toBe('INTERNAL_ERROR');
    expect(payload.error.message).toBe('Internal server error');
    expect(res.chunks.join('')).not.toContain('数据库连接字符串泄露');
  });

  it('does nothing when the response has already ended', () => {
    const res = makeFakeRes({ writableEnded: true });
    expect(() => sendSseError(res as unknown as Response, new Error('boom'))).not.toThrow();
    expect(res.chunks).toHaveLength(0);
  });
});
