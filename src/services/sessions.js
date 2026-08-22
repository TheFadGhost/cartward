import { db } from '../db/index.js';
import { config } from '../config.js';
import { sha256, randomToken } from '../lib/tokens.js';

const insertSession = db.prepare(`
  INSERT INTO sessions (id, user_id, awaiting_2fa, created_at, last_seen_at, idle_expires_at, absolute_expires_at, ip, user_agent)
  VALUES (@id, @userId, @awaiting2fa, @now, @now, @idleExpires, @absoluteExpires, @ip, @userAgent)
`);
const selectById = db.prepare('SELECT * FROM sessions WHERE id = ?');
const deleteSessionStmt = db.prepare('DELETE FROM sessions WHERE id = ?');

/**
 * Create a session for a user. Returns the raw opaque token (only time it exists).
 * Pass pending2fa=true for a restricted session awaiting TOTP verification.
 */
export function createSession(userId, { ip, userAgent, now = Date.now(), pending2fa = false } = {}) {
  const token = randomToken();
  const id = sha256(token);
  insertSession.run({
    id,
    userId,
    awaiting2fa: pending2fa ? 1 : 0,
    now,
    idleExpires: now + config.session.idleMs,
    absoluteExpires: now + config.session.absoluteMs,
    ip: ip || null,
    userAgent: userAgent ? String(userAgent).slice(0, 300) : null,
  });
  return { token, id };
}

export function getSessionById(id) {
  return selectById.get(id) ?? null;
}

/** Promote an awaiting-2FA session to fully authenticated. */
export const promoteSession = db.prepare(
  'UPDATE sessions SET awaiting_2fa = 0 WHERE id = ?',
);

/**
 * Session rotation on privilege change (2FA challenge passed): issues a fresh
 * token bound to a fully authenticated session and deletes the old row.
 * Defends against session fixation.
 */
export function rotateSession(oldId, userId, ctx = {}, now = Date.now()) {
  const fresh = createSession(userId, { ...ctx, now, pending2fa: false });
  deleteSessionStmt.run(oldId);
  return fresh;
}

export function destroySession(id) {
  deleteSessionStmt.run(id);
}

export function revokeAllUserSessions(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

/** Cookie helpers bound to configured attributes. */
export function setSessionCookie(res, token, maxAgeMs = config.session.absoluteMs) {
  res.setCookie(config.session.cookieName, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: config.isProd,
    maxAge: maxAgeMs,
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(config.session.cookieName, { httpOnly: true, sameSite: 'Lax', secure: config.isProd });
}
