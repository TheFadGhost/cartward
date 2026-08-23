import { db } from '../db/index.js';

/**
 * DB-backed fixed-window rate limiter. Survives restarts, testable with a
 * frozen clock. Bucket shape: "<name>:<identity>:<windowIndex>".
 */
const insertStmt = () => `
  INSERT INTO rate_limits (bucket, count, expires_at) VALUES (?, 1, ?)
  ON CONFLICT(bucket) DO UPDATE SET count = count + 1
`;
const getStmt = db.prepare('SELECT bucket, count, expires_at FROM rate_limits WHERE bucket = ?');
const setStmt = db.prepare(insertStmt());
const pruneStmt = db.prepare('DELETE FROM rate_limits WHERE expires_at < ?');

let lastPrune = 0;

/**
 * Consume one hit against `name`/`identity`. Returns { allowed, remaining, retryAfterMs }.
 */
export function rateLimit(name, identity, limit, windowMs, now = Date.now()) {
  if (now - lastPrune > 60_000) {
    pruneStmt.run(now);
    lastPrune = now;
  }
  const windowIndex = Math.floor(now / windowMs);
  const bucket = `${name}:${identity}:${windowIndex}`;
  setStmt.run(bucket, (windowIndex + 1) * windowMs);
  const current = getStmt.get(bucket).count;
  const expiresAt = (windowIndex + 1) * windowMs;
  if (current > limit) {
    return { allowed: false, remaining: 0, retryAfterMs: Math.max(0, expiresAt - now), count: current };
  }
  return { allowed: true, remaining: Math.max(0, limit - current), retryAfterMs: 0 };
}

/** Express middleware factory. keyFn(req) must produce a stable identity string. */
export function rateLimitMiddleware({ name, keyFn, limit, windowMs }) {
  return (req, res, next) => {
    const result = rateLimit(name, keyFn(req), limit, windowMs);
    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));
    if (!result.allowed) {
      res.setHeader('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
    req.rateLimited = true;
    return res.status(429).render('error', {
      title: 'Too many attempts',
      message: 'Too many attempts from your side. Please wait a little while and try again.',
      statusCode: 429,
      user: req.user ?? null,
      csrfToken: typeof req.csrfToken === 'function' ? req.csrfToken() : '',
    });
    }
    next();
  };
}


