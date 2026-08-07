import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { AppError, errorHandler } from '../../src/lib/errors.js';

function buildApp() {
  const app = express();
  app.get('/app-error', () => {
    throw new AppError(403, 'FORBIDDEN', 'no access');
  });
  app.get('/unknown-error', () => {
    throw new Error('oops');
  });
  app.use(errorHandler);
  return app;
}

describe('errorHandler', () => {
  it('maps AppError to its status code and error body', async () => {
    const res = await request(buildApp()).get('/app-error');

    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'FORBIDDEN', message: 'no access' });
  });

  it('maps unknown errors to 500 INTERNAL_ERROR without leaking details', async () => {
    const res = await request(buildApp()).get('/unknown-error');

    expect(res.status).toBe(500);
    expect(res.body.error).toEqual({ code: 'INTERNAL_ERROR', message: 'Internal server error' });
  });
});
