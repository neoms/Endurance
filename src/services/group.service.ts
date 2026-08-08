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
 * - @提及（显式点名）：
 *   * 消息中 @机器人名 → 仅被 @ 的机器人按出现顺序回复（覆盖响应策略与每轮上限，
 *     用户显式点名优先于策略，因此不受防循环上限约束）；
 *   * @真实群组成员（用户名/昵称）→ 合法提及，由真人本人回复，后端不处理；
 *   * 只要消息中存在 @提及（无论 @ 的是机器人还是真人）→ 只有被 @ 的对象回复，
 *     未提及的机器人一律不回复（只 @ 真人时本轮无机器人回复）；
 *   * 被 @ 的名称必须存在于当前群组（机器人名或成员用户名/昵称），
 *     否则返回 400 MENTION_NOT_FOUND（防无效引用）；
 *   * 消息中没有任何 @ 时，才走原响应策略。
 * - 防循环（三层）：
 *   1. 触发源限制：只有人类消息开启新轮次（roundId），机器人消息永不触发新轮次；
 *   2. 轮次硬上限：每轮回复数 ≤ maxConsecutiveBotReplies；
 *   3. 串行化：同一群组一次只有一个生成轮次（in-flight 锁），避免并发竞态。
 * - 保证回复：某机器人生成失败时以兜底文案占位；群组始终至少保留 1 个机器人，
 *   且 CONTENT_ROUTED 无命中时也会选一个机器人，保证人类消息后必有回复；
 * - 防御：群组内没有「启用」机器人时拒绝发送（409 NO_ACTIVE_BOT），
 *   绝不静默返回零回复破坏「保证回复」契约；
 * - 幂等：群组消息支持 clientRequestId（同一群组内唯一），
 *   并发/重试重复提交直接返回首次轮次结果，不产生重复消息。
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
import { createKeyedLock } from '../lib/locks.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import type {
  CreateGroupInput,
  GroupMessageOutput,
  GroupOutput,
  SendGroupMessageResult,
  UpdateGroupInput,
} from '../types/group.js';
import { buildContextHistory, MAX_CONTEXT_HISTORY } from './ai/context.js';
import type { AiService } from './ai/ai.service.js';
import { cacheKey, type AiReplyCache } from './ai/cache.js';

// 机器人生成失败时的兜底文案（保证人类消息后必有回复）
const FALLBACK_REPLY = '我暂时无法回答，请稍后再试。';

// 群组级 in-flight 锁：同一群组同时只允许一个生成轮次（复用共享键级锁工具）
const groupLocks = createKeyedLock();

// 群组消息查询时统一携带的发送者关联：真人（用户名/昵称）+ 机器人（名称）。
// 设计原因：历史消息的发言者名称必须「随消息可追溯」——
// 成员离开群组或机器人被移除后，若前端只查当前成员/机器人列表就会丢失名字，
// 因此这里直接连表带出发送者信息，保证历史始终可读。
const GROUP_MESSAGE_SENDER_INCLUDE = {
  user: { select: { username: true, displayName: true } },
  bot: { select: { name: true } },
};

// 带发送者信息的群组消息（Prisma include 结果类型）
type GroupMessageWithSender = GroupMessage & {
  user: { username: string; displayName: string } | null;
  bot: { name: string } | null;
};

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

// @提及提取正则：@ 后跟非空白、非常用中文/英文标点的连续字符。
// - 中文标点列入排除集，避免「@技术机器人，你好」把逗号吸进名称里；
// - 用「前面不能是字母/数字/下划线」的后行断言排除邮箱（a@b.com）被误判，
//   同时允许「请@技术机器人」这种紧贴中文的场景（中文不是字母数字）。
const MENTION_PATTERN = /(?<![a-zA-Z0-9_])@([^\s@，。！？!?；;：:]+)/g;

/**
 * 提取消息内容中的 @提及名称（纯函数，便于单元测试）
 *
 * @param content 消息内容（如「@技术机器人 帮我看下 bug」）
 * @returns string[] 按出现顺序提取的名称（保留重复出现；如 ['技术机器人', 'alice']）
 * 说明：只负责「切词」，名称合法性（是否存在于群组）由 resolveMentions 判定。
 */
export function parseMentionNames(content: string): string[] {
  const names: string[] = [];
  for (const match of content.matchAll(MENTION_PATTERN)) {
    const name = match[1]?.trim();
    if (name) {
      names.push(name);
    }
  }
  return names;
}

/**
 * 解析 @提及：判断名称是否为群组内机器人/成员，并返回被 @ 的机器人
 *
 * @param content 消息内容
 * @param bots    群组内全部机器人（含未启用；用于「存在性」校验）
 * @param members 群组成员（含用户名与昵称，用于校验 @真实用户）
 * @returns { mentionedBots, mentionedMembers, unresolved }
 *   - mentionedBots：命中的机器人，按 @ 首次出现顺序去重（同一机器人 @ 多次只回一次）；
 *   - mentionedMembers：被 @ 的真实成员名（用户名或昵称，按出现顺序；仅用于判断
 *     「消息中是否存在 @ 提及」，真实用户回复由用户本人完成，后端不处理）；
 *   - unresolved：既不是群组机器人也不是群组成员的非法名称（去重后的列表）。
 * 说明：机器人按「名称」精确匹配；真实用户按「用户名」或「昵称」精确匹配，
 * 大小写敏感（与账号系统一致），因此 `@Alice` 与 `@alice` 指向不同对象。
 */
