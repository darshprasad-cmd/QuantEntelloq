/**
 * Global Asset Registry repository.
 *
 * FTS via search_tsv + trigram fallback.
 */

import { query } from '../connection.js';

export async function searchAssets({
  q = '',
  type,
  country,
  sector,
  limit = 20,
} = {}) {
  const params = [];
  const wheres = ['is_active = TRUE'];
  let i = 1;

  if (q) {
    params.push(q);
    wheres.push(
      `(search_tsv @@ websearch_to_tsquery('simple', $${i})
        OR ticker ILIKE $${i + 1}
        OR name ILIKE $${i + 1})`
    );
    params.push(`%${q}%`);
    i += 2;
  }
  if (type) {
    params.push(type);
    wheres.push(`asset_type = $${i++}`);
  }
  if (country) {
    params.push(country);
    wheres.push(`country = $${i++}`);
  }
  if (sector) {
    params.push(sector);
    wheres.push(`sector = $${i++}`);
  }
  params.push(Math.min(limit, 50));

  const rankExpr = q
    ? `ts_rank(search_tsv, websearch_to_tsquery('simple', $1)) +
       CASE WHEN ticker ILIKE $2 THEN 0.5 ELSE 0 END +
       (market_cap / 1e15)`
    : `(market_cap / 1e15)`;

  const { rows } = await query(
    `SELECT id, ticker, name, asset_type, exchange, country, sector,
            currency, market_cap, logo_url, ${rankExpr} AS _rank
       FROM assets
      WHERE ${wheres.join(' AND ')}
      ORDER BY _rank DESC NULLS LAST, view_count DESC, ticker ASC
      LIMIT $${params.length}`,
    params
  );
  return rows;
}

export async function getAsset(id) {
  const { rows } = await query(`SELECT * FROM assets WHERE id = $1 LIMIT 1`, [id]);
  if (rows[0]) {
    // Best-effort view counter; ignore failures (e.g. read replicas)
    query(`UPDATE assets SET view_count = view_count + 1 WHERE id = $1`, [id]).catch(() => {});
  }
  return rows[0] || null;
}

export async function upsertAsset(asset) {
  const { rows } = await query(
    `INSERT INTO assets
       (id, ticker, name, asset_type, exchange, country, sector, industry,
        currency, isin, figi, market_cap, description, logo_url,
        aliases, metadata, source, last_updated)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, NOW())
     ON CONFLICT (id) DO UPDATE
       SET name = EXCLUDED.name,
           asset_type = EXCLUDED.asset_type,
           exchange = COALESCE(EXCLUDED.exchange, assets.exchange),
           country = COALESCE(EXCLUDED.country, assets.country),
           sector = COALESCE(EXCLUDED.sector, assets.sector),
           industry = COALESCE(EXCLUDED.industry, assets.industry),
           market_cap = GREATEST(COALESCE(EXCLUDED.market_cap, 0), COALESCE(assets.market_cap, 0)),
           description = COALESCE(EXCLUDED.description, assets.description),
           logo_url = COALESCE(EXCLUDED.logo_url, assets.logo_url),
           aliases = EXCLUDED.aliases,
           metadata = EXCLUDED.metadata,
           source = EXCLUDED.source,
           last_updated = NOW()
     RETURNING *`,
    [
      asset.id,
      asset.ticker,
      asset.name,
      asset.asset_type || 'stock',
      asset.exchange || null,
      asset.country || null,
      asset.sector || null,
      asset.industry || null,
      asset.currency || 'USD',
      asset.isin || null,
      asset.figi || null,
      asset.market_cap ?? 0,
      asset.description || null,
      asset.logo_url || null,
      JSON.stringify(asset.aliases || []),
      JSON.stringify(asset.metadata || {}),
      asset.source || 'api',
    ]
  );
  return rows[0];
}

export async function trendingAssets({ limit = 20 } = {}) {
  const { rows } = await query(
    `SELECT id, ticker, name, asset_type, exchange, sector, market_cap, logo_url
       FROM assets
      WHERE is_active = TRUE
      ORDER BY (search_count * 3 + view_count + COALESCE(market_cap, 0) / 1e13) DESC
      LIMIT $1`,
    [Math.min(limit, 50)]
  );
  return rows;
}

export async function incrementSearch(ids = []) {
  if (!ids.length) return;
  await query(
    `UPDATE assets SET search_count = search_count + 1 WHERE id = ANY($1::text[])`,
    [ids]
  );
}

/**
 * Resolve free-text tickers/aliases to asset IDs.
 * Used by the rewriter to link news items to assets.
 */
export async function resolveTickersToAssetIds(tickers = []) {
  if (!tickers.length) return [];
  const upper = tickers.map((t) => String(t).toUpperCase().trim()).filter(Boolean);
  if (!upper.length) return [];
  const { rows } = await query(
    `SELECT DISTINCT id FROM assets
       WHERE is_active = TRUE
         AND (ticker = ANY($1::text[])
              OR aliases ?| $1::text[])
       ORDER BY id`,
    [upper]
  );
  return rows.map((r) => r.id);
}
