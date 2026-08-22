import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { config } from '../config.js';

const router = Router();

const ALLOWED_EXT = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp']);
const CONTENT_TYPES = {
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

/**
 * Serves registered product media from the uploads dir.
 * Only files whose names were minted server-side are referenced; extension
 * whitelist + resolved-path containment guard against traversal.
 */
router.get('/media/products/:filename', (req, res) => {
  const filename = path.basename(String(req.params.filename));
  const ext = path.extname(filename).toLowerCase();
  if (!ALLOWED_EXT.has(ext) || !/^[a-z0-9-]+$/i.test(path.basename(filename, ext))) {
    return res.status(404).send('Not found');
  }
  const full = path.join(config.uploadDir, 'products', filename);
  if (!full.startsWith(path.join(config.uploadDir, 'products')) || !fs.existsSync(full)) {
    return res.status(404).send('Not found');
  }
  res.setHeader('Content-Type', CONTENT_TYPES[ext]);
  res.setHeader('Cache-Control', config.isProd ? 'public, max-age=604800, immutable' : 'no-cache');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  return res.sendFile(full);
});

export default router;
