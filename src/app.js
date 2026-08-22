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
import { formatMoney } from './lib/money.js';
import { log } from './lib/logger.js';

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

  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use(express.json({ limit: '64kb' }));
  app.use(cookieMiddleware);
  app.use(requestLogMiddleware);
  app.use(sessionMiddleware);
  app.use(csrfMiddleware);

  // View helpers available to every template.
  app.use((req, res, next) => {
    res.locals.user = req.user;
    res.locals.pending2fa = req.pending2fa;
    res.locals.csrfToken = req.csrfToken();
    res.locals.currentPath = req.path;
    res.locals.config = config;
    res.locals.formatMoney = formatMoney;
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

  app.use(homeRoutes);
  app.use(authRoutes);

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
