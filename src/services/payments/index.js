import mockProvider from './mock.js';

/**
 * Payment provider abstraction. The application only talks to this interface:
 * createPayment / refund / webhook verification. Shipping exactly one
 * implementation (mock) keeps the demo sandbox-only by construction.
 */
const providers = { mock: mockProvider };

export function getPaymentProvider(name = 'mock') {
  const p = providers[name];
  if (!p) throw new Error(`Unknown payment provider: ${name}`);
  return p;
}

export { TEST_CARDS } from './mock.js';
