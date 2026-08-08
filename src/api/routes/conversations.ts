/**
 * 个人对话路由（全部需要鉴权）
 *
 * 【资源模型】
 * - /api/conversations            对话 CRUD 与标签筛选；
 * - /api/conversations/:id/tags   对话标签管理；
 * - /api/conversations/:id/messages 对话内消息（发送/历史）。
 *
 * 【ACL 说明】
 * 所有接口的服务层均强制校验所有权（assertConversationOwnership），
 * 跨用户访问统一返回 404。
 *
 * 【依赖注入】
 * 本路由组以工厂函数导出，接收 AiService（消息发送需要调用 AI）；
 * 测试可注入故障 Provider 验证 AI 失败一致性逻辑。
 *
 * 【文档约定】
 * 每个接口通过 `@openapi` JSDoc 维护 OpenAPI 文档，修改时务必同步更新。
 */
import { Router } from 'express';

import { AiService } from '../../services/ai/ai.service.js';
import {
  addTagToConversation,
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  removeTagFromConversation,
  updateConversationTitle,
} from '../../services/conversation.service.js';
import { listMessages, sendMessage } from '../../services/message.service.js';
import { authRequired, requireUser } from '../middleware/auth.js';
import { paramId } from '../middleware/params.js';
import { validate } from '../middleware/validate.js';
import {
  addTagSchema,
  createConversationSchema,
  updateConversationSchema,
} from '../validators/conversation.js';
import {
  listMessagesQuerySchema,
  sendMessageSchema,
  type ListMessagesQuery,
} from '../validators/message.js';

/**
 * 创建对话路由组
 *
 * @param deps { aiService } AI 服务（发送消息使用）
 * @returns Router 已装配全部对话相关路由的 Express Router
 */
