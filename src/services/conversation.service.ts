/**
 * 个人对话服务：对话 CRUD 与标签管理
 *
 * 【ACL 设计（数据隔离）】
 * - 所有查询/写入都强制携带 userId 条件，确保用户只能操作自己的数据；
 * - 跨用户访问统一返回 404 CONVERSATION_NOT_FOUND（不泄露资源是否存在）；
 * - 删除对话利用外键 ON DELETE CASCADE 级联清理消息与标签关联。
 *
 * 【标签设计】
 * - 标签按「用户 + 名称」规范化存储（tags 表唯一约束），同名标签不重复；
 * - 通过关联表 conversation_tags 建立多对多关系；
 * - 多标签筛选为 AND 语义：对话必须同时拥有所有请求的标签。
 */
import type { Conversation, ConversationTag, Prisma, Tag } from '@prisma/client';

import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import type {
  AddTagInput,
  ConversationOutput,
  ConversationTagOutput,
  CreateConversationInput,
  UpdateConversationInput,
} from '../types/conversation.js';

// 创建对话时的默认标题；首条用户消息会自动替换它
export const DEFAULT_CONVERSATION_TITLE = '新对话';

// 带标签关联的对话类型（数据库查询结果）
type ConversationWithTags = Conversation & {
  tags: (ConversationTag & { tag: Tag })[];
};

// 统一的标签关联查询条件：按添加时间升序返回
const tagsInclude = {
  tags: {
    include: { tag: true },
    orderBy: { createdAt: 'asc' as const },
  },
};

/**
 * 序列化：数据库模型 → 对外输出结构
 *
 * @param conversation 含标签关联的对话记录
 * @returns ConversationOutput 对外输出（标签只暴露 id 与 name）
 */
function toConversationOutput(conversation: ConversationWithTags): ConversationOutput {
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    tags: conversation.tags.map((entry): ConversationTagOutput => ({
      id: entry.tag.id,
      name: entry.tag.name,
    })),
  };
}

/**
 * 对话所有权校验（ACL 核心）
 *
 * @param userId         当前登录用户 id
 * @param conversationId 目标对话 id
 * @returns Promise<void> 校验通过时正常返回
 * @throws AppError(404 CONVERSATION_NOT_FOUND) 对话不存在或不属于当前用户
 * 逻辑：以「id + userId」联合条件查询，命中即拥有所有权；未命中返回 404，
 * 避免向攻击者暴露资源是否存在。
 */
export async function assertConversationOwnership(
  userId: string,
  conversationId: string,
): Promise<void> {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, userId },
    select: { id: true },
  });
  if (!conversation) {
    logger.warn({ userId, conversationId }, 'conversation: ownership check failed');
    throw new AppError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found');
  }
}

/**
 * 创建个人对话
 *
 * @param userId 当前用户 id
 * @param input  { title? } 标题可选，缺省用默认标题
 * @returns Promise<ConversationOutput> 新对话（含空标签列表）
 */
export async function createConversation(
  userId: string,
  input: CreateConversationInput,
): Promise<ConversationOutput> {
  const conversation = await prisma.conversation.create({
    data: {
      userId,
      title: input.title?.trim() || DEFAULT_CONVERSATION_TITLE,
    },
    include: tagsInclude,
  });
  logger.info({ userId, conversationId: conversation.id }, 'conversation: created');
  return toConversationOutput(conversation);
}

/**
 * 对话列表（支持多标签 AND 筛选）
 *
 * @param userId   当前用户 id（只返回自己的对话）
 * @param tagNames 标签名数组；非空时要求对话同时拥有全部标签
 * @returns Promise<ConversationOutput[]> 按最近更新时间倒序
 * 逻辑：为每个标签生成一个 EXISTS 条件并组合为 AND，筛选在 SQL 层完成，
 * 避免全量拉取后在内存过滤（大数据量下更高效）。
 */
export async function listConversations(
  userId: string,
  tagNames: string[] = [],
): Promise<ConversationOutput[]> {
  const where: Prisma.ConversationWhereInput = { userId };
  if (tagNames.length > 0) {
    where.AND = tagNames.map((name) => ({
      tags: { some: { tag: { userId, name } } },
    }));
  }

  const conversations = await prisma.conversation.findMany({
    where,
    include: tagsInclude,
    orderBy: { updatedAt: 'desc' },
  });
  return conversations.map(toConversationOutput);
}

