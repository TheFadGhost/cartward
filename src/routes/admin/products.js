import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import busboy from 'busboy';
import { db } from '../../db/index.js';
import { config } from '../../config.js';
import { newId } from '../../lib/tokens.js';
import { audit } from '../../services/admin.js';
import * as catalog from '../../services/catalog.js';

const router = Router();

// --- Product list -------------------------------------------------------------

router.get('/admin/products', (req, res) => {
  const q = String(req.query.q || '').slice(0, 80);
  const statusFilter = ['draft', 'active', 'archived'].includes(req.query.status) ? req.query.status : null;
  const rows = db.prepare(`
    SELECT p.*, b.name AS brand_name, c.name AS category_name,
           (SELECT COUNT(*) FROM variants v WHERE v.product_id = p.id) AS variant_count,
           (SELECT COALESCE(SUM(v.stock - v.reserved), 0) FROM variants v WHERE v.product_id = p.id) AS available,
           (SELECT filename FROM product_images pi WHERE pi.product_id = p.id ORDER BY pi.sort_order LIMIT 1) AS image
    FROM products p
    LEFT JOIN brands b ON b.id = p.brand_id
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE (? IS NULL OR p.status = ?)
      AND (? = '' OR p.name LIKE '%' || ? || '%')
    ORDER BY p.updated_at DESC LIMIT 200
  `).all(statusFilter, statusFilter, q, q);
  res.render('admin/products/index', { layout: 'admin', title: 'Products', rows, q, statusFilter });
});

// --- Create / edit form ---------------------------------------------------------

function formData(req, res) {
  const categories = catalog.listCategories();
  const brands = db.prepare('SELECT id, name FROM brands ORDER BY name').all();
  return { categories, brands };
}

router.get('/admin/products/new', (req, res) => {
  res.render('admin/products/form', {
    layout: 'admin', title: 'New product', product: null, variants: [], images: [],
    errors: {}, values: {}, ...formData(),
  });
});

router.post('/admin/products/new', (req, res) => {
  const values = req.body;
  const errors = validateProduct(values);
  if (Object.keys(errors).length) {
    return res.status(422).render('admin/products/form', {
      layout: 'admin', title: 'New product', product: null, variants: [], images: [],
      errors, values, ...formData(),
    }, );
  }
  const product = catalog.createProduct({
    name: String(values.name).trim(),
    description: String(values.description || '').trim(),
    categoryId: String(values.category_id),
    brandName: values.brand_new?.trim() || null,
    status: values.status === 'active' ? 'active' : 'draft',
    tagNames: String(values.tags || '').split(',').map((s) => s.trim()).filter(Boolean),
  });
  audit({ actorType: 'admin', actorId: req.user.id, action: 'product.create', entityType: 'product', entityId: product.id, after: { name: product.name }, ip: req.ip });
  res.flash('success', `Product "${product.name}" created.`);
  return res.redirect(`/admin/products/${product.id}`);
});

router.get('/admin/products/:id', (req, res) => {
  const product = catalog.getProductById(req.params.id);
  if (!product) return res.status(404).render('error', { title: 'Not found', message: 'No such product.', statusCode: 404 });
  const brand = product.brand_id ? db.prepare('SELECT name FROM brands WHERE id = ?').get(product.brand_id)?.name : '';
  const variants = db.prepare('SELECT * FROM variants WHERE product_id = ? ORDER BY option_size, option_colour, sku').all(product.id)
    .map((v) => ({ ...v, available: v.stock - v.reserved }));
  const images = db.prepare('SELECT * FROM product_images WHERE product_id = ? ORDER BY sort_order').all(product.id);
  const tagStr = db.prepare(`
    SELECT group_concat(t.name, ', ') AS tags FROM product_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.product_id = ?
  `).get(product.id)?.tags ?? '';
  return res.render('admin/products/form', {
    layout: 'admin', title: `Edit — ${product.name}`,
    product: { ...product, brandName: brand ?? '' },
    variants, images, errors: {}, values: {}, tagStr, ...formData(),
  });
});

