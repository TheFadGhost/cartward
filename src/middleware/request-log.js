import { newId } from '../lib/tokens.js';
import { log } from '../lib/logger.js';

/** Attach a request id and log method/path/status/duration. */
export function requestLogMiddleware(req, res, next) {
  req.requestId = newId();
  res.setHeader('X-Request-Id', req.requestId);
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    log.info('request', {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      durationMs: Math.round(ms * 10) / 10,
      userId: req.user?.id ?? null,
    });
  });
  next();
}
