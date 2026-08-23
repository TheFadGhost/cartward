import crypto from 'node:crypto';
import { db } from '../db/index.js';
import { formatMoney } from '../lib/money.js';
import { mailer } from './email/index.js';
import { commitOrderReservations, releaseOrderReservations, restockOrderLines } from './inventory.js';

/**
 * Order lifecycle state machine. Invalid transitions are rejected, not
 * coerced — the transition table is the single source of truth.
 *
 *   pending → paid | cancelled
 *   paid → fulfilled | refunded
 *   fulfilled → shipped | refunded
 *   shipped → refunded
 *   cancelled, refunded → (terminal)
 */

export const ORDER_STATUSES = ['pending', 'paid', 'fulfilled', 'shipped', 'cancelled', 'refunded'];

export const TRANSITIONS = Object.freeze({
  pending: new Set(['paid', 'cancelled']),
  paid: new Set(['fulfilled', 'refunded']),
  fulfilled: new Set(['shipped', 'refunded']),
  shipped: new Set(['refunded']),
  cancelled: new Set(),
  refunded: new Set(),
});

export function canTransition(from, to) {
  return TRANSITIONS[from]?.has(to) ?? false;
}

export class InvalidTransitionError extends Error {
  constructor(from, to) {
    super(`Cannot move an order from "${from}" to "${to}".`);
    this.code = 'invalid_transition';
    this.from = from;
    this.to = to;
  }
}

const getOrder = db.prepare('SELECT * FROM orders WHERE id = ?');
const getOrderByNumber = db.prepare('SELECT * FROM orders WHERE number = ?');

export function getOrderById(id) {
  return getOrder.get(id) ?? null;
}
export function findOrderByNumber(number) {
  return getOrderByNumber.get(String(number).toUpperCase()) ?? null;
}

function generateOrderNumber() {
  // Crockford base32, 8 chars — unambiguous when read aloud.
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += alphabet[bytes[i] % alphabet.length];
  return `CW-${out}`;
}

export function insertOrderNumberUnique(run) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return run(generateOrderNumber());
    } catch (err) {
      if (!String(err.message).includes('UNIQUE')) throw err;
    }
  }
  throw new Error('Could not allocate an order number');
}

/**
 * Perform a validated state transition with side effects and an event row.
 * Side effects by target status:
 *   paid      → commit reserved stock, confirmation email
 *   cancelled → release held reservations
 *   refunded  → restock lines, refund email
 *   shipped   → shipping email
 */
export function transitionOrder({ orderId, toStatus, actor = 'system', detail = null, now = Date.now() }) {
  const order = getOrderById(orderId);
  if (!order) throw new Error('Order not found');
  const from = order.status;
  if (from === toStatus) {
    return order; // idempotent no-op
  }
  if (!canTransition(from, toStatus)) {
    throw new InvalidTransitionError(from, toStatus);
  }

  const stamps = { updated_at: now };
  if (toStatus === 'cancelled') stamps.closed_at = now;
  if (toStatus === 'refunded') stamps.closed_at = now;

  const tx = db.transaction(() => {
    // Re-check inside the write lock.
    const current = db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId);
    if (!canTransition(current.status, toStatus)) throw new InvalidTransitionError(current.status, toStatus);
    db.prepare(`UPDATE orders SET status = @toStatus, ${Object.keys(stamps).map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`)
      .run({ ...stamps, toStatus, id: orderId });
    db.prepare(`INSERT INTO order_events (id, order_id, type, from_status, to_status, detail, actor, created_at)
                VALUES (?, ?, 'state_change', ?, ?, ?, ?, ?)`)
      .run(crypto.randomUUID(), orderId, from, toStatus, detail, actor, now);

    if (toStatus === 'cancelled') {
      releaseOrderReservations(orderId, now);
    }
    if (toStatus === 'paid') {
      commitOrderReservations(orderId, now);
    }
    if (toStatus === 'refunded') {
      restockOrderLines(orderId, now);
    }
  });
  tx();

  // Post-commit notifications (outside the transaction; failures logged).
  notifyTransition(orderId, toStatus);

  return getOrderById(orderId);
}

/** Best-effort customer email for an order (account or guest snapshot). */
export function orderEmailFor(order) {
  if (order.user_id) {
    return db.prepare('SELECT email FROM users WHERE id = ?').get(order.user_id)?.email ?? null;
  }
  try {
    return JSON.parse(order.shipping_address_json)?.email ?? null;
  } catch {
    return null;
  }
}

function notifyTransition(orderId, toStatus) {
  const order = getOrderById(orderId);
  if (!order) return;
  const email = orderEmailFor(order);
  if (!email) return;
  try {
    if (toStatus === 'shipped') {
      mailer.sendTemplate(email, 'shippingNotice', { orderNumber: order.number }).catch(() => {});
    } else if (toStatus === 'refunded') {
      mailer.sendTemplate(email, 'refundNotice', { orderNumber: order.number, amount: formatMoney(order.refund_total_cents || order.total_cents) }).catch(() => {});
    }
  } catch { /* notification failures never break orders */ }
}

/** Timeline for the customer-facing order page / admin detail. */
export function getOrderEvents(orderId) {
  return db.prepare(`
    SELECT type, from_status, to_status, detail, actor, created_at
    FROM order_events WHERE order_id = ? ORDER BY created_at, rowid
  `).all(orderId);
}

export function listUserOrders(userId) {
  return db.prepare(`
    SELECT o.*, (SELECT COUNT(*) FROM order_lines l WHERE l.order_id = o.id) AS line_count
    FROM orders o WHERE o.user_id = ? ORDER BY o.placed_at DESC LIMIT 100
  `).all(userId);
}
