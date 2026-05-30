/**
 * Intelligence service — orchestrates ingestion + rewrite + caching.
 *
 * Mostly thin wrappers over repositories with Redis caching layered on top.
 */

import crypto from 'node:crypto';
import { Queue } from 'bullmq';
import { bullConnection, withCache } from '../cache/redis.js';
import * as IntelRepo from '../db/repositories/intel.js';
import * as PortfolioRepo from '../db/repositories/portfolio.js';
import { logger } from '../lib/logger.js';

// BullMQ queues — workers in worker.js pull from these
export const ingestionQueue = new Queue('intel-ingestion', { connection: bullConnection });
export const rewriterQueue = new Queue('intel-rewriter', { connection: bullConnection });

const FEED_CACHE_TTL = 30;        // 30s — feed is paginated, hot
const PORTFOLIO_CACHE_TTL = 60;   // 60s — per-user, recomputed less often
const OPPORTUNITIES_CACHE_TTL = 60;

export function hashFor(url, title = '') {
  return crypto.createHash('sha256').update(`${url}::${title}`).digest('hex');
}

export async function enqueueRewrite(rawId, { priority = 5 } = {}) {
  await rewriterQueue.add(
    'rewrite',
    { rawId },
    {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 1000,
      removeOnFail: 500,
      priority,
    }
  );
}

/** Public feed (with caching). */
export async function getFeed(opts = {}) {
  const key = `intel:feed:${JSON.stringify(opts)}`;
  return withCache(key, FEED_CACHE_TTL, () => IntelRepo.listFeed(opts));
}

/** Portfolio-scoped feed for a logged-in user. */
export async function getFeedForUser(userId, opts = {}) {
  const key = `intel:feed:user:${userId}:${JSON.stringify(opts)}`;
  return withCache(key, PORTFOLIO_CACHE_TTL, () =>
    IntelRepo.listForPortfolio(userId, opts)
  );
}

/** Top opportunities. */
export async function getOpportunities(opts = {}) {
  const key = `intel:opps:${JSON.stringify(opts)}`;
  return withCache(key, OPPORTUNITIES_CACHE_TTL, () => IntelRepo.listOpportunities(opts));
}

/** Single item by id (uncached — read straight through). */
export async function getItem(id) {
  return IntelRepo.findItemById(id);
}

/** Health check on ingestion freshness — used by /health/ready. */
export async function ingestionHealth() {
  const sources = await IntelRepo.listSources({ activeOnly: true });
  const now = Date.now();
  const stale = sources.filter((s) => {
    if (!s.last_fetched_at) return true;
    return now - new Date(s.last_fetched_at).getTime() > 60 * 60 * 1000; // 1h
  });
  return { total: sources.length, stale: stale.length };
}

/** Assemble a tickers list scoped to the user (for the rewriter to filter on). */
export async function userScopedTickers(userId) {
  const assetIds = await PortfolioRepo.userScopedAssetIds(userId);
  return assetIds.map((id) => id.split(':')[0]).filter(Boolean);
}

/** Manually flush hot caches (admin / after large rewrite batch). */
export async function flushFeedCaches() {
  // Quick wildcard delete via SCAN
  const { redis } = await import('../cache/redis.js');
  let cursor = '0';
  let total = 0;
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'intel:feed:*', 'COUNT', 200);
    cursor = next;
    if (keys.length) {
      await redis.del(...keys);
      total += keys.length;
    }
  } while (cursor !== '0');
  logger.info({ total }, 'intel feed cache flushed');
  return total;
}
