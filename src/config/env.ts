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
 * - 生产环境请通过真实环境变量注入敏感配置（如 JWT_SECRET），不要依赖默认值。
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
  // JWT 签名密钥：生产环境必须注入足够长的随机值，此处仅为本地开发提供默认值
  JWT_SECRET: z.string().min(16).default('dev-only-secret-do-not-use-in-production'),
  // JWT 有效期（jsonwebtoken 时间字符串，例如 24h）
  JWT_EXPIRES_IN: z.string().default('24h'),
  // DeepSeek API Key（可选）：配置后所有 AI 调用接入真实 DeepSeek 大模型；
  // 留空或未配置时自动回退到 MockAiProvider（模拟回复），保证零配置可运行。
  // 注意：生产环境务必通过环境变量注入，不要提交到代码仓库。
  DEEPSEEK_API_KEY: z
    .string()
    .trim()
    .optional()
    // 空串与未配置等价：统一归一化为 undefined，避免误判为「已配置」
    .transform((value) => (value ? value : undefined)),
  // DeepSeek API 基础地址（默认官方地址；兼容自定义网关/代理）
  DEEPSEEK_BASE_URL: z.string().url().default('https://api.deepseek.com'),
  // DeepSeek 模型名（deepseek-v4-flash 为 V4 快速模型；
  // 应用固定关闭思考模式以换取低延迟，见 DeepSeekProvider）
  DEEPSEEK_MODEL: z.string().trim().min(1).default('deepseek-v4-flash'),
  // AI 回复缓存 TTL（毫秒）：同一对话/群组内相同问题在 TTL 内直接回放上次回复，
  // 避免重复调用外部 AI；设为 0 可关闭缓存（每次都真实调用）
  AI_CACHE_TTL_MS: z.coerce.number().int().min(0).default(3600_000),
  // AI 接口限流：每个用户在一个时间窗口内最多允许的请求数（发送消息/重试，
  // 防止高频调用消耗 AI 额度）；认证接口（注册/登录）按 IP 固定限流
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(30),
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
