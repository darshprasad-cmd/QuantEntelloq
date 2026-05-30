/**
 * Global error handler — last middleware in server.js.
 *
 * Translates AppError instances to JSON responses,
 * sanitizes unknown errors in production,
 * and emits a structured log line per failure.
 */

import { AppError, NotFoundError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export function notFoundHandler(req, res, next) {
  next(new NotFoundError(`Route ${req.method} ${req.path}`));
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  // If headers already sent, bail to Express's default
  if (res.headersSent) return;

  const isAppError = err instanceof AppError;
  const status = err.status || (isAppError ? err.status : 500);
  const code = err.code || (isAppError ? err.code : 'internal_error');
  const message =
    process.env.NODE_ENV === 'production' && status >= 500 && !isAppError
      ? 'Internal server error'
      : err.message || 'Error';

  const log = logger.child({
    reqId: req.id,
    userId: req.user?.id,
    method: req.method,
    path: req.path,
    status,
    code,
  });

  if (status >= 500) log.error({ err }, 'unhandled error');
  else if (status >= 400) log.warn({ err: { message, code } }, 'request rejected');

  const body = { error: code, message };
  if (err.details) body.details = err.details;
  if (process.env.NODE_ENV !== 'production' && status >= 500 && err.stack) body.stack = err.stack;

  res.status(status).json(body);
}
