/**
 * 群组对话服务：群组 CRUD、成员/机器人管理、群组消息与机器人响应逻辑
 *
 * 【权限模型】
 * - OWNER（创建者）：可修改配置、管理成员与机器人；不可被移除、不可离开；
 * - MEMBER（普通成员）：可查看、发消息、离开群组；
 * - 非成员访问统一返回 404（不泄露群组存在性）；越权管理返回 403。
 *
 * 【机器人响应逻辑（核心）】
 * - 响应策略（responseMode）：
 *   * ALL_BOTS：本轮全部机器人回复；
 *   * RANDOM_ONE：随机一个机器人回复；
 *   * CONTENT_ROUTED：按 replyTendency 关键词匹配；无命中时随机兜底一个。
 * - 防循环（三层）：
 *   1. 触发源限制：只有人类消息开启新轮次（roundId），机器人消息永不触发新轮次；
 *   2. 轮次硬上限：每轮回复数 ≤ maxConsecutiveBotReplies；
 *   3. 串行化：同一群组一次只有一个生成轮次（in-flight 锁），避免并发竞态。
 * - 保证回复：某机器人生成失败时以兜底文案占位；群组始终至少保留 1 个机器人，
 *   且 CONTENT_ROUTED 无命中时也会选一个机器人，保证人类消息后必有回复。
 */
import {
  GroupResponseMode,
  MemberRole,
  MessageStatus,
  SenderType,
  type Bot,
  type ChatGroup,
  type GroupBot,
  type GroupMember,
  type GroupMessage,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import type {
  CreateGroupInput,
  GroupMessageOutput,
  GroupOutput,
  SendGroupMessageResult,
  UpdateGroupInput,
} from '../types/group.js';
import type { AiService } from './ai/ai.service.js';

// 机器人生成失败时的兜底文案（保证人类消息后必有回复）
const FALLBACK_REPLY = '我暂时无法回答，请稍后再试。';
// 提供给机器人的上下文消息条数
const GROUP_HISTORY_SIZE = 10;

// 群组级 in-flight 锁：同一群组同时只允许一个生成轮次
const groupLocks = new Map<string, Promise<void>>();

/**
 * 群组级互斥锁
 *
 * @param groupId 群组 id
 * @param task    需要串行执行的任务
 * @returns Promise<T> 任务结果（等待前一个轮次完成后执行）
 * 说明：通过 Promise 链让同一群组的轮次排队执行，避免并发超发机器人回复。
 */
async function withGroupLock<T>(groupId: string, task: () => Promise<T>): Promise<T> {
  const previous = groupLocks.get(groupId) ?? Promise.resolve();
  // 无论前一个轮次成败，都继续执行当前任务
  const run = previous.then(task, task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  groupLocks.set(groupId, tail);
  // 轮次结束后清理锁（仅当仍是自己的尾 Promise 时删除）
  void tail.then(() => {
    if (groupLocks.get(groupId) === tail) {
      groupLocks.delete(groupId);
    }
  });
  return run;
}

/**
 * 判断消息内容是否命中机器人的关键词倾向
 *
 * @param replyTendency 逗号分隔的关键词（如 "代码,bug,api"）
 * @param content       用户消息内容
 * @returns boolean 任一关键词（小写包含匹配）命中返回 true
 */
function keywordMatches(replyTendency: string, content: string): boolean {
  const normalized = content.toLowerCase();
  return replyTendency
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean)
    .some((keyword) => normalized.includes(keyword));
}

/**
 * 按响应策略选择本轮回复的机器人（纯函数，便于单元测试）
 *
 * @param bots        群组内启用的机器人
 * @param mode        响应策略
 * @param content     用户消息内容
 * @param maxReplies  每轮最大回复数（防循环硬上限）
 * @returns Bot[] 本轮回复的机器人（数量 ≤ maxReplies，且保证非空兜底）
 * 说明：CONTENT_ROUTED 无命中时随机选一个机器人兜底，保证必有回复。
 */
export function selectBotsForRound(
  bots: Bot[],
  mode: GroupResponseMode,
  content: string,
  maxReplies: number,
): Bot[] {
  let selected: Bot[];
  switch (mode) {
    case GroupResponseMode.ALL_BOTS:
      selected = [...bots];
      break;
    case GroupResponseMode.RANDOM_ONE:
      selected = bots.length > 0 ? [bots[Math.floor(Math.random() * bots.length)]!] : [];
      break;
    case GroupResponseMode.CONTENT_ROUTED:
      selected = bots.filter((bot) => keywordMatches(bot.replyTendency, content));
      // 兜底：无关键词命中时随机选一个机器人，保证必有回复
      if (selected.length === 0 && bots.length > 0) {
        selected = [bots[Math.floor(Math.random() * bots.length)]!];
      }
      break;
    default:
      selected = [];
  }
  return selected.slice(0, Math.max(1, maxReplies));
}

/**
 * 群组成员访问校验（ACL）
 *
 * @param userId  当前用户 id
 * @param groupId 目标群组 id
 * @returns Promise<GroupMember> 成员记录
 * @throws AppError(404 GROUP_NOT_FOUND) 群组不存在或当前用户不是成员
 */
async function assertGroupAccess(userId: string, groupId: string): Promise<GroupMember> {
  const member = await prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId, userId } },
  });
  if (!member) {
    throw new AppError(404, 'GROUP_NOT_FOUND', 'Group not found');
  }
  return member;
}

