/**
 * 消息服务：发送消息 / 历史分页 / AI 失败重试
 *
 * 【数据一致性设计（AI 调用失败时）】
 * 1. 用户消息先落库（SENT），确保用户输入永不丢失；
 * 2. 调用 AI 生成回复（含重试与超时），成功则回复落库（SENT）；
 * 3. 重试耗尽仍失败时，AI 消息以 FAILED 状态占位并记录 errorCode/errorMessage，
 *    前端可见「回复失败，可重试」；
 * 4. clientRequestId 幂等：同一对话内相同键重复提交直接返回首次结果，不产生重复消息；
 *    幂等键唯一约束限定为 (conversationId, clientRequestId) 复合键——查找时天然
 *    限定在已通过所有权校验的对话内，避免跨用户/跨对话误命中造成数据泄露或丢失；
 * 5. 对话仍为默认标题（isDefaultTitle=true）时，首条用户消息（超长截断）自动设为标题，
 *    并立刻把标记置为 false——用户手动设置过的标题永不覆盖；
 * 6. 用户消息落库后同步刷新 conversation.updatedAt，使对话列表按「最近活跃」排序；
 * 7. 对话级串行化：同一对话的「幂等检查 + 落库 + AI 调用」在互斥锁内执行——
 *    并发提交相同 clientRequestId 时，后者在锁内命中首次结果（不再撞唯一约束 500）；
 *    并发提交不同消息时回复按轮次顺序落库，多轮上下文不被并发污染。
 *
 * 【ACL】
 * 所有操作都经过 assertConversationOwnership（跨用户访问 404）或消息归属校验。
 */
import { MessageStatus, SenderType, type Message } from '@prisma/client';

import { AppError } from '../lib/errors.js';
import { createKeyedLock } from '../lib/locks.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import type {
  ListMessagesQuery,
  MessageOutput,
  SendMessageInput,
  SendMessageResult,
} from '../types/message.js';
import { buildContextHistory, MAX_CONTEXT_HISTORY } from './ai/context.js';
import type { AiService } from './ai/ai.service.js';
import { cacheKey, type AiReplyCache } from './ai/cache.js';
import { toAiErrorInfo } from './ai/errors.js';
import { assertConversationOwnership } from './conversation.service.js';

// 默认标题截断长度（首条用户消息用作标题）
const MAX_TITLE_LENGTH = 30;
// 对话级互斥锁：同一对话同时只允许一个「发送轮次」执行（见文件头第 7 条设计说明）
const conversationLocks = createKeyedLock();

/**
 * 序列化：数据库消息模型 → 对外输出结构
 *
 * @param message Prisma 消息记录
 * @returns MessageOutput 对外输出（含状态与错误信息）
 */
function toMessageOutput(message: Message): MessageOutput {
  return {
    id: message.id,
    senderType: message.senderType,
    senderUserId: message.senderUserId,
    content: message.content,
    status: message.status,
    errorCode: message.errorCode,
    errorMessage: message.errorMessage,
    createdAt: message.createdAt,
  };
}

/**
 * 若对话仍为默认标题，则将首条用户消息（超长截断）设为标题
 *
 * @param conversationId 对话 id
 * @param content        用户消息内容
 * @returns Promise<void>
 * 说明：仅当 isDefaultTitle=true（创建时未指定标题且从未手动修改）时才替换。
 * 通过 updateMany 的复合条件保证并发安全：只有一个请求能把默认标题消费掉；
 * 无论是否替换成功，都不影响用户消息已落库这一事实。
 */
async function maybeSetDefaultTitle(conversationId: string, content: string): Promise<void> {
  const title =
    content.length > MAX_TITLE_LENGTH ? `${content.slice(0, MAX_TITLE_LENGTH)}…` : content;
  const updated = await prisma.conversation.updateMany({
    where: { id: conversationId, isDefaultTitle: true },
    data: { title, isDefaultTitle: false },
  });
  if (updated.count > 0) {
    logger.debug({ conversationId, title }, 'message: default title replaced by first message');
  }
}

