// Money is represented as integer minor units ("cents") everywhere.
// Floats are never used for arithmetic on amounts.

const formatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
});

/** Format integer cents as "US$1,234.56"-style USD string: "$12.34". */
export function formatMoney(cents) {
  if (!Number.isInteger(cents)) throw new TypeError(`formatMoney expects integer cents, got ${cents}`);
  return formatter.format(cents / 100);
}

/** Parse a user-entered decimal like "19.99" into integer cents, or null when invalid. */
export function parseMoneyToCents(input) {
  if (typeof input !== 'string' && typeof input !== 'number') return null;
  const str = String(input).trim().replace(/^\$/, '');
  if (!/^\d{1,7}(\.\d{2})?$/.test(str)) return null;
  const [whole, frac = ''] = str.split('.');
  return Number(whole) * 100 + Number((frac + '00').slice(0, 2));
}

/**
 * Percentage of an amount in cents, rounded half-up to the nearest cent.
 * Pure integer arithmetic: pct is an integer percent (0-100).
 */
export function percentOf(amountCents, pct) {
  if (!Number.isInteger(amountCents) || !Number.isInteger(pct)) {
    throw new TypeError('percentOf expects integers');
  }
  return Math.trunc((amountCents * pct + 50) / 100);
}

/**
 * Basis-points share of an amount in cents, rounded half-up to nearest cent.
 * rateBp 700 == 7%.
 */
export function bpOf(amountCents, rateBp) {
  if (!Number.isInteger(amountCents) || !Number.isInteger(rateBp)) {
    throw new TypeError('bpOf expects integers');
  }
  return Math.trunc((amountCents * rateBp + 5000) / 10000);
}

