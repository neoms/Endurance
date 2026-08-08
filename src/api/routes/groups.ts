/**
 * 群组对话路由（全部需要鉴权）
 *
 * 【资源模型】
 * - /api/groups                        群组 CRUD 与配置；
 * - /api/groups/:id/members            成员管理（含离开群组）；
 * - /api/groups/:id/bots               机器人管理（至少保留 1 个）；
 * - /api/groups/:id/messages           群组消息（人类发言 + 机器人回复）。
 *
 * 【权限模型】
 * - OWNER（创建者）：管理成员/机器人/配置；
 * - MEMBER：查看、发消息、离开群组；
 * - 非成员统一 404；越权管理 403。
 *
 * 【文档约定】
 * 每个接口通过 `@openapi` JSDoc 维护 OpenAPI 文档，修改时务必同步更新。
 */
import { Router } from 'express';

import { AiService } from '../../services/ai/ai.service.js';
import type { AiReplyCache } from '../../services/ai/cache.js';
import {
  addBotToGroup,
  addGroupMember,
  createGroup,
  getGroup,
  leaveGroup,
  listGroupMessages,
  listGroups,
  removeBotFromGroup,
  removeGroupMember,
  sendGroupMessage,
  streamSendGroupMessage,
  updateGroup,
} from '../../services/group.service.js';
import { authRequired, requireUser } from '../middleware/auth.js';
import { paramId } from '../middleware/params.js';
import { validate } from '../middleware/validate.js';
import {
  addBotSchema,
  addMemberSchema,
  createGroupSchema,
  sendGroupMessageSchema,
  updateGroupSchema,
} from '../validators/group.js';
import { listMessagesQuerySchema, type ListMessagesQuery } from '../validators/message.js';
import { sendSseError, sendSseEvent, startSse } from '../sse.js';

/**
 * 创建群组路由组
 *
 * @param deps { aiService, aiCache? } AI 服务与回复缓存（相同问题回放整轮 NPC 回复）
 * @returns Router 已装配全部群组相关路由的 Express Router
 */