/**
 * 构建最近对话上下文（排除失败的 AI 消息，按时间升序）
 *
 * @param conversationId 对话 id
 * @param excludeMessageId 可选：排除某条消息（发送流程用它排除「刚落库的当前消息」，
 *                         避免当前消息在 history 与 content 里重复出现两次）
 * @returns Promise<Array<{ role, content }>> 供 AI 理解上下文
 * 说明：先取最近 MAX_CONTEXT_HISTORY（20）条，再交给 buildContextHistory
 * 应用滑动窗口/总结（只影响上下文，不影响历史展示）。
 */
async function buildHistory(
  conversationId: string,
  excludeMessageId?: string,
): Promise<Array<{ role: 'system' | 'user' | 'assistant'; content: string }>> {
  const recent = await prisma.message.findMany({
    where: {
      conversationId,
      status: { not: MessageStatus.FAILED },
      ...(excludeMessageId ? { id: { not: excludeMessageId } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: MAX_CONTEXT_HISTORY,
  });
  const messages = recent.reverse().map((m) => ({
    role: m.senderType === SenderType.HUMAN ? ('user' as const) : ('assistant' as const),
    content: m.content,
  }));
  // 滑动窗口 + 总结：达到阈值时用摘要替换最早部分，保留最近 5 条原文
  return buildContextHistory(messages);
}

/**
 * 发送消息（用户消息落库 + AI 回复生成与落库）
 *
 * @param aiService      AI 服务（含重试/超时）
 * @param userId         当前用户 id
 * @param conversationId 目标对话 id
 * @param userName       当前用户用户名（供 AI 回显「用户名说：」）
 * @param input          { content, clientRequestId? }
 * @returns Promise<SendMessageResult> 用户消息 + AI 回复（失败时为 FAILED 状态）
 * @throws AppError(404) 对话不存在或不属于当前用户
 * 主要逻辑：ACL 校验 → 幂等检查 → 用户消息落库 → 设置默认标题 → 构建上下文
 * → 调用 AI（成功 SENT / 失败 FAILED 占位）→ 返回两条消息。
 * 其中「锁内确认之后的全部步骤」都在对话级锁内执行，保证同一对话的写入串行。
 */
export async function sendMessage(
  aiService: AiService,
  userId: string,
  conversationId: string,
  userName: string,
  input: SendMessageInput,
  aiCache?: AiReplyCache | null,
): Promise<SendMessageResult> {
  // ACL：仅对话所有者可发送消息（锁外快速失败，避免非所有者阻塞在锁队列）
  await assertConversationOwnership(userId, conversationId);

  return conversationLocks(conversationId, async () => {
    // 锁内再次确认对话存在且属于当前用户：防止「锁外校验后对话被并发删除」的竞态
    const alive = await prisma.conversation.findFirst({
      where: { id: conversationId, userId },
      select: { id: true },
    });
    if (!alive) {
      throw new AppError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found');
    }

    const content = input.content.trim();

    // 幂等：以「对话 + clientRequestId」复合键查找（唯一约束见 schema）。
    // 锁内检查保证并发重复提交时，第二个请求必然看到首次结果，返回幂等响应。
    if (input.clientRequestId) {
      const existing = await prisma.message.findUnique({
        where: {
          conversationId_clientRequestId: {
            conversationId,
            clientRequestId: input.clientRequestId,
          },
        },
      });
      if (existing) {
        const existingAi = await prisma.message.findFirst({
          where: {
            conversationId,
            senderType: SenderType.BOT,
            createdAt: { gt: existing.createdAt },
          },
          orderBy: { createdAt: 'asc' },
        });
        logger.debug({ clientRequestId: input.clientRequestId }, 'message: idempotent hit');
        return {
          userMessage: toMessageOutput(existing),
          aiMessage: existingAi ? toMessageOutput(existingAi) : null,
        };
      }
    }

    // 第一步：用户消息立即落库（即使 AI 失败也不丢失）
    const userMessage = await prisma.message.create({
      data: {
        conversationId,
        senderType: SenderType.HUMAN,
        senderUserId: userId,
        content,
        status: MessageStatus.SENT,
        clientRequestId: input.clientRequestId,
      },
    });

    // 第二步：若仍为默认标题则替换为首条消息，并刷新对话 updatedAt（列表按最近活跃排序）
    await maybeSetDefaultTitle(conversationId, content);
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });

    // 缓存键：对话 + 规范化内容（同一对话内相同问题可回放）
    const cacheKeyStr = cacheKey([conversationId, content]);
    const cachedReply = aiCache?.get<string>(cacheKeyStr);

    // 第三步：缓存命中 → 直接回放上次回复（不调用 AI、不查历史，近乎瞬时返回）
    if (cachedReply) {
      logger.info({ conversationId, cacheKey: cacheKeyStr }, 'message: ai cache hit');
      const aiMessage = await prisma.message.create({
        data: {
          conversationId,
          senderType: SenderType.BOT,
          content: cachedReply,
          status: MessageStatus.SENT,
        },
      });
      return { userMessage: toMessageOutput(userMessage), aiMessage: toMessageOutput(aiMessage) };
    }

    const history = await buildHistory(conversationId, userMessage.id);

    // 第四步：调用 AI（含重试与超时），并按结果落库
    let aiMessage: Message;
    try {
      const reply = await aiService.generateWithRetry({ content, history, userName });
      aiMessage = await prisma.message.create({
        data: {
          conversationId,
          senderType: SenderType.BOT,
          content: reply,
          status: MessageStatus.SENT,
        },
      });
      // 仅成功回复写入缓存；失败/兜底不缓存（避免把故障结果当正确答案回放）
      aiCache?.set(cacheKeyStr, reply);
      logger.info(
        { userId, conversationId, aiMessageId: aiMessage.id, cacheKey: cacheKeyStr },
        'message: ai reply saved (cache set)',
      );
    } catch (err) {
      // 重试耗尽：以 FAILED 占位并记录错误信息，保证对话数据一致
      const info = toAiErrorInfo(err);
      aiMessage = await prisma.message.create({
        data: {
          conversationId,
          senderType: SenderType.BOT,
          content: '',
          status: MessageStatus.FAILED,
          errorCode: info.code,
          errorMessage: info.message,
        },
      });
      logger.error(
        { userId, conversationId, aiMessageId: aiMessage.id, errorCode: info.code },
        'message: ai reply failed after retries',
      );
    }

    return { userMessage: toMessageOutput(userMessage), aiMessage: toMessageOutput(aiMessage) };
  });
}

/**
 * 流式发送过程的事件回调（由路由层翻译为 SSE 帧）
 *
 * @property userMessage 用户消息已落库（前端据此渲染用户气泡）
 * @property aiDelta     AI 回复增量文本（前端逐块追加到 PENDING 气泡）
 * @property aiDone      AI 回复已完整落库（SENT，携带最终完整消息）
 * @property aiError     AI 回复重试耗尽失败（FAILED 占位，携带错误信息）
 */
export interface MessageStreamEvents {
  userMessage?: (message: MessageOutput) => void;
  aiDelta?: (delta: string) => void;
  aiDone?: (message: MessageOutput) => void;
  aiError?: (message: MessageOutput) => void;
}

/**
 * 流式发送消息（用户消息落库 + AI 回复流式生成与落库）
 *
 * @param aiService      AI 服务（流式重试/空闲超时）
 * @param userId         当前用户 id
 * @param conversationId 目标对话 id
 * @param userName       当前用户用户名（供 AI 回显「用户名说：」）
 * @param input          { content, clientRequestId? }
 * @param events         流式事件回调（userMessage/aiDelta/aiDone/aiError）
 * @param clientSignal   可选：客户端断连信号（断连时中止 AI 调用并落 FAILED）
 * @returns Promise<void> 流结束或失败后 resolve（错误以 aiError 事件反馈）
 * @throws AppError(404) 对话不存在或不属于当前用户（发生在任何事件发出之前）
 *
 * 与 sendMessage 的差异（数据一致性设计）：
 * - AI 回复在生成前就落库为 PENDING（拿到稳定消息 id），前端立即有占位气泡；
 * - 每个增量块通过 aiDelta 事件透传，同时在内存累积；
 * - 全部块接收完后一次性更新为 SENT（完整内容）；中途失败则更新为 FAILED，
 *   已产出的部分内容保留（用户能看到「说到一半」的回复）并记录 errorCode；
 * - 幂等命中直接回放 userMessage + aiDone（复用既有记录），不重复生成。
 */
export async function streamSendMessage(
  aiService: AiService,
  userId: string,
  conversationId: string,
  userName: string,
  input: SendMessageInput,
  events: MessageStreamEvents = {},
  clientSignal?: AbortSignal,
  aiCache?: AiReplyCache | null,
): Promise<void> {
  // ACL：仅对话所有者可发送消息（锁外快速失败，避免非所有者阻塞在锁队列）
  await assertConversationOwnership(userId, conversationId);

  await conversationLocks(conversationId, async () => {
    // 锁内再次确认对话存在且属于当前用户：防止「锁外校验后对话被并发删除」的竞态
    const alive = await prisma.conversation.findFirst({
      where: { id: conversationId, userId },
      select: { id: true },
    });
    if (!alive) {
      throw new AppError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found');
    }

    const content = input.content.trim();

    // 幂等：以「对话 + clientRequestId」复合键查找（唯一约束见 schema）。
    // 命中时直接回放首次结果（用户消息 + 完整 AI 回复），不重复生成。
    if (input.clientRequestId) {
      const existing = await prisma.message.findUnique({
        where: {
          conversationId_clientRequestId: {
            conversationId,
            clientRequestId: input.clientRequestId,
          },
        },
      });
      if (existing) {
        const existingAi = await prisma.message.findFirst({
          where: {
            conversationId,
            senderType: SenderType.BOT,
            createdAt: { gt: existing.createdAt },
          },
          orderBy: { createdAt: 'asc' },
        });
        logger.debug({ clientRequestId: input.clientRequestId }, 'message: stream idempotent hit');
        events.userMessage?.(toMessageOutput(existing));
        if (existingAi) {
          events.aiDone?.(toMessageOutput(existingAi));
        }
        return;
      }
    }

    // 第一步：用户消息立即落库（即使 AI 失败也不丢失）
    const userMessage = await prisma.message.create({
      data: {
        conversationId,
        senderType: SenderType.HUMAN,
        senderUserId: userId,
        content,
        status: MessageStatus.SENT,
        clientRequestId: input.clientRequestId,
      },
    });

    // 第二步：默认标题替换 + 刷新对话 updatedAt（列表按最近活跃排序）
    await maybeSetDefaultTitle(conversationId, content);
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });

    // 缓存键：对话 + 规范化内容
    const cacheKeyStr = cacheKey([conversationId, content]);
    const cachedReply = aiCache?.get<string>(cacheKeyStr);

    // 缓存命中：直接落一条 SENT 回复并回放 aiDone（无增量流，近乎瞬时）
    if (cachedReply) {
      logger.info({ conversationId, cacheKey: cacheKeyStr }, 'message: stream ai cache hit');
      const aiMessage = await prisma.message.create({
        data: {
          conversationId,
          senderType: SenderType.BOT,
          content: cachedReply,
          status: MessageStatus.SENT,
        },
      });
      events.userMessage?.(toMessageOutput(userMessage));
      events.aiDone?.(toMessageOutput(aiMessage));
      return;
    }

    const history = await buildHistory(conversationId, userMessage.id);

    // 第三步：AI 回复先以 PENDING 落库占位（拿到稳定消息 id），
    // 流式块到达后再在内存累积，全部完成后一次性更新为 SENT。
    const aiMessage = await prisma.message.create({
      data: {
        conversationId,
        senderType: SenderType.BOT,
        content: '',
        status: MessageStatus.PENDING,
      },
    });

    // 先通知前端用户消息已落库，再开始推送 AI 增量
    events.userMessage?.(toMessageOutput(userMessage));

    // 第四步：流式生成（含重试与空闲超时），逐块回调并累积完整回复
    let partial = '';
    try {
      for await (const delta of aiService.streamWithRetry(
        { content, history, userName },
        { clientSignal },
      )) {
        partial += delta;
        events.aiDelta?.(delta);
      }
      // 第五步：流正常结束 → 更新为 SENT（完整内容）
      const saved = await prisma.message.update({
        where: { id: aiMessage.id },
        data: { content: partial, status: MessageStatus.SENT, errorCode: null, errorMessage: null },
      });
      // 流式完整生成成功 → 写入缓存（仅成功回复）
      aiCache?.set(cacheKeyStr, partial);
      logger.info(
        { userId, conversationId, aiMessageId: saved.id, chars: saved.content.length },
        'message: stream ai reply saved (cache set)',
      );
      events.aiDone?.(toMessageOutput(saved));
    } catch (err) {
      // 重试耗尽/客户端断连/流中断：更新为 FAILED 并保留已产出部分内容，
      // 前端可见「回复中断/失败」并展示部分文本与重试入口
      const info = toAiErrorInfo(err);
      const saved = await prisma.message.update({
        where: { id: aiMessage.id },
        data: {
          content: partial,
          status: MessageStatus.FAILED,
          errorCode: info.code,
          errorMessage: info.message,
        },
      });
      logger.error(
        {
          userId,
          conversationId,
          aiMessageId: saved.id,
          errorCode: info.code,
          partialChars: partial.length,
        },
        'message: stream ai reply failed',
      );
      events.aiError?.(toMessageOutput(saved));
    }
  });
}

