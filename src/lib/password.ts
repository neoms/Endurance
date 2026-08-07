/**
 * 密码哈希工具模块
 *
 * 【模块职责】
 * 提供密码的哈希与校验能力，数据库只保存 bcrypt 哈希，绝不保存明文：
 * - hashPassword：注册时对明文密码做 bcrypt 哈希（10 轮 salt）；
 * - verifyPassword：登录时校验输入密码与已存哈希是否匹配。
 *
 * 【设计说明】
 * bcrypt 内置 salt 与慢哈希特性，可抵御彩虹表与暴力破解；
 * 轮数（SALT_ROUNDS=10）是安全性与响应时间的常见折中。
 */
import bcrypt from 'bcryptjs';

// bcrypt 加盐轮数：10 轮兼顾安全性与性能
const SALT_ROUNDS = 10;

/**
 * 对明文密码进行 bcrypt 哈希
 *
 * @param password 明文密码（长度已由请求校验层限制为 8-72 位）
 * @returns Promise<string> bcrypt 哈希串（形如 $2b$10$...）
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * 校验明文密码与哈希是否匹配
 *
 * @param password     用户输入的明文密码
 * @param passwordHash 数据库中存储的 bcrypt 哈希
 * @returns Promise<boolean> 匹配返回 true，否则返回 false
 */
export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  return bcrypt.compare(password, passwordHash);
}