export function createGroupsRouter(deps: { aiService: AiService; aiCache?: AiReplyCache | null }) {
  const router = Router();

  // 该路由组下所有接口都需要登录
  router.use(authRequired);

  /**
   * POST /api/groups 创建群组
   *
   * 入参：{ name, botIds[], responseMode?, maxConsecutiveBotReplies? }；
   * 返回值：201 { group }；创建者自动成为 OWNER。
   *
   * @openapi
   * /api/groups:
   *   post:
   *     tags: [Groups]
   *     summary: 创建群组
   *     description: 创建群组对话，必须至少选择一个 NPC；创建者自动成为 OWNER 成员。
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/CreateGroupRequest'
   *     responses:
   *       '201':
   *         description: 创建成功，返回群组详情
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [group]
   *               properties:
   *                 group:
   *                   $ref: '#/components/schemas/Group'
   *       '401':
   *         description: 未登录或 token 无效
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       '404':
   *         description: 指定的 NPC 不存在
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
  router.post('/', validate(createGroupSchema), async (req, res) => {
    const user = requireUser(req);
    const group = await createGroup(user.id, req.body);
    res.status(201).json({ group });
  });

  /**
   * GET /api/groups 我参与的群组列表
   *
   * 返回值：200 { groups }。
   *
   * @openapi
   * /api/groups:
   *   get:
   *     tags: [Groups]
   *     summary: 我参与的群组列表
   *     description: 返回当前用户参与（创建或加入）的全部群组，按加入时间倒序。
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       '200':
   *         description: 群组列表
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [groups]
   *               properties:
   *                 groups:
   *                   type: array
   *                   items:
   *                     $ref: '#/components/schemas/Group'
   *       '401':
   *         description: 未登录或 token 无效
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  router.get('/', async (req, res) => {
    const user = requireUser(req);
    const groups = await listGroups(user.id);
    res.json({ groups });
  });

  /**
   * GET /api/groups/{id} 群组详情
   *
   * 路径参数：id；返回值：200 { group }；非成员 404。
   *
   * @openapi
   * /api/groups/{id}:
   *   get:
   *     tags: [Groups]
   *     summary: 群组详情
   *     description: 返回群组详情（成员 + NPC）；仅群组成员可访问。
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         description: 群组 id
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: 群组详情
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [group]
   *               properties:
   *                 group:
   *                   $ref: '#/components/schemas/Group'
   *       '401':
   *         description: 未登录或 token 无效
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       '404':
   *         description: 群组不存在或当前用户不是成员
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  router.get('/:id', async (req, res) => {
    const user = requireUser(req);
    const group = await getGroup(user.id, paramId(req));
    res.json({ group });
  });

  /**
   * PATCH /api/groups/{id} 更新群组配置
   *
   * 入参：{ name?, responseMode?, maxConsecutiveBotReplies? }（至少一项）；
   * 仅创建者可操作（成员 403）。
   *
   * @openapi
   * /api/groups/{id}:
   *   patch:
   *     tags: [Groups]
   *     summary: 更新群组配置
   *     description: 更新群组名称、NPC 响应策略或防循环上限；仅创建者可操作。
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         description: 群组 id
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/UpdateGroupRequest'
   *     responses:
   *       '200':
   *         description: 更新后的群组
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [group]
   *               properties:
   *                 group:
   *                   $ref: '#/components/schemas/Group'
   *       '401':
   *         description: 未登录或 token 无效
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       '403':
   *         description: 非创建者，无管理权限
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       '404':
   *         description: 群组不存在或当前用户不是成员
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
  router.patch('/:id', validate(updateGroupSchema), async (req, res) => {
    const user = requireUser(req);
    const group = await updateGroup(user.id, paramId(req), req.body);
    res.json({ group });
  });

  // 注意：/members/me 必须注册在 /members/:userId 之前，避免 'me' 被解析为 userId
  /**
   * DELETE /api/groups/{id}/members/me 离开群组
   *
   * 路径参数：id；返回值：204；创建者不可离开（403）。
   *
   * @openapi
   * /api/groups/{id}/members/me:
   *   delete:
   *     tags: [Groups]
   *     summary: 离开群组
   *     description: 当前成员离开指定群组；创建者不可离开（v1 限制）。
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         description: 群组 id
   *         schema:
   *           type: string
   *     responses:
   *       '204':
   *         description: 已离开（无响应体）
   *       '401':
   *         description: 未登录或 token 无效
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       '403':
   *         description: 创建者不可离开群组
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       '404':
   *         description: 群组不存在或当前用户不是成员
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  router.delete('/:id/members/me', async (req, res) => {
    const user = requireUser(req);
    await leaveGroup(user.id, paramId(req));
    res.status(204).end();
  });

  /**
   * POST /api/groups/{id}/members 添加成员
   *
   * 入参：{ username }（用户名全局唯一、大小写敏感，按精确字符串匹配）；
   * 返回值：200 { group }；仅创建者（成员 403）。
   *
   * @openapi
   * /api/groups/{id}/members:
   *   post:
   *     tags: [Groups]
   *     summary: 添加群组成员
   *     description: 按用户名（全局唯一、大小写敏感）将用户加入群组（MEMBER 角色）；
   *       仅创建者可操作；目标用户不存在返回 404，已是成员返回 409。
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         description: 群组 id
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/AddMemberRequest'
   *     responses:
   *       '200':
   *         description: 添加成功，返回更新后的群组
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [group]
   *               properties:
   *                 group:
   *                   $ref: '#/components/schemas/Group'
   *       '401':
   *         description: 未登录或 token 无效
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       '403':
   *         description: 非创建者，无管理权限
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       '404':
   *         description: 群组不存在或目标用户不存在
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       '409':
   *         description: 目标用户已是成员
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
  router.post('/:id/members', validate(addMemberSchema), async (req, res) => {
    const user = requireUser(req);
    const group = await addGroupMember(user.id, paramId(req), req.body.username);
    res.json({ group });
  });

  /**
   * DELETE /api/groups/{id}/members/{userId} 移除成员
   *
   * 路径参数：id、userId；返回值：200 { group }；仅创建者；不能移除创建者。
   *
   * @openapi
   * /api/groups/{id}/members/{userId}:
   *   delete:
   *     tags: [Groups]
   *     summary: 移除群组成员
   *     description: 将指定成员移出群组；仅创建者可操作，且不能移除创建者本人。
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         description: 群组 id
   *         schema:
   *           type: string
   *       - name: userId
   *         in: path
   *         required: true
   *         description: 待移除成员的用户 id
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: 移除成功，返回更新后的群组
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [group]
   *               properties:
   *                 group:
   *                   $ref: '#/components/schemas/Group'
   *       '401':
   *         description: 未登录或 token 无效
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       '403':
   *         description: 非创建者或试图移除创建者
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       '404':
   *         description: 群组不存在或目标用户不是成员
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  router.delete('/:id/members/:userId', async (req, res) => {
    const user = requireUser(req);
    const group = await removeGroupMember(user.id, paramId(req), paramId(req, 'userId'));
    res.json({ group });
  });

  /**
   * POST /api/groups/{id}/bots 添加机器人
   *
   * 入参：{ botId }；返回值：200 { group }；仅创建者；重复添加幂等。
   *
   * @openapi
   * /api/groups/{id}/bots:
   *   post:
   *     tags: [Groups]
   *     summary: 添加 NPC
   *     description: 向群组添加一个 NPC 角色；仅创建者可操作；重复添加幂等。
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         description: 群组 id
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/AddBotRequest'
   *     responses:
   *       '200':
   *         description: 添加成功，返回更新后的群组
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [group]
   *               properties:
   *                 group:
   *                   $ref: '#/components/schemas/Group'
   *       '401':
   *         description: 未登录或 token 无效
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       '403':
   *         description: 非创建者，无管理权限
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       '404':
   *         description: 群组不存在或 NPC 不存在
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
  router.post('/:id/bots', validate(addBotSchema), async (req, res) => {
    const user = requireUser(req);
    const group = await addBotToGroup(user.id, paramId(req), req.body.botId);
    res.json({ group });
  });

  /**
   * DELETE /api/groups/{id}/bots/{botId} 移除机器人
   *
   * 路径参数：id、botId；返回值：200 { group }；仅创建者；至少保留 1 个。
   *
   * @openapi
   * /api/groups/{id}/bots/{botId}:
   *   delete:
   *     tags: [Groups]
   *     summary: 移除 NPC
   *     description: 从群组移除指定 NPC；仅创建者可操作；群组必须至少保留 1 个 NPC。
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         description: 群组 id
   *         schema:
   *           type: string
   *       - name: botId
   *         in: path
   *         required: true
   *         description: NPC id
   *         schema:
   *           type: string
   *     responses:
   *       '200':
   *         description: 移除成功，返回更新后的群组
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               required: [group]
   *               properties:
   *                 group:
   *                   $ref: '#/components/schemas/Group'
   *       '401':
   *         description: 未登录或 token 无效
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       '403':
   *         description: 非创建者，无管理权限
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       '404':
   *         description: 群组不存在或 NPC 不在群组中
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       '409':
   *         description: 群组只有 1 个 NPC，不可移除
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   */
  router.delete('/:id/bots/:botId', async (req, res) => {
    const user = requireUser(req);
    const group = await removeBotFromGroup(user.id, paramId(req), paramId(req, 'botId'));
    res.json({ group });
  });

  /**
   * POST /api/groups/{id}/messages 发送群组消息（触发机器人回复）
   *
   * 入参：{ content, clientRequestId? }；返回值：201 { userMessage, botMessages }。
   * 查询参数：stream=true 时改用 SSE 流式输出（事件：user_message / bot_start /
   * bot_delta / bot_done / round_done / error），每个 NPC 依次流式推送。
   *
   * @openapi
   * /api/groups/{id}/messages:
   *   post:
   *     tags: [Groups]
   *     summary: 发送群组消息（触发 NPC 回复）
   *     description: 人类成员发言，并按群组响应策略触发一个或多个 NPC 回复；
   *       支持 @提及：@NPC名 时仅被 @ 的 NPC 按出现顺序回复（覆盖响应策略与每轮上限）；
   *       只要消息中存在 @提及（含只 @ 真人）→ 仅被 @ 的对象回复，
   *       未提及的 NPC 不回复（只 @ 真人时本轮无 NPC 回复，由真人本人回复）；
   *       被 @ 的名称必须存在于当前群组，否则返回 400 MENTION_NOT_FOUND；
   *       消息中没有任何 @ 时才按响应策略回复；
   *       每轮回复数受 maxConsecutiveBotReplies 限制（防循环），
   *       生成失败时以兜底文案占位，保证至少有一个 NPC 回复；
   *       携带 clientRequestId 可在同一群组内幂等去重（重复提交返回首次轮次结果）；
   *       群组内没有启用状态的 NPC 时返回 409 NO_ACTIVE_BOT；
   *       查询参数 `stream=true` 时响应改为 text/event-stream：
   *       依次推送 user_message、bot_start（NPC 开始回复，PENDING）、
   *       bot_delta（回复增量）、bot_done（完整回复）、round_done（本轮结束）；
   *       发生校验类错误时推送 error 事件。
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         description: 群组 id
   *         schema:
   *           type: string
   *       - name: stream
   *         in: query
   *         required: false
   *         description: 传 true 时以 SSE 流式返回 NPC 回复（默认 JSON 同步返回）
   *         schema:
   *           type: boolean
   *           default: false
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/SendGroupMessageRequest'
   *     responses:
   *       '201':
   *         description: 发送成功，返回人类消息与本轮 NPC 回复
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/SendGroupMessageResult'
   *       '400':
   *         description: 消息中的 @名称不在当前群组内（MENTION_NOT_FOUND）
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       '401':
   *         description: 未登录或 token 无效
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       '404':
   *         description: 群组不存在或当前用户不是成员
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       '409':
   *         description: 群组内没有启用状态的 NPC，无法回复
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
  router.post('/:id/messages', validate(sendGroupMessageSchema), async (req, res) => {
    const user = requireUser(req);
    const groupId = paramId(req);

    // 流式模式：SSE 逐块推送每个机器人的回复（前端群聊页使用）；默认保持 JSON 同步返回
    if (req.query.stream === 'true') {
      // 客户端断连时 abort 底层 AI 调用：监听响应流 close（连接被终止时触发）
      const controller = new AbortController();
      let settled = false;
      const onClose = () => {
        if (!settled) {
          controller.abort();
        }
      };
      res.on('close', onClose);

      startSse(res);
      try {
        await streamSendGroupMessage(
          deps.aiService,
          user.id,
          groupId,
          req.body,
          {
            userMessage: (message) => sendSseEvent(res, 'user_message', { message }),
            botStart: (message) => sendSseEvent(res, 'bot_start', { message }),
            botDelta: (messageId, delta) => sendSseEvent(res, 'bot_delta', { messageId, delta }),
            botDone: (message) => sendSseEvent(res, 'bot_done', { message }),
            roundDone: () => sendSseEvent(res, 'round_done', { ok: true }),
          },
          controller.signal,
          deps.aiCache,
        );
      } catch (err) {
        // 首个事件发出前的失败（404/409/400 等）：以 error 事件告知前端
        sendSseError(res, err);
      } finally {
        settled = true;
        res.removeListener('close', onClose);
        // 正常结束且尚未收尾时主动 end；客户端断连时 res 已结束，此调用无副作用
        if (!res.writableEnded) {
          res.end();
        }
      }
      return;
    }

    const result = await sendGroupMessage(
      deps.aiService,
      user.id,
      paramId(req),
      req.body,
      deps.aiCache,
    );
    res.status(201).json(result);
  });

  /**
   * GET /api/groups/{id}/messages 群组历史消息（游标分页）
   *
   * 查询参数：cursor（正向翻页）、before（反向加载更早）、limit（1-100，默认 50）；
   * 返回值：200 { messages }（按时间升序）。cursor/before 都省略时返回最近 limit 条。
   *
   * @openapi
   * /api/groups/{id}/messages:
   *   get:
   *     tags: [Groups]
   *     summary: 群组历史消息（游标分页）
   *     description: 按时间升序返回群组内消息（人类与 NPC 发言）。
   *       默认返回最近 limit 条；`before` 返回该消息之前的消息；`cursor` 正向翻页。
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         description: 群组 id
   *         schema:
   *           type: string
   *       - name: cursor
   *         in: query
   *         required: false
   *         description: 正向游标：返回该消息之后（不含）的 limit 条
   *         schema:
   *           type: string
   *       - name: before
   *         in: query
   *         required: false
   *         description: 反向锚点：返回该消息之前（不含）的 limit 条
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
   *         description: 群组消息列表
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/GroupMessageList'
   *       '401':
   *         description: 未登录或 token 无效
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       '404':
   *         description: 群组不存在或当前用户不是成员
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *       '400':
   *         description: cursor/before 不是该群组内的消息
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
  router.get('/:id/messages', validate(listMessagesQuerySchema, 'query'), async (req, res) => {
    const user = requireUser(req);
    const query = res.locals.validatedQuery as ListMessagesQuery;
    const messages = await listGroupMessages(user.id, paramId(req), query);
    res.json({ messages });
  });

  return router;
}
