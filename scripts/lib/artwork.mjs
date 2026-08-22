import crypto from 'node:crypto';

/**
 * Deterministic abstract product art. Same seed -> same image, every run.
 * Original generated compositions — no real products, no photography.
 * Art sits on its own opaque warm-paper board so it reads correctly on both
 * storefront themes (see DESIGN.md imagery rules).
 */

function hashSeed(str) {
  return crypto.createHash('sha256').update(str).digest();
}

function prng(bytes) {
  let s = bytes.readUInt32LE(0) || 1;
  return () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Muted editorial palettes (hue families), all pass contrast on paper bg.
const PALETTES = [
  { bg: '#f3eee6', ink: '#3d5a3c', mid: '#8ba383', soft: '#cdd8c5', dark: '#26382a' },
  { bg: '#efe9e2', ink: '#7a4433', mid: '#b08a76', soft: '#dcc9bd', dark: '#4a2a20' },
  { bg: '#eceff0', ink: '#3d5a66', mid: '#7f99a4', soft: '#c6d3d9', dark: '#243640' },
  { bg: '#f2ecdf', ink: '#8a5a12', mid: '#bb9560', soft: '#e0cba8', dark: '#503508' },
  { bg: '#eeeaf1', ink: '#57496b', mid: '#8f81a5', soft: '#cec6db', dark: '#332a41' },
  { bg: '#eff0ea', ink: '#55603f', mid: '#93a077', soft: '#ccd3bc', dark: '#303823' },
];

const COMPOSITIONS = ['vessels', 'stack', 'arch', 'weave', 'orbit'];

/**
 * Generate an SVG string for a product.
 * @param {string} seed stable string (e.g. product id)
 * @param {number} size declared square size
 */
export function generateProductSvg(seedStr, size = 800) {
  const digest = hashSeed(seedStr);
  const rand = prng(digest);
  const palette = PALETTES[digest[4] % PALETTES.length];
  const composition = COMPOSITIONS[digest[5] % COMPOSITIONS.length];
  const parts = [];

  parts.push(`<rect width="${size}" height="${size}" fill="${palette.bg}"/>`);
  // subtle ground shadow line
  const groundY = size * (0.72 + rand() * 0.06);
  parts.push(`<rect x="${size * 0.12}" y="${groundY}" width="${size * 0.76}" height="10" rx="5" fill="${palette.soft}"/>`);

  if (composition === 'vessels') {
    const cx1 = size * (0.34 + rand() * 0.08);
    const cx2 = size * (0.62 + rand() * 0.08);
    parts.push(vessel(cx1, groundY, size * (0.16 + rand() * 0.05), palette.ink, palette.dark));
    parts.push(vessel(cx2, groundY, size * (0.11 + rand() * 0.04), palette.mid, palette.ink));
    parts.push(sun(cx2 - size * 0.16, groundY - size * 0.42, size * 0.05, palette.soft));
  } else if (composition === 'stack') {
    let y = groundY;
    const widths = [0.34, 0.27, 0.2].map((w) => w * (0.85 + rand() * 0.3));
    const fills = [palette.ink, palette.mid, palette.soft];
    for (let i = 0; i < 3; i++) {
      const h = size * (0.09 + rand() * 0.04);
      y -= h;
      parts.push(rect(size / 2 - widths[i] / 2, y, widths[i], h, fills[i]));
      y -= size * 0.02;
    }
  } else if (composition === 'arch') {
    const r = size * (0.22 + rand() * 0.05);
    parts.push(`<path d="M ${size / 2 - r} ${groundY} A ${r} ${r} 0 0 1 ${size / 2 + r} ${groundY} Z" fill="${palette.ink}"/>`);
    parts.push(rect(size / 2 - r, groundY - 8, 2 * r, 8, palette.dark));
    parts.push(circle(size / 2 + r * 1.6, groundY - r * 1.2, size * 0.035, palette.mid));
  } else if (composition === 'weave') {
    const n = 5 + Math.floor(rand() * 3);
    const bandW = (size * 0.6) / n;
    for (let i = 0; i < n; i++) {
      const x = size * 0.2 + i * bandW;
      const h = size * (0.25 + rand() * 0.18);
      parts.push(rect(x, groundY - h, bandW * 0.62, h, i % 2 ? palette.mid : palette.ink));
    }
  } else {
    // orbit
    const cx = size / 2;
    const cy = groundY - size * 0.2;
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${size * 0.17}" fill="none" stroke="${palette.ink}" stroke-width="${size * 0.02}"/>`);
    parts.push(circle(cx, cy, size * 0.06, palette.mid));
    const angle = rand() * Math.PI * 2;
    parts.push(circle(cx + Math.cos(angle) * size * 0.17, cy + Math.sin(angle) * size * 0.17, size * 0.025, palette.dark));
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
<metadata>Generated placeholder art for Cartward demonstration catalogue.</metadata>
${parts.join('\n')}
</svg>`;
}

function vessel(cx, baseY, radius, fill, accent) {
  const h = radius * 2.1;
  const topR = radius * 0.62;
  return `<path d="M ${cx - topR} ${baseY - h}
    C ${cx - radius} ${baseY - h * 0.7}, ${cx - radius} ${baseY - h * 0.3}, ${cx - radius * 0.86} ${baseY}
    L ${cx + radius * 0.86} ${baseY}
    C ${cx + radius} ${baseY - h * 0.3}, ${cx + radius} ${baseY - h * 0.7}, ${cx + topR} ${baseY - h} Z"
    fill="${fill}"/>
  <ellipse cx="${cx}" cy="${baseY - h}" rx="${topR}" ry="${radius * 0.14}" fill="${accent}"/>`;
}
const rect = (x, y, w, h, fill) => `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${Math.min(w, h) * 0.08}" fill="${fill}"/>`;
const circle = (cx, cy, r, fill) => `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="${fill}"/>`;
const sun = (cx, cy, r, fill) => `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="${fill}"/>`;
