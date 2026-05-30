/**
 * Health endpoints — used by load balancers and uptime monitors.
 *
 *   GET /health         — Liveness (always 200 if process is up)
 *   GET /health/ready   — Readiness (checks DB + Redis + ingestion freshness)
 */

import { Router } from 'express';
import { query } from '../db/connection.js';
import { redis } from '../cache/redis.js';
import { ingestionHealth } from '../services/intel.js';

const router = Router();
const startedAt = Date.now();

router.get('/', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    version: process.env.npm_package_version || '1.0.0',
    env: process.env.NODE_ENV || 'development',
  });
});

router.get('/ready', async (req, res) => {
  const checks = {
    db: 'unknown',
    redis: 'unknown',
    ingestion: 'unknown',
  };
  let status = 'ok';

  try {
    await query('SELECT 1');
    checks.db = 'ok';
  } catch (err) {
    checks.db = `error: ${err.message}`;
    status = 'degraded';
  }

  try {
    const pong = await redis.ping();
    checks.redis = pong === 'PONG' ? 'ok' : `unexpected: ${pong}`;
  } catch (err) {
    checks.redis = `error: ${err.message}`;
    status = 'degraded';
  }

  try {
    const ing = await ingestionHealth();
    checks.ingestion = `sources=${ing.total} stale=${ing.stale}`;
    if (ing.stale > ing.total * 0.5) status = 'degraded';
  } catch (err) {
    checks.ingestion = `error: ${err.message}`;
  }

  res.status(status === 'ok' ? 200 : 503).json({ status, checks });
});

export default router;
