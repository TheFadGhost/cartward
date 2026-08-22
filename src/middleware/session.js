import { db } from '../db/index.js';
import { config } from '../config.js';
import { sha256 } from '../lib/tokens.js';
import { destroySession } from '../services/sessions.js';

const selectByTokenHash = db.prepare(`
  SELECT s.*, u.email AS user_email, u.role AS user_role,
         u.email_verified_at AS user_email_verified_at,
         CASE WHEN u.totp_secret_enc IS NOT NULL AND u.totp_enabled_at IS NOT NULL THEN 1 ELSE 0 END AS user_2fa_on
  FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.id = ?
`);
const touchSession = db.prepare('UPDATE sessions SET last_seen_at = ?, idle_expires_at = ? WHERE id = ?');
const deleteExpired = db.prepare(
  'DELETE FROM sessions WHERE absolute_expires_at < ? OR idle_expires_at < ?',
);

/**
 * Session middleware: resolves the session from cookie, enforces idle and
 * absolute expiry, slides the idle window (throttled), attaches req.user.
 */
const REFRESH_THROTTLE_MS = 60_000;
let lastSweep = 0;

export function sessionMiddleware(req, res, next) {
  req.user = null;
  req.pending2fa = false;

  // Opportunistic sweep of dead sessions so storage stays bounded.
  const now = Date.now();
  if (now - lastSweep > 300_000) {
    try { deleteExpired.run(now, now); } catch { /* non-fatal */ }
    lastSweep = now;
  }

  const raw = req.cookies[config.session.cookieName];
  if (!raw) return next();

  // The cookie value is the raw opaque token; its SHA-256 is the stored id.
  const tokenHash = sha256(raw);
  let row;
  try {
    row = selectByTokenHash.get(tokenHash);
  } catch {
    return next();
  }
  if (!row) return next();

  if (now >= row.absolute_expires_at || now >= row.idle_expires_at) {
    destroySession(row.id);
    res.clearCookie(config.session.cookieName);
    return next();
  }

  if (now - row.last_seen_at > REFRESH_THROTTLE_MS) {
    touchSession.run(now, Math.min(now + config.session.idleMs, row.absolute_expires_at), row.id);
  }

  req.sessionId = row.id;
  req.user = {
    id: row.user_id,
    email: row.user_email,
    role: row.user_role,
    emailVerified: !!row.user_email_verified_at,
    totpEnabled: !!row.user_2fa_on,
  };
  req.pending2fa = !!row.awaiting_2fa;
  next();
}

/** Guard: full session required (2FA challenge satisfied). Redirects to login. */
export function requireUser(req, res, next) {
  if (req.user && !req.pending2fa) return next();
  if (req.user && req.pending2fa) return res.redirect('/login/challenge');
  return res.redirect('/login');
}

/** Guard: admin role checked server-side on every request, never by hiding UI. */
export function requireAdmin(req, res, next) {
  if (!req.user || req.pending2fa || req.user.role !== 'admin') {
    return res.status(303).redirect('/login');
  }
  return next();
}
