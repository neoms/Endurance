/**
 * 消息接口集成测试
 *
 * 覆盖：
 * - 发送消息 → 用户消息 + AI 回复双写；
 * - 默认标题取首条用户消息（含超长截断）；
 * - 手动设置过的标题不再被首条消息覆盖（含改回「新对话」的边界）；
 * - 发送消息刷新对话 updatedAt（列表按最近活跃排序）；
 * - 历史消息按时间顺序返回；
 * - clientRequestId 幂等去重；
 * - 幂等键按对话隔离：跨用户复用不泄露他人消息、同用户跨对话互不影响；
 * - 分页：默认返回最近消息、before 加载更早、无效游标 400；
 * - 空内容 422；跨用户发送/查看 404；
 * - AI 持续失败 → FAILED 占位 + retry 恢复（重试携带对话历史上下文）；
 * - retry 的 409 场景（SENT 消息 / 人类消息）与跨用户 404。
 */
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';
import { AiService } from '../../src/services/ai/ai.service.js';
import { MockAiProvider } from '../../src/services/ai/mock.provider.js';
import type {
  AiGenerateContext,
  AiGenerateResult,
  AiProvider,
} from '../../src/services/ai/types.js';
import { auth, createConversation, registerUser } from '../helpers.js';

// 正常应用（AI 成功）与故障应用（AI 必然失败，用于失败一致性测试）
const app = createApp();
const failingApp = createApp({ aiService: new AiService(new MockAiProvider({ failTimes: 99 })) });

/**
 * 记录调用上下文的 Provider（测试重试是否携带多轮历史）
 */
class RecordingProvider implements AiProvider {
  readonly name = 'recording';
  calls: Array<{
    content: string;
    history: Array<{ role: 'user' | 'assistant'; content: string }>;
  }> = [];

  async generate(context: AiGenerateContext): Promise<AiGenerateResult> {
    this.calls.push({ content: context.content, history: context.history ?? [] });
    return { content: '重试成功' };
  }
}

