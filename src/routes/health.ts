/**
 * 健康检查路由
 *
 * 【模块职责】
 * 提供服务探活接口（供部署平台、负载均衡与运维脚本使用）。
 *
 * 【接口文档约定】
 * 每个接口使用 `@openapi` JSDoc 注释描述，swagger-jsdoc 会自动收集到
 * `/api-docs` 文档中；新增或修改接口时务必同步更新注释。
 */
import { Router } from 'express';

export const healthRouter = Router();

/**
 * GET /api/health 健康检查
 *
 * 入参：无（无需鉴权）。
 * 返回值：服务状态与进程运行时长。
 *
 * @openapi
 * /api/health:
 *   get:
 *     tags: [System]
 *     summary: 健康检查
 *     description: 返回服务运行状态与进程运行时长，供部署平台与运维脚本探活。
 *     responses:
 *       '200':
 *         description: 服务正常
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [status, uptime]
 *               properties:
 *                 status:
 *                   type: string
 *                   enum: [ok]
 *                   description: 服务状态
 *                   example: ok
 *                 uptime:
 *                   type: number
 *                   description: 进程已运行的秒数
 *                   example: 12.34
 */
healthRouter.get('/', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});
