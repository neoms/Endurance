/**
 * Vitest 环境预置（每个测试文件运行前执行）
 *
 * 【作用】
 * 在导入应用代码前注入测试环境变量：
 * - NODE_ENV=test：应用以测试模式运行（日志不走 pino-pretty）；
 * - DATABASE_URL 指向独立测试库（prisma/test.db），与开发库（prisma/dev.db）完全隔离；
 * - JWT_SECRET 使用固定测试密钥，保证测试可复现；
 * - LOG_LEVEL=silent：静默测试期日志输出，保持测试输出干净。
 *
 * 【原理】
 * src/config/env.ts 中的 dotenv 不会覆盖已存在的环境变量，因此这里的赋值优先生效。
 */
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'file:./test.db';
process.env.JWT_SECRET = 'test-secret-at-least-16-chars';
process.env.LOG_LEVEL = 'silent';
