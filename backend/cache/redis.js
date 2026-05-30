/**
 * Redis client (ioredis) — shared by BullMQ, rate limiters, and our cache layer.
 *
 * Exposes:
 *   - redis        : the connection
 *   - bullConnection: a SECOND connection (ioredis recommends separate clients for queues)
 *   - getJSON / setJSON / del with TTL helpers
 *   - withCache(key, ttl, fn): get-or-compute pattern
 */

import Redis from 'ioredis';
import { logger } from '../lib/logger.js';

const url = process.env.REDIS_URL || 'redis://localhost:6379';
const tls = process.env.REDIS_TLS === 'true' ? {} : undefined;

function makeClient(role) {
  const client = new Redis(url, {
    tls,
    maxRetriesPerRequest: null,   // required by BullMQ
    enableReadyCheck: false,
    lazyConnect: false,
    retryStrategy: (times) => Math.min(times * 200, 5000),
  });
  client.on('error', (err) => logger.error({ err, role }, 'redis error'));
  client.on('reconnecting', () => logger.warn({ role }, 'redis reconnecting'));
  client.on('ready', () => logger.info({ role }, 'redis ready'));
  return client;
}

export const redis = makeClient('cache');
export const bullConnection = makeClient('bullmq');

// ---------- JSON helpers ---------------------------------------------

export async function getJSON(key) {
  const v = await redis.get(key);
  if (v == null) return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

export async function setJSON(key, value, ttlSec) {
  const str = JSON.stringify(value);
  if (ttlSec) return redis.set(key, str, 'EX', ttlSec);
  return redis.set(key, str);
}

export async function del(...keys) {
  if (!keys.length) return 0;
  return redis.del(...keys);
}

/**
 * Get-or-compute caching.
 *   const v = await withCache('intel:feed:home', 30, () => loadFromDb());
 *
 * Uses a per-key mutex via SETNX so concurrent requests don't all hit the upstream.
 */
export async function withCache(key, ttlSec, compute) {
  const cached = await getJSON(key);
  if (cached !== null) return cached;

  const lockKey = `${key}:lock`;
  const gotLock = await redis.set(lockKey, '1', 'EX', 30, 'NX');
  if (!gotLock) {
    // Brief wait then read again
    await new Promise((r) => setTimeout(r, 150));
    const second = await getJSON(key);
    if (second !== null) return second;
  }

  try {
    const fresh = await compute();
    await setJSON(key, fresh, ttlSec);
    return fresh;
  } finally {
    await redis.del(lockKey).catch(() => {});
  }
}

/** Increment a counter with TTL — useful for per-user limits keyed by date. */
export async function incrWithTtl(key, ttlSec) {
  const n = await redis.incr(key);
  if (n === 1 && ttlSec) await redis.expire(key, ttlSec);
  return n;
}
