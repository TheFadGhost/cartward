import { db } from '../db/index.js';
import { newId } from '../lib/tokens.js';

/** Audit trail writer — every admin action of consequence goes through here. */
export function audit({ actorType, actorId = null, action, entityType = null, entityId = null, before = null, after = null, ip = null }) {
  db.prepare(`
    INSERT INTO audit_log (id, actor_type, actor_id, action, entity_type, entity_id, before_json, after_json, ip, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    newId(), actorType, actorId, action, entityType, entityId,
    before ? JSON.stringify(before) : null,
    after ? JSON.stringify(after) : null,
    ip, Date.now(),
  );
}

export function readAuditLog({ limit = 100, entityType = null } = {}) {
  if (entityType) {
    return db.prepare('SELECT * FROM audit_log WHERE entity_type = ? ORDER BY created_at DESC LIMIT ?').all(entityType, limit);
  }
  return db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?').all(limit);
}

/** Dashboard aggregates. Revenue convention: net of refunds; cancelled excluded (see DESIGN.md). */
export function dashboardStats(now = Date.now()) {
  const dayMs = 24 * 60 * 60 * 1000;
  const since = now - 30 * dayMs;

  const ordersByDay = db.prepare(`
    SELECT date(placed_at / 1000, 'unixepoch') AS day,
           COUNT(*) AS orders,
           COALESCE(SUM(CASE WHEN status NOT IN ('cancelled') THEN total_cents - refund_total_cents ELSE 0 END), 0) AS revenue_cents
    FROM orders
    WHERE placed_at >= ?
      AND status != 'pending'
    GROUP BY day ORDER BY day
  `).all(since);

  // Fill gaps so the chart shows all 30 days.
  const byDay = new Map(ordersByDay.map((r) => [r.day, r]));
  const series = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now - i * dayMs).toISOString().slice(0, 10);
    const row = byDay.get(d);
    series.push({ day: d, orders: row?.orders ?? 0, revenueCents: row?.revenue_cents ?? 0 });
  }

  const totals = db.prepare(`
    SELECT COUNT(*) AS n_orders,
           COALESCE(SUM(total_cents), 0) AS gross_cents,
           COALESCE(SUM(refund_total_cents), 0) AS refunded_cents
    FROM orders WHERE status NOT IN ('pending', 'cancelled')
  `).get();

  const pending = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'pending'").get().n;
  const lowStock = db.prepare(`
    SELECT v.sku, p.name, v.option_size, v.option_colour, v.stock - v.reserved AS available, v.backorderable
    FROM variants v JOIN products p ON p.id = v.product_id
    WHERE p.status = 'active' AND v.stock - v.reserved <= 3
    ORDER BY available LIMIT 8
  `).all();

  // Percentile convention: p50/p95 order value over non-cancelled paid+ orders, trailing 30 days.
  const values = db.prepare(`
    SELECT total_cents FROM orders
    WHERE placed_at >= ? AND status NOT IN ('pending', 'cancelled')
    ORDER BY total_cents
  `).all(since).map((r) => r.total_cents);
  const pct = (p) => (values.length === 0 ? 0 : values[Math.min(values.length - 1, Math.floor(p * values.length))]);

  return {
    series,
    totals,
    pending,
    lowStock,
    p50: pct(0.5),
    p95: pct(0.95),
    orderCount: values.length,
  };
}

const emailForUser = db.prepare('SELECT email FROM users WHERE id = ?');

export function listCustomers({ q = '', limit = 100 } = {}) {
  const like = `%${q}%`;
  const rows = q
    ? db.prepare(`
        SELECT u.*, COUNT(o.id) AS order_count, COALESCE(SUM(o.total_cents), 0) AS spent_cents
        FROM users u LEFT JOIN orders o ON o.user_id = u.id AND o.status NOT IN ('pending','cancelled')
        WHERE u.role = 'customer' AND u.email LIKE ?
        GROUP BY u.id ORDER BY u.created_at DESC LIMIT ?
      `).all(like, limit)
    : db.prepare(`
        SELECT u.*, COUNT(o.id) AS order_count, COALESCE(SUM(o.total_cents), 0) AS spent_cents
        FROM users u LEFT JOIN orders o ON o.user_id = u.id AND o.status NOT IN ('pending','cancelled')
        WHERE u.role = 'customer'
        GROUP BY u.id ORDER BY u.created_at DESC LIMIT ?
      `).all(limit);
  return rows;
}

export function getCustomer(id) {
  const user = db.prepare('SELECT id, email, role, email_verified_at, totp_enabled_at, created_at FROM users WHERE id = ?').get(id);
  if (!user) return null;
  user.email = emailForUser.get(id)?.email ?? user.email;
  const orders = db.prepare(`
    SELECT * FROM orders WHERE user_id = ? ORDER BY placed_at DESC LIMIT 50
  `).all(id);
  return { ...user, orders };
}
