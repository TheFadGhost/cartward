import { Router } from 'express';
import { db } from '../db/index.js';
import { requireUser } from '../middleware/session.js';
import {
  beginTotpEnrollment, confirmTotpEnrollment, disableTotp, AuthError,
} from '../services/auth.js';
import { verifyPassword } from '../services/auth.js';
import { revokeAllUserSessions } from '../services/sessions.js';
import { audit } from '../services/admin.js';

const router = Router();
router.use('/account', requireUser);

router.get('/account/security', (req, res) => {
  res.render('account/security', {
    title: 'Security',
    totp: totpState(req.user.id),
    enroll: null,
    errors: {},
    recoveryCodes: null,
    sessions: listSessions(req.user.id),
  });
});

function totpState(userId) {
  const row = db.prepare('SELECT totp_secret_enc IS NOT NULL AS enrolled, totp_enabled_at FROM users WHERE id = ?').get(userId);
  return row;
}

function listSessions(userId) {
  return db.prepare(`
    SELECT id, created_at, last_seen_at, ip, user_agent FROM sessions
    WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT 20
  `).all(userId);
}

router.post('/account/security/totp/begin', (req, res) => {
  if (totpState(req.user.id).totp_enabled_at) return res.redirect('/account/security');
  const { secret, uri } = beginTotpEnrollment(req.user);
  res.render('account/security', {
    title: 'Security',
    totp: totpState(req.user.id),
    enroll: { secret, uri },
    errors: {}, recoveryCodes: null,
    sessions: listSessions(req.user.id),
  });
});

router.post('/account/security/totp/confirm', async (req, res, next) => {
  try {
    const codes = await confirmTotpEnrollment(req.user, String(req.body.code || ''));
    audit({ actorType: 'customer', actorId: req.user.id, action: 'security.totp_enabled', ip: req.ip });
    res.render('account/security', {
      title: 'Security',
      totp: totpState(req.user.id),
      enroll: null,
      errors: {},
      recoveryCodes: codes,
      sessions: listSessions(req.user.id),
    });
  } catch (err) {
    if (!(err instanceof AuthError)) return next(err);
    const { secret, uri } = beginTotpEnrollment(req.user);
    return res.status(422).render('account/security', {
      title: 'Security',
      totp: totpState(req.user.id),
      enroll: { secret, uri },
      errors: { code: err.message },
      recoveryCodes: null,
      sessions: listSessions(req.user.id),
    });
  }
});

router.post('/account/security/totp/disable', async (req, res) => {
  const ok = await verifyPassword(db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id).password_hash, String(req.body.password || ''));
  if (!ok) {
    res.flash('warn', 'Password incorrect — two-factor stays on.');
    return res.redirect('/account/security');
  }
  disableTotp(req.user);
  audit({ actorType: 'customer', actorId: req.user.id, action: 'security.totp_disabled', ip: req.ip });
  res.flash('success', 'Two-factor authentication disabled.');
  return res.redirect('/account/security');
});

router.post('/account/security/sessions/revoke-all', (req, res) => {
  revokeAllUserSessions(req.user.id);
  // The current session dies with everything else — force a clean re-login.
  return res.redirect('/logout-confirmed');
});

export default router;
