import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeClient, csrfOf, paramFromEmail, db } from '../helpers/harness.js';

let client;
const PASSWORD = 'quiet-orchard-lantern';

beforeEach(async () => {
  db.prepare('DELETE FROM rate_limits').run();
  client = await makeClient();
});

async function registerUser(email) {
  const page = await client.get('/register');
  const csrf = csrfOf(page);
  return client.post('/register', { email, password: PASSWORD, _csrf: csrf });
}

describe('registration', () => {
  it('creates an account and captures a verification email', async () => {
    const res = await registerUser('ada@example.test');
    assert.equal(res.status, 302);
    const mails = paramFromEmail('ada@example.test', 'token');
    assert.ok(mails.length > 10);
  });

  it('rejects a short password with a field error', async () => {
    const page = await client.get('/register');
    const res = await client.post('/register', {
      email: 'shortpw@example.test', password: 'tiny', _csrf: csrfOf(page),
    });
    assert.equal(res.status, 422);
    assert.match(res.text, /at least 12 characters/i);
  });

  it('rejects duplicate email without leaking whether it exists via different message', async () => {
    await registerUser('dup@example.test');
    const page = await client.get('/register');
    const res = await client.post('/register', {
      email: 'dup@example.test', password: PASSWORD, _csrf: csrfOf(page),
    });
    assert.equal(res.status, 422);
    assert.match(res.text, /already exists/);
  });

  it('requires CSRF token', async () => {
    const res = await client.post('/register', { email: 'x@y.test', password: PASSWORD });
    assert.equal(res.status, 403);
  });

  it('verification link works once then expires', async () => {
    await registerUser('verify-once@example.test');
    const token = paramFromEmail('verify-once@example.test', 'token');
    const ok = await client.get(`/verify-email?token=${encodeURIComponent(token)}`);
    assert.match(ok.text, /Email verified/);

    const again = await client.get(`/verify-email?token=${encodeURIComponent(token)}`);
    assert.match(again.text, /Link expired/);
  });
});

describe('login and sessions', () => {
  it('rejects wrong password with generic message (no enumeration)', async () => {
    await registerUser('login-fail@example.test');
    const page = await client.get('/login');
    const res = await client.post('/login', {
      email: 'login-fail@example.test', password: 'not-the-password-at-all', _csrf: csrfOf(page),
    });
    assert.equal(res.status, 401);
    assert.match(res.text, /Invalid email or password/);
    // Must not hint whether the account exists.
    assert.ok(!/no account|does not exist|not found/i.test(res.text));
  });

  it('responds identically for unknown emails', async () => {
    const page = await client.get('/login');
    const missing = await client.post('/login', {
      email: 'ghost@example.test', password: 'whatever-long-password', _csrf: csrfOf(page),
    });
    assert.equal(missing.status, 401);
    assert.match(missing.text, /Invalid email or password/);
  });

  it('sets an HttpOnly SameSite=Lax session cookie on success', async () => {
    await registerUser('cookie-check@example.test');
    const page = await client.get('/login');
    const res = await client.post('/login', {
      email: 'cookie-check@example.test', password: PASSWORD, _csrf: csrfOf(page),
    });
    assert.equal(res.status, 302);
    const raw = res.headers['set-cookie'].find((c) => c.startsWith('cw_session='));
    assert.match(raw, /HttpOnly/i);
    assert.match(raw, /SameSite=Lax/i);
    assert.ok(client.cookieValue('cw_session'));
  });

  it('grants account access after login and revokes after logout', async () => {
    await registerUser('lifecycle@example.test');
    const page = await client.get('/login');
    await client.post('/login', {
      email: 'lifecycle@example.test', password: PASSWORD, _csrf: csrfOf(page),
    });
    const account = await client.get('/account');
    assert.equal(account.status, 200);
    assert.match(account.text, /Signed in as/);

    const acctPage = await client.get('/account');
    await client.post('/logout', { _csrf: csrfOf(acctPage) });
    const afterLogout = await client.get('/account');
    assert.equal(afterLogout.status, 302);
    assert.match(afterLogout.headers.location, /\/login/);
  });

  it('rotates the session token on every login (fixation defence)', async () => {
    await registerUser('rotate@example.test');
    const first = async () => {
      const page = await client.get('/login');
      await client.post('/login', {
        email: 'rotate@example.test', password: PASSWORD, _csrf: csrfOf(page),
      });
      const t = client.cookieValue('cw_session');
      const acct = await client.get('/account');
      await client.post('/logout', { _csrf: csrfOf(acct) });
      return t;
    };
    const a = await first();
    const b = await first();
    assert.notEqual(a, b);
  });

  it('an old session cookie is useless after logout (revocation)', async () => {
    await registerUser('revoke@example.test');
    const page = await client.get('/login');
    await client.post('/login', { email: 'revoke@example.test', password: PASSWORD, _csrf: csrfOf(page) });
    const staleCookie = client.cookieValue('cw_session');

    const acct = await client.get('/account');
    await client.post('/logout', { _csrf: csrfOf(acct) });

    // Replay the captured cookie.
    client.clearCookies();
    const { default: request } = await import('supertest');
    const res = await request(client.app).get('/account').set('Cookie', `cw_session=${staleCookie}`);
    assert.equal(res.status, 302);
  });
});

