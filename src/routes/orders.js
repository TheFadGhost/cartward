import { Router } from 'express';
import { db } from '../db/index.js';
import {
  getOrderById, getOrderEvents, listUserOrders, transitionOrder, findOrderByNumber, orderEmailFor,
} from '../services/orders.js';
import { getOrderLines, orderBelongsTo } from '../services/checkout.js';
import { hmacHex } from '../lib/tokens.js';
import { config } from '../config.js';
import { rateLimitMiddleware } from '../lib/rate-limit.js';
import { log } from '../lib/logger.js';

const router = Router();
const requireLogin = (req, res, next) => {
  if (!req.user || req.pending2fa) return res.redirect('/login');
  next();
};

function viewFor(order) {
  return { order, lines: getOrderLines(order.id), events: getOrderEvents(order.id) };
}

// NOTE: literal "/orders/track" routes are registered before "/orders/:id"
// so the word "track" is never captured as an order id.

router.get('/orders', requireLogin, (req, res) => {
  const orders = listUserOrders(req.user.id);
  res.render('orders/index', { title: 'Your orders', orders });
});

router.get('/orders/track', (req, res) => {
  res.render('orders/track', {
    title: 'Track an order',
    values: { number: String(req.query.number || ''), email: String(req.query.email || '') },
    order: null,
    lines: [],
    events: [],
    errors: {},
    csrfToken: req.csrfToken(),
  });
});

const trackLimiter = rateLimitMiddleware({
  name: 'track-order',
  keyFn: (req) => `${req.ip}:${String(req.body?.number || '')}`,
  limit: 20,
  windowMs: 15 * 60 * 1000,
});

router.post('/orders/track', trackLimiter, (req, res) => {
  const number = String(req.body.number || '').trim().toUpperCase();
  const email = String(req.body.email || '').trim().toLowerCase();
  const errors = {};
  if (!/^CW-[0-9A-Z]{8}$/.test(number)) errors.number = 'Order numbers look like CW-XXXXXXXX.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Enter the email used on the order.';

  let order = null;
  let lines = [];
  let events = [];
  if (!Object.keys(errors).length) {
    const found = findOrderByNumber(number);
    if (found && orderEmailMatches(found, email)) {
      order = found;
      ({ lines, events } = viewFor(found));
    } else {
      errors.form = 'No order matches that number and email combination.';
    }
  }
  res.status(Object.keys(errors).length ? 404 : 200).render('orders/track', {
    title: 'Track an order',
    values: { number, email },
    order,
    lines,
    events,
    errors,
    csrfToken: req.csrfToken(),
  });
});

function orderEmailMatches(order, email) {
  return (orderEmailFor(order) ?? '').toLowerCase() === String(email).toLowerCase();
}

router.get('/orders/:id', requireLogin, (req, res) => {
  const order = getOrderById(req.params.id);
  if (!order || !orderBelongsTo(order, req.user.id)) {
    return res.status(404).render('error', { title: 'Order not found', message: "We couldn't find that order.", statusCode: 404 });
  }
  res.render('orders/show', {
    title: `Order ${order.number}`,
    ...viewFor(order),
    csrfToken: req.csrfToken(),
  });
});

/** Shopper-initiated cancellation while still pending (owner or verified guest). */
const cancelLimiter = rateLimitMiddleware({
  name: 'cancel-order',
  keyFn: (req) => req.user?.id ?? req.ip ?? 'anon',
  limit: 10,
  windowMs: 60 * 60 * 1000,
});

router.post('/orders/:id/cancel', cancelLimiter, (req, res) => {
  const order = getOrderById(req.params.id);
  if (!order) {
    return res.status(404).render('error', { title: 'Order not found', message: "We couldn't find that order.", statusCode: 404 });
  }
  const owns = orderBelongsTo(order, req.user && !req.pending2fa ? req.user.id : null);
  if (!owns && req.body.email) {
    // Guest cancellation via tracking page: must prove the email.
    const email = String(req.body.email || '').trim().toLowerCase();
    const matches = orderEmailMatches(order, email);
    if (!matches) {
      return res.status(403).render('error', { title: 'Not allowed', message: 'That email does not match the order.', statusCode: 403 });
    }
    return doCancel(req, res, order, '/orders/track');
  }
  if (!owns) {
    return res.status(404).render('error', { title: 'Order not found', message: "We couldn't find that order.", statusCode: 404 });
  }
  return doCancel(req, res, order, `/orders/${order.id}`);
});

function doCancel(req, res, order, backTo) {
  try {
    transitionOrder({
      orderId: order.id,
      toStatus: 'cancelled',
      actor: req.user ? `customer:${req.user.id}` : 'customer',
      detail: 'Cancelled by the customer before payment completed.',
    });
    res.flash('success', `Order ${order.number} cancelled. Reserved items are back on the shelf.`);
  } catch (err) {
    res.flash('warn', err.message);
  }
  return res.redirect(backTo);
}

// Payment status polling for the pay page. The token is time-bucketed
// (10-minute windows, current or previous) so links can't be replayed forever.
router.get('/orders/:id/status.json', (req, res) => {
  const order = getOrderById(req.params.id);
  if (!order) return res.status(403).json({ error: 'forbidden' });
  const bucket = Math.floor(Date.now() / (10 * 60 * 1000));
  const candidates = [bucket, bucket - 1].map((b) => hmacHex(config.sessionSecret, `poll:${req.params.id}:${b}`));
  if (!candidates.includes(String(req.query.t))) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const payment = db.prepare(
    'SELECT status, failure_reason FROM payments WHERE order_id = ? ORDER BY created_at DESC LIMIT 1',
  ).get(order.id);
  return res.json({ status: order.status, paymentStatus: payment?.status ?? null, failureReason: payment?.failure_reason ?? null });
});

export default router;