export function resolveMentions(
  content: string,
  bots: Bot[],
  members: Array<{ username: string; displayName: string }>,
): { mentionedBots: Bot[]; mentionedMembers: string[]; unresolved: string[] } {
  const tokens = parseMentionNames(content);
  if (tokens.length === 0) {
    return { mentionedBots: [], mentionedMembers: [], unresolved: [] };
  }

  // 建立机器人名 → 机器人、成员名 → 合法标记 的查找表
  const botByName = new Map(bots.map((bot) => [bot.name, bot]));
  const memberNames = new Set<string>();
  for (const member of members) {
    memberNames.add(member.username);
    memberNames.add(member.displayName);
  }

  const mentionedBots: Bot[] = [];
  const mentionedMembers: string[] = [];
  const unresolved: string[] = [];
  const seenBotIds = new Set<string>();
  const seenUnresolved = new Set<string>();

  for (const token of tokens) {
    // 1. 命中群组机器人：按首次出现顺序加入，重复 @ 同一机器人只保留一次
    const bot = botByName.get(token);
    if (bot) {
      if (!seenBotIds.has(bot.id)) {
        seenBotIds.add(bot.id);
        mentionedBots.push(bot);
      }
      continue;
    }
    // 2. 命中真实群组成员：合法提及，无需机器人回复逻辑
    if (memberNames.has(token)) {
      mentionedMembers.push(token);
      continue;
    }
    // 3. 既不是机器人也不是成员：非法提及，收集（去重）后由调用方 400 拒绝
    if (!seenUnresolved.has(token)) {
      seenUnresolved.add(token);
      unresolved.push(token);
    }
  }

  return { mentionedBots, mentionedMembers, unresolved };
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
 * 去除回复内容开头的「NPC 自报名」前缀
 *
 * @param content AI 生成的回复文本
 * @param botName NPC 名称
 * @returns string 去掉开头名称前缀后的内容（自动 trim）
 * 说明：真实大模型有时会模仿历史消息的「名字：」格式，在回复开头自报家门；
 * 发言者身份已由前端头像/名字标签展示，存库时应去掉该前缀——
 * 否则「内容带前缀 + 历史上下文再拼前缀」会形成双重前缀，
 * 模型再模仿该格式就可能输出多重前缀（如「库珀：库珀：…」）。
 */
export function stripLeadingSpeakerName(content: string, botName: string): string {
  // 名称可能含正则特殊字符，先转义
  const escaped = botName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 名字后必须跟「说」/冒号/空白才视为前缀（避免误伤「库珀的想法」这类正常开头）；
  // 允许连续多个前缀（处理模型多次自报家门）
  const pattern = new RegExp(`^\\s*(?:${escaped}(?=说|[:：]|\\s)(?:说)?[:：]?\\s*)+`, 'u');
  return content.replace(pattern, '').trim();
}

/**
 * 创建流式「开头名称前缀」剥离器（跨 chunk 状态机）
 *
 * @param botName NPC 名称
 * @returns (chunk: string) => string 逐块剥离函数
 * 说明：流式增量可能把前缀拆成多个 chunk（如「库」「珀：」），
 * 因此在确认开头不是名称前缀前先暂存内容；确认是前缀则剥离后输出剩余部分，
 * 确认不是则原样输出。用于群组流式回复，避免「名字前缀」在打字气泡里闪现后消失。
 */
export function createLeadingNameStripper(botName: string): (chunk: string) => string {
  const escaped = botName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 单个前缀段：可选前导空白 + 名字 + 可选「说」 + 冒号/空白。
  // 名字后必须跟「说」/冒号/空白才视为前缀段（避免误伤「库珀的想法」这类正常开头）
  const segment = new RegExp(`^\\s*(?:${escaped}(?=说|[:：]|\\s)(?:说)?[:：]?\\s*)`, 'u');
  let pending = '';
  let done = false;

  return (chunk: string): string => {
    // 已确认开头不是前缀：后续块原样透传
    if (done) {
      return chunk;
    }
    pending += chunk;

    // 循环剥离所有完整前缀段（允许连续多个，如「库珀：库珀：…」）
    for (;;) {
      const match = pending.match(segment);
      if (!match) {
        break;
      }
      pending = pending.slice(match[0].length);
    }

    // 剩余为空：全部都是前缀段（可能还有更多前缀），继续等待
    if (pending === '') {
      return '';
    }
    // 剩余是名字的部分前缀或恰好等于名字（还差分隔符，如「库」「库珀」）：
    // 暂存等待下一块，避免「库/珀/：」分块时漏剥
    if (pending.length <= botName.length && botName.startsWith(pending)) {
      return '';
    }
    // 已确认开头不是（或不再是）前缀：原样输出剩余内容，此后透传
    done = true;
    const out = pending;
    pending = '';
    return out;
  };
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
    members: (GroupMember & { user: { username: string; displayName: string } })[];
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
      username: m.user.username,
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
 * @param message 含发送者关联的群组消息记录
 * @returns GroupMessageOutput
 */
function toGroupMessageOutput(message: GroupMessageWithSender): GroupMessageOutput {
  return {
    id: message.id,
    groupId: message.groupId,
    roundId: message.roundId,
    senderType: message.senderType,
    userId: message.userId,
    botId: message.botId,
    // 发送者展示名：真人取昵称、机器人取名称；
    // 找不到（如用户被删除后 userId 置空）时返回 null，由前端兜底展示
    senderName:
      message.senderType === SenderType.HUMAN
        ? (message.user?.displayName ?? null)
        : (message.bot?.name ?? null),
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
  // botIds 去重：重复 id（如 [A, A]）按单个机器人处理，避免 404 语义不准或撞复合主键
  const uniqueBotIds = [...new Set(input.botIds)];
  const bots = await prisma.bot.findMany({
    where: { id: { in: uniqueBotIds }, isActive: true },
  });
  if (bots.length !== uniqueBotIds.length) {
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
      data: uniqueBotIds.map((botId) => ({ groupId: created.id, botId })),
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
          members: { include: { user: { select: { username: true, displayName: true } } } },
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
      members: { include: { user: { select: { username: true, displayName: true } } } },
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
 * @param targetUsername 待添加用户的用户名（全局唯一、大小写敏感，按精确字符串匹配）
 * @returns Promise<GroupOutput> 更新后的群组
 * @throws AppError(403) 非创建者；404 目标用户不存在；409 已是成员
 */
export async function addGroupMember(
  userId: string,
  groupId: string,
  targetUsername: string,
): Promise<GroupOutput> {
  await assertGroupOwner(userId, groupId);
  // 用户名全局唯一且大小写敏感：findUnique 按精确字符串查找（不做小写归一化），
  // 因此大小写不匹配时返回 404，不会误把 'Alice' 当成 'alice' 添加进群组。
  const target = await prisma.user.findUnique({
    where: { username: targetUsername },
    select: { id: true },
  });
  if (!target) {
    throw new AppError(404, 'USER_NOT_FOUND', 'Target user not found');
  }
  const targetUserId = target.id;
  const existing = await prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId, userId: targetUserId } },
  });
  if (existing) {
    throw new AppError(409, 'ALREADY_MEMBER', 'User is already a member');
  }
  await prisma.groupMember.create({
    data: { groupId, userId: targetUserId, role: MemberRole.MEMBER },
  });
  logger.info({ userId, groupId, targetUsername, targetUserId }, 'group: member added');
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
  // 移除后必须仍至少有一个「启用」的机器人（保证人类消息后必有回复）。
  // 注意按启用状态计算：若剩余机器人全被停用，同样视为不可移除。
  const remainingActive = await prisma.groupBot.count({
    where: { groupId, botId: { not: botId }, bot: { isActive: true } },
  });
  if (remainingActive === 0) {
    throw new AppError(409, 'LAST_BOT', 'A group must keep at least one active bot');
  }
  await prisma.groupBot.delete({ where: { groupId_botId: { groupId, botId } } });
  logger.info({ userId, groupId, botId }, 'group: bot removed');
  return getGroup(userId, groupId);
}

/**
 * 构建群组最近消息上下文（供机器人参考）
 *
 * @param groupId 群组 id
 * @param excludeMessageId 可选：排除某条消息（发送流程用它排除「刚落库的当前人类消息」，
 *                         避免当前消息在 history 与 content 里重复出现两次）
 * @returns Promise<Array<{ role, content }>> 上下文历史（时间升序，已应用滑动窗口/总结）
 * 说明：
 * - 真人消息带「用户名：」前缀、机器人消息带「机器人名：」前缀——
 *   历史消息（尤其机器人发言）若不带名字，模型无法区分是谁说的
 *   （DeepSeek 回复本身不携带机器人名字，与 Mock 不同）；
 * - 取最近 MAX_CONTEXT_HISTORY（20）条后交给 buildContextHistory 应用
 *   滑动窗口/总结（只影响上下文，不影响历史展示）。
 */
async function buildGroupHistory(
  groupId: string,
  excludeMessageId?: string,
): Promise<Array<{ role: 'system' | 'user' | 'assistant'; content: string }>> {
  const recent = await prisma.groupMessage.findMany({
    where: { groupId, ...(excludeMessageId ? { id: { not: excludeMessageId } } : {}) },
    orderBy: { createdAt: 'desc' },
    take: MAX_CONTEXT_HISTORY,
    include: {
      user: { select: { username: true, displayName: true } },
      bot: { select: { name: true } },
    },
  });
  const messages = recent.reverse().map((m) => {
    if (m.senderType === SenderType.HUMAN) {
      // 真人历史消息：带用户名前缀（与当前消息的「用户名：」前缀保持一致）
      const name = m.user?.username ?? m.user?.displayName;
      return {
        role: 'user' as const,
        content: name ? `${name}：${m.content}` : m.content,
      };
    }
    // 机器人历史消息：带机器人名前缀（需求：群组历史机器人发言加名字前缀）
    const botName = m.bot?.name;
    return {
      role: 'assistant' as const,
      // 先剥掉存量内容里可能残留的「NPC 名」前缀（历史数据/旧版本可能已带前缀），
      // 再统一拼一次「名字：」——避免双重前缀进入上下文、模型模仿出多重前缀
      content: botName ? `${botName}：${stripLeadingSpeakerName(m.content, botName)}` : m.content,
    };
  });
  // 滑动窗口 + 总结：达到阈值时用摘要替换最早部分，保留最近 5 条原文
  return buildContextHistory(messages);
}

/**
 * 发送群组消息（人类消息 → 触发本轮机器人回复）
 *
 * @param aiService AI 服务
 * @param userId    当前用户 id（须是群组成员）
 * @param groupId   目标群组 id
 * @param input     { content, clientRequestId? }
 * @returns Promise<SendGroupMessageResult> 人类消息 + 本轮机器人回复列表
 * @throws AppError(404) 群组不存在或当前用户不是成员
 * @throws AppError(409 NO_ACTIVE_BOT) 群组内没有启用状态的机器人
 * @throws AppError(400 MENTION_NOT_FOUND) 消息中的 @名称不在当前群组内
 *
 * 主要逻辑（在群组锁内执行）：
 * 1. 幂等检查：clientRequestId 已存在时直接返回首次轮次结果（锁内保证并发安全）；
 * 2. 生成 roundId，人类消息落库；
 * 3. 无启用机器人时拒绝发送（保证回复契约，不静默返回空轮次）；
 * 4. 校验 @提及：名称必须存在于当前群组，否则 400；
 * 5. 只要消息中存在 @提及（无论 @ 的是机器人还是真人）→ 仅被 @ 的对象回复：
 *    - 被 @ 的启用机器人按 @ 顺序回复（覆盖策略与上限）；
 *    - 只 @ 了真人 → 本轮不触发任何机器人（由真人本人回复，避免无关机器人抢话）；
 *    没有任何 @ → 按响应策略选择机器人（CONTENT_ROUTED 无命中时随机兜底）；
 * 6. 每轮回复数受 maxConsecutiveBotReplies 限制（防循环硬上限，仅作用于策略选择）；
 * 7. 逐个机器人生成回复；生成失败以兜底文案占位（保证必有回复）；
 * 8. 机器人消息共享同一 roundId，且永不触发新轮次（触发源限制）。
 */
export async function sendGroupMessage(
  aiService: AiService,
  userId: string,
  groupId: string,
  input: { content: string; clientRequestId?: string },
  aiCache?: AiReplyCache | null,
): Promise<SendGroupMessageResult> {
  // ACL：仅群组成员可发消息
  await assertGroupAccess(userId, groupId);

  return groupLocks(groupId, async () => {
    // 锁内读取群组配置与机器人（保证与轮次执行一致）
    const group = await prisma.chatGroup.findUnique({
      where: { id: groupId },
      include: {
        bots: { include: { bot: true } },
        members: { include: { user: { select: { username: true, displayName: true } } } },
      },
    });
    if (!group) {
      throw new AppError(404, 'GROUP_NOT_FOUND', 'Group not found');
    }
    const content = input.content.trim();
    const bots = group.bots.map((gb) => gb.bot).filter((bot) => bot.isActive);

    // 防御：群组内没有启用状态的机器人时，拒绝发送而不是静默返回零回复。
    // 该状态属于群组配置异常（如机器人被停用），需由创建者修复后再发消息。
    if (bots.length === 0) {
      logger.warn({ groupId, userId }, 'group: send blocked, no active bots');
      throw new AppError(409, 'NO_ACTIVE_BOT', 'Group has no active bots, cannot reply');
    }

    // @提及解析与校验：被 @ 的名称必须存在于当前群组（机器人名 / 成员用户名 / 成员昵称）。
    // 解析使用群组「全部」机器人做存在性判断（含停用的），保证「必须存在」语义完整；
    // 实际回复只从「启用」机器人中选取。
    const mentionResult = resolveMentions(
      content,
      group.bots.map((gb) => gb.bot),
      group.members.map((m) => m.user),
    );
    if (mentionResult.unresolved.length > 0) {
      // 明确拒绝非法 @，并把未解析名称放进 details，方便前端逐条提示
      logger.warn(
        { groupId, userId, unresolved: mentionResult.unresolved },
        'group: send blocked, unresolved mentions',
      );
      throw new AppError(
        400,
        'MENTION_NOT_FOUND',
        `Cannot mention: ${mentionResult.unresolved.join(', ')}`,
        { mentions: mentionResult.unresolved },
      );
    }

    // 幂等：同一群组内相同 clientRequestId 直接返回首次轮次结果（锁内保证并发安全）。
    // 命中时按 roundId 取回该轮全部机器人回复，与首次响应一致。
    if (input.clientRequestId) {
      const existing = await prisma.groupMessage.findUnique({
        where: {
          groupId_clientRequestId: {
            groupId,
            clientRequestId: input.clientRequestId,
          },
        },
        include: GROUP_MESSAGE_SENDER_INCLUDE,
      });
      if (existing) {
        const existingBots = await prisma.groupMessage.findMany({
          where: { groupId, roundId: existing.roundId, senderType: SenderType.BOT },
          orderBy: { createdAt: 'asc' },
          include: GROUP_MESSAGE_SENDER_INCLUDE,
        });
        logger.debug({ groupId, clientRequestId: input.clientRequestId }, 'group: idempotent hit');
        return {
          userMessage: toGroupMessageOutput(existing),
          botMessages: existingBots.map(toGroupMessageOutput),
        };
      }
    }

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
        clientRequestId: input.clientRequestId,
      },
    });
    // 重新带发送者信息读取，保证响应里包含 senderName（与历史查询口径一致）
    const userMessageWithSender = await prisma.groupMessage.findUnique({
      where: { id: userMessage.id },
      include: GROUP_MESSAGE_SENDER_INCLUDE,
    });

    // 选择本轮回复机器人：
    // - 消息中存在任何 @ 提及（含只 @ 真人）→ 仅被 @ 的启用机器人回复：
    //   * @ 了机器人 → 按 @ 顺序回复（用户显式点名优先，覆盖响应策略与每轮上限；
    //     这是人为指定，不属于「机器人自发循环」）；
    //   * 只 @ 了真人 → 本轮不回复（消息明确指向真人，机器人不应抢话），
    //     由真人自行回复或不回复；
    // - 没有任何 @ → 走原响应策略（含防循环上限与无命中兜底）。
    const mentionedActiveBots = mentionResult.mentionedBots.filter((bot) => bot.isActive);
    const hasMentions =
      mentionResult.mentionedBots.length > 0 || mentionResult.mentionedMembers.length > 0;
    const selectedBots = hasMentions
      ? mentionedActiveBots
      : selectBotsForRound(bots, group.responseMode, content, group.maxConsecutiveBotReplies);

    // 缓存键：群组 + 规范化内容 + 本轮选中 NPC id（顺序敏感）。
    // 一次提问多人回答时，整轮回复作为一个整体缓存，命中后按原顺序回放全部 NPC。
    const roundKey = cacheKey([groupId, content, selectedBots.map((b) => b.id).join(',')]);
    const cachedRound = aiCache?.get<Array<{ botId: string; content: string }>>(roundKey);

    // 缓存命中：直接按缓存内容落库并返回（不调用 AI、不查历史）
    if (cachedRound) {
      logger.info(
        { groupId, roundKey, botReplies: cachedRound.length, cache: 'hit' },
        'group: ai cache hit',
      );
      const cachedMessages: GroupMessageOutput[] = [];
      for (const item of cachedRound) {
        const saved = await prisma.groupMessage.create({
          data: {
            groupId,
            roundId,
            senderType: SenderType.BOT,
            botId: item.botId,
            content: item.content,
            status: MessageStatus.SENT,
          },
        });
        const savedWithSender = await prisma.groupMessage.findUnique({
          where: { id: saved.id },
          include: GROUP_MESSAGE_SENDER_INCLUDE,
        });
        cachedMessages.push(toGroupMessageOutput(savedWithSender!));
      }
      logger.info(
        { groupId, roundId, userId, mode: group.responseMode, botReplies: cachedMessages.length },
        'group: round completed (cache hit)',
      );
      return {
        userMessage: toGroupMessageOutput(userMessageWithSender!),
        botMessages: cachedMessages,
      };
    }

    const history = await buildGroupHistory(groupId, userMessage.id);

    const botMessages: GroupMessageOutput[] = [];
    // 本轮各 NPC 的成功回复（整轮全部成功才写缓存，任一走兜底则整轮不缓存）
    const roundReplies: Array<{ botId: string; content: string }> = [];
    let usedFallback = false;
    for (const bot of selectedBots) {
      let replyText: string;
      try {
        // 传入实际发言成员的用户名：Mock AI 回显「用户名说：」而非写死「你说」。
        // 群组成员已在锁内随群组一起加载（ACL 保证发送者必然是成员）
        const senderName = group.members.find((m) => m.userId === userId)?.user.username ?? '用户';
        const reply = await aiService.generateWithRetry({
          content,
          botName: bot.name,
          personality: bot.personality,
          history,
          userName: senderName,
        });
        // 去掉回复开头的「NPC 名」前缀（真实模型有时会模仿历史格式自报家门）；
        // 剥完后为空（模型只回了名字）→ 用兜底文案，保证必有回复
        const clean = stripLeadingSpeakerName(reply, bot.name);
        replyText = clean.trim() ? clean : FALLBACK_REPLY;
      } catch (err) {
        // 保证回复：生成失败时以兜底文案占位（不中断本轮其他机器人）
        logger.error(
          { groupId, roundId, botId: bot.id, err },
          'group: bot reply failed, using fallback',
        );
        replyText = FALLBACK_REPLY;
        usedFallback = true;
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
      const savedWithSender = await prisma.groupMessage.findUnique({
        where: { id: saved.id },
        include: GROUP_MESSAGE_SENDER_INCLUDE,
      });
      botMessages.push(toGroupMessageOutput(savedWithSender!));
      roundReplies.push({ botId: bot.id, content: replyText });
    }

    // 整轮全部成功 → 写入缓存（下次相同问题可直接回放全部 NPC 回复）
    if (!usedFallback && roundReplies.length > 0) {
      aiCache?.set(roundKey, roundReplies);
      logger.info({ groupId, roundKey, botReplies: roundReplies.length }, 'group: ai cache set');
    }

    logger.info(
      { groupId, roundId, userId, mode: group.responseMode, botReplies: botMessages.length },
      'group: round completed',
    );
    return {
      userMessage: toGroupMessageOutput(userMessageWithSender!),
      botMessages,
    };
  });
}

