import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const { db } = await import('../db/index.js');
const { config } = await import('../config.js');
const { generateProductSvg } = await import('../../scripts/lib/artwork.mjs');
const { newId } = await import('../lib/tokens.js');
const { hashPassword } = await import('./auth.js');

// ---------------------------------------------------------------------------
// Synthetic reference data â€” all names, brands and addresses are fictional.
// ---------------------------------------------------------------------------

const BRANDS = ['Ardent Forge', 'Mossline', 'Tidal & Timber', 'Fenwick Goods', 'Lumen Yard', 'Copperleaf Studio', 'Driftwell Supply', 'Harrow Lane'];
const CATEGORIES = [
  ['Kitchen & Dining', 'Tools and tableware for slow mornings and long dinners.'],
  ['Home & Office', 'Quiet objects that make desks and shelves feel considered.'],
  ['Outdoor', 'Field-tested gear for weather, walks and weekends away.'],
  ['Lighting', 'Lamps and candles tuned for evening hours.'],
  ['Textiles', 'Wool, linen and cotton woven to be used hard and often.'],
  ['Stationery', 'Paper goods for people who still write things down.'],
];
const TAGS = ['handmade', 'ceramic', 'oak', 'wool', 'linen', 'recycled', 'small-batch', 'brass', 'enamel', 'waxed-canvas', 'stoneware', 'cotton'];

const SIZES = {
  none: [null],
  apparel: ['Small', 'Medium', 'Large'],
  bags: ['Compact', 'Standard'],
};
const COLOURWAYS = {
  none: [null],
  warm: ['Ochre', 'Clay', 'Natural'],
  cool: ['Slate', 'Fog', 'Moss'],
};

/**
 * [name, brandIdx, catIdx, basePriceCents, sizeSet, colourSet, tagIdxs, stockPlan]
 * stockPlan: healthy | low | out | backorder | mixed
 */
