/**
 * Auth routes.
 *
 *   GET    /api/auth/config       — Public capability flags (frontend bootstrap)
 *   POST   /api/auth/signup       — Email signup
 *   POST   /api/auth/login        — Email login
 *   POST   /api/auth/google       — Verify Google ID token (One-Tap / popup)
 *   POST   /api/auth/refresh      — Rotate refresh token
 *   POST   /api/auth/logout       — Revoke session
 *   GET    /api/auth/me           — Hydrate current user
 */

import { Router } from 'express';
import Joi from 'joi';
import rateLimit from 'express-rate-limit';
import { validate, stripNullBytes } from '../middleware/validation.js';
import { requireAuth } from '../middleware/auth.js';
import {
  signup,
  login,
  loginWithGoogleIdToken,
  rotateRefresh,
  revoke,
  setAuthCookies,
  clearAuthCookies,
} from '../services/auth.js';
import { activeProvider } from '../services/ai.js';
import { findUserById } from '../db/repositories/users.js';
import { logger } from '../lib/logger.js';

const router = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Too many auth attempts, try again later' },
});

const emailSchema = Joi.string().email().max(254).lowercase().required();
const nameSchema = Joi.string().trim().min(1).max(80).required();
const passwordSchema = Joi.string().min(8).max(256).required();

router.get('/config', (req, res) => {
  const ai = activeProvider();
  res.json({
    googleEnabled: Boolean(process.env.GOOGLE_CLIENT_ID),
    googleClientId: process.env.GOOGLE_CLIENT_ID || null,
    stripeEnabled: Boolean(process.env.STRIPE_SECRET_KEY),
    aiProvider: ai.provider,
    aiModelStream: ai.streamModel,
    aiModelCall: ai.callModel,
    aiConfigured: ai.configured,
  });
});

router.post(
  '/signup',
  authLimiter,
  stripNullBytes,
  validate({
    body: Joi.object({
      email: emailSchema,
      password: passwordSchema,
      name: nameSchema,
    }),
  }),
  async (req, res, next) => {
    try {
      const ctx = { userAgent: req.headers['user-agent'], ip: req.ip };
      const { user, accessToken, refreshToken, expiresAt } = await signup(req.body, ctx);
      setAuthCookies(res, { accessToken, refreshToken, expiresAt });
      res.status(201).json({ user, accessToken });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/login',
  authLimiter,
  stripNullBytes,
  validate({ body: Joi.object({ email: emailSchema, password: passwordSchema }) }),
  async (req, res, next) => {
    try {
      const ctx = { userAgent: req.headers['user-agent'], ip: req.ip };
      const { user, accessToken, refreshToken, expiresAt } = await login(req.body, ctx);
      setAuthCookies(res, { accessToken, refreshToken, expiresAt });
      res.json({ user, accessToken });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/google',
  authLimiter,
  validate({ body: Joi.object({ idToken: Joi.string().required() }) }),
  async (req, res, next) => {
    try {
      const ctx = { userAgent: req.headers['user-agent'], ip: req.ip };
      const { user, accessToken, refreshToken, expiresAt } = await loginWithGoogleIdToken(
        req.body.idToken,
        ctx
      );
      setAuthCookies(res, { accessToken, refreshToken, expiresAt });
      res.json({ user, accessToken });
    } catch (err) {
      next(err);
    }
  }
);

router.post('/refresh', async (req, res, next) => {
  try {
    const refresh = req.body?.refreshToken || req.cookies?.qz_refresh;
    if (!refresh) return res.status(401).json({ error: 'missing_refresh' });
    const ctx = { userAgent: req.headers['user-agent'], ip: req.ip };
    const { user, accessToken, refreshToken, expiresAt } = await rotateRefresh(refresh, ctx);
    setAuthCookies(res, { accessToken, refreshToken, expiresAt });
    res.json({ user, accessToken });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', async (req, res) => {
  const refresh = req.body?.refreshToken || req.cookies?.qz_refresh;
  try {
    // Best-effort revoke if there's a token
    if (req.cookies?.qz_token) {
      const jwt = (await import('jsonwebtoken')).default;
      try {
        const payload = jwt.verify(req.cookies.qz_token, process.env.JWT_SECRET, {
          algorithms: ['HS256'],
        });
        await revoke(payload.jti, refresh);
      } catch {
        // Token already expired — just clear cookies
      }
    } else if (refresh) {
      await revoke(null, refresh);
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'logout cleanup error');
  }
  clearAuthCookies(res);
  res.json({ ok: true });
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const fresh = await findUserById(req.user.id);
    res.json({ user: fresh });
  } catch (err) {
    next(err);
  }
});

export default router;
