/**
 * Intelligence routes.
 *
 *   GET  /api/intel/feed           — Public feed (cached)
 *   GET  /api/intel/portfolio      — Auth-required, scoped to user holdings
 *   GET  /api/intel/opportunities  — Top opportunities right now
 *   GET  /api/intel/sources        — List intel sources
 *   GET  /api/intel/item/:id       — Single item details
 *   GET  /api/intel/stream         — SSE realtime feed
 */

import { Router } from 'express';
import Joi from 'joi';
import { validate } from '../middleware/validation.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import * as IntelService from '../services/intel.js';
import { listSources } from '../db/repositories/intel.js';
import { realtime } from '../realtime/server-events.js';

const router = Router();

const feedQuerySchema = Joi.object({
  q: Joi.string().max(200).allow('', null),
  category: Joi.string().valid('markets', 'crypto', 'macro', 'tech', 'filings'),
  sentiment: Joi.string().valid('bullish', 'bearish', 'neutral'),
  tickers: Joi.alternatives(Joi.string(), Joi.array().items(Joi.string())),
  minImpact: Joi.number().integer().min(0).max(100),
  minOpportunity: Joi.number().integer().min(0).max(100),
  sinceHours: Joi.number().integer().min(1).max(720).default(72),
  limit: Joi.number().integer().min(1).max(200).default(50),
  cursorAt: Joi.string().isoDate(),
  cursorId: Joi.string().guid({ version: 'uuidv4' }),
});

function parseTickers(input) {
  if (!input) return undefined;
  if (Array.isArray(input)) return input.map((t) => String(t).toUpperCase());
  return String(input).split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
}

router.get('/feed', optionalAuth, validate({ query: feedQuerySchema }), async (req, res, next) => {
  try {
    const { cursorAt, cursorId, tickers, ...rest } = req.query;
    const cursor = cursorAt && cursorId ? { publishedAt: cursorAt, id: cursorId } : undefined;
    const data = await IntelService.getFeed({
      ...rest,
      tickers: parseTickers(tickers),
      cursor,
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get(
  '/portfolio',
  requireAuth,
  validate({
    query: Joi.object({
      sinceHours: Joi.number().integer().min(1).max(720).default(72),
      limit: Joi.number().integer().min(1).max(200).default(30),
    }),
  }),
  async (req, res, next) => {
    try {
      const items = await IntelService.getFeedForUser(req.user.id, req.query);
      res.json({ items });
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/opportunities',
  optionalAuth,
  validate({
    query: Joi.object({
      limit: Joi.number().integer().min(1).max(100).default(20),
      minScore: Joi.number().integer().min(0).max(100).default(60),
    }),
  }),
  async (req, res, next) => {
    try {
      const items = await IntelService.getOpportunities(req.query);
      res.json({ items });
    } catch (err) {
      next(err);
    }
  }
);

router.get('/sources', async (req, res, next) => {
  try {
    const sources = await listSources({ activeOnly: true });
    res.json({ sources });
  } catch (err) {
    next(err);
  }
});

router.get('/item/:id', async (req, res, next) => {
  try {
    const item = await IntelService.getItem(req.params.id);
    if (!item) return res.status(404).json({ error: 'not_found' });
    res.json({ item });
  } catch (err) {
    next(err);
  }
});

/**
 * Server-Sent Events stream of new intel items.
 * Falls back to long-poll-style ping every 25s to keep connections alive.
 */
router.get('/stream', optionalAuth, async (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(`event: hello\ndata: {"ok":true}\n\n`);

  const send = (event, payload) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  const unsubscribe = realtime.subscribe('intel.new', (payload) => send('intel.new', payload));
  const ping = setInterval(() => res.write(`event: ping\ndata: ${Date.now()}\n\n`), 25000);

  req.on('close', () => {
    clearInterval(ping);
    unsubscribe();
    res.end();
  });
});

export default router;
