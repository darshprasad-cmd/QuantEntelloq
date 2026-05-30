/**
 * One-shot migration runner.
 * Invoked manually via:  npm run migrate
 *
 * Used by CI/CD to apply migrations without starting the server.
 */

import 'dotenv/config.js';
import { runMigrationsIfPending, pool } from './connection.js';
import { logger } from '../lib/logger.js';

async function main() {
  try {
    await runMigrationsIfPending();
    logger.info('Migrations complete');
    await pool.end();
    process.exit(0);
  } catch (err) {
    logger.fatal({ err }, 'Migration failed');
    await pool.end().catch(() => {});
    process.exit(1);
  }
}

main();
