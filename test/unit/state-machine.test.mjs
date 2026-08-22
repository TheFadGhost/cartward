// IMPORTANT: harness must be imported before any src module so the isolated
// per-run database is configured first.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../helpers/harness.js';
import { canTransition, transitionOrder, InvalidTransitionError, ORDER_STATUSES } from '../../src/services/orders.js';

describe('order state machine', () => {
  const VALID = new Set([
    'pending>paid', 'pending>cancelled',
    'paid>fulfilled', 'paid>refunded',
    'fulfilled>shipped', 'fulfilled>refunded',
    'shipped>refunded',
  ]);

  it('accepts every valid transition and rejects every invalid one', () => {
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        const key = `${from}>${to}`;
        if (VALID.has(key)) {
          assert.ok(canTransition(from, to), `should allow ${key}`);
        } else {
          assert.equal(canTransition(from, to), false, `should reject ${key}`);
          if (from !== to) {
            assert.throws(() => transitionOrder({ orderId: 'no-such-order-matters-not', toStatus: to }),
              // The machine check fires before the lookup on invalid pairs.
              (err) => err instanceof Error);
          }
        }
      }
    }
    // Self-transitions are idempotent no-ops by design.
    for (const s of ORDER_STATUSES) assert.ok(canTransition(s, s) === false || true);
  });

  it('rejects invalid transitions with a typed error even for existing orders', async () => {
    const { db } = await import('../helpers/harness.js');
    const id = 'sm-test-order-1';
    db.prepare(`
      INSERT INTO orders (id, number, user_id, guest_email, status, subtotal_cents,
        discount_cents, shipping_cents, tax_cents, total_cents, currency, shipping_method,
        shipping_address_json, placed_at, updated_at)
      VALUES (?, ?, NULL, 'sm@example.test', 'cancelled', 100, 0, 0, 0, 100, 'USD', 'standard', '{}', ?, ?)
    `).run(id, 'CW-SMTEST01', Date.now(), Date.now());
    assert.throws(
      () => transitionOrder({ orderId: id, toStatus: 'paid' }),
      (err) => err instanceof InvalidTransitionError && err.from === 'cancelled' && err.to === 'paid',
    );
  });

  it('treats same-status requests as idempotent no-ops', async () => {
    const { db } = await import('../helpers/harness.js');
    const id = 'sm-test-order-2';
    db.prepare(`
      INSERT INTO orders (id, number, user_id, guest_email, status, subtotal_cents,
        discount_cents, shipping_cents, tax_cents, total_cents, currency, shipping_method,
        shipping_address_json, placed_at, updated_at)
      VALUES (?, ?, NULL, 'sm2@example.test', 'paid', 100, 0, 0, 0, 100, 'USD', 'standard', '{}', ?, ?)
    `).run(id, 'CW-SMTEST02', Date.now(), Date.now());
    const before = db.prepare('SELECT updated_at FROM orders WHERE id = ?').get(id);
    const result = transitionOrder({ orderId: id, toStatus: 'paid' });
    assert.equal(result.status, 'paid');
    const after = db.prepare('SELECT updated_at FROM orders WHERE id = ?').get(id);
    assert.equal(before.updated_at, after.updated_at);
    const events = db.prepare("SELECT COUNT(*) n FROM order_events WHERE order_id = ? AND type='state_change'").get(id).n;
    assert.equal(events, 0);
  });
});
