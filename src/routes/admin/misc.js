import { Router } from 'express';
import { listCustomers, getCustomer, readAuditLog } from '../../services/admin.js';
import { db } from '../../db/index.js';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config.js';

const router = Router();

router.get('/admin/customers', (req, res) => {
  const q = String(req.query.q || '').slice(0, 80);
  const rows = listCustomers({ q });
  res.render('admin/customers/index', { layout: 'admin', title: 'Customers', rows, q });
});

router.get('/admin/customers/:id', (req, res) => {
  const customer = getCustomer(req.params.id);
  if (!customer) return res.status(404).render('error', { title: 'Not found', message: 'No such customer.', statusCode: 404 });
  res.render('admin/customers/show', {
    layout: 'admin',
    title: customer.email,
    customer,
    orders: db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY placed_at DESC LIMIT 50').all(customer.id),
  });
});

router.get('/admin/audit-log', (req, res) => {
  const rows = readAuditLog({ limit: 200 });
  res.render('admin/audit', { layout: 'admin', title: 'Audit log', rows });
});

/** Dev mailbox viewer: lists emails captured to disk (development only). */
router.get('/admin/mailbox', (req, res) => {
  let rows = [];
  try {
    rows = db.prepare('SELECT * FROM emails_out ORDER BY sent_at DESC LIMIT 100').all()
      .map((r) => {
        let preview = '';
        try {
          const eml = fs.readFileSync(path.join(config.emailDir, r.filename), 'utf8');
          preview = eml.length > 400 ? `${eml.slice(0, 400)}…` : eml;
        } catch { preview = '(file unavailable)'; }
        return { ...r, preview };
      });
  } catch { /* empty */ }
  res.render('admin/mailbox', { layout: 'admin', title: 'Captured emails', rows });
});

export default router;
