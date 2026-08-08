/**
 * 机器人角色路由
 *
 * 【接口清单】
 * - GET /api/bots 可用的机器人角色预设列表（需鉴权）
 *
 * 【文档约定】
 * 每个接口通过 `@openapi` JSDoc 维护 OpenAPI 文档，修改时务必同步更新。
 */
import { Router } from 'express';

import { listBots } from '../../services/bot.service.js';
import { authRequired } from '../middleware/auth.js';

export const botsRouter = Router();

// 该路由组下所有接口都需要登录
botsRouter.use(authRequired);

/**
 * GET /api/bots 机器人角色预设列表
 *
 * 入参：无（需鉴权）；返回值：200 { bots }。
 *
 * @openapi
 * /api/bots:
 *   get:
 *     tags: [Bots]
 *     summary: NPC 角色预设列表
 *     description: 返回全部启用的 NPC 角色（星际穿越角色等），供创建群组与添加 NPC 时选择。
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       '200':
 *         description: NPC 角色列表
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [bots]
 *               properties:
 *                 bots:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Bot'
 *       '401':
 *         description: 未登录或 token 无效
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
botsRouter.get('/', async (_req, res) => {
  const bots = await listBots();
  res.json({ bots });
});
