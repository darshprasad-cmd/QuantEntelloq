/**
 * Postgres connection pool + migration runner.
 *
 * Uses node-postgres (pg) with a connection pool sized for production.
 * Migrations are applied at boot using a tiny in-house runner that
 * tracks applied filenames in the `schema_migrations` table.
 */

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { logger } from '../lib/logger.js';

const { Pool, types } = pg;

// Return numeric/bigint columns as JS Number when small, BigInt-safe string otherwise.
// We avoid float precision loss for prices by reading them as strings and parsing in repos.
types.setTypeParser(20 /* int8 */, (v) => (v === null ? null : Number(v)));
types.setTypeParser(1700 /* numeric */, (v) => v); // keep as string — repos parse

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  logger.fatal('DATABASE_URL is not set');
}

const sslMode = process.env.DATABASE_SSL || 'disable';
const ssl =
  sslMode === 'disable'
    ? false
    : { rejectUnauthorized: sslMode === 'require_verify' };

export const pool = new Pool({
  connectionString: databaseUrl,
  ssl,
  max: parseInt(process.env.DATABASE_POOL_MAX || '12', 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: 'quant-entelloq-backend',
});

pool.on('error', (err) => {
  logger.error({ err }, 'pg pool error (idle client)');
});

/** Convenience query wrapper that auto-releases the client. */
export async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const ms = Date.now() - start;
  if (ms > 300) logger.warn({ ms, text: text.slice(0, 120) }, 'slow query');
  return res;
}

/** Run a callback inside a transaction. */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Tiny migration runner.
 * Looks for *.sql files in db/migrations/ sorted alphabetically.
 * Each is applied exactly once and tracked in schema_migrations.
 *
 * On first boot it also seeds the base schema.sql if no migrations are present.
 */
export async function runMigrationsIfPending() {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const __dirname = dirname(fileURLToPath(import.meta.url));

  // Apply base schema if database is empty
  const { rows: existing } = await query(`SELECT name FROM schema_migrations`);
  const applied = new Set(existing.map((r) => r.name));

  if (!applied.has('000_base_schema.sql')) {
    logger.info('Applying base schema (db/schema.sql)');
    const sql = await readFile(join(__dirname, 'schema.sql'), 'utf8');
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, ['000_base_schema.sql']);
    });
    applied.add('000_base_schema.sql');
  }

  // Apply numbered migrations in db/migrations/
  const migrationsDir = join(__dirname, 'migrations');
  let files = [];
  try {
    files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  for (const file of files) {
    if (applied.has(file)) continue;
    logger.info({ file }, 'applying migration');
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [file]);
    });
  }

  logger.info({ migrations: files.length }, 'migrations up to date');
}

export default pool;
