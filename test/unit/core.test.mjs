import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { formatMoney, parseMoneyToCents, percentOf, bpOf } from '../../src/lib/money.js';
import { randomToken, sha256, timingSafeEqual, hmacHex } from '../../src/lib/tokens.js';
import { rateLimit } from '../../src/lib/rate-limit.js';
import { validatePassword } from '../../src/services/auth.js';

describe('money', () => {
  it('formats cents as USD with tabular-consistent output', () => {
    assert.equal(formatMoney(0), '$0.00');
    assert.equal(formatMoney(1999), '$19.99');
    assert.equal(formatMoney(123456789), '$1,234,567.89');
  });
  it('rejects non-integers', () => {
    assert.throws(() => formatMoney(19.99));
  });
  it('parses user input to cents', () => {
    assert.equal(parseMoneyToCents('19.99'), 1999);
    assert.equal(parseMoneyToCents('$19.99'), 1999);
    assert.equal(parseMoneyToCents('5'), 500);
    assert.equal(parseMoneyToCents('-1'), null);
    assert.equal(parseMoneyToCents('1.999'), null);
    assert.equal(parseMoneyToCents('abc'), null);
  });
  it('percent discount rounds half-up in integer math', () => {
    assert.equal(percentOf(1999, 10), 200); // 199.9 -> 200
    assert.equal(percentOf(1000, 10), 100);
    assert.equal(percentOf(1250, 33), 413); // 412.5 -> 413
    assert.equal(percentOf(999, 15), 150); // 149.85 -> 150
  });
  it('basis-point tax rounds half-up', () => {
    assert.equal(bpOf(10000, 700), 700);
    assert.equal(bpOf(1999, 725), 145); // 144.9275 -> 145
    assert.equal(bpOf(1050, 825), 87); // 86.625 -> 87
  });
});

describe('tokens', () => {
  it('generates unique url-safe tokens', () => {
    const seen = new Set();
    for (let i = 0; i < 100; i++) {
      const t = randomToken();
      assert.match(t, /^[A-Za-z0-9_-]+$/);
      seen.add(t);
    }
    assert.equal(seen.size, 100);
  });
  it('hashes deterministically and compares timing-safely', () => {
    assert.equal(sha256('a'), sha256('a'));
    assert.notEqual(sha256('a'), sha256('b'));
    assert.ok(timingSafeEqual(hmacHex('s', 'v'), hmacHex('s', 'v')));
    assert.ok(!timingSafeEqual(hmacHex('s', 'v'), hmacHex('s2', 'v')));
  });
});

describe('rate limiter', () => {
  beforeEach(() => import('../../src/db/index.js'));
  it('allows up to limit then blocks until window passes', () => {
    const key = `test-${Math.random()}`;
    for (let i = 0; i < 3; i++) {
      assert.ok(rateLimit('test', key, 3, 60_000).allowed);
    }
    const blocked = rateLimit('test', key, 3, 60_000);
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterMs <= 60_000 && blocked.retryAfterMs > 0);
    // Different identity unaffected
    assert.ok(rateLimit('test', key + '-other', 3, 60_000).allowed);
  });
});

describe('password policy', () => {
  it('requires length >= 12', () => {
    assert.equal(validatePassword('short').ok, false);
    assert.equal(validatePassword('a'.repeat(201)).ok, false);
    assert.equal(validatePassword('correct horse battery').ok, true);
    assert.equal(validatePassword('passwordpassword').ok, false); // deny-listed
  });
});
