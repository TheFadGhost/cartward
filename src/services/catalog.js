import { db } from '../db/index.js';
import { newId } from '../lib/tokens.js';

export const PER_PAGE = 12;
export const SORTS = {
  relevance: null, // bm25 rank, only meaningful with a query
  newest: 'p.created_at DESC',
  price_asc: 'min_price_cents ASC',
  price_desc: 'min_price_cents DESC',
  name: 'p.name COLLATE NOCASE ASC',
};

/**
 * List active products with search, filters, sort, pagination.
 * Returns { items, total, page, pageCount }.
 */
export function listProducts({
  q = '',
  category = '',
  tag = '',
  sort = 'newest',
  page = 1,
  perPage = PER_PAGE,
  inStockOnly = false,
  minPrice = null,
  maxPrice = null,
} = {}) {
  const where = ["p.status = 'active'"];
  const params = {};

  let fromExtra = '';
  if (q.trim()) {
    // Sanitize FTS query: strip operators, wrap terms as prefix matches.
    const terms = q.trim().replace(/["'()*:^]/g, ' ').split(/\s+/).filter(Boolean);
    if (terms.length) {
      where.push('products_fts MATCH @ftsQuery');
      params.ftsQuery = terms.map((t) => `"${t}"*`).join(' ');
      fromExtra = 'JOIN products_fts ON products_fts.product_id = p.id';
    }
  }
  if (category) {
    where.push('c.slug = @category');
    params.category = String(category);
  }
  if (tag) {
    fromExtra += ' JOIN product_tags pt ON pt.product_id = p.id JOIN tags t ON t.id = pt.tag_id';
    where.push('t.slug = @tag');
    params.tag = String(tag);
  }
  if (inStockOnly) {
    where.push(`EXISTS (SELECT 1 FROM variants vi WHERE vi.product_id = p.id AND (vi.stock - vi.reserved) > 0)`);
  }
  if (minPrice !== null && Number.isFinite(minPrice)) {
    where.push('EXISTS (SELECT 1 FROM variants vp WHERE vp.product_id = p.id AND vp.price_cents >= @minPrice)');
    params.minPrice = Math.trunc(minPrice);
  }
  if (maxPrice !== null && Number.isFinite(maxPrice)) {
    where.push('EXISTS (SELECT 1 FROM variants vp WHERE vp.product_id = p.id AND vp.price_cents <= @maxPrice)');
    params.maxPrice = Math.trunc(maxPrice);
  }

  const orderBy = SORTS[sort] || SORTS.newest;
  const safePage = Math.max(1, Math.trunc(page) || 1);

  const countSql = `
    SELECT COUNT(DISTINCT p.id) AS n
    FROM products p
    LEFT JOIN brands b ON b.id = p.brand_id
    LEFT JOIN categories c ON c.id = p.category_id
    ${fromExtra}
    WHERE ${where.join(' AND ')}
  `;
  const total = db.prepare(countSql).get(params).n;

  const listSql = `
    SELECT p.id, p.slug, p.name, b.name AS brand,
           (SELECT MIN(price_cents) FROM variants v WHERE v.product_id = p.id) AS min_price_cents,
           (SELECT MAX(price_cents) FROM variants v WHERE v.product_id = p.id) AS max_price_cents,
           (SELECT COALESCE(SUM(vi.stock - vi.reserved), 0) FROM variants vi WHERE vi.product_id = p.id) AS total_available,
           (SELECT MAX(vb.backorderable) FROM variants vb WHERE vb.product_id = p.id) AS any_backorderable,
           (SELECT filename FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.sort_order, pi.created_at LIMIT 1) AS image_filename,
           (SELECT alt_text FROM product_images pi2 WHERE pi2.product_id = p.id ORDER BY pi2.sort_order, pi2.created_at LIMIT 1) AS image_alt
    FROM products p
    LEFT JOIN brands b ON b.id = p.brand_id
    LEFT JOIN categories c ON c.id = p.category_id
    ${fromExtra}
    WHERE ${where.join(' AND ')}
    GROUP BY p.id
    ORDER BY ${orderBy}
    LIMIT @limit OFFSET @offset
  `;
  const rows = db.prepare(listSql).all({ ...params, limit: perPage, offset: (safePage - 1) * perPage });

  return {
    items: rows.map(rowToCard),
    total,
    page: safePage,
    pageCount: Math.max(1, Math.ceil(total / perPage)),
  };
}

function rowToCard(row) {
  return {
    slug: row.slug,
    name: row.name,
    brand: row.brand || null,
    minPriceCents: row.min_price_cents ?? 0,
    maxPriceCents: row.max_price_cents ?? 0,
    totalAvailable: row.total_available ?? 0,
    anyBackorderable: !!row.any_backorderable,
    image: row.image_filename
      ? { url: `/media/products/${row.image_filename}`, alt: row.image_alt || row.name }
      : null,
  };
}

/** Full product detail: variants with live availability, images, tags. */
export function getProductBySlug(slug) {
  const row = db.prepare(`
    SELECT p.*, b.name AS brand_name, c.name AS category_name, c.slug AS category_slug
    FROM products p
    LEFT JOIN brands b ON b.id = p.brand_id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.slug = ? AND p.status IN ('active', 'archived')
  `).get(slug);
  if (!row) return null;

  const variants = db.prepare(`
    SELECT id, sku, option_size, option_colour, price_cents, stock, reserved, backorderable
    FROM variants WHERE product_id = ?
    ORDER BY option_size, option_colour, sku
  `).all(row.id).map((v) => ({
    ...v,
    available: v.stock - v.reserved,
    inStock: v.stock - v.reserved > 0,
    purchasable: v.stock - v.reserved > 0 || !!v.backorderable,
  }));

  const images = db.prepare(
    'SELECT id, filename, alt_text, width, height FROM product_images WHERE product_id = ? ORDER BY sort_order, created_at',
  ).all(row.id).map((img) => ({ ...img, url: `/media/products/${img.filename}` }));

  const tags = db.prepare(`
    SELECT t.name, t.slug FROM tags t JOIN product_tags pt ON pt.tag_id = t.id WHERE pt.product_id = ?
    ORDER BY t.name
  `).all(row.id);

  return { ...row, variants, images, tags };
}

export function getVariantForPurchase(variantId) {
  return db.prepare(`
    SELECT v.*, p.status AS product_status, p.name AS product_name, b.name AS brand_name
    FROM variants v
    JOIN products p ON p.id = v.product_id
    LEFT JOIN brands b ON b.id = p.brand_id
    WHERE v.id = ?
  `).get(variantId) ?? null;
}

export function listCategories() {
  return db.prepare(`
    SELECT c.id, c.name, c.slug, COUNT(p.id) AS product_count
    FROM categories c
    LEFT JOIN products p ON p.category_id = c.id AND p.status = 'active'
    GROUP BY c.id ORDER BY c.name
  `).all();
}

export function popularTags(limit = 14) {
  return db.prepare(`
    SELECT t.name, t.slug, COUNT(pt.product_id) AS n
    FROM tags t
    JOIN product_tags pt ON pt.tag_id = t.id
    JOIN products p ON p.id = pt.product_id AND p.status = 'active'
    GROUP BY t.id ORDER BY n DESC LIMIT ?
  `).all(limit);
}

// ---------------------------------------------------------------------------
// Admin-facing mutations live here too (authorization enforced at the router).
// ---------------------------------------------------------------------------

const slugify = (s) => String(s).toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

export function uniqueSlug(base, table, excludeId = null) {
  const stem = slugify(base) || 'item';
  let candidate = stem;
  let n = 2;
  while (true) {
    const row = excludeId
      ? db.prepare(`SELECT id FROM ${table} WHERE slug = ? AND id != ?`).get(candidate, excludeId)
      : db.prepare(`SELECT id FROM ${table} WHERE slug = ?`).get(candidate);
    if (!row) return candidate;
    candidate = `${stem}-${n++}`;
  }
}

export function createProduct({ name, description = '', categoryId, brandName = null, status = 'draft', tagNames = [] }) {
  const id = newId();
  const now = Date.now();
  let brandId = null;
  if (brandName) {
    const existing = db.prepare('SELECT id FROM brands WHERE name = ?').get(brandName);
    brandId = existing?.id ?? (() => {
      const bid = newId();
      db.prepare('INSERT INTO brands (id, name, slug) VALUES (?, ?, ?)').run(bid, brandName, uniqueSlug(brandName, 'brands'));
      return bid;
    })();
  }
  db.prepare(`
    INSERT INTO products (id, brand_id, category_id, name, slug, description, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, brandId, categoryId, name, uniqueSlug(name, 'products'), description, status, now, now);
  setTags(id, tagNames);
  return getProductById(id);
}

export function getProductById(id) {
  return db.prepare('SELECT * FROM products WHERE id = ?').get(id) ?? null;
}

export function setTags(productId, names) {
  db.prepare('DELETE FROM product_tags WHERE product_id = ?').run(productId);
  const insTag = db.prepare('INSERT OR IGNORE INTO tags (id, name, slug) VALUES (?, ?, ?)');
  const insPT = db.prepare('INSERT INTO product_tags (product_id, tag_id) VALUES (?, ?)');
  const tx = db.transaction(() => {
    for (const raw of names) {
      const name = String(raw).trim();
      if (!name) continue;
      const existing = db.prepare('SELECT id FROM tags WHERE name = ?').get(name);
      const tid = existing?.id ?? (insTag.run(newId(), name, uniqueSlug(name, 'tags')), db.prepare('SELECT id FROM tags WHERE name = ?').get(name).id);
      insPT.run(productId, tid);
    }
  });
  tx();
}

