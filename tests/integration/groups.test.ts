/**
 * 群组对话接口集成测试
 *
 * 覆盖：
 * - 群组 CRUD 与权限矩阵（OWNER 管理 / MEMBER 发言 / 非成员 404）；
 * - 成员管理：添加/移除/离开（创建者不可离开、不可被移除）；
 * - 机器人管理：添加、移除（至少保留 1 个）；
 * - 消息与机器人响应：ALL_BOTS / RANDOM_ONE / CONTENT_ROUTED / 无命中兜底；
 * - 防循环：roundId 轮次隔离 + maxConsecutiveBotReplies 上限；
 * - 兜底回复：AI 持续失败时机器人以兜底文案回复；
 * - 防御：无启用机器人 409；移除机器人时至少保留一个启用机器人；
 * - 幂等：clientRequestId 顺序/并发重复提交均返回首次轮次结果；
 * - 创建群组时 botIds 去重；
 * - 历史消息与 ACL。
 */
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';
import { AiService } from '../../src/services/ai/ai.service.js';
import { MockAiProvider } from '../../src/services/ai/mock.provider.js';
import type {
  AiGenerateContext,
  AiGenerateOptions,
  AiGenerateResult,
  AiProvider,
} from '../../src/services/ai/types.js';
import { auth, parseSse, registerUser } from '../helpers.js';

const app = createApp();
// 故障应用：AI 必然失败，用于验证「保证机器人回复」的兜底逻辑
const failingApp = createApp({ aiService: new AiService(new MockAiProvider({ failTimes: 99 })) });

/**
 * 计数 Provider：每次 generate/stream 调用计数 +1，
 * 回复内容携带机器人名与调用序号，用于验证「整轮缓存回放不再调用 AI」。
 */
class CountingProvider implements AiProvider {
  readonly name = 'counting';
  calls = 0;

  async generate(context: AiGenerateContext): Promise<AiGenerateResult> {
    this.calls += 1;
    return { content: `回复-${context.botName ?? 'AI'}-${context.content}-${this.calls}` };
  }

  async *stream(context: AiGenerateContext, _options?: AiGenerateOptions): AsyncIterable<string> {
    const reply = (await this.generate(context)).content;
    for (let i = 0; i < reply.length; i += 8) {
      yield reply.slice(i, i + 8);
    }
  }
}

/**
 * 读取测试库中的机器人 id（globalSetup 已写入种子机器人）
 *
 * @returns Promise<string[]> 机器人 id 列表
 */
async function getBotIds(): Promise<string[]> {
  const bots = await prisma.bot.findMany({ select: { id: true } });
  return bots.map((b) => b.id);
}

/**
 * 创建群组
 *
 * @param token     JWT
 * @param overrides 创建参数（botIds 必填）
 * @returns supertest 响应
 */
function createGroup(token: string, overrides: Record<string, unknown>) {
  return request(app).post('/api/groups').set(auth(token)).send(overrides);
}