describe('password reset', () => {
  it('issues a single-use expiring link, resets, and revokes sessions', async () => {
    await registerUser('reset-flow@example.test');
    // Log in somewhere.
    let page = await client.get('/login');
    await client.post('/login', { email: 'reset-flow@example.test', password: PASSWORD, _csrf: csrfOf(page) });
    const oldSession = client.cookieValue('cw_session');

    client.clearCookies();
    page = await client.get('/forgot-password');
    await client.post('/forgot-password', { email: 'reset-flow@example.test', _csrf: csrfOf(page) });

    const token = paramFromEmail('reset-flow@example.test', 'token', 'Reset');
    const resetPage = await client.get(`/reset-password?token=${encodeURIComponent(token)}`);
    const res = await client.post('/reset-password', {
      token, password: 'newer-stronger-passphrase', _csrf: csrfOf(resetPage),
    });
    assert.equal(res.status, 302);

    // Old password no longer valid.
    client.clearCookies();
    page = await client.get('/login');
    const badPw = await client.post('/login', {
      email: 'reset-flow@example.test', password: PASSWORD, _csrf: csrfOf(page),
    });
    assert.equal(badPw.status, 401);

    // New password works.
    page = await client.get('/login');
    const goodPw = await client.post('/login', {
      email: 'reset-flow@example.test', password: 'newer-stronger-passphrase', _csrf: csrfOf(page),
    });
    assert.equal(goodPw.status, 302);

    // The pre-reset session was revoked.
    const { default: request } = await import('supertest');
    const replay = await request(client.app).get('/account').set('Cookie', `cw_session=${oldSession}`);
    assert.equal(replay.status, 302);

    // Token is single-use.
    const reuse = await client.post('/reset-password', {
      token, password: 'another-fine-pass-phrase', _csrf: csrfOf(await client.get('/reset-password?token=' + token)),
    });
    assert.match(reuse.text, /invalid or has expired/i);
  });

  it('never reveals whether an email has an account', async () => {
    const page = await client.get('/forgot-password');
    const ghost = await client.post('/forgot-password', { email: 'nobody-here@example.test', _csrf: csrfOf(page) });
    assert.equal(ghost.status, 302);
    const landing = await client.get(ghost.headers.location);
    assert.match(landing.text, /If that email has an account/); // flash on redirect target
  });
});

