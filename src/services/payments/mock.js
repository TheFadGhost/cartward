import crypto from 'node:crypto';
import { db } from '../../db/index.js';
import { config } from '../../config.js';
import { newId, hmacHex, timingSafeEqual } from '../../lib/tokens.js';
import { log } from '../../lib/logger.js';

/**
 * Mock payment provider — the ONLY implementation shipped enabled.
 * No real credentials exist anywhere; "card" numbers are used purely in
 * memory to select a simulation scenario and are never persisted.
 */

function webhookSecret() {
  // Derived per-install from the generated session secret; never committed.
  return hmacHex(config.sessionSecret, 'cartward-webhook-secret');
}

const SLOW_DELAY_MS = () => Number(process.env.MOCK_PAYMENT_SLOW_DELAY_MS || 4000);
const FAST_DELAY_MS = () => Number(process.env.MOCK_PAYMENT_FAST_DELAY_MS || 600);

// Scenario table keyed by the test-card number typed at sandbox checkout.
const SCENARIOS = {
  '4242424242424242': { kind: 'success', outcome: 'succeeded', delayMs: FAST_DELAY_MS },
  '4000000000000002': { kind: 'decline', reason: 'card_declined', label: 'Your card was declined.', delayMs: FAST_DELAY_MS },
  '4000000000009995': { kind: 'decline', reason: 'insufficient_funds', label: 'The card has insufficient funds.', delayMs: FAST_DELAY_MS },
  '4000000000000069': { kind: 'decline', reason: 'expired_card', label: 'The card has expired.', delayMs: FAST_DELAY_MS },
  '4000000000000341': { kind: 'success', outcome: 'succeeded', delayMs: SLOW_DELAY_MS },
  '4000000000000010': { kind: 'decline', reason: 'processing_error', label: 'An error occurred while processing the card. Try again.', delayMs: SLOW_DELAY_MS },
};

export const TEST_CARDS = [
  { number: '4242 4242 4242 4242', behaviour: 'Approved immediately' },
  { number: '4000 0000 0000 0341', behaviour: 'Approves after a long pause (timeout demo)' },
  { number: '4000 0000 0000 0002', behaviour: 'Declined — card declined' },
  { number: '4000 0000 0000 9995', behaviour: 'Declined — insufficient funds' },
  { number: '4000 0000 0000 0069', behaviour: 'Declined — expired card' },
  { number: '4000 0000 0000 0010', behaviorNote: '', behaviour: 'Fails after a long pause (timeout demo)' },
];

function sanitizeCard(input) {
  return String(input || '').replace(/[\s-]/g, '');
}

/** Sign a payload exactly the way deliveries are verified. */
export function signPayload(timestamp, body) {
  return hmacHex(webhookSecret(), `${timestamp}.${body}`);
}

export function verifySignature(headerValue, rawBody, now = Date.now()) {
  const m = /^t=(\d+),v1=([0-9a-f]+)$/.exec(String(headerValue || ''));
  if (!m) return false;
  const t = Number(m[1]);
  if (!Number.isFinite(t)) return false;
  // Replay window: 5 minutes.
  if (Math.abs(now - t * 1000) > 5 * 60 * 1000) return false;
  return timingSafeEqual(signPayload(t, rawBody), m[2]);
}

async function deliverWebhook(event, { corruptSignature = false, times = 1, delayMs = 0 } = {}) {
  const send = async () => {
    const body = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    let sig = `t=${t},v1=${signPayload(t, body)}`;
    if (corruptSignature) sig = `t=${t},v1=${'0'.repeat(64)}`;
    try {
      await fetch(`${config.baseUrl}/webhooks/payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Cartward-Signature': sig },
        body,
      });
      log.info('webhook delivered', { type: event.type, eventId: event.id });
    } catch (err) {
      log.error('webhook delivery failed', { eventId: event.id, message: err.message });
    }
  };
  for (let i = 0; i < times; i++) {
    if (delayMs > 0) setTimeout(send, delayMs + (i === 1 ? 50 : 0));
    else setTimeout(send, i === 1 ? 50 : 0);
  }
}

let evtCounter = 0;
function makeEvent(type, data) {
  evtCounter += 1;
  return {
    id: `evt_${Date.now().toString(36)}_${evtCounter}_${crypto.randomBytes(4).toString('hex')}`,
    type,
    created: Math.floor(Date.now() / 1000),
    data,
  };
}

export const mockProvider = {
  name: 'mock',

  /**
   * Start a payment. Returns { paymentRef, status, failureReason? }.
   * Webhooks arrive asynchronously — that's the point.
   */
  createPayment({ order, totalCents, cardNumber, simulate = {} }) {
    const digits = sanitizeCard(cardNumber);
    if (!/^\d{16}$/.test(digits)) {
      return { ok: false, error: 'Enter a 16-digit card number.' };
    }
    const scenario = SCENARIOS[digits] ?? SCENARIOS['4242424242424242'];
    const paymentId = newId();
    const providerRef = `ch_${crypto.randomBytes(10).toString('hex')}`;

    db.prepare(`
      INSERT INTO payments (id, order_id, provider, provider_ref, amount_cents, status, scenario, created_at, updated_at)
      VALUES (?, ?, 'mock', ?, ?, ?, ?, ?, ?)
    `).run(paymentId, order.id, providerRef, totalCents,
      scenario.kind === 'success' ? 'processing' : 'requires_action',
      digits, Date.now(), Date.now());

    const baseData = { paymentRef: providerRef, orderId: order.id, amountCents: totalCents };
    if (scenario.kind === 'success') {
      const event = makeEvent('payment.succeeded', baseData);
      deliverWebhook(event, {
        times: simulate.duplicate ? 2 : 1,
        delayMs: typeof scenario.delayMs === 'function' ? scenario.delayMs() : scenario.delayMs,
      });
      if (simulate.outOfOrder) {
        // A refund notice that arrives before the payment succeeded.
        deliverWebhook(makeEvent('refund.succeeded', baseData), { delayMs: 100 });
      }
    } else {
      const event = makeEvent('payment.failed', { ...baseData, failureReason: scenario.reason, message: scenario.label });
      deliverWebhook(event, { delayMs: typeof scenario.delayMs === 'function' ? scenario.delayMs() : scenario.delayMs });
    }
    if (simulate.invalidSignature) {
      deliverWebhook(makeEvent('payment.succeeded', baseData), { corruptSignature: true, delayMs: 150 });
    }

    return {
      ok: true,
      paymentId,
      providerRef,
      status: scenario.kind === 'success' ? 'processing' : 'requires_action',
      hint: scenario.label ?? null,
    };
  },

  /** Issue a refund through the mock processor; confirmed via webhook. */
  refund(providerRef, amountCents) {
    const row = db.prepare('SELECT * FROM payments WHERE provider_ref = ?').get(providerRef);
    if (!row) return { ok: false, error: 'Payment not found.' };
    if (row.status !== 'succeeded') return { ok: false, error: 'Only settled payments can be refunded.' };
    db.prepare(`UPDATE payments SET refunded_cents = MIN(amount_cents, refunded_cents + ?),
                status = CASE WHEN refunded_cents + ? >= amount_cents THEN 'refunded' ELSE 'partially_refunded' END,
                updated_at = ? WHERE provider_ref = ?`)
      .run(amountCents, amountCents, Date.now(), providerRef);
    deliverWebhook(makeEvent('refund.succeeded', {
      paymentRef: providerRef,
      orderId: row.order_id,
      amountCents,
    }), { delayMs: FAST_DELAY_MS() });
    return { ok: true };
  },
};

export default mockProvider;
