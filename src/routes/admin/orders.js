import { Router } from 'express';
import { db } from '../../db/index.js';
import { getOrderById, getOrderEvents, transitionOrder } from '../../services/orders.js';
import { getOrderLines } from '../../services/checkout.js';
import { getPaymentProvider } from '../../services/payments/index.js';
import { audit } from '../../services/admin.js';
import { log } from '../../lib/logger.js';

const router = Router();

const STATUS_FILTERS = ['pending', 'paid', 'fulfilled', 'shipped', 'cancelled', 'refunded'];

router.get('/admin/orders', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  const status = STATUS_FILTERS.includes(req.query.status) ? req.query.status : null;

  let sql = `
    SELECT o.*, u.email AS user_email FROM orders o LEFT JOIN users u ON u.id = o.user_id
    WHERE (? IS NULL OR o.status = ?)
      AND (? = '' OR o.number LIKE '%' || ? || '%' COLLATE NOCASE
           OR o.guest_email LIKE '%' || ? || '%' COLLATE NOCASE
           OR u.email LIKE '%' || ? || '%' COLLATE NOCASE
           OR o.shipping_address_json LIKE '%' || ? || '%')
  `;
  const params = [status, status, q, q, q, q, q];
  const sortKey = ['placed', 'number', 'total'].includes(req.query.sort) ? req.query.sort : 'placed';
  const sortCols = { placed: 'o.placed_at', number: 'o.number', total: 'o.total_cents' };
  const direction = req.query.direction === 'asc' ? 'ASC' : 'DESC';
  sql += ` ORDER BY ${sortCols[sortKey]} ${direction}`;
  sql += ' LIMIT 200';

  const rows = db.prepare(sql).all(...params);
  const nextDirection = (key) => (sortKey === key && direction === 'ASC' ? 'desc' : 'asc');
  res.render('admin/orders/index', {
    layout: 'admin',
    title: 'Orders',
    rows, q, status,
    sortKey,
    direction,
    nextDirection,
    ariaSort: (key) => (sortKey === key ? (direction === 'ASC' ? 'ascending' : 'descending') : null),
    arrowFor: (key) => (sortKey === key ? (direction === 'ASC' ? '↑' : '↓') : ''),
    csrfToken: req.csrfToken(),
  });
});

router.get('/admin/orders.csv', (req, res) => {
  const rows = db.prepare(`
    SELECT o.number, o.status, o.placed_at, o.subtotal_cents, o.discount_cents,
           o.shipping_cents, o.tax_cents, o.total_cents, o.refund_total_cents,
           COALESCE(u.email, o.guest_email, '') AS email, o.shipping_method,
           o.shipping_address_json
    FROM orders o LEFT JOIN users u ON u.id = o.user_id
    WHERE (? IS NULL OR o.status = ?)
    ORDER BY o.placed_at DESC LIMIT 5000
  `).all(...[req.query.status && STATUS_FILTERS.includes(req.query.status) ? req.query.status : null, req.query.status && STATUS_FILTERS.includes(req.query.status) ? req.query.status : null]);

  const esc = (v) => {
    let s = String(v ?? '');
    // CSV injection guard: neutralise spreadsheet formula metacharacters.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const lines = ['number,status,placed_at,email,subtotal_cents,discount_cents,shipping_cents,tax_cents,total_cents,refund_total_cents,shipping_method,address'];
  for (const r of rows) {
    lines.push([
      r.number, r.status, new Date(r.placed_at).toISOString(), esc(r.email),
      r.subtotal_cents, r.discount_cents, r.shipping_cents, r.tax_cents, r.total_cents,
      r.refund_total_cents, r.shipping_method, esc(r.shipping_address_json),
    ].map(esc).join(','));
  }
  audit({ actorType: 'admin', actorId: req.user.id, action: 'orders.export_csv', ip: req.ip });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="cartward-orders.csv"');
  return res.send(lines.join('\r\n') + '\r\n');
});

router.get('/admin/orders/:id', (req, res) => {
  const order = getOrderById(req.params.id);
  if (!order) return res.status(404).render('error', { title: 'Not found', message: 'No such order.', statusCode: 404 });
  const lines = getOrderLines(order.id);
  const payment = db.prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY created_at DESC LIMIT 1').get(order.id);
  const userEmail = order.user_id ? db.prepare('SELECT email FROM users WHERE id = ?').get(order.user_id)?.email : null;
  res.render('admin/orders/show', {
    layout: 'admin',
    title: `Order ${order.number}`,
    order,
    lines,
    payment,
    userEmail,
    events: getOrderEvents(order.id),
    csrfToken: req.csrfToken(),
  });
});

/** Admin state transitions — validated by the same machine customers use. */
router.post('/admin/orders/:id/transition', (req, res) => {
  const order = getOrderById(req.params.id);
  if (!order) return res.status(404).render('error', { title: 'Not found', message: 'No such order.', statusCode: 404 });
  const toStatus = String(req.body.to_status || '');
  try {
    transitionOrder({
      orderId: order.id,
      toStatus,
      actor: `admin:${req.user.id}`,
      detail: String(req.body.note || '').trim().slice(0, 300) || null,
    });
    audit({ actorType: 'admin', actorId: req.user.id, action: `order.${toStatus}`, entityType: 'order', entityId: order.id, before: { status: order.status }, after: { status: toStatus }, ip: req.ip });
    res.flash('success', `Order moved to "${toStatus}".`);
  } catch (err) {
    res.flash('warn', err.message);
  }
  return res.redirect(`/admin/orders/${order.id}`);
});

/** Full refund via the mock provider; confirmed by webhook. */
router.post('/admin/orders/:id/refund', (req, res) => {
  const order = getOrderById(req.params.id);
  if (!order) return res.status(404).render('error', { title: 'Not found', message: 'No such order.', statusCode: 404 });
  const payment = db.prepare("SELECT * FROM payments WHERE order_id = ? AND status = 'succeeded' ORDER BY created_at DESC LIMIT 1").get(order.id);
  if (!payment) {
    res.flash('warn', 'No settled payment found for this order.');
    return res.redirect(`/admin/orders/${order.id}`);
  }
  const result = getPaymentProvider('mock').refund(payment.provider_ref);
  if (!result.ok) {
    res.flash('warn', result.error);
  } else {
    audit({ actorType: 'admin', actorId: req.user.id, action: 'order.refund_requested', entityType: 'order', entityId: order.id, after: { amountCents: order.total_cents }, ip: req.ip });
    res.flash('success', 'Refund requested — it completes when the processor confirms by webhook.');
  }
  return res.redirect(`/admin/orders/${order.id}`);
});

export default router;
