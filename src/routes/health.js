import { Router } from 'express';
import { db } from '../db/index.js';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../lib/logger.js';

const router = Router();

/** Liveness: process is up. */
router.get('/healthz', (req, res) => {
  res.status(200).json({ ok: true });
});

/** Readiness: migrations applied, database reachable, email dir accessible. */
router.get('/readyz', async (req, res) => {
  try {
    const migrations = db.prepare('SELECT COUNT(*) n FROM schema_migrations').get().n;
    if (migrations === 0) throw new Error('no migrations applied');
    db.prepare('SELECT 1').get();
    await fs.promises.access(config.emailDir);
    void path;
    res.status(200).json({ ok: true });
  } catch (err) {
    // Details stay in logs; the public body reveals nothing about the host.
    log.error('readiness check failed', { message: err.message });
    res.status(503).json({ ok: false });
  }
});

export default router;
