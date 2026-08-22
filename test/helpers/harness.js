import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUN_ID = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

// Isolated runtime data per test run. Must be set BEFORE importing src/config.js.
process.env.NODE_ENV = 'development';
process.env.SESSION_SECRET = `test-secret-${RUN_ID}`;
process.env.DATABASE_PATH = path.join(ROOT, 'data', `test-${RUN_ID}.db`);
process.env.UPLOAD_DIR = path.join(ROOT, 'data', `uploads-test-${RUN_ID}`);
process.env.EMAIL_DIR = path.join(ROOT, 'data', `emails-test-${RUN_ID}`);
process.env.APP_BASE_URL = 'http://localhost:3000';

const { createApp } = await import('../../src/app.js');
const { db } = await import('../../src/db/index.js');

/** Higher-level HTTP client over supertest with cookie persistence. */
export async function makeClient() {
  const { default: request } = await import('supertest');
  const app = createApp();
  let cookies = {};

  const absorb = (res) => {
    const set = res.headers['set-cookie'] || [];
    for (const raw of set) {
      const [pair] = raw.split(';');
      const idx = pair.indexOf('=');
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (value === '' || /Max-Age\s*=\s*0/i.test(raw)) delete cookies[name];
      else cookies[name] = value;
    }
  };
  const header = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');

  return {
    app,
    async get(url) {
      const res = await request(app).get(url).set('Cookie', header());
      absorb(res);
      return res;
    },
    async post(url, body = {}) {
      const res = await request(app)
        .post(url)
        .set('Cookie', header())
        .type('form')
        .send(body);
      absorb(res);
      return res;
    },
    clearCookies() { cookies = {}; },
    cookieValue(name) { return cookies[name]; },
  };
}

/** Extract the _csrf token from a rendered page. */
export function csrfOf(htmlResponse) {
  const meta = /<meta name="csrf-token" content="([^"]+)"/.exec(htmlResponse.text);
  if (meta) return meta[1];
  const match = /name="_csrf" value="([^"]+)"/.exec(htmlResponse.text);
  if (!match) throw new Error('No CSRF token found on page');
  return match[1];
}

/** Read captured emails for an address; returns array of {subject, text}. */
export function readCapturedEmails(toEmail) {
  const rows = db.prepare(
    'SELECT * FROM emails_out WHERE to_email = ? ORDER BY sent_at DESC',
  ).all(toEmail);
  return rows.map((row) => {
    const eml = fs.readFileSync(path.join(process.env.EMAIL_DIR, row.filename), 'utf8');
    const subject = /^Subject: (.*)$/m.exec(eml)?.[1] ?? '';
    return { subject, eml, template: row.template };
  });
}

/** Extract a URL query param from the newest matching captured email. */
export function paramFromEmail(toEmail, paramName, subjectIncludes = '') {
  const mails = readCapturedEmails(toEmail).filter((m) => m.subject.includes(subjectIncludes));
  if (!mails.length) throw new Error(`No captured email for ${toEmail}`);
  const re = new RegExp(`${paramName}=([A-Za-z0-9_-]+)`);
  const match = re.exec(mails[0].eml);
  if (!match) throw new Error(`Param ${paramName} not found in email`);
  return match[1];
}

export { db };
