/**
 * AI proxy routes.
 *
 *   GET  /api/ai/status              — Provider info (no key leakage)
 *   POST /api/ai/call                — Single JSON / text response
 *   POST /api/ai/stream              — SSE token stream
 *
 * Free tier enforced via FREE_TIER_DAILY_AI_LIMIT.
 * Per-IP slow-down via rate limiter.
 */

import { Router } from 'express';
import Joi from 'joi';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../middleware/auth.js';
import { validate, stripNullBytes } from '../middleware/validation.js';
import { callOnce, callStream, activeProvider } from '../services/ai.js';
import { incrementQueryQuota } from '../db/repositories/users.js';
import { query as dbQuery } from '../db/connection.js';
import { PaymentError, ValidationError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

const router = Router();
const FREE_LIMIT = parseInt(process.env.FREE_TIER_DAILY_AI_LIMIT || '20', 10);
const MAX_TOKENS_HARD = parseInt(process.env.AI_MAX_TOKENS || '2000', 10);

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Slow down — try again in a moment' },
});

// ----- helpers ---------------------------------------------------------

async function enforceQuota(user) {
  if (user.subscription === 'past_due') {
    throw new PaymentError('Subscription past due — please update payment');
  }
  if (user.subscription !== 'free') return; // pro / enterprise unlimited
  const today = new Date().toISOString().slice(0, 10);
  const used = await incrementQueryQuota(user.id, today);
  if (used > FREE_LIMIT) {
    throw new PaymentError(`Daily AI limit reached (${FREE_LIMIT}). Upgrade to Pro for unlimited queries.`);
  }
}

async function logUsage(user, { endpoint, provider, model, usage = {}, ms }) {
  try {
    await dbQuery(
      `INSERT INTO ai_usage
         (user_id, day, endpoint, prompt_tokens, completion_tokens, model, provider, ms)
       VALUES ($1, CURRENT_DATE, $2, $3, $4, $5, $6, $7)`,
      [user.id, endpoint, usage.prompt_tokens || 0, usage.completion_tokens || 0, model, provider, ms || null]
    );
  } catch (err) {
    logger.warn({ err }, 'ai usage log failed');
  }
}

// ----- routes ----------------------------------------------------------

router.get('/status', (req, res) => res.json(activeProvider()));

router.post(
  '/call',
  aiLimiter,
  requireAuth,
  stripNullBytes,
  validate({
    body: Joi.object({
      systemPrompt: Joi.string().max(16_000).default('You are Quant Entelloq — an AI financial intelligence assistant.'),
      message: Joi.string().min(1).max(16_000).required(),
      json: Joi.boolean().default(false),
      maxTokens: Joi.number().integer().min(1).max(MAX_TOKENS_HARD),
      model: Joi.string().max(120),
    }),
  }),
  async (req, res, next) => {
    try {
      await enforceQuota(req.user);
      const { systemPrompt, message, json, maxTokens, model } = req.body;
      const result = await callOnce(systemPrompt, message, { json, maxTokens, model });
      await logUsage(req.user, {
        endpoint: '/api/ai/call',
        provider: result.provider,
        model: result.model,
        usage: result.usage,
        ms: result.ms,
      });
      res.json({
        text: result.text,
        json: result.json,
        usage: result.usage,
        provider: result.provider,
        model: result.model,
      });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/stream',
  aiLimiter,
  requireAuth,
  stripNullBytes,
  validate({
    body: Joi.object({
      messages: Joi.array()
        .items(
          Joi.object({
            role: Joi.string().valid('system', 'user', 'assistant').required(),
            content: Joi.string().min(1).max(32_000).required(),
          })
        )
        .min(1)
        .max(40)
        .required(),
      maxTokens: Joi.number().integer().min(1).max(MAX_TOKENS_HARD),
      model: Joi.string().max(120),
    }),
  }),
  async (req, res, next) => {
    try {
      await enforceQuota(req.user);
    } catch (err) {
      return next(err);
    }

    const { messages, maxTokens, model } = req.body;
    const provider = activeProvider();

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    const start = Date.now();
    const controller = new AbortController();
    req.on('close', () => controller.abort());

    let chars = 0;
    try {
      for await (const chunk of callStream(messages, { maxTokens, model, signal: controller.signal })) {
        chars += chunk.length;
        res.write(`data: ${JSON.stringify({ delta: chunk })}\n\n`);
      }
      res.write(`event: done\ndata: {"ok":true}\n\n`);
      res.end();
    } catch (err) {
      logger.warn({ err: err.message }, 'AI stream error');
      try {
        res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
        res.end();
      } catch {
        /* */
      }
    } finally {
      logUsage(req.user, {
        endpoint: '/api/ai/stream',
        provider: provider.provider,
        model: model || provider.streamModel,
        usage: { completion_tokens: Math.round(chars / 4) }, // rough estimate
        ms: Date.now() - start,
      }).catch(() => {});
    }
  }
);

export default router;
