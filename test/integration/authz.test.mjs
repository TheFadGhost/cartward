import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeClient, listen, csrfOf, db } from '../helpers/harness.js';
import { seed } from '../../src/services/seed.mjs';

await seed({ fresh: true });
const { close } = await listen();

let client;
beforeEach(async () => {
  db.prepare('DELETE FROM rate_limits').run();
  client = await makeClient();
});
after(async () => { await close(); });

const ADMIN_PATHS = [
  '/admin',
  '/admin/orders',
  '/admin/products',
  '/admin/products/new',
  '/admin/customers',
  '/admin/audit-log',
  '/admin/mailbox',
  '/admin/orders.csv',
];

async function loginAs(email, password) {
  const page = await client.get('/login');
  const res = await client.post('/login', { email, password, _csrf: csrfOf(page) });
  assert.equal(res.status, 302);
}

describe('authorization matrix — admin surface', () => {
  it('anonymous users are redirected to login from every admin path', async () => {
    for (const p of ADMIN_PATHS) {
      const res = await client.get(p);
      assert.ok([302, 303].includes(res.status), `${p} -> ${res.status}`);
      assert.match(res.headers.location, /\/login/, `${p} should redirect to /login`);
    }
  });

  it('a valid but unprivileged session is denied on every admin path (403)', async () => {
    await loginAs('casey@example.test', 'casey-cart-demo-pass');
    for (const p of ADMIN_PATHS) {
      const res = await client.get(p);
      assert.equal(res.status, 403, `${p} must be 403 for a customer`);
      assert.doesNotMatch(res.text, /Dashboard|Audit log table|Customers<\/h1>/);
    }
  });

  it('a customer cannot mutate admin resources even with direct POSTs', async () => {
    await loginAs('riley@example.test', 'riley-cart-demo-pass');
    const product = db.prepare('SELECT id FROM products LIMIT 1').get();
    const variant = db.prepare('SELECT id FROM variants LIMIT 1').get();

    for (const [method, path] of [
      ['POST', '/admin/products/new'],
      ['POST', `/admin/products/${product.id}`],
      ['POST', `/admin/products/${product.id}/variants`],
      ['POST', `/admin/variants/${variant.id}/adjust`],
      ['GET', '/admin/orders.csv'],
    ]) {
      const home = await client.get('/');
      const res = method === 'POST'
        ? await client.post(path, { _csrf: csrfOf(home) })
        : await client.get(path);
      assert.ok([303, 403].includes(res.status), `${method} ${path} -> ${res.status}`);
      if (res.status === 303) {
        // Redirected to login means the mutation never executed.
        assert.match(res.headers.location, /login/);
      }
    }
    // Nothing was mutated.
    const audits = db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action LIKE 'inventory%' OR action LIKE 'product%'").get().n;
    assert.equal(audits, 0);
  });

  it('pending-2FA sessions cannot reach the admin either', async () => {
    // casey has no TOTP; simulate by creating a pending session directly.
    const { createSession } = await import('../../src/services/sessions.js');
    const user = db.prepare("SELECT id FROM users WHERE email='casey@example.test'").get();
    const { token } = createSession(user.id, { pending2fa: true });
    client.clearCookies();
    const { default: request } = await import('supertest');
    const res = await request(client.app).get('/admin').set('Cookie', `cw_session=${token}`).redirects(0);
    assert.ok([302, 303].includes(res.status));
    assert.match(res.headers.location, /login/);
  });
});

