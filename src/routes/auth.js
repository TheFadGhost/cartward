import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { rateLimitMiddleware, rateLimit } from '../lib/rate-limit.js';
import {
  AuthError, handleRegistration, findUserByEmail, verifyEmailWithToken, issueEmailVerification,
  requestPasswordReset, resetPasswordWithToken, verifyTotpChallenge, verifyPassword,
} from '../services/auth.js';
import { mergeGuestCartOnLogin } from '../services/cart.js';
import {
  createSession, destroySession, rotateSession, setSessionCookie, clearSessionCookie,
} from '../services/sessions.js';

const router = Router();

const ipOf = (req) => req.ip || 'unknown';

function clientContext(req) {
  return { ip: ipOf(req), userAgent: req.headers['user-agent'] };
}

function renderAuthPage(req, res, view, vars = {}, status = 200) {
  res.status(status).render(view, {
    errors: {},
    values: {},
    user: req.user,
    csrfToken: req.csrfToken(),
    ...vars,
  });
}

const emailField = z.string().trim().email('Enter a valid email address.');

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const registerSchema = z.object({
  email: emailField,
  password: z.string().min(1, 'Enter a password.'),
});

router.get('/register', (req, res) => {
  if (req.user && !req.pending2fa) return res.redirect('/account');
  renderAuthPage(req, res, 'auth/register', { title: 'Create account' });
});

router.post('/register',
  rateLimitMiddleware({ name: 'register-ip', keyFn: ipOf, limit: 10, windowMs: 60 * 60 * 1000 }),
  async (req, res, next) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      const errors = {};
      for (const issue of parsed.error.issues) errors[issue.path[0]] ??= issue.message;
      return renderAuthPage(req, res, 'auth/register', { title: 'Create account', errors, values: req.body }, 422);
    }
    try {
      await handleRegistration({ email: parsed.data.email, password: parsed.data.password });
    } catch (err) {
      if (!(err instanceof AuthError)) return next(err);
      const field = err.code === 'weak_password' ? 'password' : 'email';
      return renderAuthPage(req, res, 'auth/register', {
        title: 'Create account',
        errors: { [field]: err.message },
        values: { email: parsed.data.email },
      }, 422);
    }
    // Identical response whether or not the address was new (no enumeration).
    // Deliberately no auto-login: the verification email proves delivery.
    res.flash('success', 'Account created. Check your inbox for a verification link.');
    return res.redirect('/login');
  });

router.get('/verify-email', (req, res) => {
  let ok = false;
  try {
    verifyEmailWithToken(String(req.query.token || ''));
    ok = true;
  } catch { /* render failure state */ }
  renderAuthPage(req, res, 'auth/verify-email', { title: ok ? 'Email verified' : 'Link expired', verified: ok });
});

const resendSchema = z.object({ email: emailField });

router.post('/verify-email/resend',
  rateLimitMiddleware({ name: 'verify-resend-ip', keyFn: ipOf, limit: 5, windowMs: 60 * 60 * 1000 }),
  async (req, res, next) => {
    try {
      const parsed = resendSchema.safeParse(req.body);
      if (parsed.success) {
        const user = findUserByEmail(parsed.data.email);
        if (user && !user.email_verified_at && perAccountResend(user.email)) {
          issueEmailVerification(user.id).catch(() => {});
        }
      }
      res.flash('success', 'If that email has an unverified account, a new link is on its way.');
      return res.redirect('/login');
    } catch (err) {
      return next(err);
    }
  });

// Per-account resend throttle backed by the shared DB rate limiter.
function perAccountResend(email) {
  return rateLimit('verify-resend-account', normalizeEmailKey(email), 3, 60 * 60 * 1000).allowed;
}
const normalizeEmailKey = (e) => String(e || '').trim().toLowerCase();

// ---------------------------------------------------------------------------
// Login / logout / 2FA challenge
// ---------------------------------------------------------------------------

const loginSchema = z.object({
  email: emailField,
  password: z.string().min(1, 'Enter your password.'),
  next: z.string().optional(),
});
const safeNext = (n) => (n && n.startsWith('/') && !n.startsWith('//') ? n : null);

/** Merge the guest cart on sign-in and surface an honest summary. */
function mergeGuestCartAndReport(req, res, user) {
  const guestToken = req.cookies[config.session.cartCookieName];
  if (!guestToken) return;
  const result = mergeGuestCartOnLogin(user.id, guestToken);
  res.clearCookie(config.session.cartCookieName);
  if (!result.merged) return;
  if (result.capped?.length) {
    const names = result.capped.map((c) => c.name).join(', ');
    res.flash('warn', `Quantities for ${names} were limited to available stock.`);
  } else if (result.mergedItems > 0 || result.adopted) {
    res.flash('success', 'Your cart came with you.');
  }
}

router.get('/login', (req, res) => {
  if (req.user && req.pending2fa) return res.redirect('/login/challenge');
  if (req.user) return res.redirect('/account');
  renderAuthPage(req, res, 'auth/login', { title: 'Sign in' });
});

