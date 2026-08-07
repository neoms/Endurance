/**
 * 前端 API 数据类型定义
 *
 * 【说明】
 * 与后端 OpenAPI 文档保持一致：字段结构一一对应，
 * 后端接口变更时需同步更新本文件。
 */

// 用户（脱敏信息）
export interface User {
  id: string;
  username: string;
  displayName: string;
  createdAt: string;
}

// 登录/注册响应
export interface AuthResult {
  token: string;
  user: User;
}

// 对话标签
export interface Tag {
  id: string;
  name: string;
}

// 个人对话
export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  tags: Tag[];
}

// 消息（个人对话）
export interface Message {
  id: string;
  senderType: 'HUMAN' | 'BOT';
  senderUserId: string | null;
  content: string;
  status: 'PENDING' | 'SENT' | 'FAILED';
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
}

// 发送消息响应
export interface SendMessageResult {
  userMessage: Message;
  aiMessage: Message | null;
}

// 机器人角色
export interface Bot {
  id: string;
  code: string;
  name: string;
  personality: string;
}

// 群组成员
export interface GroupMember {
  userId: string;
  displayName: string;
  role: 'OWNER' | 'MEMBER';
  joinedAt: string;
}

// 群组
export interface Group {
  id: string;
  name: string;
  creatorId: string;
  responseMode: 'ALL_BOTS' | 'RANDOM_ONE' | 'CONTENT_ROUTED';
  maxConsecutiveBotReplies: number;
  createdAt: string;
  updatedAt: string;
  members: GroupMember[];
  bots: Bot[];
}

// 群组消息
export interface GroupMessage {
  id: string;
  groupId: string;
  roundId: string | null;
  senderType: 'HUMAN' | 'BOT';
  userId: string | null;
  botId: string | null;
  content: string;
  status: 'PENDING' | 'SENT' | 'FAILED';
  createdAt: string;
}

// 发送群组消息响应
export interface SendGroupMessageResult {
  userMessage: GroupMessage;
  botMessages: GroupMessage[];
}
