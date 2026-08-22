import { db } from '../db/index.js';
import { percentOf, bpOf } from '../lib/money.js';

/**
 * Pluggable pricing rules. Swap these modules to change commercial behaviour;
 * the checkout pipeline only depends on the interfaces below.
 *
 * Money convention (see DESIGN.md):
 *   subtotal  = sum of line totals at the prices being charged today
 *   discount  = applied to subtotal (one code, best-effort validation)
 *   shipping  = method rate; free-over thresholds compare against the DISCOUNTED subtotal
 *   tax       = basis points of (subtotal - discount), rounded half-up
 *   total     = subtotal - discount + shipping + tax
 */

// --- Shipping ---------------------------------------------------------------

export const SHIPPING_METHODS = [
  {
    id: 'standard',
    label: 'Standard delivery',
    estimate: '3–5 business days',
    priceCents: 495,
    freeOverCents: 7500,
  },
  {
    id: 'express',
    label: 'Express delivery',
    estimate: '1–2 business days',
    priceCents: 1295,
    freeOverCents: null,
  },
];

export function getShippingMethod(id) {
  return SHIPPING_METHODS.find((m) => m.id === id) ?? null;
}

export function computeShippingCents(methodId, discountedSubtotalCents) {
  const method = getShippingMethod(methodId);
  if (!method) throw new Error(`Unknown shipping method: ${methodId}`);
  if (method.freeOverCents !== null && discountedSubtotalCents >= method.freeOverCents) {
    return { cents: 0, freeApplied: true };
  }
  return { cents: method.priceCents, freeApplied: false };
}

// --- Tax --------------------------------------------------------------------
// Demonstration configuration: a flat sales-tax rate applied only to orders
// shipping to a few demo states. Replace via the same interface.

const TAX_STATE_RATES_BP = {
  CA: 700,
  NY: 700,
  TX: 625,
};

export function computeTax(stateCode, taxableCents) {
  const state = String(stateCode || '').toUpperCase();
  const rateBp = TAX_STATE_RATES_BP[state] ?? 0;
  return { cents: bpOf(taxableCents, rateBp), rateBp, state };
}

// --- Discounts ----------------------------------------------------------------

export function evaluateDiscount(code, subtotalCents, now = Date.now()) {
  if (!code || !String(code).trim()) return { ok: true, unused: true };
  const row = db.prepare('SELECT * FROM discount_codes WHERE code = ? COLLATE NOCASE').get(String(code).trim());
  if (!row || !row.active) return { ok: false, error: "That code doesn't exist." };
  if (row.starts_at && now < row.starts_at) return { ok: false, error: 'That code is not active yet.' };
  if (row.expires_at && now > row.expires_at) return { ok: false, error: 'That code has expired.' };
  if (subtotalCents < row.min_subtotal_cents) {
    return { ok: false, error: `That code needs a subtotal of at least $${(row.min_subtotal_cents / 100).toFixed(2)}.` };
  }
  let discountCents;
  if (row.kind === 'percent') {
    discountCents = percentOf(subtotalCents, Math.min(100, row.value));
  } else {
    discountCents = Math.min(row.value, subtotalCents);
  }
  return { ok: true, unused: false, id: row.id, code: row.code, kind: row.kind, discountCents };
}

// --- Totals pipeline ----------------------------------------------------------

/**
 * Compute an order total breakdown. Pure function over validated inputs.
 * @param {Array<{lineTotalCents:number}>} lines
 */
export function computeTotals({ lines, shippingMethodId, discount = null, shipState = '' }) {
  const subtotalCents = lines.reduce((n, l) => n + l.lineTotalCents, 0);
  const discountCents = discount?.ok && !discount.unused ? discount.discountCents : 0;
  const discounted = subtotalCents - discountCents;
  const shipping = computeShippingCents(shippingMethodId, discounted);
  const tax = computeTax(shipState, discounted);
  const totalCents = discounted + shipping.cents + tax.cents;
  return {
    subtotalCents,
    discountCents,
    shippingCents: shipping.cents,
    shippingFreeApplied: shipping.freeApplied,
    taxCents: tax.cents,
    taxRateBp: tax.rateBp,
    totalCents,
  };
}
