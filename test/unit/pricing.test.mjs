// IMPORTANT: harness first so the isolated per-run database exists, then
// seed the reference data that evaluateDiscount reads.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../helpers/harness.js';
import { computeTotals, evaluateDiscount, computeShippingCents } from '../../src/services/pricing.js';
import { seed } from '../../src/services/seed.mjs';

await seed({});
void db;

describe('totals pipeline (fixed expected values)', () => {
  it('computes the documented example exactly', () => {
    // 2 × $19.99, WELCOME10 (10%), standard shipping to NY (7%).
    const lines = [{ lineTotalCents: 1999 }, { lineTotalCents: 1999 }];
    const discount = evaluateDiscount('WELCOME10', 3998);
    assert.ok(discount.ok && !discount.unused);
    const totals = computeTotals({ lines, shippingMethodId: 'standard', discount, shipState: 'NY' });
    assert.equal(totals.subtotalCents, 3998);
    assert.equal(totals.discountCents, 400);        // 399.8 rounds half-up
    assert.equal(totals.shippingCents, 495);         // below free threshold
    assert.equal(totals.taxCents, 252);              // 7% of 3598 = 251.86 → 252
    assert.equal(totals.totalCents, 4345);           // 3598 + 495 + 252
  });

  it('free shipping compares against the discounted subtotal', () => {
    const lines = [{ lineTotalCents: 8000 }];
    const discount = evaluateDiscount('TAKE5OFF', 8000); // $5 off
    const totals = computeTotals({ lines, shippingMethodId: 'standard', discount, shipState: '' });
    assert.equal(totals.discountCents, 500);
    assert.equal(totals.shippingFreeApplied, true);   // 7500 >= 7500
    assert.equal(totals.shippingCents, 0);
    assert.equal(totals.totalCents, 7500);
  });

  it('fixed discounts never exceed the subtotal', () => {
    const discount = evaluateDiscount('TAKE5OFF', 300); // below min anyway
    assert.equal(discount.ok, false);
    const big = evaluateDiscount('TAKE5OFF', 3000);
    assert.equal(big.discountCents, 500);
  });

  it('tax is zero for states without a configured rate', () => {
    const totals = computeTotals({
      lines: [{ lineTotalCents: 10000 }],
      shippingMethodId: 'express',
      discount: null,
      shipState: 'OR',
    });
    assert.equal(totals.taxCents, 0);
    assert.equal(totals.shippingCents, 1295);
    assert.equal(totals.totalCents, 11295);
  });

  it('rejects expired and unknown codes', () => {
    assert.equal(evaluateDiscount('EXPIRED2024', 100000).ok, false);
    assert.equal(evaluateDiscount('NOPE', 100000).ok, false);
    assert.equal(evaluateDiscount('', 100000).unused, true);
  });

  it('express shipping has no free tier', () => {
    assert.equal(computeShippingCents('express', 999999).cents, 1295);
    assert.equal(computeShippingCents('express', 999999).freeApplied, false);
  });
});
