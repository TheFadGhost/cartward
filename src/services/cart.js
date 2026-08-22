import { db } from '../db/index.js';
import { config } from '../config.js';
import { newId, randomToken, sha256 } from '../lib/tokens.js';
import { getVariantForPurchase } from './catalog.js';

export const MAX_QTY_PER_LINE = 20;

const CART_COOKIE = () => config.session.cartCookieName;

// ---------------------------------------------------------------------------
// Cart lifecycle
// ---------------------------------------------------------------------------

function createCart({ userId = null } = {}) {
  const id = newId();
  const now = Date.now();
  const rawToken = userId ? null : randomToken(); // guest carts are cookie-bound
  db.prepare(`
    INSERT INTO carts (id, user_id, cookie_token_hash, status, created_at, updated_at, expires_at)
    VALUES (?, ?, ?, 'active', ?, ?, ?)
  `).run(id, userId, rawToken ? sha256(rawToken) : null, now, now, now + config.cartTtlMs);
  return { id, rawToken };
}

function findActiveCartByCookie(rawToken) {
  if (!rawToken) return null;
  return db.prepare(`
    SELECT * FROM carts WHERE cookie_token_hash = ? AND status = 'active' AND expires_at > ?
  `).get(sha256(rawToken), Date.now()) ?? null;
}

function findActiveUserCart(userId) {
  return db.prepare(`
    SELECT * FROM carts WHERE user_id = ? AND status = 'active' AND expires_at > ?
    ORDER BY updated_at DESC LIMIT 1
  `).get(userId, Date.now()) ?? null;
}

/**
 * Resolve the request's cart. Guests get a persistent cookie-bound cart.
 * Attaches req.cart and handles the guest cookie. Returns the cart row or null.
 */
export function resolveCart(req, res, { createIfMissing = false } = {}) {
  if (req.user && !req.pending2fa) {
    let cart = findActiveUserCart(req.user.id);
    if (!cart && createIfMissing) {
      const created = createCart({ userId: req.user.id });
      cart = db.prepare('SELECT * FROM carts WHERE id = ?').get(created.id);
    }
    return cart;
  }
  const raw = req.cookies[CART_COOKIE()];
  let cart = findActiveCartByCookie(raw);
  if (!cart && createIfMissing) {
    const created = createCart();
    cart = db.prepare('SELECT * FROM carts WHERE id = ?').get(created.id);
    res.setCookie(CART_COOKIE(), created.rawToken, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: config.isProd,
      maxAge: config.cartTtlMs,
    });
  }
  return cart;
}

/**
 * Merge a guest cart into the signed-in user's cart on login.
 * Rule: nothing is ever silently deleted. Conflicting quantities sum, capped
 * at MAX_QTY_PER_LINE and stock limits; unavailable lines carry over and are
 * flagged by the cart view so the shopper decides.
 * Returns { merged, adopted, mergedItems, capped }.
 */
