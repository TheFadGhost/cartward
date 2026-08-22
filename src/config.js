import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

function loadDotEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv();

const dataDir = path.join(ROOT, 'data');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// Session secret: generated on first run, persisted under gitignored data/,
// never committed. Override via SESSION_SECRET env only for tests.
let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  ensureDir(dataDir);
  const secretFile = path.join(dataDir, '.session-secret');
  try {
    sessionSecret = fs.readFileSync(secretFile, 'utf8').trim();
  } catch {
    sessionSecret = crypto.randomBytes(48).toString('base64url');
    fs.writeFileSync(secretFile, sessionSecret + '\n', { mode: 0o600 });
  }
}

const resolveFromRoot = (p) => (path.isAbsolute(p) ? p : path.join(ROOT, p));

export const config = {
  env: process.env.NODE_ENV === 'production' ? 'production' : 'development',
  isProd: process.env.NODE_ENV === 'production',
  port: Number(process.env.PORT || 3000),
  baseUrl: process.env.APP_BASE_URL || 'http://localhost:3000',
  databasePath: resolveFromRoot(process.env.DATABASE_PATH || 'data/cartward.db'),
  uploadDir: resolveFromRoot(process.env.UPLOAD_DIR || 'data/uploads'),
  emailDir: resolveFromRoot(process.env.EMAIL_DIR || 'data/emails'),
  sessionSecret,
  currency: 'USD',
  session: {
    cookieName: 'cw_session',
    cartCookieName: 'cw_cart',
    idleMs: 7 * 24 * 60 * 60 * 1000, // 7 days of inactivity
    absoluteMs: 30 * 24 * 60 * 60 * 1000, // hard cap
  },
  cartTtlMs: 30 * 24 * 60 * 60 * 1000,
  reservationTtlMs: 15 * 60 * 1000,
  passwordMinLength: 12,
};

ensureDir(path.dirname(config.databasePath));
ensureDir(config.uploadDir);
ensureDir(config.emailDir);
