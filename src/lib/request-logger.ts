/**
 * 请求日志中间件（自研，替代 pino-http）
 *
 * 【模块职责】
 * 为每个请求输出一行结构化摘要日志，并建立请求级上下文（AsyncLocalStorage）：
 * - **请求 id**：UUID 全局唯一（多实例不冲突），同时写入 req.id 与日志上下文，
 *   业务日志据此与请求日志关联；
 * - **状态分层**：5xx → error（需要关注）；4xx → warn（业务/客户端问题）；
 *   其余 → info；
 * - **采样降噪**：成功请求（<400）按采样率记录（生产高流量调低，如 0.1），
 *   4xx/5xx 始终全量——问题日志不因采样而丢失；
 * - **慢请求标记**：超过 SLOW_REQUEST_THRESHOLD_MS 时标记 slow: true，
 *   便于快速发现性能劣化（慢请求采样率为 1，即始终记录）；
 * - **响应耗时**：responseTime 毫秒，供延迟分析与告警。
 *
 * 【为什么不直接用 pino-http】
 * 需要采样、慢请求标记、按状态分层三项能力；pino-http 的自动日志
 * 不支持按请求采样，自研约 60 行即可实现且无额外依赖。
 */
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

import { logger } from './logger.js';
import { runWithLogContext } from './log-context.js';

/**
 * 请求日志中间件选项
 *
 * @property slowThresholdMs 慢请求阈值（毫秒），超过标记 slow: true（默认 2000）
 * @property sampleRate      成功请求（<400）采样率 0-1（默认 1 全量；
 *                           生产高流量建议调低，4xx/5xx 不受采样影响）
 */
export interface RequestLoggerOptions {
  slowThresholdMs?: number;
  sampleRate?: number;
}

/**
 * 创建请求日志中间件
 *
 * @param options 阈值与采样配置（缺省取环境变量）
 * @returns Express 中间件：生成请求 id → 建立日志上下文 → 响应结束时输出摘要日志
 * 说明：slow 请求不受采样率影响（总是记录），保证性能问题不丢日志。
 */
export function requestLogger(
  options: RequestLoggerOptions = {},
): (req: Request, res: Response, next: NextFunction) => void {
  const slowThresholdMs = options.slowThresholdMs ?? 2000;
  const sampleRate = Math.min(1, Math.max(0, options.sampleRate ?? 1));

  return (req, res, next) => {
    // 生成请求 id（UUID）：pino-http 已移除，这里统一负责；
    // 重复调用（如测试注入）时保留已有 id
    req.id = req.id ?? randomUUID();

    const start = process.hrtime.bigint();
    // 响应结束时输出摘要日志（finish 事件始终触发，包括错误响应）
    res.on('finish', () => {
      const responseTime = Math.round((Number(process.hrtime.bigint() - start) / 1e6) * 10) / 10;
      const statusCode = res.statusCode;
      const slow = responseTime >= slowThresholdMs;

      // 采样：成功请求（<400）按采样率记录；4xx/5xx 与慢请求始终全量
      if (statusCode < 400 && !slow && Math.random() >= sampleRate) {
        return;
      }

      // 状态分层：5xx error / 4xx warn / 其余 info
      const level: 'info' | 'warn' | 'error' =
        statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';
      const payload = {
        req: { id: req.id, method: req.method, url: req.url },
        res: { statusCode },
        responseTime,
        ...(slow ? { slow: true } : {}),
      };
      if (level === 'error') {
        logger.error(payload, 'request completed');
      } else if (level === 'warn') {
        logger.warn(payload, 'request completed');
      } else {
        logger.info(payload, 'request completed');
      }
    });

    // 建立请求级日志上下文：请求处理链（含后续所有异步调用）都能读到 requestId
    return runWithLogContext({ requestId: req.id }, next);
  };
}
