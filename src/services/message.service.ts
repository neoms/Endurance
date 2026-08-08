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
 * 5. 对话仍为默认标题时，首条用户消息（超长截断）自动设为标题。
 *
 * 【ACL】
 * 所有操作都经过 assertConversationOwnership（跨用户访问 404）或消息归属校验。
 */
import { MessageStatus, SenderType, type Message } from '@prisma/client';

import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import type {
  ListMessagesQuery,
  MessageOutput,
  SendMessageInput,
  SendMessageResult,
} from '../types/message.js';
import type { AiService } from './ai/ai.service.js';
import { toAiErrorInfo } from './ai/errors.js';
import { assertConversationOwnership, DEFAULT_CONVERSATION_TITLE } from './conversation.service.js';

// 默认标题截断长度（首条用户消息用作标题）
const MAX_TITLE_LENGTH = 30;
// 提供给 AI 的上下文消息条数
const HISTORY_SIZE = 10;

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
 * 说明：仅当标题仍是默认值「新对话」时才替换，用户手动改过的标题不会被覆盖。
 */
async function maybeSetDefaultTitle(conversationId: string, content: string): Promise<void> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { title: true },
  });
  if (conversation?.title === DEFAULT_CONVERSATION_TITLE) {
    const title =
      content.length > MAX_TITLE_LENGTH ? `${content.slice(0, MAX_TITLE_LENGTH)}…` : content;
    await prisma.conversation.update({ where: { id: conversationId }, data: { title } });
    logger.debug({ conversationId, title }, 'message: default title replaced by first message');
  }
}

/**
 * 构建最近对话上下文（排除失败的 AI 消息，按时间升序）
 *
 * @param conversationId 对话 id
 * @returns Promise<Array<{ role, content }>> 供 AI 理解上下文
 */
async function buildHistory(
  conversationId: string,
): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  const recent = await prisma.message.findMany({
    where: { conversationId, status: { not: MessageStatus.FAILED } },
    orderBy: { createdAt: 'desc' },
    take: HISTORY_SIZE,
  });
  return recent.reverse().map((m) => ({
    role: m.senderType === SenderType.HUMAN ? ('user' as const) : ('assistant' as const),
    content: m.content,
  }));
}

/**
 * 发送消息（用户消息落库 + AI 回复生成与落库）
 *
 * @param aiService      AI 服务（含重试/超时）
 * @param userId         当前用户 id
 * @param conversationId 目标对话 id
 * @param input          { content, clientRequestId? }
 * @returns Promise<SendMessageResult> 用户消息 + AI 回复（失败时为 FAILED 状态）
 * @throws AppError(404) 对话不存在或不属于当前用户
 * 主要逻辑：ACL 校验 → 幂等检查 → 用户消息落库 → 设置默认标题 → 构建上下文
 * → 调用 AI（成功 SENT / 失败 FAILED 占位）→ 返回两条消息。
 */
export async function sendMessage(
  aiService: AiService,
  userId: string,
  conversationId: string,
  input: SendMessageInput,
): Promise<SendMessageResult> {
  // ACL：仅对话所有者可发送消息
  await assertConversationOwnership(userId, conversationId);
  const content = input.content.trim();

  // 幂等：以「对话 + clientRequestId」复合键查找（唯一约束见 schema）。
  // 对话 id 已通过上面的所有权校验，因此命中记录必属于当前用户，杜绝跨用户泄露；
  // 命中时直接返回首次结果，不重复生成，避免客户端重复提交产生重复消息。
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

  // 第二步：更新默认标题并构建上下文
  await maybeSetDefaultTitle(conversationId, content);
  const history = await buildHistory(conversationId);

  // 第三步：调用 AI（含重试与超时），并按结果落库
  let aiMessage: Message;
  try {
    const reply = await aiService.generateWithRetry({ content, history });
    aiMessage = await prisma.message.create({
      data: {
        conversationId,
        senderType: SenderType.BOT,
        content: reply,
        status: MessageStatus.SENT,
      },
    });
    logger.info({ userId, conversationId, aiMessageId: aiMessage.id }, 'message: ai reply saved');
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
}

/**
 * 历史消息分页查询（游标分页，按时间升序）
 *
 * @param userId         当前用户 id
 * @param conversationId 目标对话 id
 * @param query          { cursor?, limit }
 * @returns Promise<MessageOutput[]> 按时间升序的消息列表
 * @throws AppError(404) 对话不存在或不属于当前用户
 */
export async function listMessages(
  userId: string,
  conversationId: string,
  query: ListMessagesQuery,
): Promise<MessageOutput[]> {
  await assertConversationOwnership(userId, conversationId);
  const messages = await prisma.message.findMany({
    where: { conversationId },
    // 以 (createdAt, id) 双字段排序，保证游标分页顺序稳定
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: query.limit,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });
  return messages.map(toMessageOutput);
}

/**
 * 重试失败的 AI 消息
 *
 * @param aiService AI 服务
 * @param userId    当前用户 id
 * @param messageId 目标消息 id
 * @returns Promise<MessageOutput> 重试后的 AI 消息（成功 SENT / 仍失败则保持 FAILED 并更新错误信息）
 * @throws AppError(404) 消息不存在或不属于当前用户
 * @throws AppError(409 MESSAGE_NOT_RETRYABLE) 消息不是 FAILED 的 AI 消息
 * 主要逻辑：归属校验 → 状态校验 → 取最近人类消息作为输入 → 重新生成 → 更新消息。
 */
export async function retryAiMessage(
  aiService: AiService,
  userId: string,
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

  try {
    const reply = await aiService.generateWithRetry({
      content: promptMessage?.content ?? '请重新生成回复',
      history: [],
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
