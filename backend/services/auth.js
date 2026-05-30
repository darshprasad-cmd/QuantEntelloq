/**
 * Auth service — password hashing, JWT issuance, Google OAuth token verification.
 *
 * All routes/auth.js calls go through here so the storage layer stays clean.
 */

import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import {
  findUserByEmail,
  findUserById,
  findUserByGoogleSub,
  createUserEmail,
  createUserGoogle,
  linkGoogleToUser,
  touchLogin,
  createSession,
  findSessionByJti,
  rotateSession,
  revokeSession,
} from '../db/repositories/users.js';
import { redis } from '../cache/redis.js';
import { AuthError, ConflictError, ValidationError } from '../lib/errors.js';

const JWT_SECRET = process.env.JWT_SECRET || '';
const ACCESS_TTL = process.env.JWT_ACCESS_TTL || '15m';
const REFRESH_TTL_DAYS = parseInt(process.env.JWT_REFRESH_TTL?.replace(/d$/, '') || '30', 10);
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || undefined;
const COOKIE_SECURE = process.env.NODE_ENV === 'production';
const BCRYPT_ROUNDS = 12;

const googleClient = process.env.GOOGLE_CLIENT_ID
  ? new OAuth2Client(process.env.GOOGLE_CLIENT_ID)
  : null;

// ---------- Password ----------------------------------------------------

export async function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain, hash) {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}

export function assertPasswordPolicy(plain) {
  if (typeof plain !== 'string' || plain.length < 8) {
    throw new ValidationError('Password must be at least 8 characters');
  }
  if (plain.length > 256) {
    throw new ValidationError('Password too long');
  }
}

// ---------- JWT ---------------------------------------------------------

function signAccessToken(user, jti) {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      subscription: user.subscription,
      jti,
    },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: ACCESS_TTL }
  );
}

