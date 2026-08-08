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
 * Provider 验证 AI 失败一致性与群组兜底回复逻辑。
 * 默认 Provider 由 createDefaultAiProvider 按配置选择：配置了 DEEPSEEK_API_KEY
 * 时使用真实 DeepSeek 大模型，否则回退 MockAiProvider（模拟回复）。
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
import swaggerUi from 'swagger-ui-express';

import { createAuthRouter } from './api/routes/auth.js';
import { botsRouter } from './api/routes/bots.js';
import { createConversationsRouter } from './api/routes/conversations.js';
import { createGroupsRouter } from './api/routes/groups.js';
import { createMessagesRouter } from './api/routes/messages.js';
import { env } from './config/env.js';
import { swaggerSpec } from './config/swagger.js';
import { errorHandler, notFoundHandler } from './lib/errors.js';
import { createRateLimiter, ipKey, userKey, type RateLimiterMiddleware } from './lib/rate-limit.js';
import { requestLogger } from './lib/request-logger.js';
import { healthRouter } from './routes/health.js';
import { AiService } from './services/ai/ai.service.js';
import { AiReplyCache } from './services/ai/cache.js';
import { createDefaultAiProvider } from './services/ai/provider.factory.js';
import { SemanticSummarizer } from './services/ai/summarizer.js';

/**
 * 应用构建选项
 *
 * @property aiService   可选的 AI 服务（默认 MockAiProvider），测试可注入故障实现
 * @property rateLimiters 可选的限流器覆盖（测试注入低阈值限流器做端到端验证；
 *                        缺省时按环境启用：NODE_ENV=test 自动关闭）
 */
export interface AppOptions {
  aiService?: AiService;
  rateLimiters?: {
    auth?: RateLimiterMiddleware | null;
    ai?: RateLimiterMiddleware | null;
  };
}

// 认证接口限流：按客户端 IP，固定 10 次 / 15 分钟（防暴力注册/登录）
const AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const AUTH_RATE_LIMIT_MAX = 10;

/**
 * 创建并配置 Express 应用
 *
 * @param options 构建选项（依赖注入）
 * @returns 配置完成的 Express 应用实例（尚未监听端口，监听由 src/server.ts 负责）
 */
export function createApp(options: AppOptions = {}) {
  // 默认 AI Provider：按环境变量选择 DeepSeek / Mock；测试可注入自定义实现
  const aiService =
    options.aiService ?? new AiService(createDefaultAiProvider(env.DEEPSEEK_API_KEY));
  // AI 回复缓存：相同问题在 TTL 内直接回放上次回复（个人=单条，群组=整轮 NPC 回复）
  const aiCache = new AiReplyCache(env.AI_CACHE_TTL_MS);
  // 语义摘要器：仅当配置了 DeepSeek API Key 时启用——用同一 AI 服务对历史消息做
  // 语义压缩（上下文滑动窗口达到阈值时）；未配置或调用失败时由摘要器降级为确定性摘要
  const summarizer = env.DEEPSEEK_API_KEY ? new SemanticSummarizer(aiService, aiCache) : null;

  // 限流：测试环境默认关闭（避免干扰既有用例），测试可注入自定义限流器验证 429 路径；
  // 生产/开发环境启用——认证按 IP、AI 接口按用户（见 rate-limit.ts）
  const rateLimitingEnabled = env.NODE_ENV !== 'test';
  const authRateLimiter =
    options.rateLimiters?.auth ??
    (rateLimitingEnabled
      ? createRateLimiter({
          windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
          max: AUTH_RATE_LIMIT_MAX,
          keyPrefix: 'auth',
          keyFrom: ipKey,
        })
      : null);
  const aiRateLimiter =
    options.rateLimiters?.ai ??
    (rateLimitingEnabled
      ? createRateLimiter({
          windowMs: env.RATE_LIMIT_WINDOW_MS,
          max: env.RATE_LIMIT_MAX,
          keyPrefix: 'ai',
          keyFrom: userKey,
        })
      : null);
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
  // 请求日志中间件：生成请求 id（UUID）并建立日志上下文，响应结束时输出一行摘要
  // （状态分层 + 慢请求标记 + 成功请求采样）；业务日志自动携带 requestId/userId
  app.use(
    requestLogger({
      slowThresholdMs: env.SLOW_REQUEST_THRESHOLD_MS,
      sampleRate: env.REQUEST_LOG_SAMPLE_RATE,
    }),
  );

  // 业务路由：认证、个人对话、群组、机器人、AI 消息重试、健康检查
  app.use('/api/auth', createAuthRouter({ authRateLimiter }));
  app.use(
    '/api/conversations',
    createConversationsRouter({ aiService, aiCache, summarizer, aiRateLimiter }),
  );
  app.use('/api/groups', createGroupsRouter({ aiService, aiCache, summarizer, aiRateLimiter }));
  app.use('/api/bots', botsRouter);
  app.use('/api/messages', createMessagesRouter({ aiService, summarizer, aiRateLimiter }));
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
