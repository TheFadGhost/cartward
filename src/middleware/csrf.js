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

  const supplied = req.body?._csrf;
  const expected = expectedToken(req);
  if (!supplied || !expected || !timingSafeEqual(String(supplied), expected)) {
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
