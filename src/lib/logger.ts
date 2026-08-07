/**
 * 全局日志器（pino）
 *
 * 【模块职责】
 * 提供全应用统一的结构化 JSON 日志能力，方便检索与问题排查：
 * - 生产环境输出纯 JSON，可直接对接日志采集系统；
 * - 开发环境启用 pino-pretty，输出带颜色的易读日志；
 * - 对敏感字段（如请求头中的 Authorization）做脱敏，避免 token 等机密写入日志。
 */
import { pino } from 'pino';

import { env } from '../config/env.js';

export const logger = pino({
  // 日志级别由环境变量控制，排查问题时可将 LOG_LEVEL 调低（如 debug）
  level: env.LOG_LEVEL,
  // 敏感字段脱敏：任何日志对象中 req.headers.authorization 一律替换为 [REDACTED]
  redact: {
    paths: ['req.headers.authorization'],
    censor: '[REDACTED]',
  },
  // 开发环境输出可读日志；生产环境保持纯 JSON
  ...(env.NODE_ENV === 'development' && {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:standard' },
    },
  }),
});
