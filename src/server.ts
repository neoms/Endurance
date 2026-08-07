import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';

const app = createApp();
const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'server started');
});

function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