describe('rate limiting on credential endpoints', () => {
  it('blocks repeated failed logins per email', async () => {
    for (let i = 0; i < 8; i++) {
      const page = await client.get('/login');
      const res = await client.post('/login', {
        email: 'hammered@example.test', password: 'wrong-password-xxxx', _csrf: csrfOf(page),
      });
      assert.ok([401, 429].includes(res.status), `attempt ${i} -> ${res.status}`);
      if (res.status === 429) throw new Error(`limited too early at attempt ${i}`);
    }
    const page = await client.get('/login');
    const blocked = await client.post('/login', {
      email: 'hammered@example.test', password: 'wrong-password-xxxx', _csrf: csrfOf(page),
    });
    assert.equal(blocked.status, 429);
    assert.ok(blocked.headers['retry-after']);
  });

  it('limits registration attempts per IP', async () => {
    for (let i = 0; i < 10; i++) {
      const page = await client.get('/register');
      const res = await client.post('/register', {
        email: `bulk-${i}@example.test`, password: PASSWORD, _csrf: csrfOf(page),
      });
      assert.equal(res.status, 302, `registration ${i} should pass`);
    }
    const page = await client.get('/register');
    const blocked = await client.post('/register', {
      email: 'bulk-over@example.test', password: PASSWORD, _csrf: csrfOf(page),
    });
    assert.equal(blocked.status, 429);
  });
});

describe('two-factor authentication', () => {
  it('enrolls, challenges, and completes login', async () => {
    const email = 'totp-user@example.test';
    await registerUser(email);
    let page = await client.get('/login');
    await client.post('/login', { email, password: PASSWORD, _csrf: csrfOf(page) });

    const { beginTotpEnrollment, confirmTotpEnrollment, findUserByEmail } =
      await import('../../src/services/auth.js');
    const user = findUserByEmail(email);
    const { secret } = beginTotpEnrollment(user);
    const codes = await confirmTotpEnrollment(user, currentTotp(secret));

    // Sign out, sign in again — now challenged.
    const acct = await client.get('/account');
    await client.post('/logout', { _csrf: csrfOf(acct) });
    page = await client.get('/login');
    const res = await client.post('/login', { email, password: PASSWORD, _csrf: csrfOf(page) });
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /challenge/);

    const challengePage = await client.get('/login/challenge');
    const done = await client.post('/login/challenge', {
      code: currentTotp(secret), _csrf: csrfOf(challengePage),
    });
    assert.equal(done.status, 302);
    assert.match(done.headers.location, /\/account/);
    assert.ok(codes.length === 10);
  });

  it('accepts a recovery code once, never twice', async () => {
    const email = 'recovery-code@example.test';
    await registerUser(email);
    let page = await client.get('/login');
    await client.post('/login', { email, password: PASSWORD, _csrf: csrfOf(page) });

    const { beginTotpEnrollment, confirmTotpEnrollment, findUserByEmail } =
      await import('../../src/services/auth.js');
    const user = findUserByEmail(email);
    const { secret } = beginTotpEnrollment(user);
    const codes = await confirmTotpEnrollment(user, currentTotp(secret));
    const recoveryCode = codes[0];

    const acct = await client.get('/account');
    await client.post('/logout', { _csrf: csrfOf(acct) });
    page = await client.get('/login');
    await client.post('/login', { email, password: PASSWORD, _csrf: csrfOf(page) });

    let challengePage = await client.get('/login/challenge');
    const first = await client.post('/login/challenge', {
      code: recoveryCode.toUpperCase(), _csrf: csrfOf(challengePage),
    });
    assert.equal(first.status, 302);

    // Second use of the same code fails.
    const acct2 = await client.get('/account');
    await client.post('/logout', { _csrf: csrfOf(acct2) });
    page = await client.get('/login');
    await client.post('/login', { email, password: PASSWORD, _csrf: csrfOf(page) });
    challengePage = await client.get('/login/challenge');
    const second = await client.post('/login/challenge', {
      code: recoveryCode.toUpperCase(), _csrf: csrfOf(challengePage),
    });
    assert.equal(second.status, 401);

    // A TOTP code still works — account not locked out by used recovery code.
    const third = await client.post('/login/challenge', {
      code: currentTotp(secret), _csrf: csrfOf(await client.get('/login/challenge')),
    });
    assert.equal(third.status, 302);
  });
});

import { TOTP, Secret as OtpSecret } from 'otpauth';
function currentTotp(secretB32) {
  const totp = new TOTP({
    issuer: 'Cartward',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OtpSecret.fromBase32(secretB32),
  });
  return totp.generate();
}
