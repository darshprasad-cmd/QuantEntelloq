/**
 * Signals routes.
 *
 *   GET  /api/signals              — All active signals, ranked
 *   GET  /api/signals/:assetId     — Signals for a specific asset
 */

import { Router } from 'express';
import Joi from 'joi';
import { validate } from '../middleware/validation.js';
import { optionalAuth } from '../middleware/auth.js';
import { query } from '../db/connection.js';
import { withCache } from '../cache/redis.js';

const router = Router();

router.get(
  '/',
  optionalAuth,
  validate({
    query: Joi.object({
      direction: Joi.string().valid('long', 'short', 'neutral'),
      kind: Joi.string().max(40),
      minScore: Joi.number().min(0).max(100).default(50),
      limit: Joi.number().integer().min(1).max(200).default(40),
    }),
  }),
  async (req, res, next) => {
    try {
      const { direction, kind, minScore, limit } = req.query;
      const key = `signals:active:${direction || ''}:${kind || ''}:${minScore}:${limit}`;
      const items = await withCache(key, 60, async () => {
        const wheres = ['active = TRUE', 'score >= $1', '(expires_at IS NULL OR expires_at > NOW())'];
        const params = [minScore];
        let i = 2;
        if (direction) {
          wheres.push(`direction = $${i++}`);
          params.push(direction);
        }
        if (kind) {
          wheres.push(`kind = $${i++}`);
          params.push(kind);
        }
        params.push(limit);
        const { rows } = await query(
          `SELECT s.id, s.asset_id, s.kind, s.direction, s.score, s.thesis,
                  s.reasoning, s.target, s.stop, s.horizon_days,
                  s.source_items, s.metadata, s.created_at, s.expires_at,
                  a.ticker, a.name, a.exchange, a.asset_type, a.logo_url
             FROM signals s
             LEFT JOIN assets a ON a.id = s.asset_id
            WHERE ${wheres.join(' AND ')}
            ORDER BY s.score DESC, s.created_at DESC
            LIMIT $${i}`,
          params
        );
        return rows;
      });
      res.json({ signals: items });
    } catch (err) {
      next(err);
    }
  }
);

router.get('/:assetId', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT * FROM signals
        WHERE asset_id = $1 AND active = TRUE
        ORDER BY created_at DESC LIMIT 20`,
      [req.params.assetId]
    );
    res.json({ signals: rows });
  } catch (err) {
    next(err);
  }
});

export default router;
