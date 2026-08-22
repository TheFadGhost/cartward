import { Router } from 'express';
import { db } from '../db/index.js';
import { newId } from '../lib/tokens.js';
import { log } from '../lib/logger.js';
import { verifySignature } from '../services/payments/mock.js';
import { transitionOrder } from '../services/orders.js';
import { mailer } from '../services/email/index.js';

const router = Router();

/**
 * Payment webhook receiver. Authenticated by HMAC signature over the raw
 * body; processed idempotently (duplicate deliveries are detected by the
 * provider event id and acknowledged without side effects). Out-of-order
 * events are recorded honestly instead of being coerced.
 */
router.post('/webhooks/payment', expressRawBody, (req, res) => {
  const rawBody = req.body; // Buffer, captured before JSON parsing
  const signature = req.headers['x-cartward-signature'];
  const sigValid = verifySignature(signature, rawBody);

  let event = null;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ received: false, error: 'invalid_json' });
  }
  if (!event || typeof event.id !== 'string' || typeof event.type !== 'string') {
    return res.status(400).json({ received: false, error: 'invalid_event' });
  }

  if (!sigValid) {
    db.prepare(`
      INSERT INTO webhook_events (id, provider, type, payload_json, signature_valid, received_at)
      VALUES (?, 'mock', ?, ?, 0, ?)
      ON CONFLICT(provider, id) DO NOTHING
    `).run(event.id, event.type, rawBody.toString('utf8'), Date.now());
    log.warn('webhook rejected: bad signature', { eventId: event.id });
    return res.status(400).json({ received: false, error: 'invalid_signature' });
  }

  // Idempotency gate: the UNIQUE(provider,id) index absorbs duplicates.
  const inserted = db.prepare(`
    INSERT INTO webhook_events (id, provider, type, payload_json, signature_valid, received_at, process_attempts)
    VALUES (?, 'mock', ?, ?, 1, ?, 1)
    ON CONFLICT(provider, id) DO NOTHING
  `).run(event.id, event.type, rawBody.toString('utf8'), Date.now());

  if (inserted.changes === 0) {
    db.prepare('UPDATE webhook_events SET process_attempts = process_attempts + 1 WHERE id = ? AND provider = ?')
      .run(event.id, 'mock');
    log.info('webhook duplicate ignored', { eventId: event.id, type: event.type });
    return res.status(200).json({ received: true, duplicate: true });
  }

  try {
    const outcome = processEvent(event);
    db.prepare('UPDATE webhook_events SET processed_at = ?, last_error = NULL WHERE id = ? AND provider = ?')
      .run(Date.now(), event.id, 'mock');
    return res.status(200).json({ received: true, ...outcome });
  } catch (err) {
    db.prepare('UPDATE webhook_events SET process_attempts = process_attempts + 1, last_error = ? WHERE id = ? AND provider = ?')
      .run(err.message, event.id, 'mock');
    log.error('webhook processing failed', { eventId: event.id, message: err.message });
    // 500 signals the processor to retry later in a real deployment.
    return res.status(500).json({ received: true, processed: false });
  }
});

function addOrderEvent(orderId, type, detail) {
  db.prepare(`INSERT INTO order_events (id, order_id, type, detail, actor, created_at)
              VALUES (?, ?, ?, ?, 'system', ?)`)
    .run(newId(), orderId, type, detail, Date.now());
}

/** Capture the exact bytes on the wire — signature verification depends on it. */
import express from 'express';
function expressRawBody(req, res, next) {
  express.raw({ type: '*/*', limit: '256kb' })(req, res, next);
}

