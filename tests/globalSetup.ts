/**
 * Vitest 全局初始化（整个测试进程运行前执行一次）
 *
 * 【作用】
 * 确保测试库文件存在，并通过 `prisma db push` 将 Schema 同步到测试库，
 * 保证集成测试使用的表结构与 schema.prisma 一致。
 *
 * 【说明】
 * 先创建空的 test.db 文件再执行 db push，是为了兼容部分环境下
 * Prisma schema engine 无法直接创建全新数据库文件的问题。
 */
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export default function globalSetup() {
  // 测试库文件路径（与 tests/setup.ts 的 DATABASE_URL 保持一致）
  const dbPath = path.join(process.cwd(), 'prisma', 'test.db');
  mkdirSync(path.dirname(dbPath), { recursive: true });
  writeFileSync(dbPath, '');

  // 调用本地 prisma CLI 同步 Schema（--skip-generate 避免重复生成 Client）
  const prismaBin = path.join(process.cwd(), 'node_modules', '.bin', 'prisma');
  execSync(`${prismaBin} db push --skip-generate`, {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: 'file:./test.db' },
    stdio: 'inherit',
  });

  // 写入种子数据（测试账号与机器人角色），保证群组测试可用机器人预设
  const tsxBin = path.join(process.cwd(), 'node_modules', '.bin', 'tsx');
  execSync(`${tsxBin} prisma/seed.ts`, {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: 'file:./test.db' },
    stdio: 'inherit',
  });
}
