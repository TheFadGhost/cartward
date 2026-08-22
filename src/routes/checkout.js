import { Router } from 'express';
import { db } from '../db/index.js';
import { resolveCart, getCartView } from '../services/cart.js';
import {
  saveCheckoutAddress, saveShippingMethod, saveDiscountCode,
  previewTotals, placeOrder, randomIdempotencyKey, CheckoutError,
} from '../services/checkout.js';
import { SHIPPING_METHODS, getShippingMethod, computeShippingCents } from '../services/pricing.js';
import { getOrderById, getOrderEvents } from '../services/orders.js';
import { getOrderLines, orderBelongsTo } from '../services/checkout.js';
import { rateLimitMiddleware } from '../lib/rate-limit.js';
import { hmacHex, sha256 } from '../lib/tokens.js';
const tokenLib = { sha256 };
import { config } from '../config.js';
import { TEST_CARDS } from '../services/payments/index.js';
import { getPaymentProvider } from '../services/payments/index.js';

const router = Router();
const provider = () => getPaymentProvider('mock');

function requireActiveCart(req, res) {
  const cart = resolveCart(req, res);
  if (!cart || getCartView(cart.id).isEmpty) {
    res.flash('warn', 'Your cart is empty.');
    res.redirect('/cart');
    return null;
  }
  return cart;
}

// --- Step 1: contact & address ----------------------------------------------

router.get('/checkout', (req, res) => {
  const cart = requireActiveCart(req, res);
  if (!cart) return;
  const draft = cart.checkout_address_json ? JSON.parse(cart.checkout_address_json) : {};
  draft.email ??= req.user?.email ?? '';
  res.render('checkout/address', {
    title: 'Checkout — address',
    step: 1,
    values: draft,
    errors: {},
  });
});

const ipOf = (req) => req.ip || 'unknown';

router.post('/checkout/address', (req, res) => {
  const cart = requireActiveCart(req, res);
  if (!cart) return;
  try {
    saveCheckoutAddress(cart.id, req.body);
    return res.redirect('/checkout/delivery');
  } catch (err) {
    if (!(err instanceof CheckoutError)) throw err;
    return res.status(422).render('checkout/address', {
      title: 'Checkout — address',
      step: 1,
      values: req.body,
      errors: err.fieldErrors ?? {},
      formError: err.message,
    });
  }
});

// --- Step 2: delivery --------------------------------------------------------

router.get('/checkout/delivery', (req, res) => {
  const cart = requireActiveCart(req, res);
  if (!cart) return;
  if (!cart.checkout_address_json) return res.redirect('/checkout');
  const preview = previewTotals(cart);
  const options = SHIPPING_METHODS.map((m) => ({
    ...m,
    effectiveCents: computeShippingCents(m.id, preview.totals ? preview.totals.subtotalCents - preview.totals.discountCents : 0).cents,
  }));
  res.render('checkout/delivery', {
    title: 'Checkout — delivery',
    step: 2,
    options,
    selected: cart.checkout_shipping_method ?? 'standard',
    csrfToken: req.csrfToken(),
    view: preview.view,
  });
});

router.post('/checkout/delivery', (req, res) => {
  const cart = requireActiveCart(req, res);
  if (!cart) return;
  try {
    saveShippingMethod(cart.id, String(req.body.shipping_method || ''));
    return res.redirect('/checkout/review');
  } catch (err) {
    if (!(err instanceof CheckoutError)) throw err;
    res.flash('warn', err.message);
    return res.redirect('/checkout/delivery');
  }
});

// --- Discount code ------------------------------------------------------------

router.post('/checkout/discount', (req, res) => {
  const cart = requireActiveCart(req, res);
  if (!cart) return;
  const code = String(req.body.code || '');
  saveDiscountCode(cart.id, code);
  if (code.trim() === '') {
    res.flash('success', 'Discount code removed.');
  } else {
    // Honest feedback via evaluate on current subtotal.
    const preview = previewTotals({ ...cart, checkout_discount_code: code });
    if (preview.discount.ok && !preview.discount.unused) {
      res.flash('success', `Code ${code.toUpperCase()} applied.`);
    } else {
      res.flash('warn', preview.discount.ok ? 'Enter a code first.' : preview.discount.error);
    }
  }
  return res.redirect('/checkout/review');
});

// --- Step 3: review & pay ------------------------------------------------------

router.get('/checkout/review', (req, res) => {
  const cart = requireActiveCart(req, res);
  if (!cart) return;
  if (!cart.checkout_address_json) return res.redirect('/checkout');
  if (!cart.checkout_shipping_method) return res.redirect('/checkout/delivery');

  if (!cart.idempotency_key) {
    db.prepare('UPDATE carts SET idempotency_key = ?, updated_at = ? WHERE id = ?')
      .run(randomIdempotencyKey(), Date.now(), cart.id);
    cart.idempotency_key = null;
  }
  const fresh = { ...cart };
  void fresh;
  const row = db.prepare('SELECT idempotency_key FROM carts WHERE id = ?').get(cart.id);

  const preview = previewTotals(db.prepare('SELECT * FROM carts WHERE id = ?').get(cart.id));
  res.render('checkout/review', {
    title: 'Checkout — review',
    step: 3,
    ...preview,
    options: SHIPPING_METHODS,
    idempotencyKey: row?.idempotency_key ?? '',
    testCards: TEST_CARDS,
    csrfToken: req.csrfToken(),
  });
});