/**
 * 群组管理员校验（仅 OWNER 可管理）
 *
 * @param userId  当前用户 id
 * @param groupId 目标群组 id
 * @returns Promise<GroupMember> 成员记录
 * @throws AppError(404) 非成员；AppError(403 FORBIDDEN) 成员但非 OWNER
 */
async function assertGroupOwner(userId: string, groupId: string): Promise<GroupMember> {
  const member = await assertGroupAccess(userId, groupId);
  if (member.role !== MemberRole.OWNER) {
    throw new AppError(403, 'FORBIDDEN', 'Only the group creator can perform this action');
  }
  return member;
}

/**
 * 序列化：群组模型 → 对外输出（含成员与机器人）
 *
 * @param group 含 members（含 user）与 bots（含 bot）的群组记录
 * @returns GroupOutput
 */
function toGroupOutput(
  group: ChatGroup & {
    members: (GroupMember & { user: { displayName: string } })[];
    bots: (GroupBot & { bot: Bot })[];
  },
): GroupOutput {
  return {
    id: group.id,
    name: group.name,
    creatorId: group.creatorId,
    responseMode: group.responseMode,
    maxConsecutiveBotReplies: group.maxConsecutiveBotReplies,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
    members: group.members.map((m) => ({
      userId: m.userId,
      displayName: m.user.displayName,
      role: m.role,
      joinedAt: m.joinedAt,
    })),
    bots: group.bots.map((gb) => ({
      id: gb.bot.id,
      code: gb.bot.code,
      name: gb.bot.name,
      personality: gb.bot.personality,
    })),
  };
}

/**
 * 序列化：群组消息模型 → 对外输出
 *
 * @param message 群组消息记录
 * @returns GroupMessageOutput
 */
function toGroupMessageOutput(message: GroupMessage): GroupMessageOutput {
  return {
    id: message.id,
    groupId: message.groupId,
    roundId: message.roundId,
    senderType: message.senderType,
    userId: message.userId,
    botId: message.botId,
    content: message.content,
    status: message.status,
    createdAt: message.createdAt,
  };
}

/**
 * 创建群组（创建者自动成为 OWNER 成员）
 *
 * @param userId 创建者用户 id
 * @param input  { name, responseMode?, maxConsecutiveBotReplies?, botIds[] }
 * @returns Promise<GroupOutput> 新群组（含成员与机器人）
 * @throws AppError(404 BOT_NOT_FOUND) 指定的机器人不存在或未启用
 * 事务内完成：建群 → 创建者成员 → 关联机器人。
 */
