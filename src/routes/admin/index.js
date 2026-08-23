import { Router } from 'express';
import { requireAdmin } from '../../middleware/session.js';
import dashboardRoutes from './dashboard.js';
import productRoutes from './products.js';
import orderRoutes from './orders.js';
import miscRoutes from './misc.js';

const router = Router();

// Every /admin route re-checks the session's role server-side. There is no
// client-side gating anywhere — hiding UI is not authorization.
router.use('/admin', requireAdmin);

router.use(dashboardRoutes);
router.use(productRoutes);
router.use(orderRoutes);
router.use(miscRoutes);

export default router;
