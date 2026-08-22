import { Router } from 'express';

const router = Router();

router.get('/account', (req, res, next) => {
  if (!req.user || req.pending2fa) return res.redirect('/login');
  try {
    res.render('account', { title: 'Your account' });
  } catch (err) {
    next(err);
  }
});

export default router;
