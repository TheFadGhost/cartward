import crypto from 'node:crypto';
import { db } from '../db/index.js';
import { config } from '../config.js';


/**
 * Inventory control. Availability = stock - reserved.
 *
 * Reservations are the only way stock leaves the shelf: checkout reserves
 * inside the order transaction; payment success commits; cancellation,
 * payment failure and reservation expiry release. Conditional UPDATEs make
 * overselling impossible regardless of concurrency (verified by test).
 */

export class OutOfStockError extends Error {
  constructor(variantId, productName) {
    super(`${productName || 'An item'} just went out of stock.`);
    this.code = 'out_of_stock';
    this.variantId = variantId;
  }
}

const getVariantLock = db.prepare(`
  SELECT v.id, v.stock, v.reserved, v.backorderable, p.name AS product_name
  FROM variants v JOIN products p ON p.id = v.product_id
  WHERE v.id = ?
`);

/**
 * Reserve line quantities for an order. MUST run inside the checkout
 * transaction. Backordered quantities beyond physical availability are not
 * reserved — they will be fulfilled from future stock.
 */
export function reserveLines(orderId, lines) {
  const insertReservation = db.prepare(`
    INSERT INTO reservations (id, order_id, variant_id, quantity, status, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'held', ?, ?, ?)
  `);
  for (const line of lines) {
    const v = getVariantLock.get(line.variantId);
    if (!v) throw new OutOfStockError(line.variantId);
    const available = v.stock - v.reserved;
    if (!v.backorderable && available < line.quantity) {
      throw new OutOfStockError(line.variantId, v.product_name);
    }
    const toReserve = Math.min(line.quantity, Math.max(available, 0));
    if (toReserve > 0) {
      // Conditional guard: another writer may have consumed stock between our
      // read and this write inside a different connection's transaction.
      const res = db.prepare(
        'UPDATE variants SET reserved = reserved + ?, updated_at = ? WHERE id = ? AND stock - reserved >= ?',
      ).run(toReserve, Date.now(), line.variantId, toReserve);
      if (res.changes !== 1) throw new OutOfStockError(line.variantId, v.product_name);
      insertReservation.run(crypto.randomUUID(), orderId, line.variantId, toReserve, Date.now() + config.reservationTtlMs, Date.now(), Date.now());
    }
  }
}

/** Payment succeeded: physical stock leaves inventory. */
export function commitOrderReservations(orderId, now = Date.now()) {
  const rows = db.prepare("SELECT id, variant_id, quantity FROM reservations WHERE order_id = ? AND status = 'held'").all(orderId);
  const tx = db.transaction(() => {
    for (const r of rows) {
      db.prepare('UPDATE variants SET stock = stock - ?, reserved = reserved - ?, updated_at = ? WHERE id = ?')
        .run(r.quantity, r.quantity, now, r.variant_id);
      db.prepare("UPDATE reservations SET status = 'committed', updated_at = ? WHERE id = ?").run(now, r.id);
    }
  });
  tx();
  return rows.length;
}

/**
 * Order cancelled / payment failed / reservation expired: put the held
 * quantity back on the shelf.
 */
export function releaseOrderReservations(orderId, now = Date.now()) {
  const rows = db.prepare("SELECT id, variant_id, quantity FROM reservations WHERE order_id = ? AND status = 'held'").all(orderId);
  const tx = db.transaction(() => {
    for (const r of rows) {
      db.prepare('UPDATE variants SET reserved = reserved - ?, updated_at = ? WHERE id = ? AND reserved >= ?')
        .run(r.quantity, now, r.variant_id, r.quantity);
      db.prepare("UPDATE reservations SET status = 'released', updated_at = ? WHERE id = ?").run(now, r.id);
    }
  });
  tx();
  return rows.length;
}

/** Refund: goods come back to the shelf. */
export function restockOrderLines(orderId, now = Date.now()) {
  const lines = db.prepare('SELECT variant_id, quantity FROM order_lines WHERE order_id = ?').all(orderId);
  const tx = db.transaction(() => {
    for (const l of lines) {
      db.prepare('UPDATE variants SET stock = stock + ?, updated_at = ? WHERE id = ?').run(l.quantity, now, l.variant_id);
    }
  });
  tx();
}

/**
 * Sweep expired reservations: release stock and auto-cancel still-pending
 * orders with an honest event explaining why.
 */
export function sweepExpiredReservations(now = Date.now()) {
  const expired = db.prepare(`
    SELECT DISTINCT r.order_id FROM reservations r
    JOIN orders o ON o.id = r.order_id
    WHERE r.status = 'held' AND r.expires_at < ?
      AND o.status = 'pending'
  `).all(now);
  let sweptOrders = 0;
  for (const { order_id } of expired) {
    releaseOrderReservations(order_id, now);
    db.prepare('UPDATE orders SET status = ?, updated_at = ?, closed_at = ? WHERE id = ? AND status = ?')
      .run('cancelled', now, now, order_id, 'pending');
    db.prepare(`INSERT INTO order_events (id, order_id, type, from_status, to_status, detail, actor, created_at)
                VALUES (?, ?, 'reservation_expired', 'pending', 'cancelled', ?, 'system', ?)`)
      .run(crypto.randomUUID(), order_id, 'Checkout was not completed in time and the reserved items were returned to the shelf.', now);
    sweptOrders += 1;
  }
  return sweptOrders;
}