export async function createGroup(userId: string, input: CreateGroupInput): Promise<GroupOutput> {
  const bots = await prisma.bot.findMany({
    where: { id: { in: input.botIds }, isActive: true },
  });
  if (bots.length !== input.botIds.length) {
    throw new AppError(404, 'BOT_NOT_FOUND', 'One or more bots not found');
  }

  const group = await prisma.$transaction(async (tx) => {
    const created = await tx.chatGroup.create({
      data: {
        name: input.name.trim(),
        creatorId: userId,
        responseMode: input.responseMode ?? GroupResponseMode.ALL_BOTS,
        maxConsecutiveBotReplies: input.maxConsecutiveBotReplies ?? 3,
      },
    });
    await tx.groupMember.create({
      data: { groupId: created.id, userId, role: MemberRole.OWNER },
    });
    await tx.groupBot.createMany({
      data: input.botIds.map((botId) => ({ groupId: created.id, botId })),
    });
    return created;
  });

  logger.info({ userId, groupId: group.id }, 'group: created');
  return getGroup(userId, group.id);
}

/**
 * 我参与的群组列表
 *
 * @param userId 当前用户 id
 * @returns Promise<GroupOutput[]> 按创建时间倒序
 */
export async function listGroups(userId: string): Promise<GroupOutput[]> {
  const memberships = await prisma.groupMember.findMany({
    where: { userId },
    include: {
      group: {
        include: {
          members: { include: { user: { select: { displayName: true } } } },
          bots: { include: { bot: true } },
        },
      },
    },
    orderBy: { joinedAt: 'desc' },
  });
  return memberships.map((m) => toGroupOutput(m.group));
}

/**
 * 群组详情
 *
 * @param userId  当前用户 id
 * @param groupId 目标群组 id
 * @returns Promise<GroupOutput> 群组详情（成员 + 机器人）
 * @throws AppError(404) 群组不存在或当前用户不是成员
 */
export async function getGroup(userId: string, groupId: string): Promise<GroupOutput> {
  await assertGroupAccess(userId, groupId);
  const group = await prisma.chatGroup.findUnique({
    where: { id: groupId },
    include: {
      members: { include: { user: { select: { displayName: true } } } },
      bots: { include: { bot: true } },
    },
  });
  if (!group) {
    throw new AppError(404, 'GROUP_NOT_FOUND', 'Group not found');
  }
  return toGroupOutput(group);
}

/**
 * 更新群组配置（仅创建者）
 *
 * @param userId  当前用户 id
 * @param groupId 目标群组 id
 * @param input   至少一个字段：name / responseMode / maxConsecutiveBotReplies
 * @returns Promise<GroupOutput> 更新后的群组
 * @throws AppError(403) 非创建者；AppError(404) 非成员
 */
export async function updateGroup(
  userId: string,
  groupId: string,
  input: UpdateGroupInput,
): Promise<GroupOutput> {
  await assertGroupOwner(userId, groupId);
  await prisma.chatGroup.update({
    where: { id: groupId },
    data: {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.responseMode !== undefined ? { responseMode: input.responseMode } : {}),
      ...(input.maxConsecutiveBotReplies !== undefined
        ? { maxConsecutiveBotReplies: input.maxConsecutiveBotReplies }
        : {}),
    },
  });
  logger.info({ userId, groupId }, 'group: updated');
  return getGroup(userId, groupId);
}

/**
 * 添加成员（仅创建者；不能添加创建者本人）
 *
 * @param userId      当前用户 id（OWNER）
 * @param groupId     目标群组 id
 * @param targetUserId 待添加的用户 id
 * @returns Promise<GroupOutput> 更新后的群组
 * @throws AppError(403) 非创建者；404 目标用户不存在；409 已是成员
 */
export async function addGroupMember(
  userId: string,
  groupId: string,
  targetUserId: string,
): Promise<GroupOutput> {
  await assertGroupOwner(userId, groupId);
  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { id: true },
  });
  if (!target) {
    throw new AppError(404, 'USER_NOT_FOUND', 'Target user not found');
  }
  const existing = await prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId, userId: targetUserId } },
  });
  if (existing) {
    throw new AppError(409, 'ALREADY_MEMBER', 'User is already a member');
  }
  await prisma.groupMember.create({
    data: { groupId, userId: targetUserId, role: MemberRole.MEMBER },
  });
  logger.info({ userId, groupId, targetUserId }, 'group: member added');
  return getGroup(userId, groupId);
}

/**
 * 移除成员（仅创建者；不能移除创建者本人）
 *
 * @param userId      当前用户 id（OWNER）
 * @param groupId     目标群组 id
 * @param targetUserId 待移除的用户 id
 * @returns Promise<GroupOutput> 更新后的群组
 * @throws AppError(403) 非创建者或试图移除创建者；404 目标不是成员
 */
