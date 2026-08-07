/**
 * 环境变量配置模块
 *
 * 【模块职责】
 * 集中定义并校验应用依赖的全部环境变量，各模块统一从 `env` 对象读取，
 * 避免配置散落、类型不安全，以及启动后才发现配置缺失的问题。
 *
 * 【设计说明】
 * - 使用 Zod schema 在进程启动阶段（模块加载时）完成校验，配置非法时快速失败（fail-fast）；
 * - `.env` 文件通过 `dotenv/config` 自动加载（仅当环境变量未设置时生效，不会覆盖已有值）；
 * - 生产环境请通过真实环境变量注入敏感配置（如后续的 JWT_SECRET），不要依赖默认值。
 */
import 'dotenv/config';

import { z } from 'zod';

/**
 * 环境变量 Schema
 *
 * 每个字段都带有默认值，保证本地零配置可启动；
 * 显式声明的类型会在编译期被 TypeScript 检查，运行时由 Zod 校验。
 */
const envSchema = z.object({
  // 运行环境标识：development（开发）/ test（测试）/ production（生产）
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // HTTP 服务监听端口（允许 1-65535 的整数）
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  // pino 日志级别：级别越低输出越详细，便于问题排查时临时调低
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

// 由 Schema 推导出的环境变量类型（供全局引用）
export type Env = z.infer<typeof envSchema>;

/**
 * 加载并校验环境变量
 *
 * @returns 校验通过后的环境变量对象（类型为 Env）
 * @throws 当环境变量不合法时抛出 Error（进程将在启动阶段失败，便于尽早发现配置问题）
 */
function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
  }
  return parsed.data;
}

// 模块加载时即完成校验并导出，供全应用使用
export const env = loadEnv();
