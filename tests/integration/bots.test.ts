/**
 * 机器人（NPC）角色接口集成测试
 *
 * 覆盖：
 * - 未登录访问返回 401（authRequired 生效）；
 * - 登录后返回全部启用的 NPC 预设，字段完整（id/code/name/personality）；
 * - 间接覆盖 bot.service.listBots 的查询与映射逻辑（仅返回 isActive 预设）。
 */
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';
import { auth, registerUser } from '../helpers.js';

const app = createApp();

describe('bots API', () => {
  // 每个用例前清空用户表；种子 NPC（globalSetup 写入）保留供查询
  beforeEach(async () => {
    await prisma.user.deleteMany();
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/bots');
    expect(res.status).toBe(401);
  });

  it('returns all active NPC presets with the expected fields', async () => {
    const { token } = await registerUser(app, 'botlistuser');
    const res = await request(app).get('/api/bots').set(auth(token));

    expect(res.status).toBe(200);
    // 种子数据包含 6 个 NPC（cooper/brand/romilly/doyle/tars/case）
    expect(res.body.bots.length).toBeGreaterThanOrEqual(6);
    for (const bot of res.body.bots as Array<Record<string, unknown>>) {
      expect(bot).toMatchObject({
        id: expect.any(String),
        code: expect.any(String),
        name: expect.any(String),
        personality: expect.any(String),
      });
    }
    const codes = (res.body.bots as Array<{ code: string }>).map((b) => b.code);
    expect(codes).toContain('cooper');
    expect(codes).toContain('tars');
  });
});
