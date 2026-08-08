/**
 * 消息接口请求校验规则
 *
 * 【字段规则说明】
 * - 内容：1-4000 字符（trim 后校验，纯空白视为非法）；
 * - clientRequestId：8-64 字符，用于幂等去重；
 * - 分页：limit 1-100（默认 50）；cursor 为正向游标（该消息之后），
 *   before 为反向锚点（该消息之前）；二者都必须是当前对话内的消息 id。
 */
import { z } from 'zod';

// 发送消息请求体校验规则
export const sendMessageSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1, 'Message must not be empty')
    .max(4000, 'Message must be at most 4000 characters'),
  clientRequestId: z.string().trim().min(8).max(64).optional(),
});

// 历史消息查询参数校验规则
export const listMessagesQuerySchema = z.object({
  cursor: z.string().trim().optional(),
  before: z.string().trim().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// 由 Schema 推导出的查询参数类型
export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;
