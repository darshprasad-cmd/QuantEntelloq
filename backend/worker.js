/**
 * Worker process entrypoint.
 *
 * Runs the BullMQ workers (rewriter, etc.) plus the news ingestion cron
 * in a separate process from the API server. Deploying as two services
 * (`web` and `worker`) keeps API latency tight even when AI rewrites
 * pile up.
 */

import 'dotenv/config.js';
import { logger } from './lib/logger.js';
import { pool, runMigrationsIfPending } from './db/connection.js';
import { redis } from './cache/redis.js';
import { startNewsIngestion, stopNewsIngestion } from './pipelines/news-ingestion.js';
import { startRewriterWorker, stopRewriterWorker } from './pipelines/rewriter.js';
import { initSentry } from './monitoring/sentry.js';

initSentry();

async function boot() {
  try {
    await pool.query('SELECT 1');
    await runMigrationsIfPending();
    logger.info('worker: postgres ready');
    await redis.ping();
    logger.info('worker: redis ready');
  } catch (err) {
    logger.fatal({ err }, 'worker: dependency check failed');
    process.exit(1);
  }

  startRewriterWorker();
  startNewsIngestion();

  logger.info('worker booted');
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'worker shutdown signal');

  const grace = setTimeout(() => {
    logger.error('worker force exit after 45s');
    process.exit(1);
  }, 45_000);
  grace.unref();

  try {
    stopNewsIngestion();
    await stopRewriterWorker();
    await pool.end();
    await redis.quit();
    logger.info('worker clean exit');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'worker shutdown error');
    process.exit(1);
  }
}

['SIGTERM', 'SIGINT'].forEach((s) => process.on(s, () => shutdown(s)));
process.on('unhandledRejection', (r) => logger.error({ reason: r }, 'worker unhandledRejection'));
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'worker uncaughtException');
  shutdown('uncaughtException');
});

boot().catch((err) => {
  logger.fatal({ err }, 'worker boot failed');
  process.exit(1);
});
