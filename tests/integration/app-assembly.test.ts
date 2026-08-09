/**
 * 应用装配（createApp）集成测试
 *
 * 覆盖 app.ts 中按「web/dist 是否已构建」分支的逻辑：
 * - 未构建前端：GET / 302 重定向到 /api-docs（方便演示接口文档）；
 * - 已构建前端：GET / 返回静态 index.html、非 /api 的 GET 走 SPA 回退、
 *   /api/* 仍由 API 路由处理（静态托管不遮蔽接口）。
 *
 * 【文件系统说明】
 * 为了稳定触发两条分支，测试会把可能存在的真实 web/dist 先重命名备份，
 * 结束后恢复原状；web/dist 是构建产物（.gitignore 已忽略），不涉及源码。
 */
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';

// 与 app.ts 相同的相对路径解析（相对于进程 cwd = 项目根目录）
const WEB_DIST = path.resolve('web', 'dist');
const BACKUP = path.resolve('web', 'dist.__test_backup');
const INDEX_HTML =
  '<!doctype html><html><head><title>Endurance</title></head><body>Endurance App</body></html>';

let hadWebDist = false;

beforeAll(() => {
  // 备份可能存在的真实构建产物，保证「未构建」分支可稳定复现
  hadWebDist = existsSync(WEB_DIST);
  if (hadWebDist) {
    renameSync(WEB_DIST, BACKUP);
  }
});

afterAll(() => {
  // 清理测试创建的构建目录，并恢复原备份（若有）
  rmSync(WEB_DIST, { recursive: true, force: true });
  if (hadWebDist) {
    renameSync(BACKUP, WEB_DIST);
  }
});

describe('createApp 前端托管分支', () => {
  it('redirects / to /api-docs when the web client is not built', async () => {
    const app = createApp();
    const res = await request(app).get('/');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/api-docs');
  });

  it('serves the built web client with SPA fallback and keeps /api untouched', async () => {
    // 模拟「已执行 npm run build:web」：写入最小静态产物
    mkdirSync(WEB_DIST, { recursive: true });
    writeFileSync(path.join(WEB_DIST, 'index.html'), INDEX_HTML);

    const app = createApp();

    // 根路径返回静态首页
    const root = await request(app).get('/');
    expect(root.status).toBe(200);
    expect(root.text).toContain('Endurance App');

    // SPA 回退：非 /api 的 GET 路径也返回 index.html（支持前端路由刷新）
    const spa = await request(app).get('/conversations/some-id');
    expect(spa.status).toBe(200);
    expect(spa.text).toContain('Endurance App');

    // API 路由不被静态托管遮蔽
    const health = await request(app).get('/api/health');
    expect(health.status).toBe(200);
    expect(health.body.status).toBe('ok');

    // 非 GET 的非 API 请求不被 SPA 回退接管：继续交给 404 兜底
    const otherMethod = await request(app).post('/some/random/path');
    expect(otherMethod.status).toBe(404);
    expect(otherMethod.body.error.code).toBe('NOT_FOUND');
  });
});