router.post('/login',
  rateLimitMiddleware({ name: 'login-ip', keyFn: ipOf, limit: 20, windowMs: 15 * 60 * 1000 }),
  rateLimitMiddleware({
    name: 'login-email',
    keyFn: (req) => String(req.body?.email || '').trim().toLowerCase() || 'blank',
    limit: 8,
    windowMs: 15 * 60 * 1000,
  }),
  async (req, res, next) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      const errors = {};
      for (const issue of parsed.error.issues) errors[issue.path[0]] ??= issue.message;
      return renderAuthPage(req, res, 'auth/login', { title: 'Sign in', errors, values: { email: parsed.data?.email } }, 422);
    }
    try {
      const user = findUserByEmail(parsed.data.email);
      // Uniform failure message prevents account enumeration.
      const fail = () => renderAuthPage(req, res, 'auth/login', {
        title: 'Sign in',
        errors: { form: 'Invalid email or password.' },
        values: { email: parsed.data.email },
      }, 401);

      if (!user) {
        // Burn comparable time so timing doesn't reveal account existence.
        await verifyPassword('$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$AAAAAAAAAAAAAAAAAAAAAA', 'x');
        return fail();
      }
      const ok = await verifyPassword(user.password_hash, parsed.data.password);
      if (!ok) return fail();

      const totpOn = !!user.totp_enabled_at;
      const session = createSession(user.id, { ...clientContext(req), pending2fa: totpOn });
      setSessionCookie(res, session.token);
      if (totpOn) return res.redirect('/login/challenge');

      mergeGuestCartAndReport(req, res, user);
      res.flash('success', `Signed in as ${user.email}.`);
      return res.redirect(safeNext(parsed.data.next) || '/account');
    } catch (err) {
      return next(err);
    }
  });

router.get('/login/challenge', (req, res) => {
  if (!req.pending2fa) return res.redirect('/login');
  renderAuthPage(req, res, 'auth/challenge', { title: 'Two-factor authentication' });
});

router.post('/login/challenge',
  rateLimitMiddleware({
    name: 'totp-attempt',
    keyFn: (req) => req.sessionId || ipOf(req),
    limit: 10,
    windowMs: 15 * 60 * 1000,
  }),
  (req, res, next) => {
    if (!req.pending2fa) return res.redirect('/login');
    let result;
    try {
      result = verifyTotpChallenge(req.user, String(req.body.code || ''));
    } catch (err) {
      if (!(err instanceof AuthError)) return next(err);
      return renderAuthPage(req, res, 'auth/challenge', {
        title: 'Two-factor authentication',
        errors: { code: err.message },
      }, 401);
    }
    const rotated = rotateSession(req.sessionId, req.user.id, clientContext(req));
    setSessionCookie(res, rotated.token);
    mergeGuestCartAndReport(req, res, req.user);
    if (result.viaRecoveryCode) {
      res.flash('warn', 'You signed in with a recovery code. Consider generating new ones from your account settings.');
    }
    return res.redirect('/account');
  });

router.post('/logout', (req, res) => {
  if (req.sessionId) destroySession(req.sessionId);
  clearSessionCookie(res);
  res.flash('success', 'Signed out.');
  res.redirect('/');
});

/** After a global session revocation the current cookie is already dead. */
router.get('/logout-confirmed', (req, res) => {
  clearSessionCookie(res);
  res.flash('success', 'Signed out of every device for this account. Sign in again to continue.');
  res.redirect('/login');
});

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

router.get('/forgot-password', (req, res) => {
  renderAuthPage(req, res, 'auth/forgot', { title: 'Reset your password' });
});

router.post('/forgot-password',
  rateLimitMiddleware({ name: 'forgot-ip', keyFn: ipOf, limit: 5, windowMs: 60 * 60 * 1000 }),
  async (req, res, next) => {
    const parsed = resendSchema.safeParse(req.body);
    if (parsed.success) {
      try { await requestPasswordReset(parsed.data.email); } catch { /* stay silent */ }
    }
    res.flash('success', 'If that email has an account, a reset link is on its way.');
    res.redirect('/login');
  });

router.get('/reset-password', (req, res) => {
  renderAuthPage(req, res, 'auth/reset', { title: 'Choose a new password', token: String(req.query.token || '') });
});

router.post('/reset-password',
  rateLimitMiddleware({ name: 'reset-ip', keyFn: ipOf, limit: 5, windowMs: 60 * 60 * 1000 }),
  async (req, res, next) => {
    const token = String(req.body.token || '');
    const password = String(req.body.password || '');
    try {
      await resetPasswordWithToken(token, password);
      res.flash('success', 'Password updated. Sign in with your new password.');
      return res.redirect('/login');
    } catch (err) {
      if (!(err instanceof AuthError)) return next(err);
      if (err.code === 'bad_token') {
        return renderAuthPage(req, res, 'error', {
          title: 'Link expired',
          message: 'This reset link is invalid or has expired.',
          statusCode: 400,
        }, 400);
      }
      return renderAuthPage(req, res, 'auth/reset', {
        title: 'Choose a new password',
        token,
        errors: { password: err.message },
      }, 422);
    }
  });

export default router;
