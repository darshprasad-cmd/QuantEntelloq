/**
 * Structured logger built on Pino.
 * - JSON lines in production (Cloud-friendly).
 * - Pretty-printed colors in development.
 * - Express middleware logs HTTP requests with request IDs.
 */

import pino from 'pino';

const isProd = process.env.NODE_ENV === 'production';
const level = process.env.LOG_LEVEL || (isProd ? 'info' : 'debug');

export const logger = pino({
  level,
  base: {
    service: 'quant-entelloq',
    env: process.env.NODE_ENV || 'development',
    pid: process.pid,
  },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.body.password',
      'req.body.password_hash',
      '*.password',
      '*.token',
      '*.refresh_token',
      '*.api_key',
    ],
    censor: '[REDACTED]',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: isProd
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          singleLine: false,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname,service,env',
        },
      },
});

/**
 * Express request logger.
 * - Logs on response finish.
 * - Skips noisy paths like /health.
 */
export function httpLogger(req, res, next) {
  const start = process.hrtime.bigint();
  const skip = req.path === '/health' || req.path === '/health/ready';

  res.on('finish', () => {
    if (skip && res.statusCode < 400) return;
    const ns = Number(process.hrtime.bigint() - start);
    const ms = +(ns / 1e6).toFixed(2);

    const child = logger.child({
      reqId: req.id,
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      ms,
      ua: req.headers['user-agent'],
      ip: req.ip,
      userId: req.user?.id,
    });

    if (res.statusCode >= 500) child.error('request failed');
    else if (res.statusCode >= 400) child.warn('request error');
    else child.info('request');
  });

  next();
}

export default logger;
