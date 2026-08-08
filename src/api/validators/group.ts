/**
 * 群组接口请求校验规则
 *
 * 【字段规则说明】
 * - 群组名：1-50 字符；
 * - 响应策略：ALL_BOTS / RANDOM_ONE / CONTENT_ROUTED；
 * - maxConsecutiveBotReplies：1-10（防循环上限）；
 * - botIds：创建群组时至少 1 个；
 * - 消息内容：1-4000 字符。
 */
import { z } from 'zod';

// 响应策略枚举（与 Prisma GroupResponseMode 一致）
const responseModeSchema = z.enum(['ALL_BOTS', 'RANDOM_ONE', 'CONTENT_ROUTED']);

// 创建群组请求体
export const createGroupSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Group name must not be empty')
    .max(50, 'Group name must be at most 50 characters'),
  responseMode: responseModeSchema.optional(),
  maxConsecutiveBotReplies: z.coerce.number().int().min(1).max(10).optional(),
  botIds: z.array(z.string().min(1)).min(1, 'At least one bot is required'),
});

// 更新群组配置请求体（至少提供一个字段）
export const updateGroupSchema = z
  .object({
    name: z.string().trim().min(1).max(50).optional(),
    responseMode: responseModeSchema.optional(),
    maxConsecutiveBotReplies: z.coerce.number().int().min(1).max(10).optional(),
  })
  .refine(
    (data) =>
      data.name !== undefined ||
      data.responseMode !== undefined ||
      data.maxConsecutiveBotReplies !== undefined,
    {
      message: 'At least one field must be provided',
    },
  );

// 添加成员请求体：按用户名添加（用户名全局唯一、大小写敏感）。
// 校验规则与注册接口保持一致（3-32 位字母/数字/下划线），
// 非法用户名在入口返回 422，而不是到服务层查库后返回 404。
export const addMemberSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3, 'Username must be at least 3 characters')
    .max(32, 'Username must be at most 32 characters')
    .regex(/^[a-zA-Z0-9_]+$/, 'Username may only contain letters, numbers and underscores'),
});

// 添加机器人请求体
export const addBotSchema = z.object({
  botId: z.string().min(1),
});

// 发送群组消息请求体
export const sendGroupMessageSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1, 'Message must not be empty')
    .max(4000, 'Message must be at most 4000 characters'),
  clientRequestId: z.string().trim().min(8).max(64).optional(),
});