describe('messages API', () => {
  // 每个用例前清空用户表（级联清空其名下数据），保证用例相互独立
  beforeEach(async () => {
    await prisma.user.deleteMany();
  });

  it('sends a message and stores user + AI replies', async () => {
    const { token } = await registerUser(app, 'msguser');
    const conv = await createConversation(app, token);
    const id = conv.body.conversation.id as string;

    const res = await request(app)
      .post(`/api/conversations/${id}/messages`)
      .set(auth(token))
      .send({ content: '你好，AI' });

    expect(res.status).toBe(201);
    expect(res.body.userMessage).toMatchObject({
      senderType: 'HUMAN',
      content: '你好，AI',
      status: 'SENT',
    });
    expect(res.body.aiMessage).toMatchObject({ senderType: 'BOT', status: 'SENT' });
    expect(res.body.aiMessage.content).toContain('你好，AI');
  });

  it('sets the conversation title from the first user message', async () => {
    const { token } = await registerUser(app, 'msguser');
    const conv = await createConversation(app, token);
    const id = conv.body.conversation.id as string;

    await request(app)
      .post(`/api/conversations/${id}/messages`)
      .set(auth(token))
      .send({ content: '帮我制定一个学习计划' });

    const detail = await request(app).get(`/api/conversations/${id}`).set(auth(token));
    expect(detail.body.conversation.title).toBe('帮我制定一个学习计划');
  });

  it('truncates long default titles to 30 characters', async () => {
    const { token } = await registerUser(app, 'msguser');
    const conv = await createConversation(app, token);
    const id = conv.body.conversation.id as string;
    const longContent = '这是一条非常长的第一条消息用来验证默认标题会被截断到三十个字符以内';

    await request(app)
      .post(`/api/conversations/${id}/messages`)
      .set(auth(token))
      .send({ content: longContent });

    const detail = await request(app).get(`/api/conversations/${id}`).set(auth(token));
    expect(detail.body.conversation.title.length).toBeLessThanOrEqual(31);
    expect(detail.body.conversation.title).toMatch(/…$/);
  });

  it('does not overwrite a manually customized title (even when set back to 新对话)', async () => {
    const { token } = await registerUser(app, 'titlekeeper');
    const conv = await createConversation(app, token);
    const id = conv.body.conversation.id as string;

    // 用户手动把标题改回默认值「新对话」
    await request(app).patch(`/api/conversations/${id}`).set(auth(token)).send({ title: '新对话' });
    await request(app)
      .post(`/api/conversations/${id}/messages`)
      .set(auth(token))
      .send({ content: '这条消息不应覆盖标题' });

    const detail = await request(app).get(`/api/conversations/${id}`).set(auth(token));
    expect(detail.body.conversation.title).toBe('新对话');
  });

  it('does not overwrite a custom title set at creation', async () => {
    const { token } = await registerUser(app, 'titlecustom');
    const conv = await createConversation(app, token, '自定义标题');
    const id = conv.body.conversation.id as string;

    await request(app)
      .post(`/api/conversations/${id}/messages`)
      .set(auth(token))
      .send({ content: '首条消息' });

    const detail = await request(app).get(`/api/conversations/${id}`).set(auth(token));
    expect(detail.body.conversation.title).toBe('自定义标题');
  });

  it('bumps conversation updatedAt when a message is sent (recent activity ordering)', async () => {
    const { token } = await registerUser(app, 'bumpuser');
    const conv = await createConversation(app, token);
    const id = conv.body.conversation.id as string;

    const before = (await request(app).get(`/api/conversations/${id}`).set(auth(token))).body
      .conversation.updatedAt as string;
    // 稍等片刻，确保时间戳可区分
    await new Promise((resolve) => setTimeout(resolve, 5));
    await request(app)
      .post(`/api/conversations/${id}/messages`)
      .set(auth(token))
      .send({ content: '新消息' });

    const after = (await request(app).get(`/api/conversations/${id}`).set(auth(token))).body
      .conversation.updatedAt as string;
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
  });

  it('paginates history: newest page by default, before loads older, invalid anchors 400', async () => {
    const { token } = await registerUser(app, 'pageuser');
    const conv = await createConversation(app, token);
    const id = conv.body.conversation.id as string;

    // 直接向数据库插入 5 条人类消息（绕过 AI，专注验证分页语义）
    for (let i = 1; i <= 5; i += 1) {
      await prisma.message.create({
        data: {
          conversationId: id,
          senderType: 'HUMAN',
          content: `m${i}`,
          status: 'SENT',
        },
      });
    }

    // 默认（无 cursor/before）：返回最近 2 条，升序
    const newest = await request(app)
      .get(`/api/conversations/${id}/messages?limit=2`)
      .set(auth(token));
    expect(newest.status).toBe(200);
    expect(newest.body.messages.map((m: { content: string }) => m.content)).toEqual(['m4', 'm5']);

    // before=m4：返回 m4 之前的 2 条
    const m4Id = newest.body.messages[0].id as string;
    const older = await request(app)
      .get(`/api/conversations/${id}/messages?before=${m4Id}&limit=2`)
      .set(auth(token));
    expect(older.body.messages.map((m: { content: string }) => m.content)).toEqual(['m2', 'm3']);

    // 继续 before=m2：只剩 m1
    const m2Id = older.body.messages[0].id as string;
    const oldest = await request(app)
      .get(`/api/conversations/${id}/messages?before=${m2Id}&limit=2`)
      .set(auth(token));
    expect(oldest.body.messages.map((m: { content: string }) => m.content)).toEqual(['m1']);

    // 无效游标/锚点（不存在或不属于该对话）→ 400 INVALID_CURSOR
    const badBefore = await request(app)
      .get(`/api/conversations/${id}/messages?before=not-a-real-id`)
      .set(auth(token));
    const badCursor = await request(app)
      .get(`/api/conversations/${id}/messages?cursor=not-a-real-id`)
      .set(auth(token));
    expect(badBefore.status).toBe(400);
    expect(badBefore.body.error.code).toBe('INVALID_CURSOR');
    expect(badCursor.status).toBe(400);
    expect(badCursor.body.error.code).toBe('INVALID_CURSOR');
  });

  it('retries a failed AI message with prior conversation history', async () => {
    const provider = new RecordingProvider();
    const retryApp = createApp({ aiService: new AiService(provider) });
    const { token } = await registerUser(app, 'retryctx');
    const conv = await createConversation(app, token);
    const id = conv.body.conversation.id as string;

    // 第一轮正常发送；第二轮用故障应用发送（AI 重试耗尽 → FAILED）
    await request(app)
      .post(`/api/conversations/${id}/messages`)
      .set(auth(token))
      .send({ content: '第一问' });
    const failed = await request(failingApp)
      .post(`/api/conversations/${id}/messages`)
      .set(auth(token))
      .send({ content: '第二问' });
    expect(failed.body.aiMessage.status).toBe('FAILED');

    // 用记录型 Provider 重试：应携带失败消息之前的对话历史
    const retry = await request(retryApp)
      .post(`/api/messages/${failed.body.aiMessage.id}/retry`)
      .set(auth(token));
    expect(retry.status).toBe(200);

    expect(provider.calls).toHaveLength(1);
    const ctx = provider.calls[0]!;
    expect(ctx.content).toBe('第二问');
    // 历史 = 第一问(user) + AI 回复(assistant) + 第二问(user)，按时间升序
    expect(ctx.history.map((h) => h.role)).toEqual(['user', 'assistant', 'user']);
    expect(ctx.history.map((h) => h.content)).toEqual(expect.arrayContaining(['第一问', '第二问']));
  });

  it('lists messages in chronological order', async () => {
    const { token } = await registerUser(app, 'msguser');
    const conv = await createConversation(app, token);
    const id = conv.body.conversation.id as string;

    await request(app)
      .post(`/api/conversations/${id}/messages`)
      .set(auth(token))
      .send({ content: '第一问' });
    await request(app)
      .post(`/api/conversations/${id}/messages`)
      .set(auth(token))
      .send({ content: '第二问' });

    const res = await request(app).get(`/api/conversations/${id}/messages`).set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(4);
    expect(res.body.messages.map((m: { senderType: string }) => m.senderType)).toEqual([
      'HUMAN',
      'BOT',
      'HUMAN',
      'BOT',
    ]);
  });

  it('is idempotent for the same clientRequestId', async () => {
    const { token } = await registerUser(app, 'msguser');
    const conv = await createConversation(app, token);
    const id = conv.body.conversation.id as string;
    const payload = { content: '别发重复', clientRequestId: 'req-00000001' };

    const first = await request(app)
      .post(`/api/conversations/${id}/messages`)
      .set(auth(token))
      .send(payload);
    const second = await request(app)
      .post(`/api/conversations/${id}/messages`)
      .set(auth(token))
      .send(payload);

    expect(second.status).toBe(201);
    expect(second.body.userMessage.id).toBe(first.body.userMessage.id);
    const list = await request(app).get(`/api/conversations/${id}/messages`).set(auth(token));
    expect(list.body.messages).toHaveLength(2);
  });

  it('does not leak messages across users when clientRequestId collides', async () => {
    const userA = await registerUser(app, 'aliceiso');
    const userB = await registerUser(app, 'bobiso');
    const convA = await createConversation(app, userA.token);
    const convB = await createConversation(app, userB.token);
    const idA = convA.body.conversation.id as string;
    const idB = convB.body.conversation.id as string;

    // A 先使用该幂等键发送消息
    await request(app)
      .post(`/api/conversations/${idA}/messages`)
      .set(auth(userA.token))
      .send({ content: 'A 的机密消息', clientRequestId: 'shared-req-000001' });

    // B 在自己的对话中复用同一幂等键：必须拿到自己的消息，而不是 A 的消息
    const resB = await request(app)
      .post(`/api/conversations/${idB}/messages`)
      .set(auth(userB.token))
      .send({ content: 'B 自己的消息', clientRequestId: 'shared-req-000001' });
    expect(resB.status).toBe(201);
    expect(resB.body.userMessage.content).toBe('B 自己的消息');

    // B 的消息确实落库（防止「命中他人幂等键导致自身消息丢失」）
    const listB = await request(app)
      .get(`/api/conversations/${idB}/messages`)
      .set(auth(userB.token));
    expect(
      listB.body.messages.some(
        (m: { senderType: string; content: string }) =>
          m.senderType === 'HUMAN' && m.content === 'B 自己的消息',
      ),
    ).toBe(true);

    // A 的消息仍只属于 A
    const listA = await request(app)
      .get(`/api/conversations/${idA}/messages`)
      .set(auth(userA.token));
    expect(
      listA.body.messages.some(
        (m: { senderType: string; content: string }) =>
          m.senderType === 'HUMAN' && m.content === 'A 的机密消息',
      ),
    ).toBe(true);
  });

  it('allows the same clientRequestId in different conversations of the same user', async () => {
    const { token } = await registerUser(app, 'multiconv');
    const conv1 = await createConversation(app, token);
    const conv2 = await createConversation(app, token);
    const id1 = conv1.body.conversation.id as string;
    const id2 = conv2.body.conversation.id as string;

    const first = await request(app)
      .post(`/api/conversations/${id1}/messages`)
      .set(auth(token))
      .send({ content: '第一对话', clientRequestId: 'same-req-000001' });
    const second = await request(app)
      .post(`/api/conversations/${id2}/messages`)
      .set(auth(token))
      .send({ content: '第二对话', clientRequestId: 'same-req-000001' });

    // 两条消息都应正常落库：幂等键作用域是「对话」，而非全局或用户
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.userMessage.id).not.toBe(first.body.userMessage.id);
  });

  it('rejects empty content with 422', async () => {
    const { token } = await registerUser(app, 'msguser');
    const conv = await createConversation(app, token);
    const id = conv.body.conversation.id as string;

    const res = await request(app)
      .post(`/api/conversations/${id}/messages`)
      .set(auth(token))
      .send({ content: '   ' });

    expect(res.status).toBe(422);
  });

  it('prevents other users from sending or listing messages (404)', async () => {
    const userA = await registerUser(app, 'aliceconv');
    const userB = await registerUser(app, 'bobconv');
    const conv = await createConversation(app, userA.token);
    const id = conv.body.conversation.id as string;

    const sendRes = await request(app)
      .post(`/api/conversations/${id}/messages`)
      .set(auth(userB.token))
      .send({ content: '越权消息' });
    const listRes = await request(app)
      .get(`/api/conversations/${id}/messages`)
      .set(auth(userB.token));

    expect(sendRes.status).toBe(404);
    expect(listRes.status).toBe(404);
  });

  it('marks AI message FAILED on persistent provider failure and retry recovers it', async () => {
    const { token } = await registerUser(app, 'retryuser');
    const conv = await createConversation(app, token);
    const id = conv.body.conversation.id as string;

    // 用故障应用发送：用户消息仍保存，AI 消息 FAILED 占位
    const res = await request(failingApp)
      .post(`/api/conversations/${id}/messages`)
      .set(auth(token))
      .send({ content: '这条会失败' });

    expect(res.status).toBe(201);
    expect(res.body.userMessage.status).toBe('SENT');
    expect(res.body.aiMessage.status).toBe('FAILED');
    expect(res.body.aiMessage.errorCode).toBe('AI_UNAVAILABLE');

    // 用正常应用重试：AI 消息恢复为 SENT
    const retry = await request(app)
      .post(`/api/messages/${res.body.aiMessage.id}/retry`)
      .set(auth(token));
    expect(retry.status).toBe(200);
    expect(retry.body.aiMessage.status).toBe('SENT');
    expect(retry.body.aiMessage.errorCode).toBeNull();
  });

  it('rejects retrying a sent or human message with 409', async () => {
    const { token } = await registerUser(app, 'retryuser');
    const conv = await createConversation(app, token);
    const id = conv.body.conversation.id as string;

    const sent = await request(app)
      .post(`/api/conversations/${id}/messages`)
      .set(auth(token))
      .send({ content: '正常消息' });

    const retrySent = await request(app)
      .post(`/api/messages/${sent.body.aiMessage.id}/retry`)
      .set(auth(token));
    const retryHuman = await request(app)
      .post(`/api/messages/${sent.body.userMessage.id}/retry`)
      .set(auth(token));

    expect(retrySent.status).toBe(409);
    expect(retryHuman.status).toBe(409);
  });

  it('prevents other users from retrying a message (404)', async () => {
    const userA = await registerUser(app, 'aliceconv');
    const userB = await registerUser(app, 'bobconv');
    const conv = await createConversation(app, userA.token);
    const id = conv.body.conversation.id as string;
    const sent = await request(app)
      .post(`/api/conversations/${id}/messages`)
      .set(auth(userA.token))
      .send({ content: '正常消息' });

    const res = await request(app)
      .post(`/api/messages/${sent.body.userMessage.id}/retry`)
      .set(auth(userB.token));
    expect(res.status).toBe(404);
  });
});
