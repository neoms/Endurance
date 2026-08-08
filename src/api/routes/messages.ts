/**
 * 消息辅助路由
 *
 * 【接口清单】
 * - POST /api/messages/:id/retry  重试失败的 AI 消息
 *
 * 【ACL 说明】
 * 归属校验在服务层完成（消息须属于当前用户的对话），跨用户访问返回 404。
 *
 * 【文档约定】
 * 每个接口通过 `@openapi` JSDoc 维护 OpenAPI 文档，修改时务必同步更新。
 */
import { Router } from 'express';

import { AiService } from '../../services/ai/ai.service.js';
import type { RateLimiterMiddleware } from '../../lib/rate-limit.js';
import { retryAiMessage } from '../../services/message.service.js';
import { authRequired, requireUser } from '../middleware/auth.js';
import { paramId } from '../middleware/params.js';

/**
 * 创建消息路由组
 *
 * @param deps { aiService, aiRateLimiter? } AI 服务与限流中间件（重试也消耗 AI 额度）
 * @returns Router 已装配的 Express Router
 */
export function createMessagesRouter(deps: {
  aiService: AiService;
  aiRateLimiter?: RateLimiterMiddleware | null;
}) {
  const router = Router();

  // 该路由组下所有接口都需要登录
  router.use(authRequired);

  /**
   * POST /api/messages/{id}/retry 重试失败的 AI 消息
   *
   * 路径参数：id（消息 id）；返回值：200 { aiMessage }。
   * 仅允许「本人对话内、BOT 发送、状态 FAILED」的消息重试，否则 409。
   *
   * @openapi
   * /api/messages/{id}/retry:
   *   post:
   *     tags: [Messages]
   *     summary: 重试失败的 AI 消息
   *     description: 对 FAILED 状态的 AI 消息重新调用 AI 生成；
   *       成功则置回 SENT，仍失败则保持 FAILED 并更新错误信息。
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         description: 消息 id（必须是当前用户对话内 FAILED 的 AI 消息）
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: 重试后的 AI 消息
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [aiMessage]
   *               properties:
   *                 aiMessage:
   *                   $ref: '#/components/schemas/Message'
   *       '401':
   *         description: 未登录或 token 无效
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       '404':
   *         description: 消息不存在或不属于当前用户
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       '409':
   *         description: 消息不是 FAILED 的 AI 消息（不可重试）
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       '429':
   *         description: 请求过于频繁（按用户限流，防止高频消耗 AI 额度）
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  router.post(
    '/:id/retry',
    ...(deps.aiRateLimiter ? [deps.aiRateLimiter] : []),
    async (req, res) => {
      const user = requireUser(req);
      const aiMessage = await retryAiMessage(deps.aiService, user.id, user.username, paramId(req));
      res.json({ aiMessage });
    },
  );

  return router;
}
