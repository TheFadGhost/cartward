import { createApp } from '../src/app.js';
import { db } from '../src/db/index.js';
const app = createApp();
const server = app.listen(3199, async () => {
  const base = 'http://localhost:3199';
  for (const path of ['/', '/register', '/login', '/forgot-password', '/nope-404']) {
    const res = await fetch(base + path);
    console.log(path, '->', res.status, res.headers.get('content-security-policy') ? 'CSP-set' : 'NO-CSP');
  }
  server.close();
  db.close();
});
