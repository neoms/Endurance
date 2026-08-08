/**
 * 一次性数据修复脚本：清理群组消息中残留的「角色名」开头前缀
 *
 * 【背景】
 * 旧版本群组机器人回复存库前只剥离「开头」的名字前缀；当模型在回复开头模仿出
 * **别人的名字**（如道尔回复「库珀：…」）、或在内容中间输出自标
 * （如「道尔：（点头）…」）时剥不干净，导致消息内容残留角色名标注。
 * 该脚本用与生产代码完全相同的 `stripSpeakerNameMarkers`
 * （传入全部机器人名 + 成员用户名/昵称，全局剔除开头与中间的名字标注）做幂等清理：
 * - 只清理 `group_messages` 中 BOT 消息；
 * - 剥完前缀后内容不变的消息跳过（幂等，可重复运行）；
 * - 不触碰个人对话消息（个人对话无角色名前缀逻辑）。
 *
 * 【运行方式】
 * npm run db:clean-prefixes
 */
import { PrismaClient, SenderType } from '@prisma/client';

import { logger } from '../src/lib/logger.js';
import { stripSpeakerNameMarkers } from '../src/services/group.service.js';

const prisma = new PrismaClient();

/**
 * 主流程：收集全部名字 → 遍历 BOT 群组消息 → 剥离前缀
 *
 * @returns Promise<void>
 * 说明：名字集合 = 全部机器人名 + 全部群组成员用户名/昵称，
 * 与运行时 `collectSpeakerNames` 保持一致，确保模型可能模仿的名字都被覆盖。
 */
async function main(): Promise<void> {
  // 1. 收集全部「可能被模型模仿的名字」
  const bots = await prisma.bot.findMany({ select: { name: true } });
  const members = await prisma.groupMember.findMany({
    include: { user: { select: { username: true, displayName: true } } },
  });
  const names = [
    ...new Set([
      ...bots.map((b) => b.name),
      ...members.map((m) => m.user.username),
      ...members.map((m) => m.user.displayName),
    ]),
  ];

  // 2. 遍历全部 BOT 群组消息，剥离开头任意角色名前缀
  const messages = await prisma.groupMessage.findMany({
    where: { senderType: SenderType.BOT },
    select: { id: true, content: true },
  });
  let fixed = 0;
  for (const message of messages) {
    const clean = stripSpeakerNameMarkers(message.content, names);
    // 仅更新确实存在前缀的消息（幂等：重复运行不再改动）
    if (clean !== message.content.trim()) {
      await prisma.groupMessage.update({
        where: { id: message.id },
        data: { content: clean },
      });
      fixed += 1;
      logger.info({ messageId: message.id }, 'clean: removed leading name prefix');
    }
  }

  logger.info({ total: messages.length, fixed }, 'clean: bot message prefix cleanup done');
}

main()
  .catch((err) => {
    // 修复脚本失败必须显式失败退出（非零退出码），避免误以为清理成功
    logger.error({ err }, 'clean: bot message prefix cleanup failed');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
