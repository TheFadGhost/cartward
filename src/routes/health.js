import { Router } from 'express';
import { db } from '../db/index.js';
import fs from 'node:fs';

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
    await fs.promises.access(process.env.EMAIL_DIR || 'data/emails');
    res.status(200).json({ ok: true, checks: { database: true, migrations, mailDir: true } });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

export default router;
