/**
 * 统一错误处理模块
 *
 * 【模块职责】
 * 1. AppError：业务错误的载体（HTTP 状态码 + 业务错误码 + 提示信息），由服务层抛出；
 * 2. notFoundHandler：未匹配任何路由的请求统一返回 404；
 * 3. errorHandler：全局兜底错误中间件，把所有错误归一为一致的结构化响应：
 *    `{ error: { code, message, details? } }`，前端可据此稳定解析错误。
 *
 * 【设计说明】
 * - 对外不泄露内部实现细节（未知错误统一返回 500 通用信息）；
 * - 未知错误会记录完整错误对象与请求信息，便于复现与排查；
 * - 校验错误（ZodError）返回 422 并附带具体校验问题，方便前端定位入参问题。
 */
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';

import { logger } from './logger.js';

/**
 * 业务错误类
 *
 * @param statusCode HTTP 状态码（如 400/401/403/404/409）
 * @param code       业务错误码（如 USERNAME_TAKEN），前端可据此做精确分支
 * @param message    面向用户的错误描述
 * @param details    可选的补充信息（如校验失败的字段明细）
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

/**
 * 未匹配路由兜底
 *
 * @param req Express 请求对象（用于获取方法与路径）
 * @param res Express 响应对象
 * @returns 统一返回 404 与 NOT_FOUND 错误码
 */
export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found` },
  });
};

/**
 * 全局错误处理中间件（必须保持 4 个参数签名，Express 才识别为错误中间件）
 *
 * @param err    被抛出的任意错误（AppError / ZodError / 未知错误）
 * @param req    Express 请求对象（记录请求信息用于排查）
 * @param res    Express 响应对象
 * @param _next  下一个中间件（此处不使用，但签名必须保留）
 * @returns 依据错误类型返回对应状态码与结构化错误响应
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  // 未知错误：记录完整错误对象 + 请求方法/路径，方便复现
  if (!(err instanceof AppError) && !(err instanceof ZodError)) {
    logger.error({ err, method: req.method, url: req.url }, 'unhandled error');
  }

  // 业务错误：按预设状态码与错误码透出
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    });
    return;
  }

  // 入参校验失败：返回 422，并把 Zod 的字段级问题原样带回
  if (err instanceof ZodError) {
    res.status(422).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: err.issues,
      },
    });
    return;
  }

  // 未知错误：仅返回通用 500，避免泄露内部信息
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
  });
};
