import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import crypto from 'node:crypto';
import { db } from '../helpers/harness.js';
import { newId } from '../../src/lib/tokens.js';
import { seed } from '../../src/services/seed.mjs';

await seed({ fresh: true });

const WORKER_CODE = `
import { Worker, parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';
const mod = (p) => import(pathToFileURL(path.join(process.cwd(), p)).href);
const { db } = await mod('src/db/index.js');
const { placeOrder } = await mod('src/services/checkout.js');
const { newId } = await mod('src/lib/tokens.js');

// Each worker builds its own guest cart for the contended variant, then
// attempts placement through the normal service path.
const cartId = newId();
db.prepare(\`
  INSERT INTO carts (id, user_id, cookie_token_hash, status, created_at, updated_at, expires_at)
  VALUES (?, NULL, NULL, 'active', ?, ?, ? + 86400000)
\`).run(cartId, Date.now(), Date.now(), Date.now());
db.prepare(\`
  INSERT INTO cart_items (id, cart_id, variant_id, quantity, unit_price_snapshot_cents, added_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
\`).run(newId(), cartId, workerData.variantId, 1, workerData.priceCents, Date.now(), Date.now());
db.prepare("UPDATE carts SET checkout_address_json = ?, checkout_shipping_method = 'standard', idempotency_key = ? WHERE id = ?")
  .run(JSON.stringify({
    name: 'Race Runner', line1: '1 Contention Way', line2: '', city: 'Springfield',
    region: 'OR', postal_code: '97035', country: 'US', email: 'race@example.test',
  }), crypto.randomBytes(16).toString('hex'), cartId);

const cart = db.prepare('SELECT * FROM carts WHERE id = ?').get(cartId);
try {
  const result = placeOrder({ cart, userId: null, idempotencyKey: cart.idempotency_key });
  parentPort.postMessage({ ok: true, orderId: result.order.id });
} catch (err) {
  parentPort.postMessage({ ok: false, code: err.code || 'error', message: err.message });
}
`;

function runWorker(variantId, priceCents) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_CODE, {
      eval: true,
      workerData: { variantId, priceCents },
    });
    worker.on('message', resolve);
    worker.on('error', reject);
    worker.on('exit', (code) => { if (code !== 0) reject(new Error(`worker exited ${code}`)); });
  });
}

describe('inventory under concurrency', () => {
  before(() => {
    // Keep reservation TTLs long enough for the race.
    process.env.RESERVATION_TTL_MS = String(10 * 60 * 1000);
  });

  it('exactly one of many simultaneous checkouts wins the last unit', async () => {
    const variant = db.prepare(`
      SELECT v.id, v.price_cents FROM variants v JOIN products p ON p.id = v.product_id
      WHERE p.status='active' AND v.backorderable = 0 LIMIT 1
    `).get();
    db.prepare('UPDATE variants SET stock = 1, reserved = 0 WHERE id = ?').run(variant.id);

    const results = await Promise.all(Array.from({ length: 8 }, () => runWorker(variant.id, variant.price_cents)));
    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);

    assert.equal(winners.length, 1, `expected exactly 1 winner, got ${winners.length}: ${JSON.stringify(results)}`);
    assert.ok(losers.every((l) => l.code === 'out_of_stock'), `all losers must be out_of_stock, got ${JSON.stringify(losers)}`);

    // Invariants: no overselling, no phantom reservations.
    const row = db.prepare('SELECT stock, reserved FROM variants WHERE id = ?').get(variant.id);
    assert.equal(row.reserved, 1);
    assert.equal(row.stock - row.reserved, 0);

    const resv = db.prepare(`
      SELECT status, COUNT(*) n FROM reservations WHERE variant_id = ? GROUP BY status
    `).all(variant.id);
    assert.deepEqual(resv, [{ status: 'held', n: 1 }]);
  });

  it('sells exactly the available units under contention, never more', async () => {
    const variant = db.prepare(`
      SELECT v.id, v.price_cents FROM variants v JOIN products p ON p.id = v.product_id
      WHERE p.status='active' AND v.backorderable = 0 AND v.product_id != (
        SELECT product_id FROM variants WHERE id = (SELECT id FROM variants LIMIT 1)
      ) LIMIT 1
    `).get();
    db.prepare('UPDATE variants SET stock = 3, reserved = 0 WHERE id = ?').run(variant.id);

    const results = await Promise.all(Array.from({ length: 10 }, () => runWorker(variant.id, variant.price_cents)));
    const winners = results.filter((r) => r.ok);
    assert.equal(winners.length, 3);
    assert.ok(results.filter((r) => !r.ok).every((l) => l.code === 'out_of_stock'));

    const row = db.prepare('SELECT stock, reserved FROM variants WHERE id = ?').get(variant.id);
    assert.equal(row.stock, 3);          // nothing committed yet (still pending payment)
    assert.equal(row.reserved, 3);       // all three units held
    assert.equal(row.stock - row.reserved, 0);
  });

  it('releases stock when winning orders are cancelled', async () => {
    const variant = db.prepare(`
      SELECT v.id FROM variants v JOIN products p ON p.id = v.product_id
      WHERE p.status='active' AND v.backorderable = 0 LIMIT 1
    `).get();
    db.prepare('UPDATE variants SET stock = 2, reserved = 2 WHERE id = ?').run(variant.id);
    const orderId = newId();
    db.prepare(`
      INSERT INTO orders (id, number, user_id, guest_email, status, subtotal_cents,
        discount_cents, shipping_cents, tax_cents, total_cents, currency, shipping_method,
        shipping_address_json, placed_at, updated_at)
      VALUES (?, ?, NULL, 'c@example.test', 'pending', 100, 0, 0, 0, 100, 'USD', 'standard', '{}', ?, ?)
    `).run(orderId, `CW-${crypto.randomBytes(4).toString('hex').toUpperCase()}`, Date.now(), Date.now());
    // Model a real checkout's held reservations.
    db.prepare(`
      INSERT INTO reservations (id, order_id, variant_id, quantity, status, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, 1, 'held', ? + 600000, ?, ?), (?, ?, ?, 1, 'held', ? + 600000, ?, ?)
    `).run(newId(), orderId, variant.id, Date.now(), Date.now(), Date.now(),
      newId(), orderId, variant.id, Date.now(), Date.now(), Date.now());

    const { transitionOrder } = await import('../../src/services/orders.js');
    transitionOrder({ orderId, toStatus: 'cancelled', actor: 'test', detail: 'release check' });
    const row = db.prepare('SELECT reserved FROM variants WHERE id = ?').get(variant.id);
    assert.equal(row.reserved, 0);
  });
});
