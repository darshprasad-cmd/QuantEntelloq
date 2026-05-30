/**
 * Portfolio routes.
 *
 *   GET    /api/portfolio                — List user's portfolios
 *   POST   /api/portfolio                — Create portfolio
 *   GET    /api/portfolio/:id/holdings   — Holdings for a portfolio
 *   PUT    /api/portfolio/:id/holdings   — Upsert holding
 *   DELETE /api/portfolio/:id/holdings/:hid — Remove holding
 *   POST   /api/portfolio/:id/transactions — Record buy/sell/etc.
 *   GET    /api/portfolio/:id/transactions — List transactions
 *   GET    /api/portfolio/watchlists     — List user watchlists
 *   PUT    /api/portfolio/watchlists     — Upsert a watchlist
 *   DELETE /api/portfolio/watchlists/:id — Delete watchlist
 */

import { Router } from 'express';
import Joi from 'joi';
import { validate } from '../middleware/validation.js';
import { requireAuth } from '../middleware/auth.js';
import * as Repo from '../db/repositories/portfolio.js';
import { ForbiddenError } from '../lib/errors.js';

const router = Router();
router.use(requireAuth);

const assetIdSchema = Joi.string().pattern(/^[A-Z0-9.:_-]{1,40}$/i).required();

// ---------- helpers ----------------------------------------------------
async function ensureOwn(req, portfolioId) {
  const ports = await Repo.listPortfolios(req.user.id);
  if (!ports.some((p) => p.id === portfolioId)) throw new ForbiddenError('Not your portfolio');
}

// ---------- portfolios -------------------------------------------------

router.get('/', async (req, res, next) => {
  try {
    const portfolios = await Repo.listPortfolios(req.user.id);
    // Bootstrap default if user has none yet
    if (!portfolios.length) {
      const def = await Repo.getOrCreateDefaultPortfolio(req.user.id);
      return res.json({ portfolios: [def] });
    }
    res.json({ portfolios });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/',
  validate({
    body: Joi.object({
      name: Joi.string().trim().min(1).max(80).required(),
      baseCcy: Joi.string().uppercase().length(3).default('USD'),
    }),
  }),
  async (req, res, next) => {
    try {
      const p = await Repo.createPortfolio(req.user.id, req.body);
      res.status(201).json({ portfolio: p });
    } catch (err) {
      next(err);
    }
  }
);

router.delete('/:id', async (req, res, next) => {
  try {
    await Repo.deletePortfolio(req.user.id, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------- holdings ---------------------------------------------------

router.get('/:id/holdings', async (req, res, next) => {
  try {
    await ensureOwn(req, req.params.id);
    const holdings = await Repo.listHoldings(req.params.id);
    res.json({ holdings });
  } catch (err) {
    next(err);
  }
});

router.put(
  '/:id/holdings',
  validate({
    body: Joi.object({
      assetId: assetIdSchema,
      quantity: Joi.number().min(0).required(),
      avgCost: Joi.number().min(0).required(),
      currency: Joi.string().uppercase().length(3).default('USD'),
      notes: Joi.string().max(500).allow('', null),
    }),
  }),
  async (req, res, next) => {
    try {
      await ensureOwn(req, req.params.id);
      const holding = await Repo.upsertHolding(req.params.id, req.body);
      res.json({ holding });
    } catch (err) {
      next(err);
    }
  }
);

router.delete('/:id/holdings/:hid', async (req, res, next) => {
  try {
    await ensureOwn(req, req.params.id);
    await Repo.removeHolding(req.params.id, req.params.hid);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------- transactions ----------------------------------------------

router.post(
  '/:id/transactions',
  validate({
    body: Joi.object({
      assetId: assetIdSchema,
      side: Joi.string().valid('buy', 'sell', 'dividend', 'split', 'fee').required(),
      quantity: Joi.number().required(),
      price: Joi.number().min(0).required(),
      fee: Joi.number().min(0).default(0),
      currency: Joi.string().uppercase().length(3).default('USD'),
      executedAt: Joi.string().isoDate(),
      notes: Joi.string().max(500).allow('', null),
    }),
  }),
  async (req, res, next) => {
    try {
      await ensureOwn(req, req.params.id);
      const tx = await Repo.recordTransaction(req.params.id, req.body);
      res.status(201).json({ transaction: tx });
    } catch (err) {
      next(err);
    }
  }
);

router.get('/:id/transactions', async (req, res, next) => {
  try {
    await ensureOwn(req, req.params.id);
    const txs = await Repo.listTransactions(req.params.id, {
      limit: parseInt(req.query.limit, 10) || 100,
      assetId: req.query.assetId,
    });
    res.json({ transactions: txs });
  } catch (err) {
    next(err);
  }
});

// ---------- watchlists -------------------------------------------------

router.get('/watchlists', async (req, res, next) => {
  try {
    const watchlists = await Repo.listWatchlists(req.user.id);
    res.json({ watchlists });
  } catch (err) {
    next(err);
  }
});

router.put(
  '/watchlists',
  validate({
    body: Joi.object({
      name: Joi.string().trim().min(1).max(80).required(),
      assetIds: Joi.array().items(assetIdSchema).max(500).default([]),
    }),
  }),
  async (req, res, next) => {
    try {
      const wl = await Repo.upsertWatchlist(req.user.id, req.body);
      res.json({ watchlist: wl });
    } catch (err) {
      next(err);
    }
  }
);

router.delete('/watchlists/:id', async (req, res, next) => {
  try {
    await Repo.deleteWatchlist(req.user.id, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