router.post('/checkout/place',
  rateLimitMiddleware({ name: 'place-order', keyFn: ipOf, limit: 30, windowMs: 10 * 60 * 1000 }),
  (req, res, next) => {
    let cart = resolveCart(req, res);
    if (!cart && req.cookies[config.session.cartCookieName]) {
      // The cart may already be 'converted' by an earlier identical submission.
      // Recover it so the idempotency dedupe can return the SAME order.
      const { sha256 } = tokenLib;
      cart = db.prepare('SELECT * FROM carts WHERE cookie_token_hash = ?')
        .get(sha256(req.cookies[config.session.cartCookieName])) ?? null;
    }
    if (!cart) return res.redirect('/cart');
    try {
      const key = String(req.body._ik || '');
      // The rendered key must be the one bound to this cart. A matching key
      // proceeds even if the cart was already converted: placeOrder's
      // transactional dedupe returns the SAME order (double-click safety).
      const stored = db.prepare('SELECT idempotency_key FROM carts WHERE id = ?').get(cart.id);
      if (!stored || stored.idempotency_key !== key) {
        return res.redirect('/checkout/review');
      }
      const result = placeOrder({
        cart,
        userId: req.user && !req.pending2fa ? req.user.id : null,
        idempotencyKey: key,
      });
      void result.replayed;
      return res.redirect(`/checkout/pay/${result.order.id}`);
    } catch (err) {
      if (!(err instanceof CheckoutError)) return next(err);
      if (['out_of_stock', 'cart_problems', 'empty_cart'].includes(err.code)) {
        res.flash('warn', err.message);
        return res.redirect('/cart');
      }
      res.flash('warn', err.message);
      return res.redirect('/checkout/review');
    }
  });

// --- Sandbox payment -------------------------------------------------------------

function canViewPendingOrder(req, order) {
  if (orderBelongsTo(order, req.user && !req.pending2fa ? req.user.id : null)) return true;
  // Pre-payment capability: the unguessable order id itself authorises guests
  // who just placed the order. Post-payment views require ownership or tracking details.
  return order.status === 'pending';
}

function pollToken(orderId) {
  return hmacHex(config.sessionSecret, `poll:${orderId}`);
}

router.get('/checkout/pay/:id', (req, res, next) => {
  try {
    const order = getOrderById(req.params.id);
    if (!order || !canViewPendingOrder(req, order)) {
      return res.status(404).render('error', { title: 'Order not found', message: "We couldn't find that order.", statusCode: 404 });
    }
    const payment = db.prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY created_at DESC LIMIT 1').get(order.id);
    const lines = getOrderLines(order.id);
    return res.render('checkout/pay', {
      title: 'Checkout — payment',
      order,
      lines,
      payment,
      failureReason: payment?.status === 'failed'
        ? (payment.failure_reason === 'card_declined' ? 'Your card was declined.'
          : payment.failure_reason === 'insufficient_funds' ? 'The card has insufficient funds.'
            : payment.failure_reason === 'expired_card' ? 'The card has expired.'
              : 'The payment could not be processed.')
        : null,
      testCards: TEST_CARDS,
      pollToken: pollToken(order.id),
      baseUrl: config.baseUrl,
      csrfToken: req.csrfToken(),
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/checkout/pay/:id', (req, res, next) => {
  try {
    const order = getOrderById(req.params.id);
    if (!order || !canViewPendingOrder(req, order)) {
      return res.status(404).render('error', { title: 'Order not found', message: "We couldn't find that order.", statusCode: 404 });
    }
    if (order.status !== 'pending') return res.redirect(orderUrl(req, order));

    const result = provider().createPayment({
      order,
      totalCents: order.total_cents,
      cardNumber: req.body.card_number,
      simulate: {
        duplicate: req.body.simulate_duplicate === 'on',
        invalidSignature: req.body.simulate_invalid_signature === 'on',
        outOfOrder: req.body.simulate_out_of_order === 'on',
      },
    });
    if (!result.ok) {
      res.flash('warn', result.error);
      return res.redirect(`/checkout/pay/${order.id}`);
    }
    return res.redirect(`/checkout/pay/${order.id}?await=1`);
  } catch (err) {
    return next(err);
  }
});

function orderUrl(req, order) {
  if (orderBelongsTo(order, req.user && !req.pending2fa ? req.user.id : null)) return `/orders/${order.id}`;
  return `/orders/track?number=${encodeURIComponent(order.number)}&email=${encodeURIComponent(guestEmailOf(order))}`;
}
function guestEmailOf(order) {
  return order.guest_email
    ?? JSON.parse(order.shipping_address_json)?.email
    ?? '';
}

export default router;