/**
 * 流式发送群组消息的事件回调（由路由层翻译为 SSE 帧）
 *
 * @property userMessage 人类消息已落库
 * @property botStart    某个机器人开始回复（PENDING 占位，前端据此显示打字气泡）
 * @property botDelta    某个机器人回复的增量文本
 * @property botDone     某个机器人回复已完成（SENT；失败时内容为兜底文案）
 * @property roundDone   本轮全部机器人回复完成（前端据此关闭发送中状态）
 */
export interface GroupMessageStreamEvents {
  userMessage?: (message: GroupMessageOutput) => void;
  botStart?: (message: GroupMessageOutput) => void;
  botDelta?: (messageId: string, delta: string) => void;
  botDone?: (message: GroupMessageOutput) => void;
  roundDone?: () => void;
}

/**
 * 流式发送群组消息（人类消息落库 + 各机器人回复流式生成）
 *
 * @param aiService   AI 服务（流式重试/空闲超时）
 * @param userId      当前用户 id（须是群组成员）
 * @param groupId     目标群组 id
 * @param input       { content, clientRequestId? }
 * @param events      流式事件回调（userMessage/botStart/botDelta/botDone/roundDone）
 * @param clientSignal 可选：客户端断连信号（断连时中止 AI 调用）
 * @returns Promise<void> 本轮结束后 resolve
 * @throws AppError(404 / 409 NO_ACTIVE_BOT / 400 MENTION_NOT_FOUND)
 *         在第一个事件发出之前抛出，路由层转为 SSE error 事件
 *
 * 与 sendGroupMessage 的关系（保证回复契约不变）：
 * - 选择机器人、@提及规则、防循环上限、兜底文案逻辑完全一致；
 * - 差异只在传输层：每个机器人的回复先 PENDING 占位 → botStart →
 *   逐块 botDelta → 完成后更新 SENT 并 botDone；
 * - 生成失败仍以兜底文案落库（保证人类消息后必有回复），不中断后续机器人；
 * - 幂等命中回放首次轮次（userMessage + 各 botDone），不重复生成。
 */
