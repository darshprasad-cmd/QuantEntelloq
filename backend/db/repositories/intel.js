/**
 * Intelligence repository.
 *
 *   - intel_sources: feed definitions
 *   - intel_items_raw: raw ingested items (pre-AI)
 *   - intel_items: AI-rewritten, scored, searchable items
 */

import { query, withTransaction } from '../connection.js';

// ---------- sources -----------------------------------------------------

export async function listSources({ activeOnly = true } = {}) {
  const { rows } = await query(
    `SELECT id, name, url, kind, category, weight, last_fetched_at, last_error, is_active
       FROM intel_sources
      ${activeOnly ? 'WHERE is_active = TRUE' : ''}
      ORDER BY weight DESC, name ASC`
  );
  return rows;
}

export async function markSourceFetched(sourceId, error = null) {
  await query(
    `UPDATE intel_sources SET last_fetched_at = NOW(), last_error = $2 WHERE id = $1`,
    [sourceId, error]
  );
}

// ---------- raw items ---------------------------------------------------

export async function insertRawItem(item) {
  const { rows } = await query(
    `INSERT INTO intel_items_raw
       (source_id, external_id, url, title, raw_html, raw_text, author, published_at, hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (source_id, external_id) DO NOTHING
     RETURNING id`,
    [
      item.sourceId,
      item.externalId,
      item.url,
      item.title,
      item.rawHtml || null,
      item.rawText || null,
      item.author || null,
      item.publishedAt || null,
      item.hash,
    ]
  );
  return rows[0] || null;
}

export async function getRawItem(id) {
  const { rows } = await query(`SELECT * FROM intel_items_raw WHERE id = $1`, [id]);
  return rows[0] || null;
}

export async function listPendingRaw({ limit = 50 } = {}) {
  // Raw items that haven't been linked to a processed intel_items row yet
  const { rows } = await query(
    `SELECT r.*
       FROM intel_items_raw r
       LEFT JOIN intel_items p ON p.raw_id = r.id
      WHERE p.id IS NULL
      ORDER BY r.published_at DESC NULLS LAST, r.fetched_at DESC
      LIMIT $1`,
    [limit]
  );
  return rows;
}

// ---------- processed items --------------------------------------------

export async function upsertProcessed(item) {
  return withTransaction(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO intel_items
         (raw_id, source_name, url, title_original, title_rewritten,
          summary, body, category, sentiment, sentiment_score, confidence,
          impact_score, opportunity_score, tickers, asset_ids, topics,
          published_at, hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (hash) DO UPDATE
         SET title_rewritten = EXCLUDED.title_rewritten,
             summary = EXCLUDED.summary,
             body = EXCLUDED.body,
             sentiment = EXCLUDED.sentiment,
             sentiment_score = EXCLUDED.sentiment_score,
             confidence = EXCLUDED.confidence,
             impact_score = EXCLUDED.impact_score,
             opportunity_score = EXCLUDED.opportunity_score,
             tickers = EXCLUDED.tickers,
             asset_ids = EXCLUDED.asset_ids,
             topics = EXCLUDED.topics,
             rewritten_at = NOW()
       RETURNING *`,
      [
        item.rawId,
        item.sourceName,
        item.url,
        item.titleOriginal,
        item.titleRewritten,
        item.summary,
        item.body || null,
        item.category || null,
        item.sentiment || null,
        item.sentimentScore ?? null,
        item.confidence ?? null,
        item.impactScore ?? null,
        item.opportunityScore ?? null,
        item.tickers || [],
        item.assetIds || [],
        item.topics || [],
        item.publishedAt || null,
        item.hash,
      ]
    );
    return rows[0];
  });
}

// ---------- public reads (feed) ----------------------------------------

/**
 * Main feed query — used by /api/intel/feed.
 * Supports filtering, search, ticker scoping, sentiment, pagination.
 */
export async function listFeed({
  q,
  category,
  sentiment,
  tickers,
  minImpact,
  minOpportunity,
  sinceHours = 72,
  limit = 50,
  cursor,
} = {}) {
  const wheres = [`published_at >= NOW() - ($1 || ' hours')::interval`];
  const params = [String(sinceHours)];
  let i = 2;

  if (q) {
    wheres.push(`search_tsv @@ websearch_to_tsquery('english', $${i})`);
    params.push(q);
    i++;
  }
  if (category) {
    wheres.push(`category = $${i}`);
    params.push(category);
    i++;
  }
  if (sentiment) {
    wheres.push(`sentiment = $${i}`);
    params.push(sentiment);
    i++;
  }
  if (tickers?.length) {
    wheres.push(`tickers && $${i}::text[]`);
    params.push(tickers.map((t) => t.toUpperCase()));
    i++;
  }
  if (minImpact != null) {
    wheres.push(`impact_score >= $${i}`);
    params.push(minImpact);
    i++;
  }
  if (minOpportunity != null) {
    wheres.push(`opportunity_score >= $${i}`);
    params.push(minOpportunity);
    i++;
  }
  if (cursor) {
    wheres.push(`(published_at, id) < ($${i}::timestamptz, $${i + 1}::uuid)`);
    params.push(cursor.publishedAt, cursor.id);
    i += 2;
  }

  params.push(Math.min(limit, 200));
  const sql = `
    SELECT id, source_name, url, title_rewritten, summary, category,
           sentiment, sentiment_score, confidence, impact_score,
           opportunity_score, tickers, asset_ids, topics,
           published_at, rewritten_at
      FROM intel_items
     WHERE ${wheres.join(' AND ')}
     ORDER BY published_at DESC NULLS LAST, id DESC
     LIMIT $${i}
  `;
  const { rows } = await query(sql, params);

  const last = rows[rows.length - 1];
  return {
    items: rows,
    nextCursor: rows.length === limit && last
      ? { publishedAt: last.published_at, id: last.id }
      : null,
  };
}

export async function findItemById(id) {
  const { rows } = await query(`SELECT * FROM intel_items WHERE id = $1`, [id]);
  return rows[0] || null;
}

/**
 * Top opportunities, ranked by opportunity_score × confidence.
 */
export async function listOpportunities({ limit = 20, minScore = 60 } = {}) {
  const { rows } = await query(
    `SELECT id, source_name, url, title_rewritten, summary, sentiment,
            impact_score, opportunity_score, confidence, tickers, asset_ids,
            published_at
       FROM intel_items
      WHERE opportunity_score >= $1
        AND published_at >= NOW() - INTERVAL '48 hours'
      ORDER BY (opportunity_score * COALESCE(confidence, 0.5)) DESC,
               published_at DESC
      LIMIT $2`,
    [minScore, limit]
  );
  return rows;
}

/**
 * Feed scoped to a user's portfolio (asset_ids overlap).
 */
export async function listForPortfolio(userId, { limit = 30, sinceHours = 72 } = {}) {
  const { rows } = await query(
    `SELECT i.*
       FROM intel_items i
       JOIN holdings h ON i.asset_ids && ARRAY[h.asset_id]
       JOIN portfolios p ON h.portfolio_id = p.id
      WHERE p.user_id = $1
        AND i.published_at >= NOW() - ($2 || ' hours')::interval
      ORDER BY i.impact_score DESC NULLS LAST, i.published_at DESC
      LIMIT $3`,
    [userId, String(sinceHours), limit]
  );
  return rows;
}
