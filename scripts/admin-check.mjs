// Admin surface smoke check against seeded data.
process.env.NODE_ENV = 'development';
process.env.DATABASE_PATH = 'data/cartward.db';
const { db } = await import('../src/db/index.js');
if (db.prepare('SELECT COUNT(*) n FROM orders').get().n === 0) {
  const { seed } = await import('../src/services/seed.mjs');
  await seed({ fresh: true });
}
const { createApp } = await import('../src/app.js');
const { config } = await import('../src/config.js');
config.baseUrl = 'http://127.0.0.1:3212';
const app = createApp();
const server = app.listen(3212);
await new Promise((r) => server.once('listening', r));

let cookies = {};
const jar = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
async function req(method, path, body) {
  const res = await fetch(`http://127.0.0.1:3212${path}`, {
    method,
    headers: { Cookie: jar(), ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: body ? new URLSearchParams(body).toString() : undefined,
    redirect: 'manual',
  });
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';');
    const i = pair.indexOf('=');
    if (pair.slice(i + 1).trim() === '') delete cookies[pair.slice(0, i).trim()];
    else cookies[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return res;
}
const csrf = (h) => /<meta name="csrf-token" content="([^"]+)"/.exec(h)[1];

await req('POST', '/login', {
  email: 'admin@cartward.test',
  password: 'cartward-admin-demo',
  _csrf: csrf(await (await req('GET', '/login')).text()),
});

for (const p of ['/admin', '/admin/orders', '/admin/products', '/admin/customers', '/admin/audit-log', '/admin/mailbox']) {
  const res = await req('GET', p);
  const text = await res.text();
  console.log(p, res.status === 200 ? 'OK' : `FAIL ${res.status}`, text.includes('<!doctype html>') ? '' : '(no html!)');
}

const product = db.prepare('SELECT id FROM products LIMIT 1').get();
console.log('/admin/products/detail', (await req('GET', `/admin/products/${product.id}`)).status === 200 ? 'OK' : 'FAIL');

const order = db.prepare("SELECT id FROM orders WHERE status != 'pending' LIMIT 1").get();
console.log('/admin/orders/detail', (await req('GET', `/admin/orders/${order.id}`)).status === 200 ? 'OK' : 'FAIL');

const customer = db.prepare("SELECT id FROM users WHERE role='customer' LIMIT 1").get();
console.log('/admin/customers/detail', (await req('GET', `/admin/customers/${customer.id}`)).status === 200 ? 'OK' : 'FAIL');

server.close();
setTimeout(() => process.exit(0), 200);
