/**
 * User repository — all DB access for users + sessions.
 */

import { query, withTransaction } from '../connection.js';
import { ConflictError } from '../../lib/errors.js';

const PUBLIC_COLUMNS = `
  id, email, name, avatar_url, auth_provider, google_sub,
  subscription, subscription_expiry, plan_interval, cancel_at_period_end,
  renewal_date, stripe_customer_id, stripe_subscription_id,
  query_date, query_count,
  email_verified_at, last_login_at, created_at, updated_at
`;

export async function findUserByEmail(email) {
  const { rows } = await query(
    `SELECT ${PUBLIC_COLUMNS}, password_hash FROM users WHERE email = $1 LIMIT 1`,
    [email]
  );
  return rows[0] || null;
}

export async function findUserById(id) {
  const { rows } = await query(
    `SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = $1 LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

export async function findUserByGoogleSub(sub) {
  const { rows } = await query(
    `SELECT ${PUBLIC_COLUMNS} FROM users WHERE google_sub = $1 LIMIT 1`,
    [sub]
  );
  return rows[0] || null;
}

export async function findUserByStripeCustomer(customerId) {
  const { rows } = await query(
    `SELECT ${PUBLIC_COLUMNS} FROM users WHERE stripe_customer_id = $1 LIMIT 1`,
    [customerId]
  );
  return rows[0] || null;
}

export async function createUserEmail({ email, name, passwordHash }) {
  try {
    const { rows } = await query(
      `INSERT INTO users (email, name, password_hash, auth_provider)
       VALUES ($1, $2, $3, 'email')
       RETURNING ${PUBLIC_COLUMNS}`,
      [email, name, passwordHash]
    );
    return rows[0];
  } catch (err) {
    if (err.code === '23505') throw new ConflictError('Email already registered');
    throw err;
  }
}

export async function createUserGoogle({ email, name, googleSub, avatarUrl }) {
  try {
    const { rows } = await query(
      `INSERT INTO users (email, name, auth_provider, google_sub, avatar_url, email_verified_at)
       VALUES ($1, $2, 'google', $3, $4, NOW())
       RETURNING ${PUBLIC_COLUMNS}`,
      [email, name, googleSub, avatarUrl || null]
    );
    return rows[0];
  } catch (err) {
    if (err.code === '23505') throw new ConflictError('Email or Google id already used');
    throw err;
  }
}

export async function linkGoogleToUser(userId, { googleSub, avatarUrl }) {
  const { rows } = await query(
    `UPDATE users
       SET google_sub = $2,
           avatar_url = COALESCE($3, avatar_url),
           email_verified_at = COALESCE(email_verified_at, NOW())
     WHERE id = $1
     RETURNING ${PUBLIC_COLUMNS}`,
    [userId, googleSub, avatarUrl || null]
  );
  return rows[0];
}

export async function touchLogin(userId) {
  await query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [userId]);
}

export async function updateSubscription(userId, fields) {
  const sets = [];
  const vals = [];
  let i = 1;
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = $${i++}`);
    vals.push(v);
  }
  if (!sets.length) return null;
  vals.push(userId);
  const { rows } = await query(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $${i} RETURNING ${PUBLIC_COLUMNS}`,
    vals
  );
  return rows[0];
}

// ----- Quotas ---------------------------------------------------------
export async function incrementQueryQuota(userId, dayISO) {
  // Reset counter if day changed
  const { rows } = await query(
    `UPDATE users
       SET query_count = CASE WHEN query_date = $2::date THEN query_count + 1 ELSE 1 END,
           query_date  = $2::date
     WHERE id = $1
     RETURNING query_count`,
    [userId, dayISO]
  );
  return rows[0]?.query_count ?? 0;
}

// ----- Sessions -------------------------------------------------------
export async function createSession({ userId, jti, refreshHash, userAgent, ip, expiresAt }) {
  const { rows } = await query(
    `INSERT INTO sessions (user_id, jti, refresh_hash, user_agent, ip, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, jti, expires_at, created_at`,
    [userId, jti, refreshHash, userAgent || null, ip || null, expiresAt]
  );
  return rows[0];
}

export async function findSessionByJti(jti) {
  const { rows } = await query(
    `SELECT id, user_id, jti, refresh_hash, expires_at, revoked_at
       FROM sessions WHERE jti = $1 LIMIT 1`,
    [jti]
  );
  return rows[0] || null;
}

export async function rotateSession({ jti, newJti, newRefreshHash, newExpiresAt }) {
  return withTransaction(async (c) => {
    await c.query(`UPDATE sessions SET revoked_at = NOW() WHERE jti = $1`, [jti]);
    const { rows: parent } = await c.query(`SELECT user_id, user_agent, ip FROM sessions WHERE jti = $1`, [jti]);
    if (!parent[0]) return null;
    const { rows } = await c.query(
      `INSERT INTO sessions (user_id, jti, refresh_hash, user_agent, ip, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, jti, expires_at`,
      [parent[0].user_id, newJti, newRefreshHash, parent[0].user_agent, parent[0].ip, newExpiresAt]
    );
    return rows[0];
  });
}

export async function revokeSession(jti) {
  await query(`UPDATE sessions SET revoked_at = NOW() WHERE jti = $1`, [jti]);
}

export async function revokeAllUserSessions(userId) {
  await query(`UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
}