export async function streamSendGroupMessage(
  aiService: AiService,
  userId: string,
  groupId: string,
  input: { content: string; clientRequestId?: string },
  events: GroupMessageStreamEvents = {},
  clientSignal?: AbortSignal,
  aiCache?: AiReplyCache | null,
): Promise<void> {
  // ACL：仅群组成员可发消息
  await assertGroupAccess(userId, groupId);

  await groupLocks(groupId, async () => {
    // 锁内读取群组配置与机器人（保证与轮次执行一致）
    const group = await prisma.chatGroup.findUnique({
      where: { id: groupId },
      include: {
        bots: { include: { bot: true } },
        members: { include: { user: { select: { username: true, displayName: true } } } },
      },
    });
    if (!group) {
      throw new AppError(404, 'GROUP_NOT_FOUND', 'Group not found');
    }
    const content = input.content.trim();
    const bots = group.bots.map((gb) => gb.bot).filter((bot) => bot.isActive);

    // 防御：群组内没有启用状态的机器人时，拒绝发送而不是静默返回零回复
    if (bots.length === 0) {
      logger.warn({ groupId, userId }, 'group: stream send blocked, no active bots');
      throw new AppError(409, 'NO_ACTIVE_BOT', 'Group has no active bots, cannot reply');
    }

    // @提及解析与校验：名称必须存在于当前群组（与 sendGroupMessage 完全一致）
    const mentionResult = resolveMentions(
      content,
      group.bots.map((gb) => gb.bot),
      group.members.map((m) => m.user),
    );
    if (mentionResult.unresolved.length > 0) {
      logger.warn(
        { groupId, userId, unresolved: mentionResult.unresolved },
        'group: stream send blocked, unresolved mentions',
      );
      throw new AppError(
        400,
        'MENTION_NOT_FOUND',
        `Cannot mention: ${mentionResult.unresolved.join(', ')}`,
        { mentions: mentionResult.unresolved },
      );
    }

    // 幂等：命中时回放首次轮次（用户消息 + 各机器人完整回复），不重复生成
    if (input.clientRequestId) {
      const existing = await prisma.groupMessage.findUnique({
        where: {
          groupId_clientRequestId: {
            groupId,
            clientRequestId: input.clientRequestId,
          },
        },
        include: GROUP_MESSAGE_SENDER_INCLUDE,
      });
      if (existing) {
        const existingBots = await prisma.groupMessage.findMany({
          where: { groupId, roundId: existing.roundId, senderType: SenderType.BOT },
          orderBy: { createdAt: 'asc' },
          include: GROUP_MESSAGE_SENDER_INCLUDE,
        });
        logger.debug(
          { groupId, clientRequestId: input.clientRequestId },
          'group: stream idempotent hit',
        );
        events.userMessage?.(toGroupMessageOutput(existing));
        for (const botMessage of existingBots) {
          events.botDone?.(toGroupMessageOutput(botMessage));
        }
        events.roundDone?.();
        return;
      }
    }

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
        clientRequestId: input.clientRequestId,
      },
    });
    const userMessageWithSender = await prisma.groupMessage.findUnique({
      where: { id: userMessage.id },
      include: GROUP_MESSAGE_SENDER_INCLUDE,
    });

    // 选择本轮回复机器人（@提及优先，其次按响应策略；防循环上限不变）
    const mentionedActiveBots = mentionResult.mentionedBots.filter((bot) => bot.isActive);
    const hasMentions =
      mentionResult.mentionedBots.length > 0 || mentionResult.mentionedMembers.length > 0;
    const selectedBots = hasMentions
      ? mentionedActiveBots
      : selectBotsForRound(bots, group.responseMode, content, group.maxConsecutiveBotReplies);

    // 缓存键：群组 + 内容 + 本轮选中 NPC id 顺序（与 sendGroupMessage 完全一致）
    const roundKey = cacheKey([groupId, content, selectedBots.map((b) => b.id).join(',')]);
    const cachedRound = aiCache?.get<Array<{ botId: string; content: string }>>(roundKey);

    // 缓存命中：回放整轮（user_message + 各 NPC 的 botDone + round_done），
    // 无增量流——前端在 botDone 时直接把最终消息追加进列表，表现与正常完成一致。
    if (cachedRound) {
      events.userMessage?.(toGroupMessageOutput(userMessageWithSender!));
      for (const item of cachedRound) {
        const saved = await prisma.groupMessage.create({
          data: {
            groupId,
            roundId,
            senderType: SenderType.BOT,
            botId: item.botId,
            content: item.content,
            status: MessageStatus.SENT,
          },
        });
        const savedWithSender = await prisma.groupMessage.findUnique({
          where: { id: saved.id },
          include: GROUP_MESSAGE_SENDER_INCLUDE,
        });
        events.botDone?.(toGroupMessageOutput(savedWithSender!));
      }
      events.roundDone?.();
      logger.info(
        { groupId, roundKey, botReplies: cachedRound.length, cache: 'hit' },
        'group: stream round completed (cache hit)',
      );
      return;
    }

    const history = await buildGroupHistory(groupId, userMessage.id);
    // 实际发言成员的用户名（Mock AI 回显「用户名说：」；ACL 保证发送者必然是成员）
    const senderName = group.members.find((m) => m.userId === userId)?.user.username ?? '用户';

    // 先通知前端人类消息已落库，再逐个机器人流式推送
    events.userMessage?.(toGroupMessageOutput(userMessageWithSender!));

    // 本轮各 NPC 的成功回复（整轮全部成功才写缓存，任一走兜底则整轮不缓存）
    const roundReplies: Array<{ botId: string; content: string }> = [];
    let usedFallback = false;
    for (const bot of selectedBots) {
      // 每个机器人：先 PENDING 落库占位（拿到稳定消息 id），前端显示打字气泡
      const pending = await prisma.groupMessage.create({
        data: {
          groupId,
          roundId,
          senderType: SenderType.BOT,
          botId: bot.id,
          content: '',
          status: MessageStatus.PENDING,
        },
      });
      const pendingWithSender = await prisma.groupMessage.findUnique({
        where: { id: pending.id },
        include: GROUP_MESSAGE_SENDER_INCLUDE,
      });
      events.botStart?.(toGroupMessageOutput(pendingWithSender!));

      // 流式生成：逐块累积并回调；失败时以兜底文案落库（保证必有回复）
      let partial = '';
      // 跨 chunk 剥离开头的「NPC 名」前缀，避免前缀在打字气泡里闪现后消失
      const strip = createLeadingNameStripper(bot.name);
      try {
        for await (const delta of aiService.streamWithRetry(
          {
            content,
            botName: bot.name,
            personality: bot.personality,
            history,
            userName: senderName,
          },
          { clientSignal },
        )) {
          const visible = strip(delta);
          partial += visible;
          if (visible) {
            events.botDelta?.(pending.id, visible);
          }
        }
        // 剥完前缀后内容为空（模型只回了名字）→ 用兜底文案，保证必有回复
        const finalContent = partial.trim() ? partial : FALLBACK_REPLY;
        const saved = await prisma.groupMessage.update({
          where: { id: pending.id },
          data: { content: finalContent, status: MessageStatus.SENT },
        });
        const savedWithSender = await prisma.groupMessage.findUnique({
          where: { id: saved.id },
          include: GROUP_MESSAGE_SENDER_INCLUDE,
        });
        logger.debug(
          { groupId, roundId, botId: bot.id, chars: saved.content.length },
          'group: stream bot reply saved',
        );
        roundReplies.push({ botId: bot.id, content: finalContent });
        events.botDone?.(toGroupMessageOutput(savedWithSender!));
      } catch (err) {
        // 保证回复：生成失败/流中断时以兜底文案落库（不中断本轮其他机器人）。
        // 与 sendGroupMessage 的兜底行为保持一致；已产出的部分内容被兜底文案替换。
        logger.error(
          { groupId, roundId, botId: bot.id, err },
          'group: stream bot reply failed, using fallback',
        );
        usedFallback = true;
        const fallback = await prisma.groupMessage.update({
          where: { id: pending.id },
          data: { content: FALLBACK_REPLY, status: MessageStatus.SENT },
        });
        const fallbackWithSender = await prisma.groupMessage.findUnique({
          where: { id: fallback.id },
          include: GROUP_MESSAGE_SENDER_INCLUDE,
        });
        events.botDone?.(toGroupMessageOutput(fallbackWithSender!));
      }
    }

    // 整轮全部成功 → 写入缓存（下次相同问题可直接回放全部 NPC 回复）
    if (!usedFallback && roundReplies.length > 0) {
      aiCache?.set(roundKey, roundReplies);
      logger.info(
        { groupId, roundKey, botReplies: roundReplies.length },
        'group: stream ai cache set',
      );
    }

    logger.info(
      { groupId, roundId, userId, mode: group.responseMode, botReplies: selectedBots.length },
      'group: stream round completed',
    );
    events.roundDone?.();
  });
}