router.post('/admin/products/:id', (req, res) => {
  const product = catalog.getProductById(req.params.id);
  if (!product) return res.status(404).render('error', { title: 'Not found', message: 'No such product.', statusCode: 404 });
  const values = req.body;
  const errors = validateProduct(values);
  if (Object.keys(errors).length) {
    return res.status(422).render('admin/products/form', {
      layout: 'admin', title: `Edit — ${product.name}`,
      product, variants: db.prepare('SELECT * FROM variants WHERE product_id = ?').all(product.id),
      images: db.prepare('SELECT * FROM product_images WHERE product_id = ?').all(product.id),
      errors, values: { ...values }, ...formData(),
    });
  }
  const before = { name: product.name, description: product.description, status: product.status };
  let brandId = product.brand_id;
  if (values.brand_new?.trim()) {
    const existing = db.prepare('SELECT id FROM brands WHERE name = ?').get(values.brand_new.trim());
    brandId = existing?.id ?? (() => {
      const bid = newId();
      db.prepare('INSERT INTO brands (id, name, slug) VALUES (?, ?, ?)').run(bid, values.brand_new.trim(), catalog.uniqueSlug(values.brand_new.trim(), 'brands'));
      return bid;
    })();
  }
  db.prepare(`
    UPDATE products SET name=?, slug=?, description=?, category_id=?, brand_id=?, status=?, updated_at=? WHERE id=?
  `).run(
    String(values.name).trim(),
    catalog.uniqueSlug(String(values.name).trim(), 'products', product.id),
    String(values.description || '').trim(),
    String(values.category_id), brandId,
    values.status === 'active' ? 'active' : values.status === 'archived' ? 'archived' : 'draft',
    Date.now(), product.id,
  );
  catalog.setTags(product.id, String(values.tags || '').split(',').map((s) => s.trim()).filter(Boolean));
  audit({ actorType: 'admin', actorId: req.user.id, action: 'product.update', entityType: 'product', entityId: product.id, before, after: { name: values.name, status: values.status }, ip: req.ip });
  res.flash('success', 'Product saved.');
  return res.redirect(`/admin/products/${product.id}`);
});

function validateProduct(values) {
  const errors = {};
  if (!String(values.name || '').trim() || values.name.length > 120) errors.name = 'Enter a name of at most 120 characters.';
  if (!values.category_id) errors.category_id = 'Choose a category.';
  if (!['draft', 'active', 'archived'].includes(values.status)) errors.status = 'Choose a valid status.';
  return errors;
}

// --- Variants -------------------------------------------------------------------

router.post('/admin/products/:id/variants', (req, res) => {
  const product = catalog.getProductById(req.params.id);
  if (!product) return res.status(404).render('error', { title: 'Not found', message: 'No such product.', statusCode: 404 });
  const priceCents = parsePriceCents(req.body.price);
  const stock = Number.parseInt(String(req.body.stock ?? '0'), 10);
  const backorderable = req.body.backorderable === 'on' ? 1 : 0;
  if (priceCents === null) {
    res.flash('warn', 'Enter a valid price like 24.99.');
    return res.redirect(`/admin/products/${product.id}`);
  }
  const size = String(req.body.option_size || '').trim().slice(0, 30) || null;
  const colour = String(req.body.option_colour || '').trim().slice(0, 30) || null;
  const now = Date.now();
  db.prepare(`
    INSERT INTO variants (id, product_id, sku, option_size, option_colour, price_cents, stock, reserved, backorderable, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  `).run(newId(), product.id, generateSku(), size, colour, priceCents,
    Number.isInteger(stock) && stock >= 0 ? stock : 0, backorderable, now, now);
  audit({ actorType: 'admin', actorId: req.user.id, action: 'variant.create', entityType: 'variant', entityId: product.id, after: { priceCents, stock, size, colour }, ip: req.ip });
  res.flash('success', 'Variant added.');
  return res.redirect(`/admin/products/${product.id}`);
});

let skuCounter = Math.floor(Math.random() * 1000) + 5000;
function generateSku() {
  return `CW-${skuCounter++}`;
}

function parsePriceCents(input) {
  const m = /^(\d{1,6})(?:\.(\d{2}))?$/.exec(String(input ?? '').trim());
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '00'));
}

/** Inventory adjustment with an explicit delta and mandatory reason. */
router.post('/admin/variants/:id/adjust', (req, res) => {
  const variant = db.prepare(`
    SELECT v.*, p.id AS pid FROM variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?
  `).get(req.params.id);
  if (!variant) return res.status(404).render('error', { title: 'Not found', message: 'No such variant.', statusCode: 404 });
  const delta = Number.parseInt(String(req.body.delta ?? ''), 10);
  const reason = String(req.body.reason || '').trim();
  if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 10000) {
    res.flash('warn', 'Enter a non-zero adjustment between -10000 and +10000.');
    return res.redirect(`/admin/products/${variant.pid}`);
  }
  if (reason.length < 3) {
    res.flash('warn', 'Give a short reason for the adjustment — it goes in the audit trail.');
    return res.redirect(`/admin/products/${variant.pid}`);
  }
  const before = { stock: variant.stock };
  try {
    db.prepare('UPDATE variants SET stock = stock + ?, updated_at = ? WHERE id = ? AND stock + ? >= reserved')
      .run(delta, Date.now(), variant.id, delta);
  } catch {
    res.flash('warn', "That adjustment would take stock below what's already reserved.");
    return res.redirect(`/admin/products/${variant.pid}`);
  }
  const afterRow = db.prepare('SELECT stock FROM variants WHERE id = ?').get(variant.id);
  audit({ actorType: 'admin', actorId: req.user.id, action: 'inventory.adjust', entityType: 'variant', entityId: variant.id, before, after: { stock: afterRow.stock, reason }, ip: req.ip });
  res.flash('success', `Stock adjusted by ${delta > 0 ? '+' : ''}${delta}.`);
  return res.redirect(`/admin/products/${variant.pid}`);
});

