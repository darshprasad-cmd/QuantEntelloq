/**
 * Sentry initialization + Express middleware wrappers.
 *
 * No-op if SENTRY_DSN is empty.
 */

import * as Sentry from '@sentry/node';
import { logger } from '../lib/logger.js';

let initialized = false;

export function initSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    logger.info('Sentry disabled (no SENTRY_DSN)');
    return;
  }
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',
    release: process.env.SENTRY_RELEASE,
    tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0.1'),
    profilesSampleRate: parseFloat(process.env.SENTRY_PROFILES_SAMPLE_RATE || '0'),
    sendDefaultPii: false,
  });
  initialized = true;
  logger.info('Sentry initialized');
}

export function sentryRequestHandler() {
  if (!initialized) return (req, res, next) => next();
  return Sentry.Handlers?.requestHandler
    ? Sentry.Handlers.requestHandler({ ip: false, user: ['id', 'email'] })
    : (req, res, next) => next();
}

export function sentryErrorHandler() {
  if (!initialized) return (err, req, res, next) => next(err);
  return Sentry.Handlers?.errorHandler
    ? Sentry.Handlers.errorHandler({
        shouldHandleError(err) {
          // Send only 5xx and uncategorized errors
          const status = err.status || 500;
          return status >= 500;
        },
      })
    : (err, req, res, next) => next(err);
}

export function captureError(err, context = {}) {
  if (!initialized) return;
  Sentry.withScope((scope) => {
    Object.entries(context).forEach(([k, v]) => scope.setExtra(k, v));
    Sentry.captureException(err);
  });
}
