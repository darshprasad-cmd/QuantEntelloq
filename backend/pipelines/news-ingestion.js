/**
 * News ingestion pipeline.
 *
 * Cron-scheduled: every 5 minutes, fetch all active RSS sources in parallel
 * (gated by a concurrency pool), insert raw items, enqueue rewrite jobs.
 *
 * Errors are isolated per-source so one bad feed doesn't take the whole pipeline down.
 */

import cron from 'node-cron';
import Parser from 'rss-parser';
import PQueue from 'p-queue';
import { logger } from '../lib/logger.js';
import { listSources, insertRawItem, markSourceFetched } from '../db/repositories/intel.js';
import { enqueueRewrite, hashFor } from '../services/intel.js';

const parser = new Parser({
  timeout: 15_000,
  headers: {
    'User-Agent': 'Quant Entelloq Intel Bot/1.0 (+https://quant.entelloq.com)',
  },
});

let task = null;
let running = false;

async function ingestSource(source) {
  try {
    const feed = await parser.parseURL(source.url);
    let inserted = 0;
    for (const entry of feed.items || []) {
      const url = entry.link || entry.guid;
      const title = entry.title?.trim();
      if (!url || !title) continue;
      const externalId = entry.guid || url;
      const hash = hashFor(url, title);
      const created = await insertRawItem({
        sourceId: source.id,
        externalId,
        url,
        title,
        rawHtml: entry['content:encoded'] || entry.content || null,
        rawText: entry.contentSnippet || stripHtml(entry.content) || null,
        author: entry.creator || entry.author || null,
        publishedAt: entry.isoDate ? new Date(entry.isoDate) : null,
        hash,
      });
      if (created?.id) {
        inserted++;
        // Higher-weighted sources jump the queue
        const priority = Math.max(1, 10 - Math.floor(source.weight / 10));
        await enqueueRewrite(created.id, { priority });
      }
    }
    await markSourceFetched(source.id, null);
    if (inserted) logger.info({ source: source.name, inserted }, 'ingested feed');
    return inserted;
  } catch (err) {
    await markSourceFetched(source.id, err.message?.slice(0, 500));
    logger.warn({ source: source.name, err: err.message }, 'ingestion error');
    return 0;
  }
}

function stripHtml(html) {
  if (!html) return null;
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 8000);
}

export async function runIngestionOnce() {
  if (running) {
    logger.warn('ingestion already running — skipping tick');
    return;
  }
  running = true;
  const t0 = Date.now();
  try {
    const sources = await listSources({ activeOnly: true });
    const rssSources = sources.filter((s) => s.kind === 'rss');
    const queue = new PQueue({ concurrency: 6 });
    let total = 0;
    await Promise.all(
      rssSources.map((s) =>
        queue.add(async () => {
          total += await ingestSource(s);
        })
      )
    );
    logger.info({ sources: rssSources.length, items: total, ms: Date.now() - t0 }, 'ingestion tick complete');
  } catch (err) {
    logger.error({ err }, 'ingestion tick failed');
  } finally {
    running = false;
  }
}

export function startNewsIngestion() {
  if (task) return task;
  // Every 5 minutes; sources with their own RSS update cadences shorter than that
  // are handled by the rss-parser staying on the same etag.
  task = cron.schedule('*/5 * * * *', () => runIngestionOnce(), { scheduled: true });
  logger.info('news ingestion cron started (every 5 min)');
  // Kick off a tick immediately
  runIngestionOnce().catch(() => {});
  return task;
}

export function stopNewsIngestion() {
  if (task) {
    task.stop();
    task = null;
    logger.info('news ingestion cron stopped');
  }
}
