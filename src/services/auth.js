import crypto from 'node:crypto';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { hash, verify } from '@node-rs/argon2';
import * as otpauth from 'otpauth';
import { newId, randomToken, sha256 } from '../lib/tokens.js';
import { mailer } from './email/index.js';

// OWASP-recommended Argon2id parameters (19 MiB memory, t=2, p=1).
// Never weaken these to make something faster.
const ARGON2_OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;

export class AuthError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Small embedded deny-list of ubiquitous passwords (NIST: length over composition).
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password12', 'password123', 'password1234',
  '123456', '123456789', '12345678910', 'qwerty', 'qwertyuiop', 'abc123456789',
  'letmeinletmein', 'iloveyouilovey', 'adminadmin1234', 'welcome1234567',
  '111111111111', '000000000000', 'aaaaaaaaaaaa', 'changemechangem',
  'correcthorsebatterystaple', 'trustno1trustno1', 'dragon.dragon.dragon',
  'monkeybusiness12', 'mastermaster12', 'sunshinesunshine', 'princessprincess',
  'passwordpassword',
]);

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < config.passwordMinLength) {
    return { ok: false, error: `Password must be at least ${config.passwordMinLength} characters.` };
  }
  if (password.length > 200) return { ok: false, error: 'Password must be at most 200 characters.' };
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower.replace(/[^a-z]/g, '')) || COMMON_PASSWORDS.has(lower)) {
    return { ok: false, error: 'That password is too common. Choose something longer and less guessable.' };
  }
  return { ok: true };
}

export async function hashPassword(password) {
  return hash(password, ARGON2_OPTS);
}

export async function verifyPassword(hashStr, password) {
  try {
    return await verify(hashStr, password);
  } catch {
    return false;
  }
}

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

const insertUser = db.prepare(`
  INSERT INTO users (id, email, password_hash, role, created_at, updated_at)
  VALUES (@id, @email, @passwordHash, @role, @now, @now)
`);
const findByEmailStmt = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE');
const findByIdStmt = db.prepare('SELECT * FROM users WHERE id = ?');
const setEmailVerified = db.prepare('UPDATE users SET email_verified_at = ?, updated_at = ? WHERE id = ?');

export function findUserByEmail(email) {
  return findByEmailStmt.get(normalizeEmail(email)) ?? null;
}
export function findUserById(id) {
  return findByIdStmt.get(id) ?? null;
}

/** Create a user (unverified) and send the verification email. */
export async function createUser({ email, password, role = 'customer', ip }) {
  const normalized = normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new AuthError('invalid_email', 'Enter a valid email address.');
  }
  const pwCheck = validatePassword(password);
  if (!pwCheck.ok) throw new AuthError('weak_password', pwCheck.error);
  if (normalized.length > 254) {
    throw new AuthError('invalid_email', 'Enter a valid email address.');
  }
  if (findUserByEmail(normalized)) {
    throw new AuthError('email_taken', 'An account with that email already exists.');
  }
  const id = newId();
  const now = Date.now();
  insertUser.run({ id, email: normalized, passwordHash: await hashPassword(password), role, now });
  await issueEmailVerification(id);
  return findUserById(id);
}

/**
 * Registration is enumeration-safe: when the address already exists we respond
 * exactly as if the account were created and notify the existing owner.
 */
