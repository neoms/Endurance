/**
 * 对话与标签接口集成测试
 *
 * 覆盖：
 * - 对话 CRUD（默认标题/自定义标题/改标题/删除）；
 * - ACL 数据隔离（用户 B 访问/改/删用户 A 的对话与标签 → 404）；
 * - 标签：添加、多标签 AND 筛选、移除、越权 404、名称归一化、孤儿标签清理；
 * - 删除级联：对话删除后消息与标签关联一并清除；
 * - 入参校验 422。
 */
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';
import { auth, createConversation, registerUser } from '../helpers.js';

const app = createApp();

describe('conversations API', () => {
  // 每个用例前清空用户表（级联清空其名下数据），保证用例相互独立
  beforeEach(async () => {
    await prisma.user.deleteMany();
  });

  it('creates a conversation with a default title', async () => {
    const { token } = await registerUser(app, 'convowner');
    const res = await request(app).post('/api/conversations').set(auth(token)).send({});

    expect(res.status).toBe(201);
    expect(res.body.conversation).toMatchObject({ title: '新对话', tags: [] });
  });

  it('creates a conversation with a custom title', async () => {
    const { token } = await registerUser(app, 'convowner');
    const res = await request(app)
      .post('/api/conversations')
      .set(auth(token))
      .send({ title: '学习计划' });

    expect(res.status).toBe(201);
    expect(res.body.conversation.title).toBe('学习计划');
  });

  it('lists only the current user conversations', async () => {
    const userA = await registerUser(app, 'aliceconv');
    const userB = await registerUser(app, 'bobconv');
    await createConversation(app, userA.token);

    const resA = await request(app).get('/api/conversations').set(auth(userA.token));
    const resB = await request(app).get('/api/conversations').set(auth(userB.token));

    expect(resA.body.conversations).toHaveLength(1);
    expect(resB.body.conversations).toHaveLength(0);
  });

  it('hides another user conversation on get/patch/delete (404)', async () => {
    const userA = await registerUser(app, 'aliceconv');
    const userB = await registerUser(app, 'bobconv');
    const created = await createConversation(app, userA.token);
    const id = created.body.conversation.id as string;

    const getRes = await request(app).get(`/api/conversations/${id}`).set(auth(userB.token));
    const patchRes = await request(app)
      .patch(`/api/conversations/${id}`)
      .set(auth(userB.token))
      .send({ title: 'hacked' });
    const deleteRes = await request(app).delete(`/api/conversations/${id}`).set(auth(userB.token));

    expect(getRes.status).toBe(404);
    expect(patchRes.status).toBe(404);
    expect(deleteRes.status).toBe(404);

    // 用户 A 的对话仍然存在，确认 B 的操作未生效
    const stillThere = await request(app).get(`/api/conversations/${id}`).set(auth(userA.token));
    expect(stillThere.status).toBe(200);
  });

  it('updates and deletes own conversation', async () => {
    const { token } = await registerUser(app, 'convowner');
    const created = await createConversation(app, token);
    const id = created.body.conversation.id as string;

    const patchRes = await request(app)
      .patch(`/api/conversations/${id}`)
      .set(auth(token))
      .send({ title: '新标题' });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.conversation.title).toBe('新标题');

    const deleteRes = await request(app).delete(`/api/conversations/${id}`).set(auth(token));
    expect(deleteRes.status).toBe(204);

    const getRes = await request(app).get(`/api/conversations/${id}`).set(auth(token));
    expect(getRes.status).toBe(404);
  });

  it('rejects invalid title with 422', async () => {
    const { token } = await registerUser(app, 'convowner');
    const res = await request(app).post('/api/conversations').set(auth(token)).send({ title: '' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('adds tags and filters conversations by tags (AND semantics)', async () => {
    const { token } = await registerUser(app, 'tagowner');

    // 对话 A：工作 + 学习；对话 B：仅学习
    const work = await createConversation(app, token, '工作对话');
    const workId = work.body.conversation.id as string;
    await request(app)
      .post(`/api/conversations/${workId}/tags`)
      .set(auth(token))
      .send({ name: '工作' });
    await request(app)
      .post(`/api/conversations/${workId}/tags`)
      .set(auth(token))
      .send({ name: '学习' });

    const study = await createConversation(app, token, '学习对话');
    const studyId = study.body.conversation.id as string;
    await request(app)
      .post(`/api/conversations/${studyId}/tags`)
      .set(auth(token))
      .send({ name: '学习' });

    const all = await request(app).get('/api/conversations').set(auth(token));
    expect(all.body.conversations).toHaveLength(2);

    // 仅「工作」→ 命中对话 A
    const workOnly = await request(app)
      .get('/api/conversations')
      .query({ tag: '工作' })
      .set(auth(token));
    expect(workOnly.body.conversations).toHaveLength(1);
    expect(workOnly.body.conversations[0].title).toBe('工作对话');

    // 「工作 + 学习」AND → 仍只命中对话 A（B 只有学习，不满足）
    const both = await request(app)
      .get('/api/conversations')
      .query({ tag: ['工作', '学习'] })
      .set(auth(token));
    expect(both.body.conversations).toHaveLength(1);
    expect(both.body.conversations[0].title).toBe('工作对话');
    expect(both.body.conversations[0].tags.map((t: { name: string }) => t.name).sort()).toEqual([
      '学习',
      '工作',
    ]);
  });

  it('removes a tag and it no longer matches the filter', async () => {
    const { token } = await registerUser(app, 'tagowner');
    const created = await createConversation(app, token);
    const id = created.body.conversation.id as string;
    const added = await request(app)
      .post(`/api/conversations/${id}/tags`)
      .set(auth(token))
      .send({ name: '临时' });
    const tagId = added.body.tag.id as string;

    const before = await request(app)
      .get('/api/conversations')
      .query({ tag: '临时' })
      .set(auth(token));
    expect(before.body.conversations).toHaveLength(1);

    const removeRes = await request(app)
      .delete(`/api/conversations/${id}/tags/${tagId}`)
      .set(auth(token));
    expect(removeRes.status).toBe(204);

    const after = await request(app)
      .get('/api/conversations')
      .query({ tag: '临时' })
      .set(auth(token));
    expect(after.body.conversations).toHaveLength(0);
  });

  it('prevents another user from touching tags (404)', async () => {
    const userA = await registerUser(app, 'aliceconv');
    const userB = await registerUser(app, 'bobconv');
    const created = await createConversation(app, userA.token);
    const id = created.body.conversation.id as string;
    const added = await request(app)
      .post(`/api/conversations/${id}/tags`)
      .set(auth(userA.token))
      .send({ name: '私有' });
    const tagId = added.body.tag.id as string;

    const addRes = await request(app)
      .post(`/api/conversations/${id}/tags`)
      .set(auth(userB.token))
      .send({ name: 'x' });
    const removeRes = await request(app)
      .delete(`/api/conversations/${id}/tags/${tagId}`)
      .set(auth(userB.token));

    expect(addRes.status).toBe(404);
    expect(removeRes.status).toBe(404);
  });

  it('deletes conversation with its messages and tag links (cascade + orphan cleanup)', async () => {
    const { token, user } = await registerUser(app, 'cascadeowner');
    const conv = await createConversation(app, token);
    const id = conv.body.conversation.id as string;

    await request(app)
      .post(`/api/conversations/${id}/messages`)
      .set(auth(token))
      .send({ content: '这条消息随对话一起删除' });
    const added = await request(app)
      .post(`/api/conversations/${id}/tags`)
      .set(auth(token))
      .send({ name: '临时' });
    const tagId = added.body.tag.id as string;

    const del = await request(app).delete(`/api/conversations/${id}`).set(auth(token));
    expect(del.status).toBe(204);

    // DB 层验证：消息、标签关联、孤儿标签全部被清除
    const msgCount = await prisma.message.count({ where: { conversationId: id } });
    const linkCount = await prisma.conversationTag.count({ where: { conversationId: id } });
    const tagCount = await prisma.tag.count({ where: { id: tagId, userId: user.id } });
    expect(msgCount).toBe(0);
    expect(linkCount).toBe(0);
    expect(tagCount).toBe(0);
  });

  it('cleans up orphaned tag rows after removing the last reference', async () => {
    const { token, user } = await registerUser(app, 'tagcleanup');
    const conv = await createConversation(app, token);
    const id = conv.body.conversation.id as string;
    const added = await request(app)
      .post(`/api/conversations/${id}/tags`)
      .set(auth(token))
      .send({ name: '临时' });
    const tagId = added.body.tag.id as string;

    const removeRes = await request(app)
      .delete(`/api/conversations/${id}/tags/${tagId}`)
      .set(auth(token));
    expect(removeRes.status).toBe(204);

    const remaining = await prisma.tag.count({ where: { id: tagId, userId: user.id } });
    expect(remaining).toBe(0);
  });

  it('normalizes tag names (trim + lowercase) on add and filter', async () => {
    const { token } = await registerUser(app, 'tagnorm');
    const conv = await createConversation(app, token);
    const id = conv.body.conversation.id as string;

    // 添加时带前后空格与大小写：服务端应归一化为小写存储
    await request(app)
      .post(`/api/conversations/${id}/tags`)
      .set(auth(token))
      .send({ name: ' Work ' });
    const detail = await request(app).get(`/api/conversations/${id}`).set(auth(token));
    expect(detail.body.conversation.tags[0].name).toBe('work');

    // 筛选时大小写不同、带空格也应命中同一标签
    const filtered = await request(app)
      .get('/api/conversations')
      .query({ tag: '  WORK  ' })
      .set(auth(token));
    expect(filtered.body.conversations).toHaveLength(1);
    expect(filtered.body.conversations[0].id).toBe(id);
  });
});