describe('authorization matrix — other-user resources', () => {
  let orderA;

  it('users cannot read or cancel each other\'s orders (IDOR)', async () => {
    // casey places an order.
    await loginAs('casey@example.test', 'casey-cart-demo-pass');
    const variant = db.prepare(`
      SELECT v.id FROM variants v JOIN products p ON p.id = v.product_id WHERE v.stock >= 10 LIMIT 1
    `).get();
    const page = await client.get('/');
    await client.post('/cart/add', { variant_id: variant.id, quantity: '1', _csrf: csrfOf(page) });
    await client.post('/checkout/address', {
      name: 'Casey Example', email: 'casey@example.test', line1: '42 Example Lane',
      line2: '', city: 'Springfield', region: 'NY', postal_code: '12345', country: 'US',
      _csrf: csrfOf(await client.get('/checkout')),
    });
    await client.post('/checkout/delivery', { shipping_method: 'standard', _csrf: csrfOf(await client.get('/checkout/delivery')) });
    const review = await client.get('/checkout/review');
    const placed = await client.post('/checkout/place', {
      _ik: /name="_ik" value="([0-9a-f]+)"/.exec(review.text)[1], _csrf: csrfOf(review),
    });
    orderA = /pay\/([0-9a-f-]+)/.exec(placed.headers.location)[1];

    // Switch to riley and attack casey's order.
    const acctPage = await client.get('/account');
    await client.post('/logout', { _csrf: csrfOf(acctPage) });
    await loginAs('riley@example.test', 'riley-cart-demo-pass');

    const view = await client.get(`/orders/${orderA}`);
    assert.equal(view.status, 404, 'another user\'s order must not render');

    const cancel = await client.post(`/orders/${orderA}/cancel`, { _csrf: csrfOf(await client.get('/')) });
    assert.ok([403, 404].includes(cancel.status), `cancel as other user -> ${cancel.status}`);
    assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(orderA).status, 'pending');
  });

  it('payment polling requires the signed token', async () => {
    const res = await client.get(`/orders/${orderA}/status.json`);
    assert.equal(res.status, 403);
  });
});

