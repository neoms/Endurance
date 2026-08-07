/**
 * Express 应用装配模块
 *
 * 【模块职责】
 * 按顺序挂载全局中间件、业务路由与文档路由，是应用的「组装工厂」：
 * - Swagger 文档（/api-docs、/api-docs.json）：接口文档可视化与机器可读输出；
 * - 安全中间件（helmet）：设置 CSP 等安全响应头；
 * - 请求体解析（express.json）：支持 JSON 请求体并限制大小；
 * - 请求日志（pino-http）：每个请求输出一行结构化日志（含耗时），方便排查；
 * - 业务路由：认证、健康检查；其余按 plan.md 后续添加；
 * - 兜底中间件：404 与全局错误处理必须最后挂载。
 *
 * 【挂载顺序说明】
 * Swagger UI 依赖内联脚本，而 helmet 默认 CSP 禁止内联脚本；
 * 因此将 /api-docs 挂载在 helmet 之前（文档页不承载用户数据），
 * 其余所有 API 接口仍由 helmet 保护。
 */
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';

import { authRouter } from './api/routes/auth.js';
import { swaggerSpec } from './config/swagger.js';
import { errorHandler, notFoundHandler } from './lib/errors.js';
import { logger } from './lib/logger.js';
import { healthRouter } from './routes/health.js';

/**
 * 创建并配置 Express 应用
 *
 * @returns 配置完成的 Express 应用实例（尚未监听端口，监听由 src/server.ts 负责）
 */
export function createApp() {
  const app = express();

  // 隐藏 X-Powered-By 响应头，降低技术栈信息泄露
  app.disable('x-powered-by');

  // Swagger 文档：必须先于 helmet（见文件头「挂载顺序说明」）
  // 1) /api-docs：可视化文档 UI；2) /api-docs.json：原始 OpenAPI JSON
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  app.get('/api-docs.json', (_req, res) => {
    res.json(swaggerSpec);
  });
  // 根路径重定向到文档页，方便演示时直接访问
  app.get('/', (_req, res) => {
    res.redirect('/api-docs');
  });

  // 安全响应头（CSP、X-Frame-Options、X-Content-Type-Options 等）
  app.use(helmet());
  // 解析 JSON 请求体；limit 限制单次请求体大小，防止超大请求拖垮服务
  app.use(express.json({ limit: '1mb' }));
  // 请求日志：记录 method/url/状态码/耗时；Authorization 头已在 logger 中脱敏
  app.use(pinoHttp({ logger }));

  // 业务路由：认证、健康检查（其余路由在后续步骤按 plan.md 添加）
  app.use('/api/auth', authRouter);
  app.use('/api/health', healthRouter);

  // 兜底：未匹配路由 → 404；全局错误 → 结构化错误响应
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
