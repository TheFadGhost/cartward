import crypto from 'node:crypto';

/** Opaque 256-bit URL-safe token from the CSPRNG. */
export function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/** SHA-256 hex digest — used to store tokens/sessions at rest. */
export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Constant-time string equality. */
export function timingSafeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Still burn comparable time before failing.
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

/** HMAC-SHA256 hex signature. */
export function hmacHex(secret, value) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

export function newId() {
  return crypto.randomUUID();
}