export const CATALOGUE = [
  ['Pour-Over Kettle No. 4', 0, 0, 8400, 'none', 'none', [0, 7], 'healthy'],
  ['Stoneware Pour-Over Set', 1, 0, 4600, 'none', 'warm', [1, 6], 'mixed'],
  ['Everyday Enamel Mug', 3, 0, 1800, 'none', 'cool', [8], 'healthy'],
  ['Maple Serving Board', 2, 0, 5200, 'bags', 'none', [2, 6], 'low'],
  ['Cast Iron Trivet Trio', 0, 0, 3400, 'none', 'none', [0, 7], 'healthy'],
  ['Linen Apron', 7, 0, 4800, 'apparel', 'warm', [4, 0], 'mixed'],
  ['Walnut Desk Tray', 5, 1, 3800, 'bags', 'none', [2, 6], 'healthy'],
  ['Brass Desk Lamp', 4, 3, 12800, 'none', 'none', [7, 0], 'low'],
  ['Recycled Wool Throw', 1, 4, 9600, 'none', 'cool', [3, 5], 'healthy'],
  ['Field Notebook, Three-Pack', 6, 5, 1400, 'none', 'none', [11, 6], 'healthy'],
  ['Waxed Canvas Rucksack', 2, 2, 14800, 'bags', 'none', [9, 6], 'mixed'],
  ['Enamel Camp Plate Pair', 3, 2, 2600, 'none', 'cool', [8], 'healthy'],
  ['Oak Bookend Duo', 5, 1, 4200, 'none', 'none', [2], 'low'],
  ['Hand-Dipped Taper Candles', 4, 3, 2200, 'none', 'warm', [0, 6], 'healthy'],
  ['Merino Hiking Socks', 7, 2, 2400, 'apparel', 'none', [3], 'mixed'],
  ['Ceramic Butter Keeper', 1, 0, 3200, 'none', 'warm', [1, 0], 'healthy'],
  ['Linen Table Runner', 7, 4, 5600, 'none', 'cool', [4], 'low'],
  ['Copper Measuring Spoons', 5, 0, 2800, 'none', 'none', [7, 6], 'healthy'],
  ['Canvas Tool Roll', 6, 2, 6400, 'bags', 'warm', [9, 6], 'healthy'],
  ['Aluminium Camp Stool', 2, 2, 7800, 'none', 'none', [], 'out'],
  ['Wool Lumbar Pillow', 1, 4, 6800, 'none', 'cool', [3, 5], 'healthy'],
  ['Pocket Weekly Planner', 6, 5, 1900, 'none', 'none', [11], 'healthy'],
  ['Stoneware Dinner Plates, Four', 1, 0, 8800, 'none', 'warm', [1, 10, 6], 'mixed'],
  ['Pendant Light Cord Kit', 4, 3, 4400, 'none', 'none', [7], 'backorder'],
  ['Beeswax Wood Balm', 3, 1, 1600, 'none', 'none', [0, 6], 'healthy'],
  ['Fireside Wool Slippers', 7, 4, 5900, 'apparel', 'none', [3, 0], 'mixed'],
  ['Galvanised Watering Can', 2, 2, 4700, 'bags', 'none', [], 'healthy'],
  ['Letterpress Notecards', 6, 5, 2100, 'none', 'warm', [0, 11], 'low'],
  ['Cast Iron Skillet, 26 cm', 0, 0, 9200, 'none', 'none', [0], 'healthy'],
  ['Cotton Hammock', 2, 2, 8300, 'none', 'cool', [11], 'out'],
  ['Oak Wall Shelf', 5, 1, 7200, 'bags', 'none', [2, 6], 'healthy'],
  ['Soy Candle, Cedar & Smoke', 4, 3, 2600, 'none', 'none', [6], 'healthy'],
  ['Flannel Picnic Blanket', 7, 4, 5400, 'none', 'warm', [11, 5], 'healthy'],
  ['Stainless Lunch Tin', 3, 0, 3100, 'bags', 'none', [], 'backorder'],
  ['Leather Journal Cover', 6, 5, 6900, 'none', 'warm', [0, 6], 'low'],
  ['Ceramic Vase, Tall', 1, 1, 7600, 'none', 'warm', [1, 0, 6], 'healthy'],
];

const OPENERS = [
  'Made in small runs, finished by hand.',
  'Built around one honest material.',
  'Designed to be repaired, not replaced.',
  'The kind of object that improves with use.',
];
const CLOSERS = [
  'Ships flat-packed where sensible to cut packaging waste.',
  'Each piece varies slightly â€” that is the point.',
  'Care instructions included; questions welcome.',
  'If it ever fails through ordinary use, we want to hear about it.',
];

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function uniqueSlug(base, table) {
  let candidate = slugify(base);
  let n = 2;
  while (db.prepare(`SELECT id FROM ${table} WHERE slug = ?`).get(candidate)) candidate = `${slugify(base)}-${n++}`;
  return candidate;
}