/**
 * 历史消息分页查询（游标分页，按时间升序）
 *
 * @param userId         当前用户 id
 * @param conversationId 目标对话 id
 * @param query          { cursor?, before?, limit }
 * @returns Promise<MessageOutput[]> 按时间升序的消息列表
 * @throws AppError(404) 对话不存在或不属于当前用户
 * @throws AppError(400 INVALID_CURSOR) cursor/before 不是该对话内的消息
 *
 * 分页语义：
 * - 默认（cursor 与 before 都省略）：返回最近 limit 条（升序），聊天页首屏展示最新消息；
 * - before=<id>：返回该消息之前（不含）的 limit 条（升序），用于「加载更早」；
 * - cursor=<id>：返回该消息之后（不含）的 limit 条（升序），用于正向向下翻页。
 */
export async function listMessages(
  userId: string,
  conversationId: string,
  query: ListMessagesQuery,
): Promise<MessageOutput[]> {
  await assertConversationOwnership(userId, conversationId);

  // 游标/锚点校验：cursor 与 before 都必须是「当前对话内」的消息。
  // 若传了不存在的 id 或他人对话的消息 id，统一返回 400（而不是 Prisma 报错/静默空列表）。
  const anchorId = query.before ?? query.cursor;
  let anchor: { id: string; createdAt: Date } | null = null;
  if (anchorId) {
    anchor = await prisma.message.findFirst({
      where: { id: anchorId, conversationId },
      select: { id: true, createdAt: true },
    });
    if (!anchor) {
      throw new AppError(400, 'INVALID_CURSOR', 'Cursor message not found in this conversation');
    }
  }

  let messages: Message[];
  if (query.before && anchor) {
    // 反向分页：取锚点之前（按 (createdAt, id) 复合键严格小于）的 limit 条，
    // 先倒序取再反转回升序，保证「最近优先取满一页」且返回顺序仍为时间升序。
    messages = await prisma.message.findMany({
      where: {
        conversationId,
        OR: [
          { createdAt: { lt: anchor.createdAt } },
          { createdAt: anchor.createdAt, id: { lt: anchor.id } },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit,
    });
    messages.reverse();
  } else if (query.cursor) {
    // 正向分页：以 (createdAt, id) 升序，从游标之后继续取
    messages = await prisma.message.findMany({
      where: { conversationId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: query.limit,
      cursor: { id: query.cursor },
      skip: 1,
    });
  } else {
    // 默认：返回最近 limit 条（升序），聊天页首屏应展示最新消息
    messages = await prisma.message.findMany({
      where: { conversationId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit,
    });
    messages.reverse();
  }
  return messages.map(toMessageOutput);
}

/**
 * 重试失败的 AI 消息
 *
 * @param aiService AI 服务
 * @param userId    当前用户 id
 * @param userName  当前用户用户名（供 AI 回显「用户名说：」）
 * @param messageId 目标消息 id
 * @returns Promise<MessageOutput> 重试后的 AI 消息（成功 SENT / 仍失败则保持 FAILED 并更新错误信息）
 * @throws AppError(404) 消息不存在或不属于当前用户
 * @throws AppError(409 MESSAGE_NOT_RETRYABLE) 消息不是 FAILED 的 AI 消息
 * 主要逻辑：归属校验 → 状态校验 → 取最近人类消息作为输入 → 重新生成 → 更新消息。
 */
export async function retryAiMessage(
  aiService: AiService,
  userId: string,
  userName: string,
  messageId: string,
): Promise<MessageOutput> {
  const message = await prisma.message.findUnique({
    where: { id: messageId },
    include: { conversation: { select: { userId: true } } },
  });
  // ACL：消息不存在或不属于当前用户 → 404
  if (!message || message.conversation.userId !== userId) {
    throw new AppError(404, 'MESSAGE_NOT_FOUND', 'Message not found');
  }
  if (message.senderType !== SenderType.BOT) {
    throw new AppError(409, 'MESSAGE_NOT_RETRYABLE', 'Only AI messages can be retried');
  }
  if (message.status !== MessageStatus.FAILED) {
    throw new AppError(409, 'MESSAGE_NOT_RETRYABLE', 'Message is not in a retryable state');
  }

  // 取失败消息之前最近的人类消息作为重新生成的输入
  const promptMessage = await prisma.message.findFirst({
    where: {
      conversationId: message.conversationId,
      senderType: SenderType.HUMAN,
      createdAt: { lt: message.createdAt },
    },
    orderBy: { createdAt: 'desc' },
  });

  // 取失败消息之前的历史（排除 FAILED，最多 MAX_CONTEXT_HISTORY 条）作为重试的多轮上下文，
  // 与正常发送消息的 buildHistory 行为保持一致，避免重试退化为单轮回答。
  const history = await prisma.message.findMany({
    where: {
      conversationId: message.conversationId,
      createdAt: { lt: message.createdAt },
      status: { not: MessageStatus.FAILED },
    },
    orderBy: { createdAt: 'desc' },
    take: MAX_CONTEXT_HISTORY,
  });
  const contextHistory = buildContextHistory(
    history.reverse().map((m) => ({
      role: m.senderType === SenderType.HUMAN ? ('user' as const) : ('assistant' as const),
      content: m.content,
    })),
  );

  try {
    const reply = await aiService.generateWithRetry({
      content: promptMessage?.content ?? '请重新生成回复',
      history: contextHistory,
      userName,
    });
    const updated = await prisma.message.update({
      where: { id: messageId },
      data: { content: reply, status: MessageStatus.SENT, errorCode: null, errorMessage: null },
    });
    logger.info({ userId, messageId }, 'message: ai reply retried successfully');
    return toMessageOutput(updated);
  } catch (err) {
    const info = toAiErrorInfo(err);
    const updated = await prisma.message.update({
      where: { id: messageId },
      data: { errorCode: info.code, errorMessage: info.message },
    });
    logger.error({ userId, messageId, errorCode: info.code }, 'message: ai reply retry failed');
    return toMessageOutput(updated);
  }
}
