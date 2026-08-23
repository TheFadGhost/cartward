import { Router } from 'express';
import { dashboardStats, readAuditLog } from '../../services/admin.js';

const router = Router();

router.get('/admin', (req, res) => {
  const stats = dashboardStats();
  const recentAudit = readAuditLog({ limit: 6 });
  res.render('admin/dashboard', {
    layout: 'admin',
    title: 'Dashboard',
    ...stats,
    recentAudit,
  });
});

export default router;