export function mergeGuestCartOnLogin(userId, guestRawToken) {
  const guestCart = findActiveCartByCookie(guestRawToken);
  if (!guestCart || !guestCartHasItems(guestCart.id)) {
    return { merged: false, adopted: false, mergedItems: 0, capped: [] };
  }
  let target = findActiveUserCart(userId);
  if (!target) {
    // Adopt the guest cart directly — cleanest when no account cart exists.
    db.prepare('UPDATE carts SET user_id = ?, cookie_token_hash = NULL, updated_at = ? WHERE id = ?')
      .run(userId, Date.now(), guestCart.id);
    return { merged: true, adopted: true, mergedItems: countItems(guestCart.id), capped: [] };
  }

  const guestItems = db.prepare('SELECT * FROM cart_items WHERE cart_id = ?').all(guestCart.id);
  const capped = [];
  let mergedCount = 0;
  const tx = db.transaction(() => {
    for (const item of guestItems) {
      const variant = getVariantForPurchase(item.variant_id);
      if (!variant || variant.product_status !== 'active') continue; // dead product: leave behind
      const available = variant.stock - variant.reserved;
      const cap = variant.backorderable
        ? MAX_QTY_PER_LINE
        : Math.max(1, Math.min(MAX_QTY_PER_LINE, Math.max(available, 0)));
      const existing = db.prepare('SELECT * FROM cart_items WHERE cart_id = ? AND variant_id = ?')
        .get(target.id, item.variant_id);
      const desiredQty = (existing?.quantity ?? 0) + item.quantity;
      const finalQty = Math.min(desiredQty, cap);
      if (finalQty < desiredQty) capped.push({ name: variant.product_name, kept: finalQty, wanted: desiredQty });
      if (existing) {
        db.prepare('UPDATE cart_items SET quantity = ?, unit_price_snapshot_cents = ?, updated_at = ? WHERE id = ?')
          .run(finalQty, variant.price_cents, Date.now(), existing.id);
      } else {
        db.prepare(`
          INSERT INTO cart_items (id, cart_id, variant_id, quantity, unit_price_snapshot_cents, added_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(newId(), target.id, item.variant_id, finalQty, variant.price_cents, Date.now(), Date.now());
      }
      mergedCount += 1;
    }
    db.prepare(`UPDATE carts SET status = 'converted', updated_at = ? WHERE id = ?`).run(Date.now(), guestCart.id);
    touchCart(target.id);
  });
  tx();
  return { merged: true, adopted: false, mergedItems: mergedCount, capped };
}

function cartHasItems(cartId) {
  return db.prepare('SELECT COUNT(*) n FROM cart_items WHERE cart_id = ?').get(cartId).n > 0;
}
const guestCartHasItems = cartHasItems;
const countItems = (cartId) => db.prepare('SELECT COALESCE(SUM(quantity),0) n FROM cart_items WHERE cart_id = ?').get(cartId).n;

export function touchCart(cartId) {
  const now = Date.now();
  db.prepare('UPDATE carts SET updated_at = ?, expires_at = ? WHERE id = ?').run(now, now + config.cartTtlMs, cartId);
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/**
 * Add a variant. Snapshot price at add time. Quantity is validated against
 * live availability; backorderable variants may exceed on-hand stock up to cap.
 * Returns { ok, line, error } with human-readable error for the shopper.
 */
export function addItem(cartId, variantId, quantity) {
  const qty = Math.trunc(Number(quantity));
  if (!Number.isInteger(qty) || qty < 1) return { ok: false, error: 'Choose a quantity of at least 1.' };

  const variant = getVariantForPurchase(variantId);
  if (!variant || variant.product_status !== 'active') {
    return { ok: false, error: "That item isn't available." };
  }
  const available = variant.stock - variant.reserved;
  const purchasableCap = variant.backorderable
    ? MAX_QTY_PER_LINE
    : Math.min(MAX_QTY_PER_LINE, available);
  if (!variant.backorderable && available <= 0) {
    return { ok: false, error: `${variant.product_name} is out of stock right now.` };
  }
  const finalQty = Math.min(qty, purchasableCap);
  if (finalQty < qty) {
    // Allowed but clamped — report honestly.
  }

  const existing = db.prepare('SELECT * FROM cart_items WHERE cart_id = ? AND variant_id = ?').get(cartId, variantId);
  const tx = db.transaction(() => {
    if (existing) {
      const desired = Math.min(existing.quantity + finalQty, purchasableCap);
      db.prepare('UPDATE cart_items SET quantity = ?, updated_at = ? WHERE id = ?')
        .run(desired, Date.now(), existing.id);
    } else {
      db.prepare(`
        INSERT INTO cart_items (id, cart_id, variant_id, quantity, unit_price_snapshot_cents, added_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(newId(), cartId, variantId, finalQty, variant.price_cents, Date.now(), Date.now());
    }
    touchCart(cartId);
  });
  tx();

  // Honest reporting: tell the shopper when we clamped their request.
  const quantityInCart = existing
    ? Math.min(existing.quantity + finalQty, purchasableCap)
    : finalQty;
  return {
    ok: true,
    clamped: (finalQty < qty || (existing ? existing.quantity + finalQty > purchasableCap : false))
      ? { limit: purchasableCap } : null,
    quantityInCart,
  };
}

export function updateQuantity(cartId, itemId, quantity) {
  const item = db.prepare('SELECT ci.*, v.stock, v.reserved, v.backorderable FROM cart_items ci JOIN variants v ON v.id = ci.variant_id WHERE ci.id = ? AND ci.cart_id = ?')
    .get(itemId, cartId);
  if (!item) return { ok: false, error: "That line isn't in your cart." };
  const qty = Math.trunc(Number(quantity));
  if (Number.isInteger(qty) && qty <= 0) {
    removeItem(cartId, itemId);
    return { ok: true, removed: true };
  }
  if (!Number.isInteger(qty)) return { ok: false, error: 'Enter a whole number of items.' };
  const available = item.stock - item.reserved;
  const cap = item.backorderable ? MAX_QTY_PER_LINE : Math.min(MAX_QTY_PER_LINE, available);
  const finalQty = Math.min(qty, cap);
  db.prepare('UPDATE cart_items SET quantity = ?, updated_at = ? WHERE id = ?').run(finalQty, Date.now(), itemId);
  touchCart(cartId);
  return { ok: true, clamped: finalQty < qty ? { limit: cap } : null };
}

export function removeItem(cartId, itemId) {
  db.prepare('DELETE FROM cart_items WHERE id = ? AND cart_id = ?').run(itemId, cartId);
  touchCart(cartId);
}

/** Full cart view for pages/checkout. Detects price drift vs snapshots. */
export function getCartView(cartId) {
  const rows = db.prepare(`
    SELECT ci.id AS item_id, ci.variant_id, ci.quantity, ci.unit_price_snapshot_cents,
           v.sku, v.option_size, v.option_colour, v.price_cents, v.stock, v.reserved, v.backorderable,
           p.name AS product_name, p.slug AS product_slug, b.name AS brand_name
    FROM cart_items ci
    JOIN variants v ON v.id = ci.variant_id
    JOIN products p ON p.id = v.product_id
    LEFT JOIN brands b ON b.id = p.brand_id
    WHERE ci.cart_id = ?
    ORDER BY ci.added_at, ci.id
  `).all(cartId);

  const lines = rows.map((r) => {
    const available = r.stock - r.reserved;
    const priceChanged = r.unit_price_snapshot_cents !== r.price_cents;
    const insufficient = available <= 0 && !r.backorderable;
    const overAvailable = !r.backorderable && r.quantity > available;
    const variantLabel = [r.option_size, r.option_colour].filter(Boolean).join(' / ');
    return {
      itemId: r.item_id,
      variantId: r.variant_id,
      slug: r.product_slug,
      brand: r.brand_name,
      name: r.product_name,
      variantLabel: variantLabel || 'Standard',
      sku: r.sku,
      quantity: r.quantity,
      snapshotCents: r.unit_price_snapshot_cents,
      currentCents: r.price_cents,
      priceChanged,
      problem: insufficient ? 'out_of_stock' : overAvailable ? 'quantity_limited' : null,
      maxQuantity: r.backorderable ? MAX_QTY_PER_LINE : Math.max(available, 0),
      backordered: available <= 0 && r.backorderable,
      lineTotalCents: r.unit_price_snapshot_cents * r.quantity,
    };
  });

  const hasProblems = lines.some((l) => l.problem || l.priceChanged);
  return {
    lines,
    itemCount: lines.reduce((n, l) => n + l.quantity, 0),
    subtotalCents: lines.reduce((n, l) => n + l.lineTotalCents, 0),
    hasPriceChanges: lines.some((l) => l.priceChanged),
    hasProblems,
    isEmpty: lines.length === 0,
  };
}
