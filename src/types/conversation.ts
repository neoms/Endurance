/**
 * 个人对话相关类型定义
 *
 * 【字段说明】
 * - ConversationTagOutput：对外输出的标签结构（id + name）；
 * - ConversationOutput：对外输出的对话结构（含标签列表）；
 * - CreateConversationInput / UpdateConversationInput / AddTagInput：各操作入参。
 *
 * 【设计说明】
 * 标签按用户去重存储（tags 表 userId+name 唯一），
 * 多标签筛选采用 AND 语义（对话必须同时拥有所有请求的标签）。
 */

// 对外输出的标签结构
export interface ConversationTagOutput {
  id: string;
  name: string;
}

// 对外输出的对话结构（含标签列表）
export interface ConversationOutput {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  tags: ConversationTagOutput[];
}

// 创建对话入参（标题可缺省，缺省时使用默认标题「新对话」）
export interface CreateConversationInput {
  title?: string;
}

// 修改对话标题入参
export interface UpdateConversationInput {
  title: string;
}

// 为对话添加标签入参
export interface AddTagInput {
  name: string;
}
