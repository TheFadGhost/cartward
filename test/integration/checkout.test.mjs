import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeClient, listen, csrfOf, db } from '../helpers/harness.js';
import { seed } from '../../src/services/seed.mjs';

await seed({ fresh: true });
const { close, baseUrl } = await listen();

let client;
beforeEach(async () => {
  db.prepare('DELETE FROM rate_limits').run();
  client = await makeClient();
});
after(async () => { await close(); });

function pickStockedVariant(minAvail = 5) {
  return db.prepare(`
    SELECT v.id, v.price_cents, v.stock, p.slug AS product_slug
    FROM variants v JOIN products p ON p.id = v.product_id
    WHERE v.backorderable = 0 AND v.stock - v.reserved >= ?
      AND p.status = 'active' LIMIT 1
  `).get(minAvail);
}

async function guestCheckoutToReview(variantId, qty = 1) {
  const page = await client.get('/');
  await client.post('/cart/add', { variant_id: variantId, quantity: String(qty), _csrf: csrfOf(page) });
  const addrPage = await client.get('/checkout');
  const res = await client.post('/checkout/address', {
    name: 'Casey Example', email: 'guest-checkout@example.test',
    line1: '42 Example Lane', line2: '', city: 'Springfield',
    region: 'NY', postal_code: '12345', country: 'US',
    _csrf: csrfOf(addrPage),
  });
  assert.equal(res.status, 302);
  await client.get('/checkout/delivery');
  const delivRes = await client.post('/checkout/delivery', { shipping_method: 'standard', _csrf: csrfOf(await client.get('/checkout/delivery')) });
  assert.equal(delivRes.status, 302);
  const review = await client.get('/checkout/review');
  return review;
}

async function placeOrderFromReview(review) {
  const ik = /name="_ik" value="([0-9a-f]+)"/.exec(review.text)[1];
  return client.post('/checkout/place', { _ik: ik, _csrf: csrfOf(review) });
}