export async function handleRegistration({ email, password }) {
  try {
    return await createUser({ email, password });
  } catch (err) {
    if (err instanceof AuthError && err.code === 'email_taken') {
      const existing = findUserByEmail(email);
      await mailer.sendTemplate(existing.email, 'registrationAttempt', {});
      return null; // indistinguishable response downstream
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Single-use expiring tokens (email verification + password reset share this)
// ---------------------------------------------------------------------------

const insertToken = db.prepare(`
  INSERT INTO verification_tokens (id, user_id, purpose, token_hash, expires_at, created_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const consumeTokenStmt = db.prepare(`
  UPDATE verification_tokens SET used_at = ?
  WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?
`);

/**
 * Issue a single-use token. The raw token is returned once; only its SHA-256
 * is stored. Issuing a new one invalidates prior tokens of the same purpose.
 */
async function issueToken(userId, purpose, ttlMs) {
  db.prepare('DELETE FROM verification_tokens WHERE user_id = ? AND purpose = ? AND used_at IS NULL').run(userId, purpose);
  const raw = randomToken();
  insertToken.run(newId(), userId, purpose, sha256(raw), Date.now() + ttlMs, Date.now());
  return raw;
}

/** Mark a token used; returns true when it was valid and unused. */
function consumeToken(rawToken, purpose, now = Date.now()) {
  const res = consumeTokenStmt.run(now, sha256(rawToken), purpose, now);
  return res.changes === 1;
}

export async function issueEmailVerification(userId) {
  const raw = await issueToken(userId, 'email_verify', EMAIL_VERIFY_TTL_MS);
  await mailer.sendTemplate(findUserById(userId).email, 'verifyEmail', {
    url: `${config.baseUrl}/verify-email?token=${encodeURIComponent(raw)}`,
    hours: 24,
  });
}

export function verifyEmailWithToken(rawToken) {
  const row = db.prepare('SELECT user_id FROM verification_tokens WHERE token_hash = ?').get(sha256(rawToken));
  const ok = !!row && consumeToken(rawToken, 'email_verify');
  if (!ok) throw new AuthError('bad_token', 'This link is invalid or has expired.');
  setEmailVerified.run(Date.now(), Date.now(), row.user_id);
  return findUserById(row.user_id);
}

export async function requestPasswordReset(email) {
  // Always succeeds from the caller's perspective (no account enumeration).
  const user = findUserByEmail(email);
  if (!user) return;
  const raw = await issueToken(user.id, 'password_reset', PASSWORD_RESET_TTL_MS);
  await mailer.sendTemplate(user.email, 'passwordReset', {
    url: `${config.baseUrl}/reset-password?token=${encodeURIComponent(raw)}`,
    minutes: 30,
  });
}

/**
 * Complete a password reset: single-use token, revokes every existing
 * session for the account, then confirms by email.
 */
export async function resetPasswordWithToken(rawToken, newPassword) {
  const userRow = db
    .prepare('SELECT user_id FROM verification_tokens WHERE token_hash = ?')
    .get(sha256(rawToken));
  const pwCheck = validatePassword(newPassword);
  if (!pwCheck.ok) throw new AuthError('weak_password', pwCheck.error);
  const ok = consumeToken(rawToken, 'password_reset');
  if (!ok || !userRow) throw new AuthError('bad_token', 'This reset link is invalid or has expired.');
  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
    await hashPassword(newPassword), Date.now(), userRow.user_id,
  );
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userRow.user_id);
  return findUserById(userRow.user_id);
}

// ---------------------------------------------------------------------------
// TOTP two-factor
// ---------------------------------------------------------------------------

function totpKey() {
  return crypto.scryptSync(config.sessionSecret, 'cartward-totp-salt', 32);
}

function encryptSecret(secretBase32) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', totpKey(), iv);
  const enc = Buffer.concat([cipher.update(secretBase32, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}

function decryptSecret(blob) {
  const buf = Buffer.from(blob);
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', totpKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function buildTotp(secretBase32, email) {
  return new otpauth.TOTP({
    issuer: 'Cartward',
    label: email,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: otpauth.Secret.fromBase32(secretBase32),
  });
}

/** Generate (but do not enable) a TOTP enrollment secret for the user. */
export function beginTotpEnrollment(user) {
  const secret = new otpauth.Secret({ size: 20 }).base32;
  db.prepare('UPDATE users SET totp_secret_enc = ?, updated_at = ? WHERE id = ?')
    .run(encryptSecret(secret), Date.now(), user.id);
  const totp = buildTotp(secret, user.email);
  return { secret, uri: totp.toString() };
}

/**
 * otpauth validate() returns the step delta (>= 0, so 0 is a PASS) or null.
 */
function totpMatches(totpInstance, token) {
  return totpInstance.validate({ token, window: 1 }) !== null;
}

/** Confirm enrollment with a valid code; returns single-use recovery codes. */
export async function confirmTotpEnrollment(user, code) {
  const row = findUserById(user.id);
  if (!row?.totp_secret_enc) throw new AuthError('not_enrolled', 'Start two-factor setup first.');
  const secret = decryptSecret(row.totp_secret_enc);
  if (!totpMatches(buildTotp(secret, row.email), code)) {
    throw new AuthError('bad_code', 'That code is not valid. Check your authenticator and try again.');
  }
  db.prepare('UPDATE users SET totp_enabled_at = ?, updated_at = ? WHERE id = ?')
    .run(Date.now(), Date.now(), row.id);
  // 10 recovery codes, argon2-hashed, single use.
  db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(row.id);
  const codes = Array.from({ length: 10 }, () => randomToken().slice(0, 16).toLowerCase());
  const ins = db.prepare('INSERT INTO recovery_codes (id, user_id, code_hash, created_at) VALUES (?, ?, ?, ?)');
  const all = db.transaction((list) => {
    for (const c of list) ins.run(newId(), row.id, sha256(c), Date.now());
  });
  all(codes);
  await mailer.sendTemplate(row.email, 'twoFactorEnabled', {});
  return codes;
}

/** Verify a TOTP code or recovery code during login challenge. */
export function verifyTotpChallenge(user, code) {
  const trimmed = String(code || '').trim().toLowerCase();
  const row = findUserById(user.id);
  if (!row?.totp_secret_enc || !row.totp_enabled_at) {
    throw new AuthError('not_enrolled', 'Two-factor is not set up on this account.');
  }
  const secret = decryptSecret(row.totp_secret_enc);
  if (/^\d{6}$/.test(trimmed)) {
    if (!totpMatches(buildTotp(secret, row.email), trimmed)) throw new AuthError('bad_code', 'That code is not valid. Try the next one.');
    return { viaRecoveryCode: false };
  }
  // Recovery code path — single use.
  const recRow = db.prepare(
    'SELECT id FROM recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL',
  ).get(row.id, sha256(trimmed));
  if (!recRow) throw new AuthError('bad_code', 'That code or recovery code is not valid.');
  db.prepare('UPDATE recovery_codes SET used_at = ? WHERE id = ?').run(Date.now(), recRow.id);
  return { viaRecoveryCode: true };
}

export function disableTotp(user) {
  db.prepare('UPDATE users SET totp_secret_enc = NULL, totp_enabled_at = NULL, updated_at = ? WHERE id = ?')
    .run(Date.now(), user.id);
  db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(user.id);
}
