/**
 * Swagger 文档集成测试
 *
 * 验证「接口文档即注释」的约定是否生效：
 * - /api-docs.json 返回 OpenAPI 规范，且包含 /api/health 的完整定义；
 * - /api-docs 返回 Swagger UI 页面（HTML）。
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';

const app = createApp();

describe('Swagger docs', () => {
  it('serves the OpenAPI spec JSON with the health endpoint documented', async () => {
    const res = await request(app).get('/api-docs.json');

    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.0.0');
    expect(res.body.paths['/api/health']).toBeDefined();
    expect(res.body.paths['/api/health'].get.summary).toBe('健康检查');
  });

  it('serves the Swagger UI page', async () => {
    // swagger-ui-express 会把 /api-docs 301 重定向到 /api-docs/，直接请求带斜杠路径
    const res = await request(app).get('/api-docs/');

    expect(res.status).toBe(200);
    expect(res.text).toContain('swagger-ui');
  });
});