function waitForOrderStatus(orderId, statuses, timeoutMs = 8000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const order = db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId);
      if (order && statuses.includes(order.status)) return resolve(order.status);
      if (Date.now() - start > timeoutMs) return reject(new Error(`Timed out waiting for ${statuses}; last=${order?.status}`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

describe('guest checkout end to end (sandbox success)', () => {
  it('places an order, pays, reserves then commits stock, emails confirmation', async () => {
    const variant = pickStockedVariant();
    const availBefore = variant.stock;
    const review = await guestCheckoutToReview(variant.id, 1);
    assert.match(review.text, /Review your order/);
    assert.match(review.text, /Place order/);

    const res = await placeOrderFromReview(review);
    assert.equal(res.status, 302);
    const orderId = /\/checkout\/pay\/([0-9a-f-]+)/.exec(res.headers.location)[1];

    // Stock is reserved while pending.
    let row = db.prepare('SELECT stock, reserved FROM variants WHERE id = ?').get(variant.id);
    assert.equal(row.reserved, 1);
    assert.equal(row.stock - row.reserved, availBefore - 1);

    // Pay with the instant-success test card.
    const payPage = await client.get(`/checkout/pay/${orderId}`);
    assert.equal(payPage.status, 200);
    await client.post(`/checkout/pay/${orderId}`, {
      card_number: '4242424242424242',
      _csrf: csrfOf(await client.get(`/checkout/pay/${orderId}`)),
    });

    const status = await waitForOrderStatus(orderId, ['paid']);
    assert.equal(status, 'paid');

    // Reservation committed: physical stock decremented, reservation cleared.
    row = db.prepare('SELECT stock, reserved FROM variants WHERE id = ?').get(variant.id);
    assert.equal(row.stock, availBefore - 1);
    assert.equal(row.reserved, 0);

    // Confirmation email captured.
    const mail = db.prepare(
      "SELECT subject FROM emails_out WHERE to_email = 'guest-checkout@example.test' ORDER BY sent_at DESC LIMIT 1",
    ).get();
    assert.match(mail.subject, /confirmed/);

    // Timeline shows the full honest story.
    const events = db.prepare('SELECT type FROM order_events WHERE order_id = ?').all(orderId).map((e) => e.type);
    assert.ok(events.includes('order_placed'));
    assert.ok(events.includes('state_change'));
  });

  it('declined payment keeps the order pending and allows retry', async () => {
    const variant = pickStockedVariant(10);
    const review = await guestCheckoutToReview(variant.id, 1);
    const res = await placeOrderFromReview(review);
    const orderId = /\/checkout\/pay\/([0-9a-f-]+)/.exec(res.headers.location)[1];

    await client.post(`/checkout/pay/${orderId}`, {
      card_number: '4000000000000002',
      _csrf: csrfOf(await client.get(`/checkout/pay/${orderId}`)),
    });
    const paymentRow = () => db.prepare('SELECT status, failure_reason FROM payments WHERE order_id = ? ORDER BY created_at DESC LIMIT 1').get(orderId);

    let tries = 0;
    while (paymentRow()?.status !== 'failed' && tries++ < 100) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(paymentRow().status, 'failed');

    // Order still pending; stock still reserved.
    const order = db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId);
    assert.equal(order.status, 'pending');
    const v = db.prepare('SELECT reserved FROM variants WHERE id = ?').get(variant.id);
    assert.equal(v.reserved, 1);

    // Failure event recorded on the timeline.
    const ev = db.prepare("SELECT detail FROM order_events WHERE order_id = ? AND type = 'payment_failed'").get(orderId);
    assert.match(ev.detail, /failed/i);

    // Retry succeeds.
    await client.post(`/checkout/pay/${orderId}`, {
      card_number: '4242424242424242',
      _csrf: csrfOf(await client.get(`/checkout/pay/${orderId}`)),
    });
    assert.equal(await waitForOrderStatus(orderId, ['paid']), 'paid');
  });
});

describe('idempotent order submission', () => {
  it('a double-submitted place request creates exactly one order', async () => {
    const variant = pickStockedVariant(20);
    const review = await guestCheckoutToReview(variant.id, 1);
    const ik = /name="_ik" value="([0-9a-f]+)"/.exec(review.text)[1];
    const csrf = csrfOf(review);

    const first = await client.post('/checkout/place', { _ik: ik, _csrf: csrf });
    const second = await client.post('/checkout/place', { _ik: ik, _csrf: csrf });
    assert.equal(first.status, 302);
    assert.equal(second.status, 302);
    assert.equal(first.headers.location, second.headers.location); // same order

    const count = db.prepare('SELECT COUNT(*) n FROM orders WHERE idempotency_key = ?').get(ik).n;
    assert.equal(count, 1);
  });

  it('replaying a spent key returns the same order without creating another', async () => {
    const variant = pickStockedVariant(20);
    const review = await guestCheckoutToReview(variant.id, 1);
    const ik = /name="_ik" value="([0-9a-f]+)"/.exec(review.text)[1];
    const first = await client.post('/checkout/place', { _ik: ik, _csrf: csrfOf(review) });
    assert.equal(first.status, 302);

    // A retried request (same key) hits the dedupe path.
    const replay = await client.post('/checkout/place', { _ik: ik, _csrf: csrfOf(review) });
    assert.equal(replay.headers.location, first.headers.location);
    const total = db.prepare('SELECT COUNT(*) n FROM orders WHERE idempotency_key = ?').get(ik).n;
    assert.equal(total, 1);
  });
});

describe('address validation', () => {
  it('rejects bad addresses field-by-field without losing input', async () => {
    const variant = pickStockedVariant();
    const page = await client.get('/');
    await client.post('/cart/add', { variant_id: variant.id, quantity: '1', _csrf: csrfOf(page) });
    const addrPage = await client.get('/checkout');
    const res = await client.post('/checkout/address', {
      name: 'C', email: 'not-an-email', line1: '', city: '',
      region: 'NYC', postal_code: '12', country: 'US', _csrf: csrfOf(addrPage),
    });
    assert.equal(res.status, 422);
    for (const fragment of ['full recipient name', 'valid email', 'street address', 'Enter a city', 'two-letter state', 'ZIP code']) {
      assert.match(res.text, new RegExp(fragment, 'i'));
    }
    assert.match(res.text, /value="C"/); // input preserved
  });
});

describe('discount codes at checkout', () => {
  it('applies WELCOME10 and reduces the total', async () => {
    const variant = pickStockedVariant();
    const review = await guestCheckoutToReview(variant.id, 1);

    const discRes = await client.post('/checkout/discount', { code: 'WELCOME10', _csrf: csrfOf(review) });
    assert.equal(discRes.status, 302);
    const after = await client.get('/checkout/review');
    assert.match(after.text, /Discount \(WELCOME10\)/);

    // Place and verify the stored money reflects the discount.
    const placed = await client.post('/checkout/place', {
      _ik: /name="_ik" value="([0-9a-f]+)"/.exec(after.text)[1],
      _csrf: csrfOf(after),
    });
    const orderId = /pay\/([0-9a-f-]+)/.exec(placed.headers.location)[1];
    const order = db.prepare('SELECT subtotal_cents, discount_cents FROM orders WHERE id = ?').get(orderId);
    assert.equal(order.discount_cents, Math.trunc((order.subtotal_cents * 10 + 50) / 100));
  });

  it('rejects expired codes with a clear notice', async () => {
    const variant = pickStockedVariant();
    const review = await guestCheckoutToReview(variant.id, 1);
    const res = await client.post('/checkout/discount', { code: 'EXPIRED2024', _csrf: csrfOf(review) });
    const landing = await client.get(res.headers.location);
    assert.match(landing.text, /expired/i);
  });
});

describe('guest order tracking + cancellation', () => {
  it('tracks by number+email and cancels while pending, releasing stock', async () => {
    const variant = pickStockedVariant(3);
    const review = await guestCheckoutToReview(variant.id, 1);
    const placed = await placeOrderFromReview(review);
    const orderId = /pay\/([0-9a-f-]+)/.exec(placed.headers.location)[1];
    const order = db.prepare('SELECT number, status FROM orders WHERE id = ?').get(orderId);

    const availBefore = db.prepare('SELECT stock - reserved AS a FROM variants WHERE id = ?').get(variant.id).a;

    // Wrong email does not reveal the order.
    const wrongPage = await client.get('/orders/track');
    const wrong = await client.post('/orders/track', {
      number: order.number, email: 'wrong@example.test', _csrf: csrfOf(wrongPage),
    });
    assert.match(wrong.text, /No order matches/);

    // Correct email shows the timeline.
    const track = await client.post('/orders/track', {
      number: order.number, email: 'guest-checkout@example.test', _csrf: csrfOf(wrongPage),
    });
    assert.match(track.text, new RegExp(order.number));
    assert.match(track.text, /Awaiting payment|pending/);

    // Guest cancels.
    await client.post(`/orders/${orderId}/cancel`, {
      email: 'guest-checkout@example.test',
      _csrf: csrfOf(await client.get('/orders/track')),
    });
    assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId).status, 'cancelled');

    // Stock released.
    const availAfter = db.prepare('SELECT stock - reserved AS a FROM variants WHERE id = ?').get(variant.id).a;
    assert.equal(availAfter, availBefore + 1);
  });
});