function processEvent(event) {
  const { paymentRef } = event.data ?? {};
  const payment = paymentRef
    ? db.prepare("SELECT * FROM payments WHERE provider_ref = ? AND provider = 'mock'").get(paymentRef)
    : null;
  if (!payment) throw new Error(`Unknown payment reference ${paymentRef}`);

  if (event.type === 'payment.succeeded') {
    if (payment.status === 'succeeded') return { processed: true, note: 'already_succeeded' };

    db.prepare("UPDATE payments SET status = 'succeeded', updated_at = ? WHERE id = ?")
      .run(Date.now(), payment.id);
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(payment.order_id);

    try {
        transitionOrder({ orderId: order.id, toStatus: 'paid', actor: 'system', detail: `Payment ${payment.provider_ref} settled.` });
      sendConfirmationEmail(order.id);
      return { processed: true };
    } catch (err) {
      if (err.code === 'invalid_transition' && ['cancelled', 'refunded'].includes(order.status)) {
        // Payment landed after the order closed (e.g. reservation expired).
        // Auto-refund honestly rather than taking money for a dead order.
        autoRefundAfterClose(payment, order);
        return { processed: true, note: 'auto_refunded_after_close' };
      }
      throw err;
    }
  }

  if (event.type === 'payment.failed') {
    db.prepare("UPDATE payments SET status = 'failed', failure_reason = ?, updated_at = ? WHERE id = ?")
      .run(event.data.failureReason ?? 'unknown', Date.now(), payment.id);
    addOrderEvent(
      payment.order_id,
      'payment_failed',
      `Payment failed (${event.data.failureReason ?? 'unknown'}). The card was not charged. Reserved items stay held for a short while in case you retry.`,
    );
    return { processed: true };
  }

  if (event.type === 'refund.succeeded') {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(payment.order_id);
    const amountCents = event.data.amountCents ?? payment.amount_cents;

    if (order.status === 'pending') {
      // Out-of-order: refund before settlement. Record, don't coerce.
      addOrderEvent(order.id, 'webhook_ignored',
        `Refund notice arrived while the order was still awaiting payment — nothing to refund yet.`);
      return { processed: true, note: 'ignored_out_of_order' };
    }
    if (order.status === 'refunded') return { processed: true, note: 'already_refunded' };

    db.prepare('UPDATE payments SET refunded_cents = COALESCE(refunded_cents,0) + ?, updated_at = ? WHERE id = ?')
      .run(amountCents, Date.now(), payment.id);
    db.prepare('UPDATE orders SET refund_total_cents = COALESCE(refund_total_cents,0) + ?, updated_at = ? WHERE id = ?')
      .run(amountCents, Date.now(), order.id);
    transitionOrder({
      orderId: order.id,
      toStatus: 'refunded',
      actor: 'admin',
      detail: `Refund of $${(amountCents / 100).toFixed(2)} confirmed by the processor.`,
    });
    return { processed: true };
  }

  addOrderEvent(payment.order_id, 'webhook_unknown_type', `Unrecognised webhook type: ${event.type}`);
  return { processed: true, note: 'unknown_type_recorded' };
}


function sendConfirmationEmail(orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  const email = order.user_id
    ? db.prepare('SELECT email FROM users WHERE id = ?').get(order.user_id)?.email
    : order.guest_email;
  if (!email) return;
  const lines = db.prepare('SELECT product_name AS name, quantity, line_total_cents FROM order_lines WHERE order_id = ?')
    .all(orderId)
    .map((l) => ({ ...l, lineTotal: `$${(l.line_total_cents / 100).toFixed(2)}` }));
  import('../services/email/index.js').then(({ mailer }) => {
    mailer.sendTemplate(email, 'orderConfirmation', {
      orderNumber: order.number,
      total: `$${(order.total_cents / 100).toFixed(2)}`,
      lines,
    }).catch(() => {});
  }).catch(() => {});
}

function autoRefundAfterClose(payment, order) {
  const amount = payment.amount_cents;
  db.transaction(() => {
    db.prepare("UPDATE payments SET status = 'refunded', refunded_cents = ?, updated_at = ? WHERE id = ?")
      .run(amount, Date.now(), payment.id);
    db.prepare('UPDATE orders SET refund_total_cents = COALESCE(refund_total_cents,0) + ?, updated_at = ? WHERE id = ?')
      .run(amount, Date.now(), order.id);
    addOrderEvent(order.id, 'auto_refund',
      `Payment settled after the order was already cancelled. A full refund of $${(amount / 100).toFixed(2)} was issued automatically — no money changes hands.`);
  })();
}

export default router;
