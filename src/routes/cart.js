import { Router } from 'express';
import {
  resolveCart, addItem, updateQuantity, removeItem, getCartView,
} from '../services/cart.js';

const router = Router();

router.get('/cart', (req, res) => {
  const cart = resolveCart(req, res);
  const view = cart ? getCartView(cart.id) : { lines: [], isEmpty: true, itemCount: 0, subtotalCents: 0, hasPriceChanges: false, hasProblems: false };
  res.render('cart/show', {
    title: 'Your cart',
    cart: view,
    csrfToken: req.csrfToken(),
  });
});

router.post('/cart/add', (req, res) => {
  const cart = resolveCart(req, res, { createIfMissing: true });
  const variantId = String(req.body.variant_id || '');
  const quantity = req.body.quantity || 1;

  const result = addItem(cart.id, variantId, quantity);
  if (!result.ok) {
    return res.status(422).render('error', {
      title: 'Item unavailable',
      message: result.error,
      statusCode: 422,
    });
  }
  if (result.clamped) {
    res.flash('warn', `Quantity limited to ${result.clamped.limit} of that item — that's all the stock allows.`);
  } else if (result.quantityInCart > Number(quantity)) {
    // Merged into an existing line; neutral confirmation is fine.
  }
  return res.redirect('/cart');
});

router.post('/cart/update', (req, res) => {
  const cart = resolveCart(req, res);
  if (!cart) return res.redirect('/cart');
  const result = updateQuantity(cart.id, String(req.body.item_id || ''), req.body.quantity);
  if (result.clamped) {
    res.flash('warn', `That's more than we have in stock — kept it at ${result.clamped.limit}.`);
  }
  return res.redirect('/cart');
});

router.post('/cart/remove', (req, res) => {
  const cart = resolveCart(req, res);
  if (cart) removeItem(cart.id, String(req.body.item_id || ''));
  return res.redirect('/cart');
});

export default router;
