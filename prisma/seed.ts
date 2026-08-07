/**
 * 种子数据脚本（幂等，可重复执行）
 *
 * 【模块职责】
 * 写入演示与评审所需的基础数据：
 * - 2 个测试账号：alice / alice123456、bob / bob123456（bcrypt 哈希存储）；
 * - 3 个机器人角色预设：客服、技术、幽默（含性格描述与内容路由关键词）。
 *
 * 【幂等性】
 * 全部使用 upsert（按唯一键存在则更新、不存在则创建），可安全重复执行。
 */
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

// 数据库客户端实例（脚本独立使用，不依赖应用单例）
const prisma = new PrismaClient();

// bcrypt 加盐轮数：越高越安全但越慢，10 轮是安全性与性能的常见折中
const SALT_ROUNDS = 10;

// 测试账号清单：username / 明文密码 / 展示昵称
const users = [
  { username: 'alice', password: 'alice123456', displayName: 'Alice' },
  { username: 'bob', password: 'bob123456', displayName: 'Bob' },
];

// 机器人角色预设：code 为稳定标识，replyTendency 为内容路由关键词（逗号分隔）
const bots = [
  {
    code: 'customer-service',
    name: '客服机器人',
    personality: '耐心、礼貌，善于解决问题',
    replyTendency: '客服,退款,订单,售后,物流,帮助,help',
  },
  {
    code: 'tech',
    name: '技术机器人',
    personality: '严谨、专业，喜欢讲原理',
    replyTendency: '代码,bug,报错,接口,api,部署,typescript,技术',
  },
  {
    code: 'humor',
    name: '幽默机器人',
    personality: '风趣幽默，爱讲段子',
    replyTendency: '笑话,段子,搞笑,幽默,哈哈',
  },
];

/**
 * 写入测试用户
 *
 * @returns Promise<void>；每个用户输出一行日志（用户名 + 处理结果）
 * 逻辑：先对明文密码做 bcrypt 哈希，再按 username upsert（已存在则仅更新昵称）。
 */
async function seedUsers() {
  for (const user of users) {
    const passwordHash = await bcrypt.hash(user.password, SALT_ROUNDS);
    await prisma.user.upsert({
      where: { username: user.username },
      update: { displayName: user.displayName },
      create: {
        username: user.username,
        passwordHash,
        displayName: user.displayName,
      },
    });
    console.log(`[seed] user upserted: ${user.username}`);
  }
}

/**
 * 写入机器人角色预设
 *
 * @returns Promise<void>；每个机器人输出一行日志（code + 处理结果）
 * 逻辑：按稳定 code upsert，更新时同步刷新性格与关键词配置。
 */
async function seedBots() {
  for (const bot of bots) {
    await prisma.bot.upsert({
      where: { code: bot.code },
      update: {
        name: bot.name,
        personality: bot.personality,
        replyTendency: bot.replyTendency,
      },
      create: bot,
    });
    console.log(`[seed] bot upserted: ${bot.code}`);
  }
}

/**
 * 种子主流程
 *
 * @returns Promise<void>
 * 逻辑：依次写入用户与机器人，最后统计并输出总量日志（用于校验）。
 */
async function main() {
  console.log('[seed] starting...');
  await seedUsers();
  await seedBots();

  const [userCount, botCount] = await Promise.all([prisma.user.count(), prisma.bot.count()]);
  console.log(`[seed] completed: ${userCount} users, ${botCount} bots`);
}

// 执行主流程；失败时输出错误日志并设置非零退出码，最后关闭数据库连接
main()
  .catch((err) => {
    console.error('[seed] failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
