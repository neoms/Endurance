/**
 * 机器人角色服务
 *
 * 【模块职责】
 * 提供机器人角色预设的查询能力（群组创建/管理时选择机器人）。
 */
import { prisma } from '../lib/prisma.js';
import type { GroupBotOutput } from '../types/group.js';

/**
 * 查询全部启用的机器人角色
 *
 * @returns Promise<GroupBotOutput[]> 机器人预设列表（仅 isActive=true）
 */
export async function listBots(): Promise<GroupBotOutput[]> {
  const bots = await prisma.bot.findMany({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
  });
  return bots.map((bot) => ({
    id: bot.id,
    code: bot.code,
    name: bot.name,
    personality: bot.personality,
  }));
}
