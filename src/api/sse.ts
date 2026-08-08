/**
 * SSE（Server-Sent Events）响应辅助模块
 *
 * 【模块职责】
 * 统一聊天消息流式接口的 SSE 帧写入：
 * - startSse：设置响应头并 flushHeaders（必须在写入任何数据前调用，
 *   否则 Express 会把响应当作普通 JSON 一次性返回）；
 * - sendSseEvent：写入一个标准 SSE 帧（event + data），返回是否写入成功；
 * - sendSseError：把业务错误（AppError）包装为 error 事件并结束响应。
 *
 * 【帧格式】
 * event: <事件名>
 * data: <JSON 字符串>
 * （空行分隔）
 */
import type { Response } from 'express';

import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

/**
 * 初始化 SSE 响应头
 *
 * @param res Express 响应对象
 * 说明：
 * - Content-Type 必须是 text/event-stream，浏览器 fetch 才能按流读取；
 * - Cache-Control: no-cache 防止代理/浏览器缓存整个流；
 * - X-Accel-Buffering: no 告诉 nginx 等反向代理不要缓冲；
 * - flushHeaders 立即把响应头发给客户端（否则会等第一个事件才发送）。
 */
export function startSse(res: Response): void {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

/**
 * 写入一个 SSE 帧
 *
 * @param res   Express 响应对象
 * @param event 事件名（前端按事件名分发）
 * @param data  事件数据（会被 JSON 序列化）
 * @returns boolean 是否真正写入（false 表示响应已结束/连接已断开，调用方可停止后续写入）
 */
export function sendSseEvent(res: Response, event: string, data: unknown): boolean {
  // 客户端已断连或响应已结束：不能再写，返回 false 让上层尽早停止
  if (res.writableEnded || res.destroyed) {
    return false;
  }
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
  return true;
}

/**
 * 把业务错误包装为 SSE error 事件并结束响应
 *
 * @param res   Express 响应对象
 * @param err   捕获到的错误（AppError 透出业务 code/message；其余归为 INTERNAL_ERROR）
 * 说明：SSE 场景下响应头已发出（HTTP 200），无法再改状态码，
 * 因此错误统一以 error 事件承载，前端按事件处理而不是 HTTP 状态。
 */
export function sendSseError(res: Response, err: unknown): void {
  if (res.writableEnded || res.destroyed) {
    return;
  }
  if (err instanceof AppError) {
    logger.warn({ code: err.code, message: err.message }, 'sse: business error event');
    sendSseEvent(res, 'error', {
      error: { code: err.code, message: err.message, details: err.details },
    });
  } else {
    logger.error({ err }, 'sse: unexpected error event');
    sendSseEvent(res, 'error', {
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  }
  res.end();
}