function rngFrom(seedStr) {
  const h = crypto.createHash('sha256').update(seedStr).digest();
  let s = h.readUInt32LE(0);
  return () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function createUserRow(email, password, role) {
  const id = newId();
  const now = Date.now();
  db.prepare(`
    INSERT INTO users (id, email, password_hash, role, email_verified_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, email, await hashPassword(password), role, now, now, now);
  return id;
}

/** Seed the database with a synthetic catalogue and demo accounts. */
export async function seed({ fresh = false } = {}) {
  if (db.prepare('SELECT COUNT(*) n FROM products').get().n > 0 && !fresh) {
    return { seeded: false, reason: 'already-populated' };
  }

  if (fresh) {
    console.log('[seed] --fresh: clearing existing data');
    const tables = [
      'order_events', 'order_lines', 'reservations', 'payments', 'webhook_events',
      'orders', 'cart_items', 'carts', 'audit_log', 'verification_tokens',
      'recovery_codes', 'sessions', 'product_images', 'product_tags', 'variants',
      'products', 'tags', 'categories', 'brands', 'discount_codes', 'users', 'emails_out', 'rate_limits',
    ];
    for (const t of tables) db.prepare(`DELETE FROM ${t}`).run();
  }

  const brandIds = BRANDS.map((name) => {
    const id = newId();
    db.prepare('INSERT INTO brands (id, name, slug) VALUES (?, ?, ?)').run(id, name, uniqueSlug(name, 'brands'));
    return id;
  });
  const categoryIds = CATEGORIES.map(([name, description]) => {
    const id = newId();
    db.prepare('INSERT INTO categories (id, name, slug, description) VALUES (?, ?, ?, ?)')
      .run(id, name, uniqueSlug(name, 'categories'), description);
    return id;
  });
  const tagIds = TAGS.map((name) => {
    const id = newId();
    db.prepare('INSERT INTO tags (id, name, slug) VALUES (?, ?, ?)').run(id, name, uniqueSlug(name, 'tags'));
    return id;
  });

  const uploadProductDir = path.join(config.uploadDir, 'products');
  fs.mkdirSync(uploadProductDir, { recursive: true });

  let skuCounter = 1000;
  const insertImage = db.prepare(`
    INSERT INTO product_images (id, product_id, filename, alt_text, width, height, sort_order, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

  for (const [name, brandIdx, catIdx, basePrice, sizeSetKey, colourSetKey, tagIdxs, stockPlan] of CATALOGUE) {
    const rand = rngFrom(name);
    const productId = newId();
    const now = Date.now();

    db.prepare(`
      INSERT INTO products (id, brand_id, category_id, name, slug, description, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(productId, brandIds[brandIdx], categoryIds[catIdx], name, uniqueSlug(name, 'products'),
      `${OPENERS[Math.floor(rand() * OPENERS.length)]} The ${name.toLowerCase()} is made by ${BRANDS[brandIdx]} â€” fictional makers, real attention to detail.\n\n${CLOSERS[Math.floor(rand() * CLOSERS.length)]}`,
      now - Math.floor(rand() * 120 * 24 * 3600 * 1000), now);

    for (const ti of tagIdxs) {
      db.prepare('INSERT INTO product_tags (product_id, tag_id) VALUES (?, ?)').run(productId, tagIds[ti]);
    }

    const sizes = SIZES[sizeSetKey];
    const colours = COLOURWAYS[colourSetKey];
    const combos = [];
    for (const s of sizes) for (const c of colours) combos.push([s, c]);
    const chosenCombos = combos.length > 3 ? combos.slice(0, 3) : combos;

    chosenCombos.forEach(([size, colour], vi) => {
      const variantId = newId();
      let stock;
      switch (stockPlan) {
        case 'low': stock = 1 + Math.floor(rand() * 5); break;
        case 'out': stock = 0; break;
        case 'backorder': stock = 0; break;
        case 'mixed': stock = vi === 0 ? Math.floor(rand() * 6) : 10 + Math.floor(rand() * 25); break;
        default: stock = 12 + Math.floor(rand() * 28);
      }
      const priceDelta = colour ? [0, 200, -100][vi % 3] : 0;
      const sku = `CW-${skuCounter++}`;
      db.prepare(`
        INSERT INTO variants (id, product_id, sku, option_size, option_colour, price_cents, stock, reserved, backorderable, weight_grams, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
      `).run(variantId, productId, sku, size, colour,
        basePrice + priceDelta, stock,
        stockPlan === 'backorder' ? 1 : 0,
        150 + Math.floor(rand() * 1800),
        now, now);
    });

    for (let i = 0; i < 2; i++) {
      const imageId = newId();
      const filename = `${imageId}.svg`;
      fs.writeFileSync(path.join(uploadProductDir, filename), generateProductSvg(`${productId}:${i}`, 800));
      insertImage.run(imageId, productId, filename,
        `${name} by ${BRANDS[brandIdx]} â€” illustration ${i + 1}`, 800, 800, i, now);
    }
  }

  // Accounts --------------------------------------------------------------
  const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@cartward.test';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'cartward-admin-demo';
  if (adminPassword.length < 12) throw new Error('SEED_ADMIN_PASSWORD must be at least 12 characters');
  const adminId = await createUserRow(adminEmail, adminPassword, 'admin');

  await createUserRow('casey@example.test', 'casey-cart-demo-pass', 'customer');
  await createUserRow('riley@example.test', 'riley-cart-demo-pass', 'customer');

  // Discounts ---------------------------------------------------------------
  const insertDiscount = db.prepare(`
    INSERT INTO discount_codes (id, code, kind, value, min_subtotal_cents, starts_at, expires_at, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  insertDiscount.run(newId(), 'WELCOME10', 'percent', 10, 2500, Date.now() - 86_400_000, null, 1);
  insertDiscount.run(newId(), 'TAKE5OFF', 'fixed', 500, 3000, Date.now() - 86_400_000, null, 1);
  insertDiscount.run(newId(), 'EXPIRED2024', 'percent', 15, 0, Date.now() - 730 * 86_400_000, Date.now() - 365 * 86_400_000, 1);

  // Order history: a realistic spread of statuses so every admin screen and
  // the dashboard have something honest to show. All synthetic.
  const day = 24 * 60 * 60 * 1000;
  const customers = [
    { email: 'casey@example.test' },
    { email: 'riley@example.test' },
    { email: 'avery@example.test', password: 'avery-cart-demo-pass' },
    { email: 'jordan@example.test', password: 'jordan-cart-demo-pass' },
  ];
  for (const c of customers.slice(2)) {
    if (!db.prepare('SELECT id FROM users WHERE email = ?').get(c.email)) {
      await createUserRow(c.email, c.password, 'customer');
    }
  }
  const userIdByEmail = (email) => db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;

  const pickVariant = () => {
    const row = db.prepare(`
      SELECT v.id, v.price_cents FROM variants v JOIN products p ON p.id = v.product_id
      WHERE p.status='active' AND v.stock >= 30 LIMIT 1 OFFSET ABS(RANDOM()) % 12
    `).get();
    return row ?? db.prepare(`
      SELECT v.id, v.price_cents FROM variants v JOIN products p ON p.id = v.product_id
      WHERE p.status='active' AND v.stock >= 10 LIMIT 1
    `).get();
  };

  const SCENARIOS = [
    // [customerEmail, daysAgo, status, lines]
    ['casey@example.test', 26, 'shipped', 2],
    ['riley@example.test', 22, 'paid', 1],
    ['casey@example.test', 18, 'fulfilled', 3],
    ['avery@example.test', 15, 'refunded', 1],
    ['jordan@example.test', 11, 'shipped', 1],
    ['riley@example.test', 8, 'refunded', 2],
    ['casey@example.test', 5, 'paid', 1],
    ['avery@example.test', 3, 'cancelled', 1],
    ['jordan@example.test', 1, 'pending', 1],   // stuck: awaiting payment
    ['casey@example.test', 0, 'pending', 2],
  ];

  const insertSeedOrder = db.prepare(`
    INSERT INTO orders (id, number, user_id, guest_email, status,
      subtotal_cents, discount_cents, shipping_cents, tax_cents, total_cents, refund_total_cents,
      currency, shipping_method, shipping_address_json, placed_at, updated_at, closed_at)
    VALUES (?, ?, ?, NULL, ?, ?, 0, ?, ?, ?, ?, 'USD', 'standard', ?, ?, ?, ?)
  `);
  const insertSeedLine = db.prepare(`
    INSERT INTO order_lines (id, order_id, variant_id, product_name, variant_label, sku, quantity, unit_price_cents, line_total_cents)
    VALUES (?, ?, ?, ?, 'Standard', ?, ?, ?, ?)
  `);
  const insertEvent = db.prepare(`
    INSERT INTO order_events (id, order_id, type, from_status, to_status, detail, actor, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let seedOrderSeq = 100;
  const ADDRESS = {
    name: 'Demo Customer', line1: '900 Example Avenue', line2: '',
    city: 'Springfield', region: 'OR', postal_code: '97035', country: 'US',
  };
  for (const [email, daysAgo, status, lineCount] of SCENARIOS) {
    const orderId = newId();
    const placedAt = Date.now() - daysAgo * day - Math.floor(Math.random() * 6) * 3600 * 1000;
    const method = 'standard';
    let subtotal = 0;
    const chosen = [];
    for (let i = 0; i < lineCount; i++) {
      const v = pickVariant();
      chosen.push(v);
      subtotal += v.price_cents;
    }
    const shippingCents = subtotal >= 7500 ? 0 : 495;
    const tax = 0; // Oregon address in seed data â€” no sales tax
    const total = subtotal + shippingCents + tax;
    const closedAt = ['cancelled', 'refunded'].includes(status) ? placedAt + 2 * day : null;

    insertSeedOrder.run(orderId, `CW-S${String(seedOrderSeq++).padStart(7, '0')}`,
      userIdByEmail(email), status, subtotal, shippingCents, tax, total,
      status === 'refunded' ? total : 0,
      JSON.stringify({ ...ADDRESS, email }), placedAt,
      closedAt ?? placedAt + day, closedAt);

    for (const v of chosen) {
      const info = db.prepare(`
        SELECT p.name, v.sku FROM variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?
      `).get(v.id);
      insertSeedLine.run(newId(), orderId, v.id, info.name, info.sku, 1, v.price_cents, v.price_cents);
    }

    // Pending orders hold stock like real checkouts do.
    if (status === 'pending') {
      for (const v of chosen) {
        db.prepare('UPDATE variants SET reserved = reserved + 1 WHERE id = ? AND stock - reserved >= 1').run(v.id);
        db.prepare(`
          INSERT INTO reservations (id, order_id, variant_id, quantity, status, expires_at, created_at, updated_at)
          VALUES (?, ?, ?, 1, 'held', ?, ?, ?)
        `).run(newId(), orderId, v.id, placedAt + 15 * 60 * 1000, placedAt, placedAt);
      }
    }

    insertEvent.run(newId(), orderId, 'order_placed', null, null, 'Order placed.', 'customer', placedAt);
    const chain = {
      paid: [['state_change', null, 'paid', 'Payment settled.', 'system']],
      fulfilled: [['state_change', null, 'paid', 'Payment settled.', 'system'], ['state_change', 'paid', 'fulfilled', 'Packed for dispatch.', 'admin']],
      shipped: [['state_change', null, 'paid', 'Payment settled.', 'system'], ['state_change', 'paid', 'fulfilled', 'Packed for dispatch.', 'admin'], ['state_change', 'fulfilled', 'shipped', 'Handed to the carrier.', 'admin']],
      refunded: [['state_change', null, 'paid', 'Payment settled.', 'system'], ['state_change', 'paid', 'refunded', 'Customer returned the item; refund confirmed by processor.', 'admin']],
      cancelled: [['state_change', null, 'cancelled', 'Cancelled by the customer before payment completed.', 'customer']],
      pending: [],
    }[status];
    let t = placedAt;
    for (const [, from, to, detail, actor] of chain) {
      t += Math.floor(Math.random() * 2 + 1) * 3600 * 1000;
      insertEvent.run(newId(), orderId, 'state_change', from, to, detail, actor, Math.min(t, Date.now()));
    }
    if (status === 'pending') {
      insertEvent.run(newId(), orderId, 'payment_awaiting', null, null, 'Checkout not completed yet â€” this is where stuck orders wait.', 'system', placedAt + 3600 * 1000);
    }
  }
  console.log(`[seed] ${SCENARIOS.length} historical orders across all statuses`);

  console.log(`[seed] ${CATALOGUE.length} products, ${BRANDS.length} brands, ${CATEGORIES.length} categories`);
  console.log(`[seed] admin account: ${adminEmail} (change the password after first login)`);
  return { seeded: true, products: CATALOGUE.length, adminId };
}
