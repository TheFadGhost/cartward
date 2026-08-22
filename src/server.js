import { createApp } from './app.js';
import { config } from './config.js';
import { log } from './lib/logger.js';
import { db } from './db/index.js';

const app = createApp();
const server = app.listen(config.port, () => {
  log.info(`cartward listening`, { port: config.port, env: config.env });
});

function shutdown(signal) {
  log.info(`${signal} received, shutting down`);
  server.close(() => {
    try { db.close(); } catch { /* already closed */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