describe('admin flows (as admin)', () => {
  async function loginAdmin() {
    await loginAs('admin@cartward.test', 'cartward-admin-demo');
  }

  it('dashboard renders with chart and stats', async () => {
    await loginAdmin();
    const res = await client.get('/admin');
    assert.equal(res.status, 200);
    assert.match(res.text, /Orders per day/);
    assert.match(res.text, /p50/);
  });

  it('order list search finds an order by number and CSV export streams', async () => {
    await loginAdmin();
    const anyOrder = db.prepare("SELECT number FROM orders WHERE status != 'pending' LIMIT 1").get();
    const res = await client.get(`/admin/orders?q=${encodeURIComponent(anyOrder.number)}`);
    assert.match(res.text, new RegExp(anyOrder.number));
    assert.match(res.text, /shown/);

    const csv = await client.get('/admin/orders.csv');
    assert.match(csv.headers['content-type'], /csv/);
    assert.ok(csv.text.startsWith('number,status'));
  });

  it('fulfil then ship a paid order through validated transitions', async () => {
    await loginAdmin();
    // Find a paid seed order; if none, make one pending->paid first.
    let paid = db.prepare("SELECT * FROM orders WHERE status = 'paid' ORDER BY placed_at DESC LIMIT 1").get();
    if (!paid) {
      paid = db.prepare("SELECT * FROM orders WHERE status = 'pending' ORDER BY placed_at DESC LIMIT 1").get();
      const stockBefore = db.prepare(`
        SELECT v.stock - v.reserved AS a FROM variants v
        JOIN order_lines l ON l.variant_id = v.id WHERE l.order_id = ? LIMIT 1
      `).get(paid.id).a;
      const detail = await client.get(`/admin/orders/${paid.id}`);
      await client.post(`/admin/orders/${paid.id}/transition`, {
        to_status: 'paid', note: 'test settle', _csrf: csrfOf(detail),
      });
      const stockAfter = db.prepare(`
        SELECT v.stock - v.reserved AS a, v.stock AS s, v.reserved AS r FROM variants v
        JOIN order_lines l ON l.variant_id = v.id WHERE l.order_id = ? LIMIT 1
      `).get(paid.id);
      assert.equal(stockAfter.a, stockBefore - 1, 'commit decrements availability once');
      assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(paid.id).status, 'paid');
      paid = db.prepare('SELECT * FROM orders WHERE id = ?').get(paid.id);
    }

    const detail = await client.get(`/admin/orders/${paid.id}`);
    await client.post(`/admin/orders/${paid.id}/transition`, { to_status: 'fulfilled', _csrf: csrfOf(detail) });
    assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(paid.id).status, 'fulfilled');

    const d2 = await client.get(`/admin/orders/${paid.id}`);
    await client.post(`/admin/orders/${paid.id}/transition`, { to_status: 'cancelled', _csrf: csrfOf(d2) });
    assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(paid.id).status, 'fulfilled',
      'invalid transition must be rejected');
  });

  it('refund flow completes via webhook, restocks, writes audit rows', async () => {
    await loginAdmin();
    // Ensure we have a paid order with a settled payment.
    let target = db.prepare(`
      SELECT o.*, p.provider_ref FROM orders o
      JOIN payments p ON p.order_id = o.id AND p.status = 'succeeded'
      WHERE o.status IN ('paid','fulfilled','shipped') LIMIT 1
    `).get();
    if (!target) {
      const pending = db.prepare("SELECT * FROM orders WHERE status='pending' LIMIT 1").get();
      const { mockProvider } = await import('../../src/services/payments/mock.js');
      mockProvider.createPayment({ order: { id: pending.id }, totalCents: pending.total_cents, cardNumber: '4242424242424242' });
      for (let i = 0; i < 60 && db.prepare('SELECT status FROM orders WHERE id=?').get(pending.id).status !== 'paid'; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      target = db.prepare(`
        SELECT o.*, pay.provider_ref FROM orders o
        JOIN payments pay ON pay.order_id = o.id AND pay.status = 'succeeded'
        WHERE o.id = ?
      `).get(pending.id);
    }
    const variantStockBefore = db.prepare(`
      SELECT v.stock FROM variants v JOIN order_lines l ON l.variant_id = v.id WHERE l.order_id = ? LIMIT 1
    `).get(target.id).stock;

    const detail = await client.get(`/admin/orders/${target.id}`);
    const refund = await client.post(`/admin/orders/${target.id}/refund`, { _csrf: csrfOf(detail) });
    assert.equal(refund.status, 302);

    for (let i = 0; i < 80 && db.prepare('SELECT status FROM orders WHERE id=?').get(target.id).status !== 'refunded'; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(db.prepare('SELECT status FROM orders WHERE id=?').get(target.id).status, 'refunded');

    const stockAfter = db.prepare(`
      SELECT v.stock FROM variants v JOIN order_lines l ON l.variant_id = v.id WHERE l.order_id = ? LIMIT 1
    `).get(target.id).stock;
    assert.equal(stockAfter, variantStockBefore + 1, 'refund restocks the shelf');

    const audits = db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action LIKE 'order.refund%'").get().n;
    assert.ok(audits >= 1);
  });

  it('inventory adjustments are audited with reason', async () => {
    await loginAdmin();
    const variant = db.prepare(`
      SELECT v.id, p.id AS pid, v.stock FROM variants v JOIN products p ON p.id = v.product_id LIMIT 1
    `).get();
    const detail = await client.get(`/admin/products/${variant.pid}`);
    await client.post(`/admin/variants/${variant.id}/adjust`, {
      delta: '+5', reason: 'cycle count correction', _csrf: csrfOf(detail),
    });
    const row = db.prepare('SELECT stock FROM variants WHERE id = ?').get(variant.id);
    assert.equal(row.stock, variant.stock + 5);
    const entry = db.prepare(`
      SELECT after_json FROM audit_log WHERE action = 'inventory.adjust' AND entity_id = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(variant.id);
    assert.match(entry.after_json, /cycle count correction/);
  });
});

describe('health endpoints', () => {
  it('healthz and readyz respond OK', async () => {
    const hz = await client.get('/healthz');
    assert.equal(hz.status, 200);
    const rz = await client.get('/readyz');
    assert.equal(rz.status, 200);
    assert.equal(JSON.parse(rz.text).ok, true);
  });
});
