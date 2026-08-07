/**
 * Express 应用装配模块
 *
 * 【模块职责】
 * 按顺序挂载全局中间件、业务路由与文档路由，是应用的「组装工厂」：
 * - Swagger 文档（/api-docs、/api-docs.json）：接口文档可视化与机器可读输出；
 * - 安全中间件（helmet）：设置 CSP 等安全响应头；
 * - 请求体解析（express.json）：支持 JSON 请求体并限制大小；
 * - 请求日志（pino-http）：每个请求输出一行结构化日志（含耗时），方便排查；
 * - 业务路由：认证、个人对话（含标签与消息）、群组、机器人、AI 消息重试、健康检查；
 * - 兜底中间件：404 与全局错误处理必须最后挂载。
 *
 * 【依赖注入】
 * AppOptions.aiService 可注入自定义 AI 服务；测试用它注入「必然失败」的
 * Provider 验证 AI 失败一致性与群组兜底回复逻辑。默认使用 MockAiProvider。
 *
 * 【挂载顺序说明】
 * Swagger UI 依赖内联脚本，而 helmet 默认 CSP 禁止内联脚本；
 * 因此将 /api-docs 挂载在 helmet 之前（文档页不承载用户数据），
 * 其余所有 API 接口仍由 helmet 保护。
 */
import express from 'express';
import helmet from 'helmet';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';

import { authRouter } from './api/routes/auth.js';
import { botsRouter } from './api/routes/bots.js';
import { createConversationsRouter } from './api/routes/conversations.js';
import { createGroupsRouter } from './api/routes/groups.js';
import { createMessagesRouter } from './api/routes/messages.js';
import { swaggerSpec } from './config/swagger.js';
import { errorHandler, notFoundHandler } from './lib/errors.js';
import { logger } from './lib/logger.js';
import { healthRouter } from './routes/health.js';
import { AiService } from './services/ai/ai.service.js';
import { MockAiProvider } from './services/ai/mock.provider.js';

/**
 * 应用构建选项
 *
 * @property aiService 可选的 AI 服务（默认 MockAiProvider），测试可注入故障实现
 */
export interface AppOptions {
  aiService?: AiService;
}

/**
 * 创建并配置 Express 应用
 *
 * @param options 构建选项（依赖注入）
 * @returns 配置完成的 Express 应用实例（尚未监听端口，监听由 src/server.ts 负责）
 */
export function createApp(options: AppOptions = {}) {
  // 默认使用 Mock AI Provider；测试可注入自定义实现
  const aiService = options.aiService ?? new AiService(new MockAiProvider());
  const app = express();

  // 隐藏 X-Powered-By 响应头，降低技术栈信息泄露
  app.disable('x-powered-by');

  // Swagger 文档：必须先于 helmet（见文件头「挂载顺序说明」）
  // 1) /api-docs：可视化文档 UI；2) /api-docs.json：原始 OpenAPI JSON
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  app.get('/api-docs.json', (_req, res) => {
    res.json(swaggerSpec);
  });

  // 安全响应头（CSP、X-Frame-Options、X-Content-Type-Options 等）
  app.use(helmet());
  // 解析 JSON 请求体；limit 限制单次请求体大小，防止超大请求拖垮服务
  app.use(express.json({ limit: '1mb' }));
  // 请求日志：记录 method/url/状态码/耗时；Authorization 头已在 logger 中脱敏
  app.use(pinoHttp({ logger }));

  // 业务路由：认证、个人对话、群组、机器人、AI 消息重试、健康检查
  app.use('/api/auth', authRouter);
  app.use('/api/conversations', createConversationsRouter({ aiService }));
  app.use('/api/groups', createGroupsRouter({ aiService }));
  app.use('/api/bots', botsRouter);
  app.use('/api/messages', createMessagesRouter({ aiService }));
  app.use('/api/health', healthRouter);

  // 前端静态资源：若 web/dist 已构建（npm run build:web），由 Express 托管，实现一体化部署
  const webDist = path.resolve('web', 'dist');
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    // SPA 回退：非 /api 的 GET 请求返回 index.html，支持前端路由刷新（如 /conversations/xxx）
    app.use((req, res, next) => {
      if (req.method === 'GET' && !req.path.startsWith('/api')) {
        res.sendFile(path.join(webDist, 'index.html'));
        return;
      }
      next();
    });
  } else {
    // 未构建前端时，根路径重定向到接口文档页，方便演示
    app.get('/', (_req, res) => {
      res.redirect('/api-docs');
    });
  }

  // 兜底：未匹配路由 → 404；全局错误 → 结构化错误响应
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
