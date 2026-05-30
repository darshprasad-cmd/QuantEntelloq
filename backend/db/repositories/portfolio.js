/**
 * Portfolio repository — portfolios, holdings, transactions, watchlists.
 */

import { query, withTransaction } from '../connection.js';
import { NotFoundError } from '../../lib/errors.js';

// ---------- Portfolios -------------------------------------------------

export async function listPortfolios(userId) {
  const { rows } = await query(
    `SELECT id, name, base_ccy, created_at, updated_at
       FROM portfolios WHERE user_id = $1 ORDER BY created_at ASC`,
    [userId]
  );
  return rows;
}

export async function getOrCreateDefaultPortfolio(userId) {
  return withTransaction(async (c) => {
    const { rows: existing } = await c.query(
      `SELECT * FROM portfolios WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1`,
      [userId]
    );
    if (existing[0]) return existing[0];
    const { rows } = await c.query(
      `INSERT INTO portfolios (user_id, name) VALUES ($1, 'Main') RETURNING *`,
      [userId]
    );
    return rows[0];
  });
}

export async function createPortfolio(userId, { name, baseCcy = 'USD' }) {
  const { rows } = await query(
    `INSERT INTO portfolios (user_id, name, base_ccy) VALUES ($1, $2, $3) RETURNING *`,
    [userId, name, baseCcy]
  );
  return rows[0];
}

export async function deletePortfolio(userId, portfolioId) {
  const { rowCount } = await query(
    `DELETE FROM portfolios WHERE id = $1 AND user_id = $2`,
    [portfolioId, userId]
  );
  if (!rowCount) throw new NotFoundError('Portfolio');
}

// ---------- Holdings ---------------------------------------------------

export async function listHoldings(portfolioId) {
  const { rows } = await query(
    `SELECT h.id, h.asset_id, h.quantity, h.avg_cost, h.currency, h.notes,
            h.opened_at, h.updated_at,
            a.ticker, a.name, a.asset_type, a.exchange, a.sector, a.logo_url
       FROM holdings h
       LEFT JOIN assets a ON a.id = h.asset_id
      WHERE h.portfolio_id = $1
      ORDER BY (h.quantity * h.avg_cost) DESC NULLS LAST`,
    [portfolioId]
  );
  return rows;
}

export async function upsertHolding(portfolioId, { assetId, quantity, avgCost, currency = 'USD', notes }) {
  const { rows } = await query(
    `INSERT INTO holdings (portfolio_id, asset_id, quantity, avg_cost, currency, notes)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (portfolio_id, asset_id) DO UPDATE
       SET quantity = EXCLUDED.quantity,
           avg_cost = EXCLUDED.avg_cost,
           currency = EXCLUDED.currency,
           notes = EXCLUDED.notes,
           updated_at = NOW()
     RETURNING *`,
    [portfolioId, assetId, quantity, avgCost, currency, notes || null]
  );
  return rows[0];
}

export async function removeHolding(portfolioId, holdingId) {
  const { rowCount } = await query(
    `DELETE FROM holdings WHERE id = $1 AND portfolio_id = $2`,
    [holdingId, portfolioId]
  );
  if (!rowCount) throw new NotFoundError('Holding');
}

// ---------- Transactions ----------------------------------------------

export async function recordTransaction(portfolioId, tx) {
  return withTransaction(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO transactions
         (portfolio_id, asset_id, side, quantity, price, fee, currency, executed_at, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8, NOW()), $9)
       RETURNING *`,
      [
        portfolioId,
        tx.assetId,
        tx.side,
        tx.quantity,
        tx.price,
        tx.fee || 0,
        tx.currency || 'USD',
        tx.executedAt || null,
        tx.notes || null,
      ]
    );

    // Recompute position
    const { rows: positions } = await c.query(
      `SELECT
          SUM(CASE WHEN side='buy' THEN quantity WHEN side='sell' THEN -quantity ELSE 0 END) AS qty,
          SUM(CASE WHEN side='buy' THEN quantity * price ELSE 0 END) AS cost_basis,
          SUM(CASE WHEN side='buy' THEN quantity ELSE 0 END) AS buy_qty
         FROM transactions
        WHERE portfolio_id = $1 AND asset_id = $2`,
      [portfolioId, tx.assetId]
    );
    const pos = positions[0];
    const qty = Number(pos.qty) || 0;
    const avgCost = pos.buy_qty > 0 ? Number(pos.cost_basis) / Number(pos.buy_qty) : 0;

    if (qty > 0) {
      await c.query(
        `INSERT INTO holdings (portfolio_id, asset_id, quantity, avg_cost, currency)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (portfolio_id, asset_id) DO UPDATE
           SET quantity = EXCLUDED.quantity,
               avg_cost = EXCLUDED.avg_cost,
               updated_at = NOW()`,
        [portfolioId, tx.assetId, qty, avgCost, tx.currency || 'USD']
      );
    } else {
      await c.query(
        `DELETE FROM holdings WHERE portfolio_id = $1 AND asset_id = $2`,
        [portfolioId, tx.assetId]
      );
    }

    return rows[0];
  });
}

export async function listTransactions(portfolioId, { limit = 100, assetId } = {}) {
  const params = [portfolioId];
  let where = `WHERE portfolio_id = $1`;
  if (assetId) {
    params.push(assetId);
    where += ` AND asset_id = $2`;
  }
  params.push(Math.min(limit, 500));
  const { rows } = await query(
    `SELECT * FROM transactions ${where} ORDER BY executed_at DESC LIMIT $${params.length}`,
    params
  );
  return rows;
}

// ---------- Watchlists -------------------------------------------------

export async function listWatchlists(userId) {
  const { rows } = await query(
    `SELECT id, name, asset_ids, created_at, updated_at
       FROM watchlists WHERE user_id = $1 ORDER BY created_at ASC`,
    [userId]
  );
  return rows;
}

export async function upsertWatchlist(userId, { name, assetIds = [] }) {
  const { rows } = await query(
    `INSERT INTO watchlists (user_id, name, asset_ids)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, name) DO UPDATE
       SET asset_ids = EXCLUDED.asset_ids, updated_at = NOW()
     RETURNING *`,
    [userId, name, assetIds]
  );
  return rows[0];
}

export async function deleteWatchlist(userId, watchlistId) {
  const { rowCount } = await query(
    `DELETE FROM watchlists WHERE id = $1 AND user_id = $2`,
    [watchlistId, userId]
  );
  if (!rowCount) throw new NotFoundError('Watchlist');
}

/** Distinct asset IDs across a user's holdings + watchlists. */
export async function userScopedAssetIds(userId) {
  const { rows } = await query(
    `SELECT DISTINCT asset_id FROM holdings h
        JOIN portfolios p ON p.id = h.portfolio_id
       WHERE p.user_id = $1
     UNION
     SELECT DISTINCT UNNEST(asset_ids) AS asset_id FROM watchlists WHERE user_id = $1`,
    [userId]
  );
  return rows.map((r) => r.asset_id).filter(Boolean);
}
