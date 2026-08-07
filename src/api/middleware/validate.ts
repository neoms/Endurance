/**
 * 请求校验中间件（基于 Zod）
 *
 * 【模块职责】
 * 在路由处理前对请求体（body）或查询参数（query）做 Zod 校验：
 * - source=body：校验通过后替换 req.body（后续代码拿到的是类型安全的解析结果）；
 * - source=query：校验结果写入 res.locals.validatedQuery。
 *
 * 【设计说明】
 * 注意：Express 5 中 req.query 是只读 getter，不能直接赋值，
 * 因此查询参数的校验结果存放在 res.locals 上，由路由自行读取。
 */
import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';

/**
 * 生成校验中间件
 *
 * @param schema Zod 校验规则（入参结构定义）
 * @param source 校验目标：'body'（请求体，默认）或 'query'（查询参数）
 * @returns RequestHandler 中间件；校验失败时抛出 ZodError，由全局错误处理转为 422
 */
export function validate<T>(schema: ZodType<T>, source: 'body' | 'query' = 'body'): RequestHandler {
  return (req, res, next) => {
    const parsed = schema.parse(req[source]);
    if (source === 'body') {
      req.body = parsed;
    } else {
      res.locals.validatedQuery = parsed;
    }
    next();
  };
}
