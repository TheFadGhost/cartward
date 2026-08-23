import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import { config, ROOT } from './config.js';
import { cookieMiddleware } from './middleware/cookies.js';
import { sessionMiddleware } from './middleware/session.js';
import { csrfMiddleware } from './middleware/csrf.js';
import { requestLogMiddleware } from './middleware/request-log.js';
import authRoutes from './routes/auth.js';
import homeRoutes from './routes/home.js';
import accountRoutes from './routes/account.js';
import catalogRoutes from './routes/catalog.js';
import cartRoutes from './routes/cart.js';
import mediaRoutes from './routes/media.js';
import checkoutRoutes from './routes/checkout.js';
import orderRoutes from './routes/orders.js';
import webhookRoutes from './routes/webhooks.js';
import healthRoutes from './routes/health.js';
import adminRoutes from './routes/admin/index.js';
import { formatMoney } from './lib/money.js';
import { log } from './lib/logger.js';
import { resolveCart } from './services/cart.js';
import { db } from './db/index.js';

export function createApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(ROOT, 'src', 'views'));
  app.set('view options', { root: path.join(ROOT, 'src', 'views') });
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind a single reverse proxy in deployment

  const directives = {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'"],
    imgSrc: ["'self'", 'data:'],
    connectSrc: ["'self'"],
    fontSrc: ["'self'"],
    objectSrc: ["'none'"],
    frameAncestors: ["'none'"],
    baseUri: ["'none'"],
    formAction: ["'self'"],
  };
  if (config.isProd) directives.upgradeInsecureRequests = [];

  app.use(helmet({
    contentSecurityPolicy: { useDefaults: false, directives },
    hsts: config.isProd ? { maxAge: 15552000 } : false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  }));

  // The webhook route needs the raw body for signature verification —
  // mount it before the JSON parser touches anything.
  app.use(webhookRoutes);

  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use(express.json({ limit: '64kb' }));
  app.use(cookieMiddleware);
  app.use(requestLogMiddleware);
  app.use(sessionMiddleware);
  app.use(csrfMiddleware);

  // View helpers available to every template.
  const cartCountStmt = () => db.prepare('SELECT COALESCE(SUM(quantity),0) n FROM cart_items WHERE cart_id = ?');
  app.use((req, res, next) => {
    res.locals.user = req.user;
    res.locals.pending2fa = req.pending2fa;
    res.locals.csrfToken = req.csrfToken();
    res.locals.currentPath = req.path;
    res.locals.config = config;
    res.locals.formatMoney = formatMoney;
    res.locals.sessionId = req.sessionId ?? null;
    next();
  });

  // Header cart badge — resolves without creating carts on every request.
  app.use((req, res, next) => {
    res.locals.cartCount = 0;
    if (['GET', 'HEAD'].includes(req.method)) {
      try {
        const cart = resolveCart(req, res);
        if (cart) res.locals.cartCount = cartCountStmt().get(cart.id).n;
      } catch { /* header badge is best-effort */ }
    }
    next();
  });

  // One-shot flash messages via short-lived cookie.
  app.use((req, res, next) => {
    res.locals.flash = null;
    const raw = req.cookies.cw_flash;
    if (raw && ['GET', 'HEAD'].includes(req.method)) {
      try {
        const parsed = JSON.parse(decodeURIComponent(raw));
        if (parsed && typeof parsed.message === 'string' && parsed.message.length < 500) {
          res.locals.flash = parsed;
        }
      } catch { /* ignore malformed */ }
      res.clearCookie('cw_flash');
    }
    res.flash = (type, message) => {
      res.setCookie('cw_flash', encodeURIComponent(JSON.stringify({ type, message })), {
        httpOnly: true,
        sameSite: 'Lax',
        secure: config.isProd,
        maxAge: 60_000,
      });
    };
    next();
  });

  app.use(express.static(path.join(ROOT, 'src', 'public'), {
    maxAge: config.isProd ? '7d' : 0,
    setHeaders(res) { res.setHeader('Cross-Origin-Resource-Policy', 'same-origin'); },
  }));

  app.use(mediaRoutes);
  app.use(homeRoutes);
  app.use(accountRoutes);
  app.use(authRoutes);
  app.use(catalogRoutes);
  app.use(cartRoutes);
  app.use(checkoutRoutes);
  app.use(orderRoutes);
  app.use(adminRoutes);
  app.use(healthRoutes);

  // 404
  app.use((req, res) => {
    res.status(404).render('error', {
      title: 'Page not found',
      message: "We couldn't find that page.",
      statusCode: 404,
      user: req.user,
      csrfToken: req.csrfToken(),
    });
  });

  // Central error handler
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) {
      log.error('unhandled error', { requestId: req.requestId, message: err.message, stack: err.stack });
    }
    if (req.accepts('html') === 'html') {
      return res.status(status).render('error', {
        title: status >= 500 ? 'Something went wrong' : 'Request failed',
        message: status >= 500
          ? 'Something went wrong on our side. Please try again.'
          : (err.publicMessage || 'The request could not be completed.'),
        statusCode: status,
        user: req.user,
        csrfToken: typeof req.csrfToken === 'function' ? req.csrfToken() : '',
      });
    }
    return res.status(status).json({ error: { code: err.code || 'error', message: err.publicMessage || 'Request failed' } });
  });

  return app;
}
