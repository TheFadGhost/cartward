// Live end-to-end purchase verification against a real server process.
// Simulates a shopper: register -> browse -> cart -> checkout -> pay (decline,
// then success) -> order history. Prints PASS/FAIL per step.
import crypto from 'node:crypto';
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:3210';
let cookies = {};

function absorb(res) {
  const set = res.headers.getSetCookie?.() ?? [];
  for (const raw of set) {
    const [pair] = raw.split(';');
    const idx = pair.indexOf('=');
    const name = pair.slice(0, idx).trim();
    if (pair.slice(idx + 1).trim() === '') delete cookies[name];
    else cookies[name] = pair.slice(idx + 1).trim();
  }
}
const jar = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');

async function get(path) {
  const res = await fetch(BASE + path, { headers: { Cookie: jar() }, redirect: 'manual' });
  absorb(res);
  return res;
}
async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jar() },
    body: new URLSearchParams(body).toString(),
    redirect: 'manual',
  });
  absorb(res);
  return res;
}
function csrf(html) {
  return /<meta name="csrf-token" content="([^"]+)"/.exec(html)[1];
}

const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${extra}`); };

// 0. Fresh database
for (const f of fs.readdirSync('data')) if (f.startsWith('e2e-')) fs.rmSync(`data/${f}`, { force: true, recursive: true });
process.env.NODE_ENV = 'development';
process.env.DATABASE_PATH = 'data/e2e.db';
process.env.EMAIL_DIR = 'data/e2e-emails';
process.env.UPLOAD_DIR = 'data/e2e-uploads';
process.env.MOCK_PAYMENT_FAST_DELAY_MS = '100';

const { createApp } = await import('../src/app.js');
const { db } = await import('../src/db/index.js');
const { seed } = await import('../src/services/seed.mjs');
const { config } = await import('../src/config.js');
config.baseUrl = BASE; // webhook deliveries target this instance
await seed({ fresh: true });
const server = createApp().listen(3210);
await new Promise((r) => server.once('listening', r));

try {
  // 1. Register
  let page = await get('/register');
  check('register page renders', page.status === 200);
  const email = `shopper-${crypto.randomBytes(3).toString('hex')}@example.test`;
  const reg = await post('/register', { email, password: 'quiet-orchard-lantern', _csrf: csrf(await (await get('/register')).text()) });
  check('account created', reg.status === 302);

  // Verify via captured email
  const tokenRow = db.prepare(`
    SELECT vt.token_hash FROM verification_tokens vt
    JOIN users u ON u.id = vt.user_id WHERE u.email = ? AND vt.purpose = 'email_verify'
  `).get(email);
  // Extract raw link from the captured .eml
  const emlFile = fs.readdirSync('data/e2e-emails').find((f) => f.endsWith('.eml'));
  void emlFile;
  const mails = fs.readFileSync(`data/e2e-emails/${fs.readdirSync('data/e2e-emails')[0]}`, 'utf8');
  void tokenRow;
  const verifyToken = /token=([A-Za-z0-9_-]+)/.exec(mails)?.[1];
  const ver = await get(`/verify-email?token=${encodeURIComponent(verifyToken)}`);
  check('email verified from captured mail', (await ver.text()).includes('Email verified'));

  // 2. Login
  cookies = {};
  page = await get('/login');
  const login = await post('/login', { email, password: 'quiet-orchard-lantern', _csrf: csrf(await (await get('/login')).text()) });
  check('signed in', login.status === 302 && cookies.cw_session);

  // 3. Browse + add to cart
  page = await get('/');
  check('shop grid renders with products', page.status === 200 && (await page.text()).includes('product-card'));
  const variant = db.prepare(`
    SELECT v.id, v.price_cents FROM variants v JOIN products p ON p.id = v.product_id
    WHERE p.status='active' AND v.backorderable=0 AND v.stock >= 5 LIMIT 1
  `).get();
  await post('/cart/add', { variant_id: variant.id, quantity: '2', _csrf: csrf(await (await get('/')).text()) });
  const cartPage = await get('/cart');
  check('cart shows the line', (await cartPage.text()).includes('Subtotal'));

  // 4. Checkout steps
  await post('/checkout/address', {
    name: 'Casey Example', email, line1: '42 Example Lane', line2: '',
    city: 'Springfield', region: 'NY', postal_code: '12345', country: 'US',
    _csrf: csrf(await (await get('/checkout')).text()),
  });
  await post('/checkout/delivery', { shipping_method: 'standard', _csrf: csrf(await (await get('/checkout/delivery')).text()) });
  const review = await get('/checkout/review');
  const reviewText = await review.text();
  check('review shows totals and tax line', reviewText.includes('Total') && reviewText.includes('Tax'));
  const ik = /name="_ik" value="([0-9a-f]+)"/.exec(reviewText)[1];

  // 5. Place order
  const placed = await post('/checkout/place', { _ik: ik, _csrf: csrf(reviewText) });
  check('order placed', placed.status === 302 && placed.headers.get('location').startsWith('/checkout/pay/'));
  const orderId = placed.headers.get('location').split('/').pop();

  // 6. Decline then succeed
  await post(`/checkout/pay/${orderId}`, { card_number: '4000000000000002', _csrf: csrf(await (await get(`/checkout/pay/${orderId}`)).text()) });
  await new Promise((r) => setTimeout(r, 700));
  const afterDecline = db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId);
  check('declined payment leaves order pending', afterDecline.status === 'pending');

  await post(`/checkout/pay/${orderId}`, { card_number: '4242424242424242', _csrf: csrf(await (await get(`/checkout/pay/${orderId}`)).text()) });
  let paid = false;
  for (let i = 0; i < 40; i++) {
    if (db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId).status === 'paid') { paid = true; break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  check('payment succeeded via webhook', paid);

  // 7. Order visible in history
  const history = await get('/orders');
  check('order in account history', (await history.text()).includes('CW-'));
  const detail = await get(`/orders/${orderId}`);
  check('order detail renders timeline', (await detail.text()).includes('History'));

  console.log(`\n${results.filter(r => r.ok).length}/${results.length} steps passed`);
  process.exitCode = results.every(r => r.ok) ? 0 : 1;
} finally {
  server.close();
  setTimeout(() => process.exit(process.exitCode || 0), 300);
}
