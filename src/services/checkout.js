import crypto from 'node:crypto';
import { db } from '../db/index.js';
import { newId } from '../lib/tokens.js';
import { getCartView, touchCart } from './cart.js';
import { evaluateDiscount, computeTotals, getShippingMethod } from './pricing.js';
import { reserveLines, OutOfStockError } from './inventory.js';
import { insertOrderNumberUnique } from './orders.js';

export class CheckoutError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const setDraftAddress = db.prepare('UPDATE carts SET checkout_address_json = ?, updated_at = ? WHERE id = ?');
const setDraftShipping = db.prepare('UPDATE carts SET checkout_shipping_method = ?, updated_at = ? WHERE id = ?');
const setDraftDiscount = db.prepare('UPDATE carts SET checkout_discount_code = ?, updated_at = ? WHERE id = ?');

const ADDRESS_FIELD_ERRORS = {
  name: 'Enter the full recipient name.',
  line1: 'Enter a street address.',
  line2: '',
  city: 'Enter a city.',
  region: 'Use a two-letter state code.',
  postal_code: 'Enter a ZIP code like 12345 or 12345-6789.',
  country: 'Only US addresses are supported in this demo.',
  email: 'Enter a valid email for the receipt.',
};

/** Validate and store the shipping address draft on the cart. */
export function saveCheckoutAddress(cartId, address) {
  const schema = {
    name: (v) => typeof v === 'string' && v.trim().length >= 2 && v.length <= 100,
    line1: (v) => typeof v === 'string' && v.trim().length >= 4 && v.length <= 200,
    line2: (v) => v === undefined || v === '' || (typeof v === 'string' && v.length <= 200),
    city: (v) => typeof v === 'string' && v.trim().length >= 2 && v.length <= 80,
    region: (v) => typeof v === 'string' && /^[A-Za-z]{2}$/.test(String(v).trim()),
    postal_code: (v) => typeof v === 'string' && /^\d{5}(-\d{4})?$/.test(String(v).trim()),
    country: (v) => v === 'US',
    email: (v) => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v)),
  };
  const errors = {};
  for (const [field, check] of Object.entries(schema)) {
    if (!check(address[field])) errors[field] = ADDRESS_FIELD_ERRORS[field];
  }
  if (Object.keys(errors).length) {
    const err = new CheckoutError('invalid_address', 'Please correct the highlighted fields.');
    err.fieldErrors = errors;
    throw err;
  }
  const clean = {
    name: String(address.name).trim(),
    line1: String(address.line1).trim(),
    line2: String(address.line2 ?? '').trim(),
    city: String(address.city).trim(),
    region: String(address.region).trim().toUpperCase(),
    postal_code: String(address.postal_code).trim(),
    country: 'US',
    email: String(address.email).trim().toLowerCase(),
  };
  setDraftAddress.run(JSON.stringify(clean), Date.now(), cartId);
  return clean;
}

export function saveShippingMethod(cartId, methodId) {
  if (!getShippingMethod(methodId)) throw new CheckoutError('bad_method', 'Choose a delivery option.');
  setDraftShipping.run(methodId, Date.now(), cartId);
}

export function saveDiscountCode(cartId, code) {
  const trimmed = String(code ?? '').trim();
  setDraftDiscount.run(trimmed === '' ? null : trimmed.slice(0, 40), Date.now(), cartId);
}

/** Compute everything the review page and placement need from the current cart. */
export function previewTotals(cart) {
  const view = getCartView(cart.id);
  const address = cart.checkout_address_json ? JSON.parse(cart.checkout_address_json) : null;
  const methodId = cart.checkout_shipping_method || null;
  const lines = view.lines.map((l) => ({
    ...l,
    lineTotalCents: l.currentCents * l.quantity,
    priceChangedNow: l.snapshotCents !== l.currentCents,
  }));
  const discountCode = cart.checkout_discount_code || null;
  const rawSubtotal = lines.reduce((n, l) => n + l.lineTotalCents, 0);
  const discount = evaluateDiscount(discountCode, rawSubtotal);
  const totals = methodId
    ? computeTotals({ lines, shippingMethodId: methodId, discount, shipState: address?.region ?? '' })
    : null;
  return { view, address, methodId, lines, discountCode, discount, totals };
}

/**
 * Place an order atomically:
 *   - idempotent by key (double-click / retried POST returns the same order)
 *   - reserves stock inside the same transaction that writes the order
 */
