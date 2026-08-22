import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeClient, db } from '../helpers/harness.js';
import { seed } from '../../src/services/seed.mjs';

await seed({});
let client;

beforeEach(async () => {
  db.prepare('DELETE FROM rate_limits').run();
  client = await makeClient();
});

describe('product listing', () => {
  it('shows a paginated grid', async () => {
    const res = await client.get('/');
    assert.equal(res.status, 200);
    assert.match(res.text, /36 products/i);
    assert.equal((res.text.match(/class="product-card"/g) || []).length, 12);
    assert.match(res.text, /Page 1 of 3/);

    const p2 = await client.get('/?page=2');
    assert.equal((p2.text.match(/class="product-card"/g) || []).length, 12);
    assert.match(p2.text, /Page 2 of 3/);
  });

  it('page far beyond range yields empty state without error', async () => {
    const res = await client.get('/?page=99');
    assert.equal(res.status, 200);
    assert.match(res.text, /No results|0 products/i);
  });
});

describe('search and filters', () => {
  it('finds products by query', async () => {
    const res = await client.get('/?q=kettle');
    assert.match(res.text, /Pour-Over Kettle No\. 4/);
    assert.match(res.text, /1 product/i);
  });

  it('search with no hits shows the no-results state', async () => {
    const res = await client.get('/?q=zzzqqqxyzzy');
    assert.match(res.text, /No results/);
    assert.match(res.text, /Clear all filters/);
  });

  it('filters by category', async () => {
    const catRow = db.prepare("SELECT slug FROM categories WHERE name = 'Lighting'").get();
    const res = await client.get(`/?category=${catRow.slug}`);
    const countMatch = /(\d+) product/.exec(res.text);
    assert.ok(Number(countMatch[1]) >= 3);
    assert.match(res.text, /Desk Lamp|Pendant Light|Taper Candles|Candle, Cedar/);
  });

  it('filters by tag', async () => {
    const res = await client.get('/?tag=wool');
    assert.match(res.text, /Wool|Merino|Fireside/);
  });

  it('in-stock filter hides fully out-of-stock products', async () => {
    const plain = await client.get('/?in_stock=0');
    const filtered = await client.get('/?in_stock=1');
    void plain;
    // Find a known out-of-stock product name from seed ("Cotton Hammock").
    assert.doesNotMatch(filtered.text, /Cotton Hammock/);
  });

  it('price bounds exclude everything when absurdly tight', async () => {
    const res = await client.get('/?min_price=9999&max_price=9999');
    assert.match(res.text, /No results/);
  });
});

describe('sorting', () => {
  it('sorts by price ascending across pages', async () => {
    const res = await client.get('/?sort=price_asc');
    // One price per card (the minimum), so ranges don't break ordering checks.
    const prices = [...res.text.matchAll(/class="card-price">\$([0-9,]+\.\d{2})/g)].map((m) => Number(m[1].replace(',', '')));
    assert.ok(prices.length >= 10);
    const sorted = [...prices].sort((a, b) => a - b);
    assert.deepEqual(prices.slice(0, sorted.length), sorted.slice(0, prices.length));
  });

  it('sorts by name A–Z', async () => {
    const res = await client.get('/?sort=name');
    const names = [...res.text.matchAll(/card-title"><a href="\/products\/[^"]+">([^<]+)<\/a>/g)].map((m) => m[1]);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    assert.deepEqual(names, sorted);
  });
});

describe('product detail', () => {
  it('renders variants, stock states and description', async () => {
    const row = db.prepare(`
      SELECT p.slug FROM products p WHERE p.id IN (
        SELECT product_id FROM variants GROUP BY product_id HAVING COUNT(*) > 1
      ) AND p.status='active' LIMIT 1
    `).get();
    const res = await client.get(`/products/${row.slug}`);
    assert.equal(res.status, 200);
    assert.match(res.text, /variant-pill/);
    assert.match(res.text, /About this product/);
    assert.match(res.text, /Add to cart/);
  });

  it('marks out-of-stock variants disabled and unselectable', async () => {
    const row = db.prepare(`
      SELECT p.slug FROM products p JOIN variants v ON v.product_id = p.id
      WHERE v.stock = 0 AND v.backorderable = 0 AND p.status='active'
      GROUP BY p.id LIMIT 1
    `).get();
    assert.ok(row, 'seed should include an out-of-stock product');
    const res = await client.get(`/products/${row.slug}`);
    assert.match(res.text, /disabled/);
    assert.match(res.text, /Out of stock/);
  });

  it('labels backorderable variants honestly', async () => {
    const row = db.prepare(`
      SELECT p.slug FROM products p JOIN variants v ON v.product_id = p.id
      WHERE v.backorderable = 1 AND p.status='active' LIMIT 1
    `).get();
    const res = await client.get(`/products/${row.slug}`);
    assert.match(res.text, /Backordered/);
  });

  it('404s unknown slugs', async () => {
    const res = await client.get('/products/not-a-real-product');
    assert.equal(res.status, 404);
  });
});

describe('media route', () => {
  it('serves seeded artwork with correct content type', async () => {
    const img = db.prepare("SELECT filename FROM product_images WHERE filename LIKE '%.svg' LIMIT 1").get();
    const res = await client.get(`/media/products/${img.filename}`);
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /svg/);
  });

  it('blocks path traversal', async () => {
    const res = await client.get('/media/products/..%2F..%2Fsecrets.txt');
    assert.notEqual(res.status, 200);
    const res2 = await client.get('/media/products/evil.exe');
    assert.notEqual(res2.status, 200);
  });
});