function hashRefresh(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function refreshExpiresAt() {
  return new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Issue { accessToken, refreshToken, session } for a user.
 * Persists a session row tracking the refresh token hash.
 */
export async function issueTokens(user, { userAgent, ip } = {}) {
  const jti = crypto.randomUUID();
  const refreshToken = crypto.randomBytes(48).toString('base64url');
  const refreshHash = hashRefresh(refreshToken);
  const expiresAt = refreshExpiresAt();
  const session = await createSession({
    userId: user.id,
    jti,
    refreshHash,
    userAgent,
    ip,
    expiresAt,
  });
  const accessToken = signAccessToken(user, jti);
  return { accessToken, refreshToken, jti, session, expiresAt };
}

/**
 * Rotate refresh token. Old one is revoked; new (jti, refresh) issued.
 */
export async function rotateRefresh(oldRefresh, { userAgent, ip } = {}) {
  if (!oldRefresh) throw new AuthError('Missing refresh token');
  const oldHash = hashRefresh(oldRefresh);

  // We can't look up by hash directly without scanning sessions — instead,
  // clients always send the JWT (jti) and the refresh together.
  // Use redis to map refreshHash → jti for O(1) lookup on rotation.
  const jti = await redis.get(`auth:refresh:${oldHash}`);
  if (!jti) throw new AuthError('Refresh token unknown or expired');

  const session = await findSessionByJti(jti);
  if (!session) throw new AuthError('Session not found');
  if (session.revoked_at) throw new AuthError('Session revoked');
  if (session.refresh_hash !== oldHash) throw new AuthError('Refresh hash mismatch');
  if (new Date(session.expires_at) < new Date()) throw new AuthError('Refresh token expired');

  const newJti = crypto.randomUUID();
  const newRefresh = crypto.randomBytes(48).toString('base64url');
  const newHash = hashRefresh(newRefresh);
  const newExpiresAt = refreshExpiresAt();

  await rotateSession({
    jti,
    newJti,
    newRefreshHash: newHash,
    newExpiresAt,
  });

  // Map new refresh → jti, drop old mapping
  await redis.set(`auth:refresh:${newHash}`, newJti, 'EX', REFRESH_TTL_DAYS * 86400);
  await redis.del(`auth:refresh:${oldHash}`);

  const user = await findUserById(session.user_id);
  const accessToken = signAccessToken(user, newJti);
  return { user, accessToken, refreshToken: newRefresh, jti: newJti, expiresAt: newExpiresAt };
}

/** Mark an access token revoked (logout). */
export async function revoke(jti, refreshToken) {
  if (jti) {
    await revokeSession(jti);
    // Revocation TTL ~= access token TTL
    await redis.set(`auth:revoked:${jti}`, '1', 'EX', 60 * 60).catch(() => {});
  }
  if (refreshToken) {
    await redis.del(`auth:refresh:${hashRefresh(refreshToken)}`).catch(() => {});
  }
}

// ---------- Signup / Login flows ---------------------------------------

export async function signup({ email, password, name }, ctx = {}) {
  assertPasswordPolicy(password);
  const existing = await findUserByEmail(email);
  if (existing) throw new ConflictError('Email already registered');

  const passwordHash = await hashPassword(password);
  const user = await createUserEmail({ email, name, passwordHash });
  await touchLogin(user.id);
  const tokens = await issueTokens(user, ctx);
  await redis.set(
    `auth:refresh:${hashRefresh(tokens.refreshToken)}`,
    tokens.jti,
    'EX',
    REFRESH_TTL_DAYS * 86400
  );
  return { user, ...tokens };
}

export async function login({ email, password }, ctx = {}) {
  const user = await findUserByEmail(email);
  if (!user || !user.password_hash) throw new AuthError('Invalid credentials');
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) throw new AuthError('Invalid credentials');
  delete user.password_hash;

  await touchLogin(user.id);
  const tokens = await issueTokens(user, ctx);
  await redis.set(
    `auth:refresh:${hashRefresh(tokens.refreshToken)}`,
    tokens.jti,
    'EX',
    REFRESH_TTL_DAYS * 86400
  );
  return { user, ...tokens };
}

// ---------- Google ID token verification --------------------------------

export async function loginWithGoogleIdToken(idToken, ctx = {}) {
  if (!googleClient) throw new ValidationError('Google login not configured');

  let ticket;
  try {
    ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
  } catch (err) {
    throw new AuthError('Invalid Google token');
  }
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload?.email) throw new AuthError('Google token missing fields');

  let user = await findUserByGoogleSub(payload.sub);
  if (!user) {
    // Match by email (link existing email account to Google)
    const existing = await findUserByEmail(payload.email);
    if (existing) {
      user = await linkGoogleToUser(existing.id, {
        googleSub: payload.sub,
        avatarUrl: payload.picture,
      });
    } else {
      user = await createUserGoogle({
        email: payload.email,
        name: payload.name || payload.email.split('@')[0],
        googleSub: payload.sub,
        avatarUrl: payload.picture,
      });
    }
  }

  await touchLogin(user.id);
  const tokens = await issueTokens(user, ctx);
  await redis.set(
    `auth:refresh:${hashRefresh(tokens.refreshToken)}`,
    tokens.jti,
    'EX',
    REFRESH_TTL_DAYS * 86400
  );
  return { user, ...tokens };
}

// ---------- Cookie helpers ---------------------------------------------

export function setAuthCookies(res, { accessToken, refreshToken, expiresAt }) {
  const base = {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: 'lax',
    domain: COOKIE_DOMAIN,
    path: '/',
  };
  res.cookie('qz_token', accessToken, { ...base, maxAge: 15 * 60 * 1000 });
  res.cookie('qz_refresh', refreshToken, {
    ...base,
    maxAge: expiresAt.getTime() - Date.now(),
  });
}

export function clearAuthCookies(res) {
  const base = { domain: COOKIE_DOMAIN, path: '/' };
  res.clearCookie('qz_token', base);
  res.clearCookie('qz_refresh', base);
}
