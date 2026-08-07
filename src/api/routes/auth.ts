/**
 * 认证路由
 *
 * 【接口清单】
 * - POST /api/auth/register  注册（返回 JWT + 用户信息）
 * - POST /api/auth/login     登录（返回 JWT + 用户信息）
 * - GET  /api/auth/me        获取当前用户（需鉴权）
 *
 * 【文档约定】
 * 每个接口通过 `@openapi` JSDoc 注释维护 OpenAPI 文档（swagger-jsdoc 自动收集），
 * 修改接口时务必同步更新注释，保证「文档与实现一致」。
 */
import { Router } from 'express';

import { getCurrentUser, login, register } from '../../services/auth.service.js';
import { authRequired, requireUser } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { loginSchema, registerSchema } from '../validators/auth.js';

export const authRouter = Router();

/**
 * POST /api/auth/register 用户注册
 *
 * 入参：{ username, password, displayName? }
 * 返回值：201 { token, user }；用户名已存在 409；参数不合法 422。
 *
 * @openapi
 * /api/auth/register:
 *   post:
 *     tags: [Auth]
 *     summary: 用户注册
 *     description: 使用用户名/密码注册新用户，成功后直接返回 JWT 与用户信息（前端可免二次登录）。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/RegisterRequest'
 *     responses:
 *       '201':
 *         description: 注册成功，返回 JWT 与用户信息
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthResult'
 *       '409':
 *         description: 用户名已被占用
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '422':
 *         description: 入参校验失败
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
authRouter.post('/register', validate(registerSchema), async (req, res) => {
  const result = await register(req.body);
  res.status(201).json(result);
});

/**
 * POST /api/auth/login 用户登录
 *
 * 入参：{ username, password }
 * 返回值：200 { token, user }；用户名或密码错误 401；参数不合法 422。
 *
 * @openapi
 * /api/auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: 用户登录
 *     description: 校验用户名与密码，成功后返回 JWT 与用户信息。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/LoginRequest'
 *     responses:
 *       '200':
 *         description: 登录成功，返回 JWT 与用户信息
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthResult'
 *       '401':
 *         description: 用户名或密码错误
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       '422':
 *         description: 入参校验失败
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
authRouter.post('/login', validate(loginSchema), async (req, res) => {
  const result = await login(req.body);
  res.json(result);
});

/**
 * GET /api/auth/me 获取当前用户
 *
 * 入参：Authorization: Bearer <token>（必需）
 * 返回值：200 { user }；未携带/无效 token 401。
 *
 * @openapi
 * /api/auth/me:
 *   get:
 *     tags: [Auth]
 *     summary: 获取当前用户信息
 *     description: 根据请求头中的 JWT 返回当前登录用户信息；未携带或无效 token 返回 401。
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       '200':
 *         description: 当前用户信息
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [user]
 *               properties:
 *                 user:
 *                   $ref: '#/components/schemas/User'
 *       '401':
 *         description: 未登录或 token 无效/过期
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
authRouter.get('/me', authRequired, async (req, res) => {
  const user = requireUser(req);
  res.json({ user: await getCurrentUser(user.id) });
});
