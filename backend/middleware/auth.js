/**
 * JWT authentication middleware.
 *
 * Reads token from:
 *   1. Authorization: Bearer <token>
 *   2. Cookie: qz_token  (set by /api/auth/login)
 *
 * Attaches req.user = { id, email, subscription, ... } on success.
 */

import jwt from 'jsonwebtoken';
import { AuthError, ForbiddenError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { findUserById } from '../db/repositories/users.js';
import { redis } from '../cache/redis.js';

const JWT_SECRET = process.env.JWT_SECRET || '';
if (!JWT_SECRET || JWT_SECRET === 'replace-me-with-64-char-random-hex') {
  logger.fatal('JWT_SECRET is not set — refusing to start');
  // We don't throw here at import time so tests can stub it, but server.js
  // should validate this before listen().
}

function extractToken(req) {
  const authHeader = req.headers['authorization'];
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7).trim();
  if (req.cookies?.qz_token) return req.cookies.qz_token;
  if (req.signedCookies?.qz_token) return req.signedCookies.qz_token;
  return null;
}

/**
 * Verify token, hydrate req.user.
 * Throws AuthError if invalid / missing.
 */
export async function requireAuth(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) throw new AuthError('Missing auth token');

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    } catch (err) {
      throw new AuthError(err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token');
    }

    // Optional: revocation check (logout, force-rotate)
    const revoked = await redis.get(`auth:revoked:${payload.jti}`).catch(() => null);
    if (revoked) throw new AuthError('Token revoked');

    const user = await findUserById(payload.sub);
    if (!user) throw new AuthError('User no longer exists');

    req.user = user;
    req.token = { jti: payload.jti, exp: payload.exp };
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Optional auth — does NOT 401 if token is missing/invalid.
 * Useful for routes that personalize but still serve public content.
 */
export async function optionalAuth(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) return next();
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    const user = await findUserById(payload.sub);
    if (user) {
      req.user = user;
      req.token = { jti: payload.jti, exp: payload.exp };
    }
    next();
  } catch {
    next(); // silent
  }
}

/**
 * Require a specific subscription tier.
 *   requireSubscription('pro')
 */
export function requireSubscription(minTier = 'pro') {
  const tiers = { free: 0, pro: 1, enterprise: 2 };
  return (req, res, next) => {
    if (!req.user) return next(new AuthError());
    if (req.user.subscription === 'past_due') {
      return next(new ForbiddenError('Subscription past due — please update payment'));
    }
    const userLevel = tiers[req.user.subscription] ?? 0;
    const required = tiers[minTier] ?? 1;
    if (userLevel < required) {
      return next(new ForbiddenError(`Requires ${minTier} subscription`));
    }
    next();
  };
}