/**
 * 获取对话详情
 *
 * @param userId         当前用户 id
 * @param conversationId 目标对话 id
 * @returns Promise<ConversationOutput> 对话详情（含标签）
 * @throws AppError(404) 对话不存在或不属于当前用户
 */
export async function getConversation(
  userId: string,
  conversationId: string,
): Promise<ConversationOutput> {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, userId },
    include: tagsInclude,
  });
  if (!conversation) {
    throw new AppError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found');
  }
  return toConversationOutput(conversation);
}

/**
 * 修改对话标题
 *
 * @param userId         当前用户 id
 * @param conversationId 目标对话 id
 * @param input          { title } 新标题
 * @returns Promise<ConversationOutput> 更新后的对话
 * @throws AppError(404) 对话不存在或不属于当前用户
 */
export async function updateConversationTitle(
  userId: string,
  conversationId: string,
  input: UpdateConversationInput,
): Promise<ConversationOutput> {
  await assertConversationOwnership(userId, conversationId);
  const conversation = await prisma.conversation.update({
    where: { id: conversationId },
    data: { title: input.title.trim() },
    include: tagsInclude,
  });
  logger.debug({ userId, conversationId }, 'conversation: title updated');
  return toConversationOutput(conversation);
}

/**
 * 删除对话（级联删除其全部消息与标签关联）
 *
 * @param userId         当前用户 id
 * @param conversationId 目标对话 id
 * @returns Promise<void>
 * @throws AppError(404) 对话不存在或不属于当前用户
 */
export async function deleteConversation(userId: string, conversationId: string): Promise<void> {
  await assertConversationOwnership(userId, conversationId);
  await prisma.conversation.delete({ where: { id: conversationId } });
  logger.info({ userId, conversationId }, 'conversation: deleted');
}

/**
 * 为对话添加标签（幂等）
 *
 * @param userId         当前用户 id
 * @param conversationId 目标对话 id
 * @param input          { name } 标签名
 * @returns Promise<ConversationTagOutput> 标签（id + name）
 * @throws AppError(404) 对话不存在或不属于当前用户
 * 逻辑：先按「用户 + 名称」upsert 标签（同一用户同名标签只存一条），
 * 再 upsert 对话-标签关联（重复添加不报错）。
 */
export async function addTagToConversation(
  userId: string,
  conversationId: string,
  input: AddTagInput,
): Promise<ConversationTagOutput> {
  await assertConversationOwnership(userId, conversationId);

  const name = input.name.trim();
  const tag = await prisma.tag.upsert({
    where: { userId_name: { userId, name } },
    update: {},
    create: { userId, name },
  });
  await prisma.conversationTag.upsert({
    where: { conversationId_tagId: { conversationId, tagId: tag.id } },
    update: {},
    create: { conversationId, tagId: tag.id },
  });
  logger.debug({ userId, conversationId, tagId: tag.id }, 'conversation: tag added');
  return { id: tag.id, name: tag.name };
}

/**
 * 移除对话上的标签
 *
 * @param userId         当前用户 id
 * @param conversationId 目标对话 id
 * @param tagId          标签 id
 * @returns Promise<void>
 * @throws AppError(404 TAG_NOT_FOUND) 标签不在该对话上或不属于当前用户
 * 逻辑：先校验对话所有权，再按「对话 + 标签 + 标签归属用户」删除关联，
 * 双重归属校验防止越权操作。
 */
export async function removeTagFromConversation(
  userId: string,
  conversationId: string,
  tagId: string,
): Promise<void> {
  await assertConversationOwnership(userId, conversationId);
  const deleted = await prisma.conversationTag.deleteMany({
    where: { conversationId, tagId, tag: { userId } },
  });
  if (deleted.count === 0) {
    throw new AppError(404, 'TAG_NOT_FOUND', 'Tag not found on this conversation');
  }
  logger.debug({ userId, conversationId, tagId }, 'conversation: tag removed');
}