export function placeOrder({ cart, userId, idempotencyKey }) {
  if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.length > 64
      || !/^[0-9a-f]+$/.test(idempotencyKey)) {
    throw new CheckoutError('bad_idempotency_key', 'Your session expired mid-checkout. Please review your order again.');
  }

  return db.transaction(() => {
    // Idempotent replay: same key returns the same order.
    const replayed = db.prepare('SELECT * FROM orders WHERE idempotency_key = ?').get(idempotencyKey);
    if (replayed) return { order: replayed, replayed: true };

    const freshCart = db.prepare('SELECT * FROM carts WHERE id = ?').get(cart.id);
    if (!freshCart || freshCart.status !== 'active') throw new CheckoutError('cart_gone', 'This cart has already been checked out.');
    if (!freshCart.checkout_address_json) throw new CheckoutError('no_address', 'Add a shipping address first.');
    if (!freshCart.checkout_shipping_method) throw new CheckoutError('no_shipping', 'Choose a delivery method.');

    const view = getCartView(freshCart.id);
    if (view.isEmpty) throw new CheckoutError('empty_cart', 'Your cart is empty.');
    // Stock viability is enforced by reserveLines below inside this same
    // transaction — its OutOfStockError names the item precisely under races.

    const address = JSON.parse(freshCart.checkout_address_json);
    const lines = view.lines.map((l) => ({
      variantId: l.variantId,
      quantity: l.quantity,
      unitPriceCents: l.currentCents,
      lineTotalCents: l.currentCents * l.quantity,
      snapshot: l.snapshotCents,
      name: l.name,
      label: l.variantLabel,
      sku: l.sku,
    }));
    const priceChanged = lines.some((l) => l.snapshot !== l.unitPriceCents);

    const subtotal = lines.reduce((n, l) => n + l.lineTotalCents, 0);
    const discount = evaluateDiscount(freshCart.checkout_discount_code, subtotal);
    if (!discount.ok) {
      throw new CheckoutError('bad_discount', `${discount.error} Remove or change the code to continue.`);
    }
    const totals = computeTotals({
      lines,
      shippingMethodId: freshCart.checkout_shipping_method,
      discount,
      shipState: address.region,
    });

    const orderId = newId();
    insertOrderNumberUnique((number) => {
      db.prepare(`
        INSERT INTO orders (id, number, user_id, guest_email, status,
          subtotal_cents, discount_cents, shipping_cents, tax_cents, total_cents,
          currency, shipping_method, shipping_address_json, discount_code_id,
          idempotency_key, placed_at, updated_at)
        VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?, ?)
      `).run(orderId, number, userId, userId ? null : address.email,
        totals.subtotalCents, totals.discountCents, totals.shippingCents, totals.taxCents, totals.totalCents,
        freshCart.checkout_shipping_method, JSON.stringify(address),
        discount.unused ? null : discount.id,
        idempotencyKey, Date.now(), Date.now());
      return number;
    });

    const insertLine = db.prepare(`
      INSERT INTO order_lines (id, order_id, variant_id, product_name, variant_label, sku, quantity, unit_price_cents, line_total_cents)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const l of lines) {
      insertLine.run(newId(), orderId, l.variantId, l.name, l.label, l.sku, l.quantity, l.unitPriceCents, l.lineTotalCents);
    }

    try {
      reserveLines(orderId, lines);
    } catch (err) {
      if (err instanceof OutOfStockError) {
        throw new CheckoutError('out_of_stock', err.message);
      }
      throw err;
    }

    db.prepare(`INSERT INTO order_events (id, order_id, type, detail, actor, created_at)
                VALUES (?, ?, 'order_placed', ?, 'customer', ?)`)
      .run(newId(), orderId, priceChanged
        ? "Order placed at today's prices — some prices had changed since items were added."
        : 'Order placed.', Date.now());

    // Convert the cart so it can't be double-submitted.
    db.prepare("UPDATE carts SET status = 'converted', updated_at = ? WHERE id = ?").run(Date.now(), freshCart.id);
    touchCart(freshCart.id);

    return { order: db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId), replayed: false };
  }).immediate();
}

export function getOrderLines(orderId) {
  return db.prepare('SELECT * FROM order_lines WHERE order_id = ?').all(orderId);
}

export function orderBelongsTo(order, userId, guestEmail = null) {
  if (order.user_id && userId) return order.user_id === userId;
  if (guestEmail) return order.guest_email?.toLowerCase() === String(guestEmail).toLowerCase();
  return false;
}

export function randomIdempotencyKey() {
  return crypto.randomBytes(16).toString('hex');
}
