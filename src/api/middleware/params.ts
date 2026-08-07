/**
 * 路径参数提取助手
 *
 * 【模块职责】
 * Express 5 的 req.params 类型为联合类型（可能含 undefined），
 * 这里统一收窄为 string；参数缺失或非字符串时返回 400 INVALID_PARAM。
 */
import type { Request } from 'express';

import { AppError } from '../../lib/errors.js';

/**
 * 从请求路径中提取字符串参数
 *
 * @param req  Express 请求对象
 * @param name 参数名（默认 'id'，如 :id / :tagId）
 * @returns string 参数值
 * @throws AppError(400) 当参数不是字符串时
 */
export function paramId(req: Request, name: string = 'id'): string {
  const value = req.params[name];
  if (typeof value !== 'string') {
    throw new AppError(400, 'INVALID_PARAM', `Invalid ${name}`);
  }
  return value;
}
