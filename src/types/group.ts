/**
 * 群组对话相关类型定义
 *
 * 【字段说明】
 * - GroupOutput：群组详情（成员 + 机器人列表）；
 * - GroupMessageOutput：群组消息（含 roundId 轮次标识）；
 * - 各 Input 为操作入参。
 *
 * 【设计说明】
 * 群组权限分为 OWNER（创建者，可管理）与 MEMBER（普通成员，可发言/查看）；
 * 群组消息通过 roundId 划分「一条人类消息触发的一轮机器人回复」，
 * 配合 maxConsecutiveBotReplies 实现防循环。
 */

// 群组内机器人（对外输出）
export interface GroupBotOutput {
  id: string;
  code: string;
  name: string;
  personality: string;
}

// 群组成员（对外输出）
export interface GroupMemberOutput {
  userId: string;
  displayName: string;
  role: 'OWNER' | 'MEMBER';
  joinedAt: Date;
}

// 群组详情（对外输出）
export interface GroupOutput {
  id: string;
  name: string;
  creatorId: string;
  responseMode: 'ALL_BOTS' | 'RANDOM_ONE' | 'CONTENT_ROUTED';
  maxConsecutiveBotReplies: number;
  createdAt: Date;
  updatedAt: Date;
  members: GroupMemberOutput[];
  bots: GroupBotOutput[];
}

// 群组消息（对外输出）
export interface GroupMessageOutput {
  id: string;
  groupId: string;
  roundId: string | null;
  senderType: 'HUMAN' | 'BOT';
  userId: string | null;
  botId: string | null;
  content: string;
  status: 'PENDING' | 'SENT' | 'FAILED';
  createdAt: Date;
}

// 创建群组入参（至少选择一个机器人）
export interface CreateGroupInput {
  name: string;
  responseMode?: 'ALL_BOTS' | 'RANDOM_ONE' | 'CONTENT_ROUTED';
  maxConsecutiveBotReplies?: number;
  botIds: string[];
}

// 更新群组配置入参（至少提供一个字段）
export interface UpdateGroupInput {
  name?: string;
  responseMode?: 'ALL_BOTS' | 'RANDOM_ONE' | 'CONTENT_ROUTED';
  maxConsecutiveBotReplies?: number;
}

// 群组消息发送结果：人类消息 + 本轮机器人回复列表
export interface SendGroupMessageResult {
  userMessage: GroupMessageOutput;
  botMessages: GroupMessageOutput[];
}

// 发送群组消息入参
export interface SendGroupMessageInput {
  content: string;
  /** 幂等键（可选，8-64 字符）：同一群组内相同键重复提交直接返回首次轮次结果 */
  clientRequestId?: string;
}
