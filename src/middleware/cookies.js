/** Minimal RFC 6265 cookie parser — req.cookies object + res helpers. */
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    let value = part.slice(idx + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

export function cookieMiddleware(req, res, next) {
  req.cookies = parseCookies(req.headers.cookie);
  res.setCookie = (name, value, opts = {}) => {
    const parts = [`${name}=${encodeURIComponent(value)}`];
    parts.push(`Path=${opts.path || '/'}`);
    if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAge / 1000)}`);
    if (opts.httpOnly !== false) parts.push('HttpOnly');
    parts.push(`SameSite=${opts.sameSite || 'Lax'}`);
    if (opts.secure) parts.push('Secure');
    const existing = res.getHeader('Set-Cookie');
    const list = existing ? [].concat(existing) : [];
    list.push(parts.join('; '));
    res.setHeader('Set-Cookie', list);
  };
  res.clearCookie = (name, opts = {}) => {
    res.setCookie(name, '', { ...opts, maxAge: 0 });
  };
  next();
}
