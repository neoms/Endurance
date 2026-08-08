/**
 * 全局日志器（pino）
 *
 * 【模块职责】
 * 提供全应用统一的结构化 JSON 日志能力，面向生产可观测性设计：
 * - **请求关联**：通过 mixin + AsyncLocalStorage（见 log-context.ts），
 *   每条日志自动携带 requestId / userId——业务日志与请求日志可凭 requestId 关联，
 *   出问题时能精确定位「哪个请求、哪个用户、哪次操作」；
 * - **多流输出**：控制台（开发 pino-pretty、生产纯 JSON 到 stdout 供采集器接管）
 *   + 文件（pino-roll 按大小轮转、保留 N 份，防止磁盘膨胀）；
 * - **部署语义**：开发默认写 logs/app.log；生产默认不写文件（由容器采集 stdout），
 *   显式设置 LOG_FILE 才启用；测试环境始终不写文件；
 * - **服务元数据**：每条日志带 service / version / hostname / pid，
 *   多版本灰度与多实例部署时可区分来源；
 * - **敏感脱敏**：Authorization 等敏感字段一律替换为 [REDACTED]。
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { multistream, pino, transport, type StreamEntry } from 'pino';
import pinoRoll from 'pino-roll';

import { env } from '../config/env.js';
import { getLogContext } from './log-context.js';

// ESM 下读取 package.json（name/version 注入每条日志的服务元数据）
const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { name: string; version: string };

// 是否写文件：
// - 测试环境：不写（避免污染测试输出）；
// - 开发环境：未显式配置 LOG_FILE 时默认写 logs/app.log（本地便于回溯）；
// - 生产环境：默认不写（由 stdout 交给日志采集器），显式设置 LOG_FILE 才写
const logFileExplicit = env.LOG_FILE !== undefined && env.LOG_FILE !== 'off';
const shouldWriteFile =
  env.NODE_ENV !== 'test' && (logFileExplicit || env.NODE_ENV === 'development');
// 当前生效的日志文件绝对路径（供启动日志展示；未写文件时为 null）
export const logFilePath = shouldWriteFile
  ? path.resolve(process.cwd(), env.LOG_FILE ?? 'logs/app.log')
  : null;

// 输出流清单：控制台 + 可选的文件流
const streams: StreamEntry[] = [];

// 控制台流：开发环境 pino-pretty（可读、带颜色）；生产/测试纯 JSON 直出 stdout
if (env.NODE_ENV === 'development') {
  streams.push({
    stream: transport({
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:standard', ignore: 'hostname,pid' },
    }),
  });
} else {
  streams.push({ stream: process.stdout });
}

// 文件流：按大小轮转（LOG_FILE_MAX_SIZE）+ 保留 N 份（LOG_FILE_KEEP），
// 防止单个日志文件无限增长打满磁盘
if (logFilePath) {
  mkdirSync(path.dirname(logFilePath), { recursive: true });
  // pino-roll 异步初始化：ESM 顶层 await（Node 24 + NodeNext 支持）
  streams.push({
    stream: await pinoRoll({
      file: logFilePath,
      size: env.LOG_FILE_MAX_SIZE,
      limit: { count: env.LOG_FILE_KEEP },
      mkdir: true,
      sync: false,
    }),
  });
}

/**
 * 日志 mixin：为每条日志注入请求级上下文
 *
 * @returns Record<string, unknown> 注入的字段（requestId / userId）
 * 说明：pino 在每次写入日志时调用；从 AsyncLocalStorage 读取当前请求上下文，
 * 使业务日志无需手动传参即可自动携带关联字段。非请求处理期间返回空对象。
 */
export function logMixin(): Record<string, unknown> {
  const ctx = getLogContext();
  if (!ctx) {
    return {};
  }
  return { requestId: ctx.requestId, ...(ctx.userId ? { userId: ctx.userId } : {}) };
}

export const logger = pino(
  {
    // 日志级别由环境变量控制，排查问题时可将 LOG_LEVEL 调低（如 debug）
    level: env.LOG_LEVEL,
    // 服务元数据：每条日志都带服务名与版本，多版本灰度时可区分来源
    base: { service: pkg.name, version: pkg.version },
    // 敏感字段脱敏：Authorization 等机密绝不写入日志
    redact: {
      paths: ['req.headers.authorization', 'password', 'apiKey'],
      censor: '[REDACTED]',
    },
    // 请求关联：业务日志自动携带 requestId / userId
    mixin: logMixin,
  },
  multistream(streams),
);
