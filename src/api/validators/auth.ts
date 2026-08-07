/**
 * 认证接口请求校验规则
 *
 * 【字段规则说明】
 * - 用户名：3-32 位，仅允许字母/数字/下划线（禁止特殊字符，防注入与展示异常）；
 * - 密码：8-72 位（72 为 bcrypt 单次输入的长度上限，超出部分会被截断，须显式拒绝）；
 * - 昵称：可选，1-32 位。
 */
import { z } from 'zod';

const usernameSchema = z
  .string()
  .trim()
  .min(3, 'Username must be at least 3 characters')
  .max(32, 'Username must be at most 32 characters')
  .regex(/^[a-zA-Z0-9_]+$/, 'Username may only contain letters, numbers and underscores');

const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(72, 'Password must be at most 72 characters');

// 注册请求体校验规则
export const registerSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(1).max(32).optional(),
});

// 登录请求体校验规则
export const loginSchema = z.object({
  username: z.string().trim().min(1).max(32),
  password: z.string().min(1).max(72),
});