export async function removeGroupMember(
  userId: string,
  groupId: string,
  targetUserId: string,
): Promise<GroupOutput> {
  await assertGroupOwner(userId, groupId);
  const target = await prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId, userId: targetUserId } },
  });
  if (!target) {
    throw new AppError(404, 'MEMBER_NOT_FOUND', 'Target user is not a member');
  }
  if (target.role === MemberRole.OWNER) {
    throw new AppError(403, 'FORBIDDEN', 'The group creator cannot be removed');
  }
  await prisma.groupMember.delete({
    where: { groupId_userId: { groupId, userId: targetUserId } },
  });
  logger.info({ userId, groupId, targetUserId }, 'group: member removed');
  return getGroup(userId, groupId);
}

/**
 * 成员离开群组（创建者不可离开）
 *
 * @param userId  当前用户 id
 * @param groupId 目标群组 id
 * @returns Promise<void>
 * @throws AppError(403) 创建者不可离开；AppError(404) 非成员
 */
export async function leaveGroup(userId: string, groupId: string): Promise<void> {
  const member = await assertGroupAccess(userId, groupId);
  if (member.role === MemberRole.OWNER) {
    throw new AppError(403, 'FORBIDDEN', 'The group creator cannot leave the group');
  }
  await prisma.groupMember.delete({
    where: { groupId_userId: { groupId, userId } },
  });
  logger.info({ userId, groupId }, 'group: member left');
}

/**
 * 添加机器人（仅创建者；重复添加幂等）
 *
 * @param userId  当前用户 id（OWNER）
 * @param groupId 目标群组 id
 * @param botId   机器人 id
 * @returns Promise<GroupOutput> 更新后的群组
 * @throws AppError(403) 非创建者；404 机器人不存在
 */
export async function addBotToGroup(
  userId: string,
  groupId: string,
  botId: string,
): Promise<GroupOutput> {
  await assertGroupOwner(userId, groupId);
  const bot = await prisma.bot.findUnique({ where: { id: botId }, select: { id: true } });
  if (!bot) {
    throw new AppError(404, 'BOT_NOT_FOUND', 'Bot not found');
  }
  // upsert：重复添加幂等，不报错
  await prisma.groupBot.upsert({
    where: { groupId_botId: { groupId, botId } },
    update: {},
    create: { groupId, botId },
  });
  logger.info({ userId, groupId, botId }, 'group: bot added');
  return getGroup(userId, groupId);
}

/**
 * 移除机器人（仅创建者；群组必须至少保留 1 个机器人）
 *
 * @param userId  当前用户 id（OWNER）
 * @param groupId 目标群组 id
 * @param botId   机器人 id
 * @returns Promise<GroupOutput> 更新后的群组
 * @throws AppError(403) 非创建者；404 机器人不在群组；409 LAST_BOT 最后一个机器人不可移除
 */
export async function removeBotFromGroup(
  userId: string,
  groupId: string,
  botId: string,
): Promise<GroupOutput> {
  await assertGroupOwner(userId, groupId);
  const existing = await prisma.groupBot.findUnique({
    where: { groupId_botId: { groupId, botId } },
  });
  if (!existing) {
    throw new AppError(404, 'BOT_NOT_FOUND', 'Bot is not in this group');
  }
  const botCount = await prisma.groupBot.count({ where: { groupId } });
  if (botCount <= 1) {
    throw new AppError(409, 'LAST_BOT', 'A group must keep at least one bot');
  }
  await prisma.groupBot.delete({ where: { groupId_botId: { groupId, botId } } });
  logger.info({ userId, groupId, botId }, 'group: bot removed');
  return getGroup(userId, groupId);
}

/**
 * 构建群组最近消息上下文（供机器人参考）
 *
 * @param groupId 群组 id
 * @returns Promise<Array<{ role, content }>> 最近消息（时间升序）
 */
async function buildGroupHistory(
  groupId: string,
): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  const recent = await prisma.groupMessage.findMany({
    where: { groupId },
    orderBy: { createdAt: 'desc' },
    take: GROUP_HISTORY_SIZE,
  });
  return recent.reverse().map((m) => ({
    role: m.senderType === SenderType.HUMAN ? ('user' as const) : ('assistant' as const),
    content: m.content,
  }));
}

