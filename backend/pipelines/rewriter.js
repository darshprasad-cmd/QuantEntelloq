/**
 * News rewriter pipeline.
 *
 * BullMQ Worker that:
 *   1. Pulls a raw news item from the queue
 *   2. Asks the AI to rewrite it as platform-native intel
 *      — NOT copying source text (legally clean + platform-voice)
 *   3. Extracts tickers, sentiment, opportunity score
 *   4. Resolves tickers to global asset IDs
 *   5. Writes to intel_items
 *   6. Publishes `intel.new` realtime event
 *
 * Designed to run in the dedicated worker.js process.
 */

import { Worker } from 'bullmq';
import { bullConnection } from '../cache/redis.js';
import { logger } from '../lib/logger.js';
import { callOnce } from '../services/ai.js';
import { getRawItem, upsertProcessed } from '../db/repositories/intel.js';
import { resolveTickersToAssetIds } from '../db/repositories/assets.js';
import { realtime } from '../realtime/server-events.js';
import { extractSentiment } from './sentiment.js';
import { hashFor } from '../services/intel.js';

const REWRITE_MODEL = process.env.AI_REWRITE_MODEL || process.env.AI_MODEL_CALL;

const SYSTEM_PROMPT = `You are Quant Entelloq's news rewrite engine.

Your job: take a raw news item from a third-party source and rewrite it as a short,
platform-native intelligence summary. CRITICAL RULES:

1. DO NOT copy the original text verbatim. Rephrase entirely in your own words.
   Aim for substantially shorter than the source. Never quote more than 10 words.
2. Output strict JSON with this schema:
   {
     "title": string  (max 90 chars, sharp & specific),
     "summary": string  (1-2 sentences, plain English, no fluff),
     "body": string  (3-5 sentences, deeper context),
     "category": "markets" | "crypto" | "macro" | "tech" | "filings",
     "tickers": string[]  (UPPERCASE stock/crypto/FX tickers actually mentioned, [] if none),
     "topics": string[]  (1-4 short keywords),
     "impact_score": integer 0-100  (how much this could move markets),
     "opportunity_score": integer 0-100  (how actionable for a trader, 0 if just news)
   }
3. If the source is unrelated to finance, set impact_score and opportunity_score to 0.
4. Never invent tickers. Only include tickers explicitly named or unambiguously implied.
5. NO commentary, NO disclaimers, NO "according to source" phrases. Just the JSON.`;

async function rewriteOne(rawId) {
  const raw = await getRawItem(rawId);
  if (!raw) {
    logger.warn({ rawId }, 'raw item missing — skipping');
    return null;
  }

  const userMsg = [
    `Source: ${raw.url}`,
    `Original title: ${raw.title}`,
    raw.author ? `Author: ${raw.author}` : null,
    raw.raw_text ? `Original body:\n${raw.raw_text.slice(0, 6000)}` : null,
  ].filter(Boolean).join('\n\n');

  let parsed = null;
  try {
    const result = await callOnce(SYSTEM_PROMPT, userMsg, {
      json: true,
      model: REWRITE_MODEL,
      maxTokens: 800,
    });
    parsed = result.json;
    if (!parsed) {
      logger.warn({ rawId, text: result.text?.slice(0, 200) }, 'rewriter returned non-JSON');
      return null;
    }
  } catch (err) {
    logger.warn({ rawId, err: err.message }, 'rewriter AI call failed');
    throw err; // let BullMQ retry
  }

  // Backstop sentiment using local NLP — AI may not always include it cleanly
  const sentimentInfo = extractSentiment(`${parsed.title} ${parsed.summary} ${parsed.body || ''}`);

  const tickers = Array.isArray(parsed.tickers) ? parsed.tickers.map((t) => String(t).toUpperCase()).filter(Boolean) : [];
  const assetIds = await resolveTickersToAssetIds(tickers);

  // Determine the displayed source name (from the source row if available)
  const sourceName = raw.source_name || (await sourceNameFor(raw.source_id));

  const item = await upsertProcessed({
    rawId: raw.id,
    sourceName,
    url: raw.url,
    titleOriginal: raw.title,
    titleRewritten: String(parsed.title || raw.title).slice(0, 200),
    summary: String(parsed.summary || '').slice(0, 2000),
    body: String(parsed.body || '').slice(0, 6000) || null,
    category: validCategory(parsed.category),
    sentiment: sentimentInfo.sentiment,
    sentimentScore: sentimentInfo.score,
    confidence: sentimentInfo.confidence,
    impactScore: clamp(parsed.impact_score, 0, 100),
    opportunityScore: clamp(parsed.opportunity_score, 0, 100),
    tickers,
    assetIds,
    topics: Array.isArray(parsed.topics) ? parsed.topics.slice(0, 8) : [],
    publishedAt: raw.published_at,
    hash: hashFor(raw.url, parsed.title || raw.title),
  });

  realtime.publish('intel.new', {
    id: item.id,
    title: item.title_rewritten,
    summary: item.summary,
    category: item.category,
    sentiment: item.sentiment,
    impact_score: item.impact_score,
    opportunity_score: item.opportunity_score,
    tickers: item.tickers,
    asset_ids: item.asset_ids,
    published_at: item.published_at,
  });

  return item;
}

async function sourceNameFor(sourceId) {
  const { query } = await import('../db/connection.js');
  const { rows } = await query(`SELECT name FROM intel_sources WHERE id = $1`, [sourceId]);
  return rows[0]?.name || 'Unknown';
}

function validCategory(c) {
  const valid = new Set(['markets', 'crypto', 'macro', 'tech', 'filings']);
  return valid.has(c) ? c : 'markets';
}

function clamp(n, lo, hi) {
  const v = parseInt(n, 10);
  if (Number.isNaN(v)) return null;
  return Math.max(lo, Math.min(hi, v));
}

let worker = null;

export function startRewriterWorker() {
  if (worker) return worker;
  worker = new Worker(
    'intel-rewriter',
    async (job) => rewriteOne(job.data.rawId),
    {
      connection: bullConnection,
      concurrency: parseInt(process.env.REWRITER_CONCURRENCY || '4', 10),
      lockDuration: 60_000,
    }
  );
  worker.on('completed', (job) => {
    logger.debug({ jobId: job.id, rawId: job.data.rawId }, 'rewrite completed');
  });
  worker.on('failed', (job, err) => {
    logger.warn({ jobId: job?.id, err: err.message }, 'rewrite failed');
  });
  worker.on('error', (err) => {
    logger.error({ err: err.message }, 'rewriter worker error');
  });
  logger.info('rewriter worker started');
  return worker;
}

export async function stopRewriterWorker() {
  if (worker) {
    await worker.close();
    worker = null;
  }
}

export { rewriteOne };