describe('webhook security and ordering', () => {
  async function craftWebhook(event, { corruptSig = false, oldTimestamp = false, signTwice = false } = {}) {
    const body = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000) - (oldTimestamp ? 3600 : 0);
    const { signPayload } = await import('../../src/services/payments/mock.js');
    let sig = `t=${t},v1=${signPayload(t, body)}`;
    if (corruptSig) sig = `t=${t},v1=${'f'.repeat(64)}`;
    if (signTwice) sig += ',v1=deadbeef';
    const res = await fetch(`${baseUrl}/webhooks/payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Cartward-Signature': sig },
      body,
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  }

  it('rejects invalid signatures and records the attempt unprocessed', async () => {
    const event = { id: `evt_test_${Math.random()}`, type: 'payment.succeeded', data: { paymentRef: 'ch_missing' } };
    const res = await craftWebhook(event, { corruptSig: true });
    assert.equal(res.status, 400);
    const row = db.prepare('SELECT signature_valid, processed_at FROM webhook_events WHERE id = ?').get(event.id);
    assert.equal(row.signature_valid, 0);
    assert.equal(row.processed_at, null);
  });

  it('rejects stale timestamps (replay protection)', async () => {
    const event = { id: `evt_stale_${Math.random()}`, type: 'payment.succeeded', data: { paymentRef: 'x' } };
    const res = await craftWebhook(event, { oldTimestamp: true });
    assert.equal(res.status, 400);
  });

  it('duplicate deliveries are acknowledged but processed once', async () => {
    // Place a real order to attach the events to.
    const variant = pickStockedVariant(20);
    const review = await guestCheckoutToReview(variant.id, 1);
    const placed = await placeOrderFromReview(review);
    const orderId = /pay\/([0-9a-f-]+)/.exec(placed.headers.location)[1];

    const { mockProvider } = await import('../../src/services/payments/mock.js');
    const result = mockProvider.createPayment({ order: { id: orderId }, totalCents: 12345, cardNumber: '4242424242424242' });
    // The provider already scheduled one delivery (with duplicate=false).
    // Craft a duplicate of a *known* event id manually:
    const paymentRow = db.prepare('SELECT provider_ref FROM payments WHERE provider_ref = ?').get(result.providerRef);
    assert.ok(paymentRow);

    const eventId = `evt_dup_${Math.random().toString(36).slice(2)}`;
    const first = await craftWebhook({ id: eventId, type: 'payment.failed', data: { paymentRef: result.providerRef, failureReason: 'card_declined' } });
    const second = await craftWebhook({ id: eventId, type: 'payment.failed', data: { paymentRef: result.providerRef, failureReason: 'card_declined' } });
    assert.equal(first.json.duplicate, undefined);
    assert.equal(second.json.duplicate, true);

    const attempts = db.prepare('SELECT process_attempts FROM webhook_events WHERE id = ?').get(eventId).process_attempts;
    assert.equal(attempts, 2);
    const events = db.prepare("SELECT COUNT(*) n FROM order_events WHERE order_id = ? AND type='payment_failed'").get(orderId).n;
    assert.equal(events, 1); // effect applied once
  });

  it('out-of-order refund notices are recorded, not applied', async () => {
    const variant = pickStockedVariant(20);
    const review = await guestCheckoutToReview(variant.id, 1);
    const placed = await placeOrderFromReview(review);
    const orderId = /pay\/([0-9a-f-]+)/.exec(placed.headers.location)[1];

    // Start a payment that would succeed only after a long pause…
    const { mockProvider, signPayload } = await import('../../src/services/payments/mock.js');
    mockProvider.createPayment({ order: { id: orderId }, totalCents: 999, cardNumber: '4000000000000341' });
    const payment = db.prepare('SELECT provider_ref FROM payments WHERE order_id = ? ORDER BY created_at DESC LIMIT 1').get(orderId);

    // …and sneak in a refund notice while the order is still pending.
    const event = { id: `evt_ooo_${Math.random().toString(36).slice(2)}`, type: 'refund.succeeded', data: { paymentRef: payment.provider_ref, orderId, amountCents: 999 } };
    const body = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    const res = await fetch(`${baseUrl}/webhooks/payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Cartward-Signature': `t=${t},v1=${signPayload(t, body)}` },
      body,
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).note, 'ignored_out_of_order');
    assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId).status, 'pending');
  });

  it('auto-refunds a payment that settles after cancellation', async () => {
    const variant = pickStockedVariant(20);
    const review = await guestCheckoutToReview(variant.id, 1);
    const placed = await placeOrderFromReview(review);
    const orderId = /pay\/([0-9a-f-]+)/.exec(placed.headers.location)[1];

    // Start a slow payment, then cancel the order before it settles.

    // Cancel first.
    await client.post(`/orders/${orderId}/cancel`, {
      email: 'guest-checkout@example.test',
      _csrf: csrfOf(await client.get('/orders/track')),
    });
    assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId).status, 'cancelled');

    // Now deliver a late success webhook directly.
    const paymentRef = `ch_late_${Date.now()}`;
    db.prepare(`
      INSERT INTO payments (id, order_id, provider, provider_ref, amount_cents, status, created_at, updated_at)
      VALUES (?, ?, 'mock', ?, 4321, 'processing', ?, ?)
    `).run(`pay_${paymentRef}`, orderId, paymentRef, Date.now(), Date.now());

    const event = { id: `evt_late_${Math.random().toString(36).slice(2)}`, type: 'payment.succeeded', data: { paymentRef, orderId, amountCents: 4321 } };
    const res = await craftWebhook(event);
    assert.equal(res.json.note, 'auto_refunded_after_close');

    const pay = db.prepare('SELECT status, refunded_cents FROM payments WHERE provider_ref = ?').get(paymentRef);
    assert.equal(pay.status, 'refunded');
    assert.equal(pay.refunded_cents, 4321);
    const ev = db.prepare("SELECT detail FROM order_events WHERE order_id = ? AND type='auto_refund'").get(orderId);
    assert.match(ev.detail, /automatically/);
  });
});
