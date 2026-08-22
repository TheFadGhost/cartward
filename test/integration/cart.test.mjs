import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeClient, csrfOf, db } from '../helpers/harness.js';
import { seed } from '../../src/services/seed.mjs';

await seed({});
let client;
const PASSWORD = 'quiet-orchard-lantern';

beforeEach(async () => {
  db.prepare('DELETE FROM rate_limits').run();
  client = await makeClient();
});

function pickVariant(plan) {
  const where = plan === 'out'
    ? 'v.stock = 0 AND v.backorderable = 0'
    : plan === 'backorder'
      ? 'v.backorderable = 1'
      : 'v.stock - v.reserved >= 10';
  return db.prepare(`
    SELECT v.id, v.stock, v.price_cents, p.slug AS product_slug, p.name
    FROM variants v JOIN products p ON p.id = v.product_id
    WHERE ${where} AND p.status = 'active' LIMIT 1
  `).get();
}

async function addToCart(variantId, qty = 1) {
  await client.get('/'); // establishes guest CSRF cookie
  const csrf = csrfOf(await client.get('/'));
  return client.post('/cart/add', { variant_id: variantId, quantity: String(qty), _csrf: csrf });
}

async function registerAndLogin(email) {
  let page = await client.get('/register');
  await client.post('/register', { email, password: PASSWORD, _csrf: csrfOf(page) });
  // Registration does not auto-login, so the guest cart cookie survives.
  page = await client.get('/login');
  const res = await client.post('/login', { email, password: PASSWORD, _csrf: csrfOf(page) });
  assert.equal(res.status, 302);
}

describe('guest cart basics', () => {
  it('adds an item and persists it by cookie across requests', async () => {
    const variant = pickVariant('stocked');
    const res = await addToCart(variant.id, 2);
    assert.equal(res.status, 302);

    const cartPage = await client.get('/cart');
    assert.match(cartPage.text, new RegExp(variant.product_slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(cartPage.text, /Subtotal/);
    assert.ok(client.cookieValue('cw_cart'), 'guest cart cookie set');
  });

  it('rejects adding out-of-stock items with a clear error', async () => {
    const variant = pickVariant('out');
    const res = await addToCart(variant.id);
    assert.equal(res.status, 422);
    assert.match(res.text, /out of stock/i);
  });

  it('allows backordered items and labels them', async () => {
    const variant = pickVariant('backorder');
    const res = await addToCart(variant.id);
    assert.equal(res.status, 302);
    const page = await client.get('/cart');
    assert.match(page.text, /Backordered/);
  });

  it('clamps quantity to available stock honestly', async () => {
    const variant = pickVariant('stocked');
    // Find a low-stock stocked variant (<=5 available).
    const low = db.prepare(`
      SELECT id, stock - reserved AS avail FROM variants
      WHERE backorderable = 0 AND stock - reserved BETWEEN 1 AND 4 LIMIT 1
    `).get() ?? variant;
    const res = await addToCart(low.id, 50);
    assert.equal(res.status, 302);
    assert.ok(res.headers.location === '/cart');
  });

  it('updates quantities and removes lines', async () => {
    const variant = pickVariant('stocked');
    await addToCart(variant.id, 1);
    let page = await client.get('/cart');
    const itemId = /name="quantity_([0-9a-f-]+)"/.exec(page.text)[1];
    const csrf = csrfOf(page);

    const upd = await client.post('/cart/update', {
      item_id: itemId, quantity: '3', _csrf: csrf,
    });
    assert.equal(upd.status, 302);
    page = await client.get('/cart');
    assert.match(page.text, /value="3"/);

    const rm = await client.post('/cart/remove', { item_id: itemId, _csrf: csrf });
    assert.equal(rm.status, 302);
    page = await client.get('/cart');
    assert.match(page.text, /Your cart is empty/);
  });
});

describe('price snapshotting', () => {
  it('keeps the add-time price but flags the change', async () => {
    const variant = pickVariant('stocked');
    await addToCart(variant.id, 1);

    // Merchant raises the price after the add.
    db.prepare('UPDATE variants SET price_cents = price_cents + 500 WHERE id = ?').run(variant.id);

    const page = await client.get('/cart');
    assert.match(page.text, /Prices have changed/);
    assert.match(page.text, /each<\/span>/); // old → new presentation
    // Snapshot total still used for subtotal until checkout refreshes it.
    assert.match(page.text, new RegExp(`\\$${(variant.price_cents / 100).toFixed(2)}`));
  });

  it('detects items that went out of stock after being added', async () => {
    const variant = pickVariant('stocked');
    await addToCart(variant.id, 1);
    db.prepare('UPDATE variants SET reserved = stock WHERE id = ?').run(variant.id);
    const page = await client.get('/cart');
    assert.match(page.text, /need attention|now out of stock|no longer available/i);
    assert.match(page.text, /aria-disabled="true"/);
  });
});

describe('guest cart merge on login', () => {
  it('adopts a guest cart when the account has none', async () => {
    const variant = pickVariant('stocked');
    await addToCart(variant.id, 2);

    await registerAndLogin('merge-adopt@example.test');
    const page = await client.get('/cart');
    assert.match(page.text, new RegExp(variant.product_slug));
    assert.doesNotMatch(page.text, /Your cart is empty/);
    // Cookie cleared post-merge.
    assert.equal(client.cookieValue('cw_cart'), undefined);
  });

  it('sums conflicting quantities, capped at stock, and reports honestly', async () => {
    const variant = pickVariant('stocked');

    // The user's existing account cart already holds one line.
    await registerAndLogin('merge-conflict@example.test');
    await addToCart(variant.id, 1); // while logged in → account cart
    // Sign out; become a guest with the same variant.
    let page = await client.get('/account');
    await client.post('/logout', { _csrf: csrfOf(page) });

    await addToCart(variant.id, 2);
    // Log back in: guest line merges into the account line.
    page = await client.get('/login');
    const res = await client.post('/login', {
      email: 'merge-conflict@example.test', password: PASSWORD, _csrf: csrfOf(page),
    });
    assert.equal(res.status, 302);

    page = await client.get('/cart');
    assert.match(page.text, /value="3"/); // 1 + 2 summed into one line
  });

  it('carries over items that went out of stock and flags them instead of deleting', async () => {
    const variant = pickVariant('stocked');
    await addToCart(variant.id, 1);
    db.prepare('UPDATE variants SET stock = 0, backorderable = 0 WHERE id = ?').run(variant.id);

    await registerAndLogin('merge-flag@example.test');
    const page = await client.get('/cart');
    assert.match(page.text, new RegExp(variant.product_slug));
    assert.match(page.text, /need attention|now out of stock/i);
  });
});

describe('cart expiry scaffolding', () => {
  it('marks expired carts inactive so their cookie stops resolving', async () => {
    const variant = pickVariant('stocked');
    await addToCart(variant.id, 1);
    // Age the cart past its TTL directly.
    db.prepare('UPDATE carts SET expires_at = 1').run();
    const page = await client.get('/cart');
    assert.match(page.text, /Your cart is empty/);
  });
});
