/**
 * Prisma Client 单例模块
 *
 * 【模块职责】
 * 全应用共享同一个 PrismaClient 实例，避免每次使用都重复创建数据库连接。
 *
 * 【设计说明】
 * - 连接串来自环境变量 DATABASE_URL（.env 中配置，指向 prisma/dev.db）；
 * - 测试环境通过 tests/setup.ts 在导入本模块前改写 DATABASE_URL，
 *   指向独立测试库 prisma/test.db，与开发数据完全隔离。
 */
import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();