describe('groups API', () => {
  // 每个用例前清空用户表（级联清空其名下数据）；种子机器人保留
  beforeEach(async () => {
    await prisma.user.deleteMany();
  });

  it('creates a group with creator as OWNER and selected bots', async () => {
    const { token, user } = await registerUser(app, 'groupowner');
    const [botId] = await getBotIds();

    const res = await createGroup(token, { name: '技术讨论群', botIds: [botId!] });

    expect(res.status).toBe(201);
    expect(res.body.group.name).toBe('技术讨论群');
    expect(res.body.group.creatorId).toBe(user.id);
    expect(res.body.group.members).toHaveLength(1);
    expect(res.body.group.members[0]).toMatchObject({ userId: user.id, role: 'OWNER' });
    expect(res.body.group.bots).toHaveLength(1);
  });

  it('rejects unknown bot with 404 and missing botIds with 422', async () => {
    const { token } = await registerUser(app, 'groupowner');

    const badBot = await createGroup(token, { name: 'g', botIds: ['not-a-real-bot'] });
    const noBot = await createGroup(token, { name: 'g', botIds: [] });

    expect(badBot.status).toBe(404);
    expect(noBot.status).toBe(422);
  });

  it('dedupes duplicate botIds when creating a group', async () => {
    const { token } = await registerUser(app, 'groupowner');
    const [botId] = await getBotIds();

    // botIds 传入重复 id：按单个机器人去重处理，不应报 404 或撞复合主键
    const res = await createGroup(token, { name: 'g', botIds: [botId!, botId!] });

    expect(res.status).toBe(201);
    expect(res.body.group.bots).toHaveLength(1);
  });

  it('lists only groups I participate in', async () => {
    const owner = await registerUser(app, 'groupowner');
    const outsider = await registerUser(app, 'outsider');
    const [botId] = await getBotIds();
    await createGroup(owner.token, { name: '我的群', botIds: [botId!] });

    const mine = await request(app).get('/api/groups').set(auth(owner.token));
    const others = await request(app).get('/api/groups').set(auth(outsider.token));

    expect(mine.body.groups).toHaveLength(1);
    expect(others.body.groups).toHaveLength(0);
  });

  it('enforces the permission matrix (owner can manage, member 403, non-member 404)', async () => {
    const owner = await registerUser(app, 'groupowner');
    const member = await registerUser(app, 'groupmember');
    const outsider = await registerUser(app, 'outsider');
    const [botId] = await getBotIds();
    const created = await createGroup(owner.token, { name: 'g', botIds: [botId!] });
    const groupId = created.body.group.id as string;

    const addRes = await request(app)
      .post(`/api/groups/${groupId}/members`)
      .set(auth(owner.token))
      .send({ username: member.user.username });
    expect(addRes.status).toBe(200);

    const memberPatch = await request(app)
      .patch(`/api/groups/${groupId}`)
      .set(auth(member.token))
      .send({ name: 'hacked' });
    expect(memberPatch.status).toBe(403);

    const outsiderGet = await request(app).get(`/api/groups/${groupId}`).set(auth(outsider.token));
    expect(outsiderGet.status).toBe(404);

    const msg = await request(app)
      .post(`/api/groups/${groupId}/messages`)
      .set(auth(member.token))
      .send({ content: '大家好' });
    expect(msg.status).toBe(201);
  });

  it('manages members: duplicate 409, unknown target 404, cannot remove creator', async () => {
    const owner = await registerUser(app, 'groupowner');
    const member = await registerUser(app, 'groupmember');
    const [botId] = await getBotIds();
    const created = await createGroup(owner.token, { name: 'g', botIds: [botId!] });
    const groupId = created.body.group.id as string;

    const added = await request(app)
      .post(`/api/groups/${groupId}/members`)
      .set(auth(owner.token))
      .send({ username: member.user.username });
    expect(added.status).toBe(200);
    // 成员输出应包含用户名（前端按用户名展示与排查）
    expect(added.body.group.members.map((m: { username: string }) => m.username)).toContain(
      member.user.username,
    );

    const duplicate = await request(app)
      .post(`/api/groups/${groupId}/members`)
      .set(auth(owner.token))
      .send({ username: member.user.username });
    expect(duplicate.status).toBe(409);

    const unknown = await request(app)
      .post(`/api/groups/${groupId}/members`)
      .set(auth(owner.token))
      .send({ username: 'not_a_real_user' });
    expect(unknown.status).toBe(404);

    // 用户名大小写敏感：用错误大小写添加已存在的用户 → 404（精确匹配失败）
    const wrongCase = await request(app)
      .post(`/api/groups/${groupId}/members`)
      .set(auth(owner.token))
      .send({ username: member.user.username.toUpperCase() });
    expect(wrongCase.status).toBe(404);

    const removeCreator = await request(app)
      .delete(`/api/groups/${groupId}/members/${owner.user.id}`)
      .set(auth(owner.token));
    expect(removeCreator.status).toBe(403);

    const removeMember = await request(app)
      .delete(`/api/groups/${groupId}/members/${member.user.id}`)
      .set(auth(owner.token));
    expect(removeMember.status).toBe(200);
  });

  it('allows members to leave but not the creator', async () => {
    const owner = await registerUser(app, 'groupowner');
    const member = await registerUser(app, 'groupmember');
    const [botId] = await getBotIds();
    const created = await createGroup(owner.token, { name: 'g', botIds: [botId!] });
    const groupId = created.body.group.id as string;
    await request(app)
      .post(`/api/groups/${groupId}/members`)
      .set(auth(owner.token))
      .send({ username: member.user.username });

    const ownerLeave = await request(app)
      .delete(`/api/groups/${groupId}/members/me`)
      .set(auth(owner.token));
    expect(ownerLeave.status).toBe(403);

    const memberLeave = await request(app)
      .delete(`/api/groups/${groupId}/members/me`)
      .set(auth(member.token));
    expect(memberLeave.status).toBe(204);
  });

  it('manages bots: add works, last bot cannot be removed', async () => {
    const { token } = await registerUser(app, 'groupowner');
    const [botA, botB] = await getBotIds();
    const created = await createGroup(token, { name: 'g', botIds: [botA!] });
    const groupId = created.body.group.id as string;

    const addRes = await request(app)
      .post(`/api/groups/${groupId}/bots`)
      .set(auth(token))
      .send({ botId: botB! });
    expect(addRes.status).toBe(200);
    expect(addRes.body.group.bots).toHaveLength(2);

    const removeOne = await request(app)
      .delete(`/api/groups/${groupId}/bots/${botA}`)
      .set(auth(token));
    expect(removeOne.status).toBe(200);

    const removeLast = await request(app)
      .delete(`/api/groups/${groupId}/bots/${botB}`)
      .set(auth(token));
    expect(removeLast.status).toBe(409);
    expect(removeLast.body.error.code).toBe('LAST_BOT');
  });

  it('refuses to remove a bot if it would leave no active bots', async () => {
    const { token } = await registerUser(app, 'groupowner');
    const [botA, botB] = await getBotIds();
    const created = await createGroup(token, { name: 'g', botIds: [botA!, botB!] });
    const groupId = created.body.group.id as string;

    // 模拟停用 botA：此时只有 botB 处于启用状态
    await prisma.bot.update({ where: { id: botA! }, data: { isActive: false } });
    try {
      // 移除已停用的 botA → 允许（还剩启用的 botB）
      const removeInactive = await request(app)
        .delete(`/api/groups/${groupId}/bots/${botA}`)
        .set(auth(token));
      expect(removeInactive.status).toBe(200);

      // 再移除最后一个启用机器人 botB → 409（保证人类消息后必有回复）
      const removeLastActive = await request(app)
        .delete(`/api/groups/${groupId}/bots/${botB}`)
        .set(auth(token));
      expect(removeLastActive.status).toBe(409);
      expect(removeLastActive.body.error.code).toBe('LAST_BOT');
    } finally {
      // 恢复启用状态，避免影响其他用例（bots 表不在 beforeEach 清理范围内）
      await prisma.bot.update({ where: { id: botA! }, data: { isActive: true } });
    }
  });

  it('blocks sending when the group has no active bots (409)', async () => {
    const { token } = await registerUser(app, 'groupowner');
    const [botId] = await getBotIds();
    const created = await createGroup(token, { name: 'g', botIds: [botId!] });
    const groupId = created.body.group.id as string;

    // 模拟唯一机器人被停用（当前无停用接口，直接改库）
    await prisma.bot.update({ where: { id: botId! }, data: { isActive: false } });
    try {
      const res = await request(app)
        .post(`/api/groups/${groupId}/messages`)
        .set(auth(token))
        .send({ content: '还有机器人吗' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('NO_ACTIVE_BOT');
    } finally {
      await prisma.bot.update({ where: { id: botId! }, data: { isActive: true } });
    }
  });

  it('is idempotent for the same clientRequestId in group messages', async () => {
    const { token } = await registerUser(app, 'groupowner');
    const [botId] = await getBotIds();
    const created = await createGroup(token, { name: 'g', botIds: [botId!] });
    const groupId = created.body.group.id as string;
    const payload = { content: '幂等群消息', clientRequestId: 'group-req-000001' };

    const first = await request(app)
      .post(`/api/groups/${groupId}/messages`)
      .set(auth(token))
      .send(payload);
    const second = await request(app)
      .post(`/api/groups/${groupId}/messages`)
      .set(auth(token))
      .send(payload);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.userMessage.id).toBe(first.body.userMessage.id);
    expect(second.body.botMessages[0].id).toBe(first.body.botMessages[0].id);

    // 历史中只有一轮（1 条人类 + 1 条机器人），无重复消息
    const history = await request(app).get(`/api/groups/${groupId}/messages`).set(auth(token));
    expect(history.body.messages).toHaveLength(2);
  });

  it('handles concurrent duplicate group submissions idempotently (no 500)', async () => {
    const { token } = await registerUser(app, 'groupowner');
    const [botId] = await getBotIds();
    const created = await createGroup(token, { name: 'g', botIds: [botId!] });
    const groupId = created.body.group.id as string;
    const payload = { content: '并发幂等', clientRequestId: 'group-race-0001' };

    // 群组级锁保证串行：两个并发相同键的请求都返回首次轮次结果
    const [r1, r2] = await Promise.all([
      request(app).post(`/api/groups/${groupId}/messages`).set(auth(token)).send(payload),
      request(app).post(`/api/groups/${groupId}/messages`).set(auth(token)).send(payload),
    ]);

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r2.body.userMessage.id).toBe(r1.body.userMessage.id);
  });

  it('ALL_BOTS: every bot replies in the same round', async () => {
    const { token } = await registerUser(app, 'groupowner');
    const [botA, botB] = await getBotIds();
    const created = await createGroup(token, { name: 'g', botIds: [botA!, botB!] });
    const groupId = created.body.group.id as string;

    const res = await request(app)
      .post(`/api/groups/${groupId}/messages`)
      .set(auth(token))
      .send({ content: '大家好' });

    expect(res.status).toBe(201);
    expect(res.body.userMessage.senderType).toBe('HUMAN');
    // 人类消息返回发送者展示名（registerUser 的 displayName 取用户名）
    expect(res.body.userMessage.senderName).toBe('groupowner');
    expect(res.body.botMessages).toHaveLength(2);
    expect(res.body.botMessages.every((m: { senderType: string }) => m.senderType === 'BOT')).toBe(
      true,
    );
    expect(
      res.body.botMessages.every(
        (m: { roundId: string }) => m.roundId === res.body.userMessage.roundId,
      ),
    ).toBe(true);
  });

  it('RANDOM_ONE: exactly one bot replies', async () => {
    const { token } = await registerUser(app, 'groupowner');
    const [botA, botB] = await getBotIds();
    const created = await createGroup(token, {
      name: 'g',
      botIds: [botA!, botB!],
      responseMode: 'RANDOM_ONE',
    });
    const groupId = created.body.group.id as string;

    const res = await request(app)
      .post(`/api/groups/${groupId}/messages`)
      .set(auth(token))
      .send({ content: '随机一个' });

    expect(res.body.botMessages).toHaveLength(1);
  });

  it('CONTENT_ROUTED: keyword matching and fallback when nothing matches', async () => {
    const { token } = await registerUser(app, 'groupowner');
    const bots = await prisma.bot.findMany({ select: { id: true, code: true } });
    const romilly = bots.find((b) => b.code === 'romilly');
    const cooper = bots.find((b) => b.code === 'cooper');
    expect(romilly).toBeDefined();
    expect(cooper).toBeDefined();

    const created = await createGroup(token, {
      name: 'g',
      botIds: [romilly!.id, cooper!.id],
      responseMode: 'CONTENT_ROUTED',
    });
    const groupId = created.body.group.id as string;

    const hit = await request(app)
      .post(`/api/groups/${groupId}/messages`)
      .set(auth(token))
      .send({ content: '卡冈图雅黑洞的视界怎么计算' });
    expect(hit.body.botMessages).toHaveLength(1);
    const repliedBot = await prisma.bot.findUnique({
      where: { id: hit.body.botMessages[0].botId },
    });
    expect(repliedBot?.code).toBe('romilly');

    const miss = await request(app)
      .post(`/api/groups/${groupId}/messages`)
      .set(auth(token))
      .send({ content: '今天天气真好' });
    expect(miss.body.botMessages).toHaveLength(1);
  });

  it('mentioning a bot replies only that bot, even in ALL_BOTS mode', async () => {
    const { token } = await registerUser(app, 'groupowner');
    const bots = await prisma.bot.findMany({ select: { id: true, code: true, name: true } });
    const romilly = bots.find((b) => b.code === 'romilly');
    const cooper = bots.find((b) => b.code === 'cooper');
    expect(romilly).toBeDefined();
    expect(cooper).toBeDefined();

    // ALL_BOTS 模式下群组有 2 个机器人，但只 @ 罗米利 → 只有它回复
    const created = await createGroup(token, {
      name: 'g',
      botIds: [romilly!.id, cooper!.id],
      responseMode: 'ALL_BOTS',
    });
    const groupId = created.body.group.id as string;

    const res = await request(app)
      .post(`/api/groups/${groupId}/messages`)
      .set(auth(token))
      .send({ content: `@${romilly!.name} 帮我算一下轨道参数` });

    expect(res.status).toBe(201);
    expect(res.body.botMessages).toHaveLength(1);
    expect(res.body.botMessages[0].botId).toBe(romilly!.id);
  });

  it('replies to multiple mentioned bots in @ order (deduped)', async () => {
    const { token } = await registerUser(app, 'groupowner');
    const bots = await prisma.bot.findMany({ select: { id: true, code: true, name: true } });
    const romilly = bots.find((b) => b.code === 'romilly');
    const cooper = bots.find((b) => b.code === 'cooper');
    expect(romilly).toBeDefined();
    expect(cooper).toBeDefined();

    const created = await createGroup(token, {
      name: 'g',
      botIds: [romilly!.id, cooper!.id],
      responseMode: 'RANDOM_ONE', // 显式 @ 应覆盖随机策略
    });
    const groupId = created.body.group.id as string;

    // 按 @ 顺序：库珀先、罗米利后；@ 顺序与消息内容一致
    const res = await request(app)
      .post(`/api/groups/${groupId}/messages`)
      .set(auth(token))
      .send({ content: `@${cooper!.name} 先来一句 @${romilly!.name} 再来分析` });

    expect(res.status).toBe(201);
    expect(res.body.botMessages).toHaveLength(2);
    expect(res.body.botMessages[0].botId).toBe(cooper!.id);
    expect(res.body.botMessages[1].botId).toBe(romilly!.id);
  });

  it('mentioning only a real member triggers no bot replies', async () => {
    const owner = await registerUser(app, 'groupowner');
    const member = await registerUser(app, 'groupmember');
    const bots = await prisma.bot.findMany({ select: { id: true, code: true } });
    const romilly = bots.find((b) => b.code === 'romilly');
    const cooper = bots.find((b) => b.code === 'cooper');

    const created = await createGroup(owner.token, {
      name: 'g',
      botIds: [romilly!.id, cooper!.id],
      responseMode: 'ALL_BOTS',
    });
    const groupId = created.body.group.id as string;
    // 先把 member 加入群组，使其成为可被 @ 的合法成员
    await request(app)
      .post(`/api/groups/${groupId}/members`)
      .set(auth(owner.token))
      .send({ username: member.user.username });

    // 只 @ 真人 → 消息明确指向真人，本轮不触发任何机器人（由真人本人回复）
    const res = await request(app)
      .post(`/api/groups/${groupId}/messages`)
      .set(auth(owner.token))
      .send({ content: `@${member.user.username} 你方便的话回一下` });

    expect(res.status).toBe(201);
    expect(res.body.botMessages).toHaveLength(0);
  });

  it('rejects mentions of names not in the group with 400 MENTION_NOT_FOUND', async () => {
    const { token } = await registerUser(app, 'groupowner');
    const [botId] = await getBotIds();
    const created = await createGroup(token, { name: 'g', botIds: [botId!] });
    const groupId = created.body.group.id as string;

    // 「不存在的人」既不是群组机器人也不是群组成员 → 400，并带 details 说明非法名称
    const res = await request(app)
      .post(`/api/groups/${groupId}/messages`)
      .set(auth(token))
      .send({ content: '@不存在的人 你好，请问在吗' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MENTION_NOT_FOUND');
    expect(res.body.error.details.mentions).toContain('不存在的人');
  });

  it('keeps sender names in history after a bot is removed from the group', async () => {
    const { token } = await registerUser(app, 'groupowner');
    const bots = await prisma.bot.findMany({ select: { id: true, code: true, name: true } });
    const romilly = bots.find((b) => b.code === 'romilly');
    const cooper = bots.find((b) => b.code === 'cooper');
    expect(romilly).toBeDefined();
    expect(cooper).toBeDefined();

    const created = await createGroup(token, {
      name: 'g',
      botIds: [romilly!.id, cooper!.id],
      responseMode: 'ALL_BOTS',
    });
    const groupId = created.body.group.id as string;
    await request(app)
      .post(`/api/groups/${groupId}/messages`)
      .set(auth(token))
      .send({ content: '大家好' });

    // 移除 cooper 机器人后再看历史：它发的消息仍应带原名，而不是退化为「机器人」
    const removed = await request(app)
      .delete(`/api/groups/${groupId}/bots/${cooper!.id}`)
      .set(auth(token));
    expect(removed.status).toBe(200);

    const history = await request(app).get(`/api/groups/${groupId}/messages`).set(auth(token));
    const cooperMessage = history.body.messages.find(
      (m: { botId: string | null }) => m.botId === cooper!.id,
    );
    expect(cooperMessage).toBeDefined();
    expect(cooperMessage.senderName).toBe(cooper!.name);
  });

  it('passes speaker-prefixed history to the AI as context', async () => {
    // 捕获每次 AI 调用的上下文，验证历史消息带「用户名/机器人名：」前缀
    const contexts: AiGenerateContext[] = [];
    const capturingProvider: AiProvider = {
      name: 'capturing',
      async generate(context: AiGenerateContext): Promise<AiGenerateResult> {
        contexts.push(context);
        return { content: '收到' };
      },
    };
    const capturingApp = createApp({ aiService: new AiService(capturingProvider) });
    const { token } = await registerUser(capturingApp, 'groupowner');
    const bots = await prisma.bot.findMany({ select: { id: true, code: true, name: true } });
    const romilly = bots.find((b) => b.code === 'romilly');
    const cooper = bots.find((b) => b.code === 'cooper');
    expect(romilly).toBeDefined();
    expect(cooper).toBeDefined();

    const created = await request(capturingApp)
      .post('/api/groups')
      .set(auth(token))
      .send({ name: 'g', botIds: [romilly!.id, cooper!.id], responseMode: 'ALL_BOTS' });
    const groupId = created.body.group.id as string;

    // 第一轮：人类消息 + 2 个机器人回复
    await request(capturingApp)
      .post(`/api/groups/${groupId}/messages`)
      .set(auth(token))
      .send({ content: '大家好' });
    // 清空第一轮的调用记录，只验证第二轮携带的历史上下文
    contexts.length = 0;

    const second = await request(capturingApp)
      .post(`/api/groups/${groupId}/messages`)
      .set(auth(token))
      .send({ content: '继续讨论' });

    expect(second.status).toBe(201);
    expect(contexts).toHaveLength(2); // 两个机器人各一次调用
    const history = contexts[0]!.history ?? [];
    // 上下文历史 = 第一轮的 3 条消息（当前消息已被排除，避免重复）
    expect(history).toHaveLength(3);
    expect(history[0]?.content).toBe('groupowner：大家好');
    const botContents = history.slice(1).map((h) => h.content);
    expect(botContents.some((c) => c.startsWith(`${romilly!.name}：收到`))).toBe(true);
    expect(botContents.some((c) => c.startsWith(`${cooper!.name}：收到`))).toBe(true);
  });

  it('prevents bot loops: bot replies never trigger new rounds and max cap applies', async () => {
    const { token } = await registerUser(app, 'groupowner');
    const [botA, botB, botC] = await getBotIds();
    // maxConsecutiveBotReplies=2：即使群组有 3 个机器人，每轮最多 2 条回复
    const created = await createGroup(token, {
      name: 'g',
      botIds: [botA!, botB!, botC!],
      maxConsecutiveBotReplies: 2,
    });
    const groupId = created.body.group.id as string;

    const first = await request(app)
      .post(`/api/groups/${groupId}/messages`)
      .set(auth(token))
      .send({ content: '第一轮' });
    expect(first.body.botMessages).toHaveLength(2);

    const second = await request(app)
      .post(`/api/groups/${groupId}/messages`)
      .set(auth(token))
      .send({ content: '第二轮' });
    expect(second.body.botMessages).toHaveLength(2);
    expect(second.body.userMessage.roundId).not.toBe(first.body.userMessage.roundId);

    const history = await request(app).get(`/api/groups/${groupId}/messages`).set(auth(token));
    expect(history.body.messages).toHaveLength(6); // HUMAN+BOT+BOT × 2 轮
  });

  it('guarantees a reply with fallback text when AI keeps failing', async () => {
    const { token } = await registerUser(app, 'groupowner');
    const [botA, botB] = await getBotIds();
    const created = await createGroup(token, { name: 'g', botIds: [botA!, botB!] });
    const groupId = created.body.group.id as string;

    const res = await request(failingApp)
      .post(`/api/groups/${groupId}/messages`)
      .set(auth(token))
      .send({ content: '这条会失败' });

    expect(res.status).toBe(201);
    expect(res.body.botMessages).toHaveLength(2);
    expect(
      res.body.botMessages.every((m: { content: string }) => m.content.includes('我暂时无法回答')),
    ).toBe(true);
  });

  it('prevents non-members from sending or reading messages (404)', async () => {
    const owner = await registerUser(app, 'groupowner');
    const outsider = await registerUser(app, 'outsider');
    const [botId] = await getBotIds();
    const created = await createGroup(owner.token, { name: 'g', botIds: [botId!] });
    const groupId = created.body.group.id as string;

    const sendRes = await request(app)
      .post(`/api/groups/${groupId}/messages`)
      .set(auth(outsider.token))
      .send({ content: '越权' });
    const listRes = await request(app)
      .get(`/api/groups/${groupId}/messages`)
      .set(auth(outsider.token));

    expect(sendRes.status).toBe(404);
    expect(listRes.status).toBe(404);
  });

  it('rejects an invalid message cursor with 400', async () => {
    const { token } = await registerUser(app, 'groupowner');
    const [botId] = await getBotIds();
    const created = await createGroup(token, { name: 'g', botIds: [botId!] });
    const groupId = created.body.group.id as string;

    const res = await request(app)
      .get(`/api/groups/${groupId}/messages?cursor=not-a-real-id`)
      .set(auth(token));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CURSOR');
  });

  it('streams bot replies via SSE (?stream=true)', async () => {
    const { token } = await registerUser(app, 'gstream');
    const [botId] = await getBotIds();
    const created = await createGroup(token, {
      name: '流式群',
      botIds: [botId!],
      responseMode: 'ALL_BOTS',
    });
    const groupId = created.body.group.id as string;

    const res = await request(app)
      .post(`/api/groups/${groupId}/messages?stream=true`)
      .set(auth(token))
      .send({ content: '大家好' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');

    const events = parseSse(res.text);
    const names = events.map((e) => e.event);
    // 事件顺序：user_message → bot_start → bot_delta… → bot_done → round_done
    expect(names[0]).toBe('user_message');
    expect(names).toContain('bot_start');
    expect(names).toContain('bot_delta');
    expect(names).toContain('bot_done');
    expect(names[names.length - 1]).toBe('round_done');

    const doneEvent = events.find((e) => e.event === 'bot_done');
    expect(doneEvent?.data).toMatchObject({
      message: { senderType: 'BOT', status: 'SENT' },
    });
    // bot_start 的 PENDING 占位消息带稳定 id，与 bot_done 最终消息一致
    const startEvent = events.find((e) => e.event === 'bot_start');
    expect((startEvent?.data as { message: { id: string } }).message.id).toBe(
      (doneEvent?.data as { message: { id: string } }).message.id,
    );

    // 数据库：人类消息 + 机器人回复均落库为 SENT
    const rows = await prisma.groupMessage.findMany({
      where: { groupId },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ senderType: 'HUMAN', status: 'SENT' });
    expect(rows[1]).toMatchObject({ senderType: 'BOT', status: 'SENT' });
  });

  it('streams fallback replies when AI keeps failing (guaranteed reply)', async () => {
    const { token } = await registerUser(failingApp, 'gstreamfail');
    const [botId] = await getBotIds();
    const created = await request(failingApp)
      .post('/api/groups')
      .set(auth(token))
      .send({ name: '兜底群', botIds: [botId!] });
    const groupId = created.body.group.id as string;

    const res = await request(failingApp)
      .post(`/api/groups/${groupId}/messages?stream=true`)
      .set(auth(token))
      .send({ content: 'hi' });

    const events = parseSse(res.text);
    const doneEvent = events.find((e) => e.event === 'bot_done');
    expect(doneEvent).toBeDefined();
    expect(doneEvent?.data).toMatchObject({ message: { status: 'SENT' } });
    // 兜底文案保证「人类消息后必有机器人回复」
    expect((doneEvent?.data as { message: { content: string } }).message.content).toContain(
      '我暂时无法回答',
    );
  });

  it('replays all cached NPC replies for the same group question (cache hit)', async () => {
    const provider = new CountingProvider();
    const cacheApp = createApp({ aiService: new AiService(provider) });
    const { token } = await registerUser(cacheApp, 'gcache');
    const bots = await prisma.bot.findMany({ select: { id: true, code: true } });
    const romilly = bots.find((b) => b.code === 'romilly');
    const cooper = bots.find((b) => b.code === 'cooper');
    const created = await request(cacheApp)
      .post('/api/groups')
      .set(auth(token))
      .send({ name: '缓存群', botIds: [romilly!.id, cooper!.id], responseMode: 'ALL_BOTS' });
    const groupId = created.body.group.id as string;

    const first = await request(cacheApp)
      .post(`/api/groups/${groupId}/messages`)
      .set(auth(token))
      .send({ content: '同一个群问题' });
    const second = await request(cacheApp)
      .post(`/api/groups/${groupId}/messages`)
      .set(auth(token))
      .send({ content: '同一个群问题' });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.botMessages).toHaveLength(2);
    expect(second.body.botMessages).toHaveLength(2);
    // 整轮回放：机器人顺序与内容与首次完全一致
    expect(second.body.botMessages.map((m: { botId: string | null }) => m.botId)).toEqual(
      first.body.botMessages.map((m: { botId: string | null }) => m.botId),
    );
    expect(second.body.botMessages.map((m: { content: string }) => m.content)).toEqual(
      first.body.botMessages.map((m: { content: string }) => m.content),
    );
    // 两个 NPC 各只调用一次（第二轮整轮命中缓存）
    expect(provider.calls).toBe(2);
  });

  it('replays the whole cached round via SSE for the same question', async () => {
    const provider = new CountingProvider();
    const cacheApp = createApp({ aiService: new AiService(provider) });
    const { token } = await registerUser(cacheApp, 'gcachestream');
    const bots = await prisma.bot.findMany({ select: { id: true, code: true } });
    const romilly = bots.find((b) => b.code === 'romilly');
    const cooper = bots.find((b) => b.code === 'cooper');
    const created = await request(cacheApp)
      .post('/api/groups')
      .set(auth(token))
      .send({ name: '缓存流式群', botIds: [romilly!.id, cooper!.id], responseMode: 'ALL_BOTS' });
    const groupId = created.body.group.id as string;

    // 第一次 JSON 生成并写入整轮缓存
    const first = await request(cacheApp)
      .post(`/api/groups/${groupId}/messages`)
      .set(auth(token))
      .send({ content: '同一个群问题' });
    // 第二次流式：应命中缓存（无 bot_start/bot_delta，直接 bot_done 回放）
    const second = await request(cacheApp)
      .post(`/api/groups/${groupId}/messages?stream=true`)
      .set(auth(token))
      .send({ content: '同一个群问题' });

    expect(second.status).toBe(200);
    const events = parseSse(second.text);
    const names = events.map((e) => e.event);
    expect(names[0]).toBe('user_message');
    expect(names).not.toContain('bot_start');
    expect(names).not.toContain('bot_delta');
    expect(names.filter((n) => n === 'bot_done')).toHaveLength(2);
    expect(names[names.length - 1]).toBe('round_done');
    const doneContents = events
      .filter((e) => e.event === 'bot_done')
      .map((e) => (e.data as { message: { content: string } }).message.content);
    expect(doneContents).toEqual(first.body.botMessages.map((m: { content: string }) => m.content));
    expect(provider.calls).toBe(2);
  });
});