export function createConversationsRouter(deps: { aiService: AiService }) {
  const conversationsRouter = Router();

  // 该路由组下所有接口都需要登录
  conversationsRouter.use(authRequired);

  /**
   * 解析查询参数中的标签列表
   *
   * @param value Express 查询参数值（string | string[] | undefined）
   * @returns string[] 标签名数组（空数组表示不过滤）
   * Express 对重复查询参数会解析为数组，这里统一归一化。
   */
  function parseTagQuery(value: unknown): string[] {
    if (Array.isArray(value)) {
      return value.map(String);
    }
    return typeof value === 'string' ? [value] : [];
  }

  /**
   * POST /api/conversations 创建对话
   *
   * 入参：{ title? }；返回值：201 { conversation }；未登录 401；参数不合法 422。
   *
   * @openapi
   * /api/conversations:
   *   post:
   *     tags: [Conversations]
   *     summary: 创建个人对话
   *     description: 创建新的个人对话；标题可缺省，缺省时为「新对话」，首条用户消息会自动替换标题。
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/CreateConversationRequest'
   *     responses:
   *       '201':
   *         description: 创建成功
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [conversation]
   *               properties:
   *                 conversation:
   *                   $ref: '#/components/schemas/Conversation'
   *       '401':
   *         description: 未登录或 token 无效
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       '422':
   *         description: 入参校验失败
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  conversationsRouter.post('/', validate(createConversationSchema), async (req, res) => {
    const user = requireUser(req);
    const conversation = await createConversation(user.id, req.body);
    res.status(201).json({ conversation });
  });

  /**
   * GET /api/conversations 对话列表（支持多标签 AND 筛选）
   *
   * 查询参数：tag（可重复，如 ?tag=工作&tag=学习）；返回值：200 { conversations }。
   *
   * @openapi
   * /api/conversations:
   *   get:
   *     tags: [Conversations]
   *     summary: 对话列表（可按标签筛选）
   *     description: 返回当前用户的对话列表，按最近更新时间倒序；`tag` 可重复传入，
   *       多标签为 AND 语义（对话必须同时拥有所有标签）。
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: tag
   *         in: query
   *         required: false
   *         description: 标签名，可重复传入实现多标签 AND 筛选
   *         schema:
   *           type: array
   *           items:
   *             type: string
   *         style: form
   *         explode: true
   *     responses:
   *       '200':
   *         description: 对话列表
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ConversationList'
   *       '401':
   *         description: 未登录或 token 无效
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  conversationsRouter.get('/', async (req, res) => {
    const user = requireUser(req);
    const tagNames = parseTagQuery(req.query.tag);
    const conversations = await listConversations(user.id, tagNames);
    res.json({ conversations });
  });

  /**
   * GET /api/conversations/{id} 对话详情
   *
   * 路径参数：id；返回值：200 { conversation }；非本人对话 404。
   *
   * @openapi
   * /api/conversations/{id}:
   *   get:
   *     tags: [Conversations]
   *     summary: 获取对话详情
   *     description: 返回指定对话的详情（含标签列表）；仅对话所有者可访问，其他用户返回 404。
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         description: 对话 id
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: 对话详情
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [conversation]
   *               properties:
   *                 conversation:
   *                   $ref: '#/components/schemas/Conversation'
   *       '401':
   *         description: 未登录或 token 无效
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       '404':
   *         description: 对话不存在或不属于当前用户
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  conversationsRouter.get('/:id', async (req, res) => {
    const user = requireUser(req);
    const conversation = await getConversation(user.id, paramId(req));
    res.json({ conversation });
  });

  /**
   * PATCH /api/conversations/{id} 修改对话标题
   *
   * 入参：{ title }；返回值：200 { conversation }；非本人对话 404。
   *
   * @openapi
   * /api/conversations/{id}:
   *   patch:
   *     tags: [Conversations]
   *     summary: 修改对话标题
   *     description: 更新指定对话的标题；仅对话所有者可操作。
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         description: 对话 id
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/UpdateConversationTitleRequest'
   *     responses:
   *       '200':
   *         description: 更新后的对话
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [conversation]
   *               properties:
   *                 conversation:
   *                   $ref: '#/components/schemas/Conversation'
   *       '401':
   *         description: 未登录或 token 无效
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       '404':
   *         description: 对话不存在或不属于当前用户
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       '422':
   *         description: 入参校验失败
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  conversationsRouter.patch('/:id', validate(updateConversationSchema), async (req, res) => {
    const user = requireUser(req);
    const conversation = await updateConversationTitle(user.id, paramId(req), req.body);
    res.json({ conversation });
  });

  /**
   * DELETE /api/conversations/{id} 删除对话
   *
   * 路径参数：id；返回值：204；级联删除对话内消息与标签关联。
   *
   * @openapi
   * /api/conversations/{id}:
   *   delete:
   *     tags: [Conversations]
   *     summary: 删除对话
   *     description: 删除指定对话，级联删除其全部消息与标签关联；仅对话所有者可操作。
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         description: 对话 id
   *         schema:
   *           type: string
   *     responses:
   *       '204':
   *         description: 删除成功（无响应体）
   *       '401':
   *         description: 未登录或 token 无效
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       '404':
   *         description: 对话不存在或不属于当前用户
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  conversationsRouter.delete('/:id', async (req, res) => {
    const user = requireUser(req);
    await deleteConversation(user.id, paramId(req));
    res.status(204).end();
  });

  /**
   * POST /api/conversations/{id}/tags 添加标签
   *
   * 入参：{ name }；返回值：201 { tag }；幂等（重复添加不报错）。
   *
   * @openapi
   * /api/conversations/{id}/tags:
   *   post:
   *     tags: [Conversations]
   *     summary: 为对话添加标签
   *     description: 为指定对话添加一个自定义标签；标签按用户去重存储，重复添加幂等。
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         description: 对话 id
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/AddTagRequest'
   *     responses:
   *       '201':
   *         description: 添加成功，返回标签
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [tag]
   *               properties:
   *                 tag:
   *                   $ref: '#/components/schemas/ConversationTag'
   *       '401':
   *         description: 未登录或 token 无效
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       '404':
   *         description: 对话不存在或不属于当前用户
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       '422':
   *         description: 入参校验失败
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  conversationsRouter.post('/:id/tags', validate(addTagSchema), async (req, res) => {
    const user = requireUser(req);
    const tag = await addTagToConversation(user.id, paramId(req), req.body);
    res.status(201).json({ tag });
  });

  /**
   * DELETE /api/conversations/{id}/tags/{tagId} 移除标签
   *
   * 路径参数：id（对话）、tagId（标签）；返回值：204。
   *
   * @openapi
   * /api/conversations/{id}/tags/{tagId}:
   *   delete:
   *     tags: [Conversations]
   *     summary: 移除对话标签
   *     description: 从指定对话移除标签；仅对话所有者可操作，标签须属于该对话且归属当前用户。
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         description: 对话 id
   *         schema:
   *           type: string
   *       - name: tagId
   *         in: path
   *         required: true
   *         description: 标签 id
   *         schema:
   *           type: string
   *     responses:
   *       '204':
   *         description: 移除成功（无响应体）
   *       '401':
   *         description: 未登录或 token 无效
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       '404':
   *         description: 对话或标签不存在/无权访问
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  conversationsRouter.delete('/:id/tags/:tagId', async (req, res) => {
    const user = requireUser(req);
    await removeTagFromConversation(user.id, paramId(req), paramId(req, 'tagId'));
    res.status(204).end();
  });

  /**
   * POST /api/conversations/{id}/messages 发送消息
   *
   * 入参：{ content, clientRequestId? }；返回值：201 { userMessage, aiMessage }。
   * AI 调用重试耗尽时 aiMessage.status=FAILED 并携带 errorCode，用户消息始终保存。
   *
   * @openapi
   * /api/conversations/{id}/messages:
   *   post:
   *     tags: [Messages]
   *     summary: 发送消息（触发 AI 回复）
   *     description: 保存用户消息并调用 AI 生成回复；用户消息先落库，
   *       AI 重试耗尽时回复以 FAILED 状态占位（前端可展示「回复失败，可重试」）；
   *       携带 clientRequestId 可在同一对话内幂等去重（不同对话互不影响）。
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         description: 对话 id
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/SendMessageRequest'
   *     responses:
   *       '201':
   *         description: 发送成功，返回用户消息与 AI 回复（可能为 FAILED 状态）
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/SendMessageResult'
   *       '401':
   *         description: 未登录或 token 无效
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       '404':
   *         description: 对话不存在或不属于当前用户
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       '422':
   *         description: 入参校验失败
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  conversationsRouter.post('/:id/messages', validate(sendMessageSchema), async (req, res) => {
    const user = requireUser(req);
    const result = await sendMessage(deps.aiService, user.id, paramId(req), req.body);
    res.status(201).json(result);
  });

  /**
   * GET /api/conversations/{id}/messages 历史消息（游标分页）
   *
   * 查询参数：cursor（上一页最后一条消息 id）、limit（1-100，默认 50）；
   * 返回值：200 { messages }（按时间升序）。
   *
   * @openapi
   * /api/conversations/{id}/messages:
   *   get:
   *     tags: [Messages]
   *     summary: 对话历史消息（游标分页）
   *     description: 按时间升序返回对话内全部消息（人类与 AI 发言）；支持游标分页。
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         description: 对话 id
   *         schema:
   *           type: string
   *       - name: cursor
   *         in: query
   *         required: false
   *         description: 游标（上一页最后一条消息的 id），省略表示第一页
   *         schema:
   *           type: string
   *       - name: limit
   *         in: query
   *         required: false
   *         description: 每页条数（1-100，默认 50）
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 100
   *           default: 50
   *     responses:
   *       '200':
   *         description: 消息列表
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/MessageList'
   *       '401':
   *         description: 未登录或 token 无效
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       '404':
   *         description: 对话不存在或不属于当前用户
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       '422':
   *         description: 分页参数不合法
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  conversationsRouter.get(
    '/:id/messages',
    validate(listMessagesQuerySchema, 'query'),
    async (req, res) => {
      const user = requireUser(req);
      const query = res.locals.validatedQuery as ListMessagesQuery;
      const messages = await listMessages(user.id, paramId(req), query);
      res.json({ messages });
    },
  );

  return conversationsRouter;
}
