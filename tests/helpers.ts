/**
 * 集成测试公共工具
 *
 * 【函数说明】
 * - registerUser：注册一个用户并返回 { token, user }，供测试快速获得登录态；
 * - auth：构造 Bearer 鉴权请求头。
 * - parseSse：把 SSE 文本解析为事件数组（流式接口测试用）。
 */
import type { Express } from 'express';
import request from 'supertest';

/**
 * 注册用户并返回登录态
 *
 * @param app      Express 应用实例
 * @param username 注册用户名（测试内需唯一，beforeEach 会清空用户表）
 * @returns { token: string, user: { id: string, username: string } }
 */
export async function registerUser(app: Express, username: string) {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ username, password: 'password123', displayName: username });
  return {
    token: res.body.token as string,
    user: res.body.user as { id: string; username: string },
  };
}

/**
 * 构造 Bearer 鉴权请求头
 *
 * @param token JWT
 * @returns { Authorization: string } 可直接传给 supertest 的 .set()
 */
export function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

/**
 * 创建个人对话
 *
 * @param app   Express 应用实例
 * @param token JWT
 * @param title 对话标题（可选，缺省时服务端使用默认标题）
 * @returns supertest 响应（可通过 res.body.conversation 取结果）
 */
export async function createConversation(app: Express, token: string, title?: string) {
  return request(app)
    .post('/api/conversations')
    .set(auth(token))
    .send(title ? { title } : {});
}

/**
 * 解析 SSE 响应文本为事件数组
 *
 * @param body SSE 响应文本（event: 行 + data: 行 + 空行分隔）
 * @returns Array<{ event: string; data: unknown }> 按出现顺序的事件列表
 * 说明：data 已 JSON.parse；空帧（如结尾多余空行）自动跳过。
 */
export function parseSse(body: string): Array<{ event: string; data: unknown }> {
  const events: Array<{ event: string; data: unknown }> = [];
  for (const frame of body.split('\n\n')) {
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      }
    }
    if (dataLines.length > 0) {
      events.push({ event, data: JSON.parse(dataLines.join('\n')) });
    }
  }
  return events;
}
