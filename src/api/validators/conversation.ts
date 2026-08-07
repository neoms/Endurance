/**
 * 对话与标签接口请求校验规则
 *
 * 【字段规则说明】
 * - 对话标题：1-100 字符（trim 后校验，纯空白视为非法）；
 * - 标签名：1-30 字符（标签按「用户 + 名称」去重存储）。
 */
import { z } from 'zod';

const titleSchema = z
  .string()
  .trim()
  .min(1, 'Title must not be empty')
  .max(100, 'Title must be at most 100 characters');

// 创建对话请求体（标题可选）
export const createConversationSchema = z.object({
  title: titleSchema.optional(),
});

// 修改对话标题请求体
export const updateConversationSchema = z.object({
  title: titleSchema,
});

// 添加标签请求体
export const addTagSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Tag name must not be empty')
    .max(30, 'Tag name must be at most 30 characters'),
});
