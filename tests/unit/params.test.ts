/**
 * 路由参数解析工具单元测试
 *
 * 覆盖 paramId：正常取值、自定义参数名、参数缺失时抛 400 INVALID_PARAM。
 */
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';

import { paramId } from '../../src/api/middleware/params.js';

describe('paramId', () => {
  it('returns the param value when present', () => {
    expect(paramId({ params: { id: 'abc' } } as unknown as Request)).toBe('abc');
  });

  it('supports a custom param name', () => {
    expect(paramId({ params: { tagId: 't1' } } as unknown as Request, 'tagId')).toBe('t1');
  });

  it('throws 400 INVALID_PARAM when the param is missing', () => {
    let caught: { statusCode: number; code: string } | undefined;
    try {
      paramId({ params: {} } as unknown as Request);
    } catch (err) {
      caught = err as { statusCode: number; code: string };
    }
    expect(caught?.statusCode).toBe(400);
    expect(caught?.code).toBe('INVALID_PARAM');
  });
});
