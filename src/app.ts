import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';

import { errorHandler, notFoundHandler } from './lib/errors.js';
import { logger } from './lib/logger.js';
import { healthRouter } from './routes/health.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '1mb' }));
  app.use(pinoHttp({ logger }));

  app.use('/api/health', healthRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