router.post('/admin/variants/:id/delete', (req, res) => {
  const variant = db.prepare('SELECT *, p.id AS pid FROM variants v JOIN products p ON p.id = v.product_id WHERE v.id = ?').get(req.params.id);
  if (!variant) return res.status(404).render('error', { title: 'Not found', message: 'No such variant.', statusCode: 404 });
  const referenced = db.prepare('SELECT COUNT(*) n FROM order_lines WHERE variant_id = ?').get(variant.id).n;
  if (referenced > 0) {
    // Keep order history coherent; deactivate instead of destroying.
    db.prepare('DELETE FROM cart_items WHERE variant_id = ?').run(variant.id);
    db.prepare("DELETE FROM reservations WHERE variant_id = ? AND status = 'held'").run(variant.id);
    db.prepare('UPDATE variants SET stock = 0, reserved = 0, backorderable = 0, updated_at = ? WHERE id = ?').run(Date.now(), variant.id);
    audit({ actorType: 'admin', actorId: req.user.id, action: 'variant.deactivate', entityType: 'variant', entityId: variant.id, ip: req.ip });
    res.flash('success', 'Variant has order history, so it was emptied and deactivated rather than deleted.');
  } else {
    db.prepare('DELETE FROM cart_items WHERE variant_id = ?').run(variant.id);
    db.prepare('DELETE FROM reservations WHERE variant_id = ? AND status = \'held\'').run(variant.id);
    db.prepare('UPDATE variants SET reserved = 0 WHERE id = ?').run(variant.id);
    db.prepare('DELETE FROM variants WHERE id = ?').run(variant.id);
    audit({ actorType: 'admin', actorId: req.user.id, action: 'variant.delete', entityType: 'variant', entityId: variant.id, before: { sku: variant.sku }, ip: req.ip });
    res.flash('success', 'Variant deleted.');
  }
  return res.redirect(`/admin/products/${variant.pid}`);
});

// --- Images -----------------------------------------------------------------------

const MAGIC = [
  { ext: '.png', type: 'image/png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: '.jpg', type: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: '.webp', type: 'image/webp', test: (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP' },
  { ext: '.svg', type: 'image/svg+xml', test: (b) => /^\s*(<\?xml[\s\S]*?\?>\s*)?<svg[\s>]/i.test(b.subarray(0, 512).toString('utf8')) },
];

router.post('/admin/products/:id/images', (req, res) => {
  const product = catalog.getProductById(req.params.id);
  if (!product) return res.status(404).send('Not found');

  const finish = (message, isError = false) => {
    if (isError) res.flash('warn', message); else res.flash('success', message);
    res.redirect(`/admin/products/${product.id}`);
  };

  let altText = '';
  let upload = null;

  const bb = busboy({ headers: req.headers, limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 10 } });
  bb.on('field', (name, value) => {
    if (name === 'alt') altText = String(value || '').trim().slice(0, 200);
  });
  bb.on('file', (name, stream) => {
    const chunks = [];
    let truncated = false;
    stream.on('data', (d) => chunks.push(d));
    stream.on('limit', () => { truncated = true; });
    stream.on('end', () => { upload = { buffer: Buffer.concat(chunks), truncated }; });
  });
  bb.on('close', () => {
    try {
      if (!upload) return finish('Choose an image file first.', true);
      if (upload.truncated || upload.buffer.length < 12) return finish('File too large or empty (max 5 MB).', true);
      const magic = MAGIC.find((m) => m.test(upload.buffer));
      if (!magic) return finish('Only PNG, JPEG, WebP or SVG images are accepted.', true);

      const imageId = newId();
      const filename = `${imageId}${magic.ext}`;
      const dir = path.join(config.uploadDir, 'products');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, filename), upload.buffer);
      const alt = altText || product.name;
      const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), -1) m FROM product_images WHERE product_id = ?').get(product.id).m;
      db.prepare(`
        INSERT INTO product_images (id, product_id, filename, alt_text, width, height, sort_order, created_at)
        VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)
      `).run(imageId, product.id, filename, alt, maxSort + 1, Date.now());
      audit({ actorType: 'admin', actorId: req.user.id, action: 'image.upload', entityType: 'image', entityId: imageId, after: { filename, alt }, ip: req.ip });
      return finish('Image uploaded.');
    } catch (err) {
      return finish(`Upload failed: ${err.message}`, true);
    }
  });
  req.pipe(bb);
});

router.post('/admin/images/:id/delete', (req, res) => {
  const img = db.prepare('SELECT * FROM product_images WHERE id = ?').get(req.params.id);
  if (!img) return res.status(404).render('error', { title: 'Not found', message: 'No such image.', statusCode: 404 });
  db.prepare('DELETE FROM product_images WHERE id = ?').run(img.id);
  fs.rmSync(path.join(config.uploadDir, 'products', img.filename), { force: true });
  audit({ actorType: 'admin', actorId: req.user.id, action: 'image.delete', entityType: 'image', entityId: img.id, before: { filename: img.filename }, ip: req.ip });
  res.flash('success', 'Image removed.');
  return res.redirect(`/admin/products/${img.product_id}`);
});

export default router;