/**
 * 群组历史消息（游标分页，按时间升序）
 *
 * @param userId  当前用户 id
 * @param groupId 目标群组 id
 * @param query   { cursor?, before?, limit }
 * @returns Promise<GroupMessageOutput[]> 含人类与机器人发言
 * @throws AppError(404) 群组不存在或当前用户不是成员
 * @throws AppError(400 INVALID_CURSOR) cursor/before 不是该群组内的消息
 *
 * 分页语义与个人对话历史一致：
 * - 默认：返回最近 limit 条（升序）；
 * - before=<id>：返回该消息之前（不含）的 limit 条（升序，聊天页「加载更早」）；
 * - cursor=<id>：返回该消息之后（不含）的 limit 条（升序，正向翻页）。
 */
export async function listGroupMessages(
  userId: string,
  groupId: string,
  query: { cursor?: string; before?: string; limit: number },
): Promise<GroupMessageOutput[]> {
  await assertGroupAccess(userId, groupId);

  // 锚点校验：cursor/before 必须是该群组内的消息，否则 400（避免静默空列表或错误定位）
  const anchorId = query.before ?? query.cursor;
  let anchor: { id: string; createdAt: Date } | null = null;
  if (anchorId) {
    anchor = await prisma.groupMessage.findFirst({
      where: { id: anchorId, groupId },
      select: { id: true, createdAt: true },
    });
    if (!anchor) {
      throw new AppError(400, 'INVALID_CURSOR', 'Cursor message not found in this group');
    }
  }

  let messages: GroupMessageWithSender[];
  if (query.before && anchor) {
    // 反向分页：锚点之前（(createdAt, id) 复合键严格小于）取 limit 条，反转回升序
    messages = await prisma.groupMessage.findMany({
      where: {
        groupId,
        OR: [
          { createdAt: { lt: anchor.createdAt } },
          { createdAt: anchor.createdAt, id: { lt: anchor.id } },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit,
      include: GROUP_MESSAGE_SENDER_INCLUDE,
    });
    messages.reverse();
  } else if (query.cursor) {
    // 正向分页
    messages = await prisma.groupMessage.findMany({
      where: { groupId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: query.limit,
      cursor: { id: query.cursor },
      skip: 1,
      include: GROUP_MESSAGE_SENDER_INCLUDE,
    });
  } else {
    // 默认：最近 limit 条（升序）
    messages = await prisma.groupMessage.findMany({
      where: { groupId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit,
      include: GROUP_MESSAGE_SENDER_INCLUDE,
    });
    messages.reverse();
  }
  return messages.map(toGroupMessageOutput);
}
