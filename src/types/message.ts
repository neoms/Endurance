/**
 * 消息相关类型定义
 *
 * 【MessageStatus 语义】
 * - PENDING：生成中（预留状态）；
 * - SENT：已成功（用户消息或 AI 回复成功落库）；
 * - FAILED：AI 调用重试后仍失败，消息位置已占位并携带 errorCode，
 *   前端据此展示「回复失败，可重试」。
 */
export type SenderType = 'HUMAN' | 'BOT';
export type MessageStatus = 'PENDING' | 'SENT' | 'FAILED';

/**
 * 对外输出的消息结构
 */
export interface MessageOutput {
  id: string;
  senderType: SenderType;
  senderUserId: string | null;
  content: string;
  status: MessageStatus;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: Date;
}

/**
 * 发送消息入参
 *
 * @property content         消息内容（1-4000 字符）
 * @property clientRequestId 幂等键（可选，8-64 字符）；相同键重复提交只产生一条用户消息
 */
export interface SendMessageInput {
  content: string;
  clientRequestId?: string;
}

/**
 * 历史消息分页查询参数
 *
 * @property cursor 正向游标：返回该消息之后的 limit 条（升序），用于向下翻页
 * @property before 反向锚点：返回该消息之前的 limit 条（升序），用于聊天页「加载更早」
 * @property limit  每页条数（1-100，默认 50）；cursor 与 before 都省略时返回最近 limit 条
 */
export interface ListMessagesQuery {
  cursor?: string;
  before?: string;
  limit: number;
}

/**
 * 发送消息的返回结构
 *
 * @property userMessage 已保存的用户消息（必存在）
 * @property aiMessage   AI 回复（同步流程下必有；幂等命中且回复缺失时为 null）
 */
export interface SendMessageResult {
  userMessage: MessageOutput;
  aiMessage: MessageOutput | null;
}
