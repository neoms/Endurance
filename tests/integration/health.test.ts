/**
 * 健康检查接口集成测试
 *
 * 验证 GET /api/health 返回 200 与 { status: 'ok', uptime: number }。
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';

describe('GET /api/health', () => {
  it('returns ok status with uptime', async () => {
    const res = await request(createApp()).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.uptime).toBe('number');
  });
});
