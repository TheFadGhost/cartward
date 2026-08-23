import { config } from '../config.js';
import { randomToken, hmacHex, timingSafeEqual } from '../lib/tokens.js';

const GUEST_CSRF_COOKIE = 'cw_csrf';

function expectedToken(req) {
  if (req.sessionId) {
    // Bound to the session id: rotates with the session, useless without it.
    return hmacHex(config.sessionSecret, `csrf:${req.sessionId}`);
  }
  const guest = req.cookies[GUEST_CSRF_COOKIE];
  if (!guest) return null;
  return hmacHex(config.sessionSecret, `csrf-guest:${guest}`);
}

/**
 * Time-bucketed upload ticket for multipart forms whose token can't ride in
 * the body. Bound to the session and valid for ~10 minutes; never a
 * long-lived secret in a URL.
 */
function uploadTicketValid(req) {
  if (!req.sessionId || typeof req.query._t !== 'string') return false;
  const bucket = Math.floor(Date.now() / (10 * 60 * 1000));
  const candidates = [bucket, bucket - 1]
    .map((b) => hmacHex(config.sessionSecret, `csrf-upload:${req.sessionId}:${b}`));
  return candidates.includes(req.query._t);
}

/**
 * CSRF protection for all state-changing requests.
 * Authenticated: synchronizer token derived via HMAC from the server-side
 * session id. Guests: signed double-submit cookie (SameSite=Lax is the first
 * line of defence; the HMAC binding is the second).
 * Exempts the payment webhook route (authenticated by HMAC signature instead).
 */
export function csrfMiddleware(req, res, next) {
  // Ensure guests always have a CSRF anchor cookie before any form renders.
  if (!req.sessionId && !req.cookies[GUEST_CSRF_COOKIE]) {
    const guestToken = randomToken();
    res.setCookie(GUEST_CSRF_COOKIE, guestToken, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: config.isProd,
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
    req.cookies[GUEST_CSRF_COOKIE] = guestToken; // usable within this request
  }

  req.csrfToken = () => expectedToken(req);

  const safe = ['GET', 'HEAD', 'OPTIONS'];
  const exemptPaths = ['/webhooks/'];
  if (safe.includes(req.method) || exemptPaths.some((p) => req.path.startsWith(p))) {
    return next();
  }

  // Multipart uploads append a time-bound ticket to the action URL instead
  // of the body token (which can't be read before parsing).
  const supplied = req.body?._csrf;
  const expected = expectedToken(req);
  const bodyOk = supplied && expected && timingSafeEqual(String(supplied), expected);
  if (!bodyOk && !uploadTicketValid(req)) {
    return res.status(403).render('error', {
      title: 'Request blocked',
      message: 'Your session may have expired. Go back, reload the page and try again.',
      statusCode: 403,
      user: req.user,
      csrfToken: req.csrfToken(),
    });
  }
  next();
}