/**
 * 发送群组消息（人类消息 → 触发本轮机器人回复）
 *
 * @param aiService AI 服务
 * @param userId    当前用户 id（须是群组成员）
 * @param groupId   目标群组 id
 * @param input     { content }
 * @returns Promise<SendGroupMessageResult> 人类消息 + 本轮机器人回复列表
 * @throws AppError(404) 群组不存在或当前用户不是成员
 *
 * 主要逻辑（在群组锁内执行）：
 * 1. 生成 roundId，人类消息落库；
 * 2. 按响应策略选择机器人（CONTENT_ROUTED 无命中时随机兜底）；
 * 3. 每轮回复数受 maxConsecutiveBotReplies 限制（防循环硬上限）；
 * 4. 逐个机器人生成回复；生成失败以兜底文案占位（保证必有回复）；
 * 5. 机器人消息共享同一 roundId，且永不触发新轮次（触发源限制）。
 */
export async function sendGroupMessage(
  aiService: AiService,
  userId: string,
  groupId: string,
  input: { content: string },
): Promise<SendGroupMessageResult> {
  // ACL：仅群组成员可发消息
  await assertGroupAccess(userId, groupId);

  return withGroupLock(groupId, async () => {
    // 锁内读取群组配置与机器人（保证与轮次执行一致）
    const group = await prisma.chatGroup.findUnique({
      where: { id: groupId },
      include: { bots: { include: { bot: true } } },
    });
    if (!group) {
      throw new AppError(404, 'GROUP_NOT_FOUND', 'Group not found');
    }
    const content = input.content.trim();
    const bots = group.bots.map((gb) => gb.bot).filter((bot) => bot.isActive);

    // 生成唯一轮次 id：本轮所有机器人回复共享，作为防循环的分组依据
    const roundId = randomUUID();
    const userMessage = await prisma.groupMessage.create({
      data: {
        groupId,
        roundId,
        senderType: SenderType.HUMAN,
        userId,
        content,
        status: MessageStatus.SENT,
      },
    });

    // 按策略选择本轮机器人（防循环上限 + 无命中兜底）
    const selectedBots = selectBotsForRound(
      bots,
      group.responseMode,
      content,
      group.maxConsecutiveBotReplies,
    );
    const history = await buildGroupHistory(groupId);

    const botMessages: GroupMessageOutput[] = [];
    for (const bot of selectedBots) {
      let replyText: string;
      try {
        const reply = await aiService.generateWithRetry({
          content,
          botName: bot.name,
          personality: bot.personality,
          history,
        });
        replyText = reply;
      } catch (err) {
        // 保证回复：生成失败时以兜底文案占位（不中断本轮其他机器人）
        logger.error(
          { groupId, roundId, botId: bot.id, err },
          'group: bot reply failed, using fallback',
        );
        replyText = FALLBACK_REPLY;
      }
      const saved = await prisma.groupMessage.create({
        data: {
          groupId,
          roundId,
          senderType: SenderType.BOT,
          botId: bot.id,
          content: replyText,
          status: MessageStatus.SENT,
        },
      });
      botMessages.push(toGroupMessageOutput(saved));
    }

    logger.info(
      { groupId, roundId, userId, mode: group.responseMode, botReplies: botMessages.length },
      'group: round completed',
    );
    return {
      userMessage: toGroupMessageOutput(userMessage),
      botMessages,
    };
  });
}

/**
 * 群组历史消息（游标分页，按时间升序）
 *
 * @param userId  当前用户 id
 * @param groupId 目标群组 id
 * @param query   { cursor?, limit }
 * @returns Promise<GroupMessageOutput[]> 含人类与机器人发言
 * @throws AppError(404) 群组不存在或当前用户不是成员
 */
export async function listGroupMessages(
  userId: string,
  groupId: string,
  query: { cursor?: string; limit: number },
): Promise<GroupMessageOutput[]> {
  await assertGroupAccess(userId, groupId);
  const messages = await prisma.groupMessage.findMany({
    where: { groupId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: query.limit,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });
  return messages.map(toGroupMessageOutput);
}
