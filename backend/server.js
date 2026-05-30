/**
 * Quant Entelloq — Backend Server
 * Production-grade Express application with:
 *   - Helmet security headers + CSP
 *   - CORS (origin allowlist)
 *   - Compression + cookie parser
 *   - Per-route rate limiting
 *   - Structured logging (Pino) with request IDs
 *   - JWT authentication middleware
 *   - Sentry error tracking
 *   - Socket.io realtime layer
 *   - Graceful shutdown on SIGTERM/SIGINT
 */

import 'dotenv/config.js';
import http from 'node:http';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { v4 as uuid } from 'uuid';
import { Server as SocketServer } from 'socket.io';

import { logger, httpLogger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { initSentry, sentryRequestHandler, sentryErrorHandler } from './monitoring/sentry.js';
import { pool, runMigrationsIfPending } from './db/connection.js';
import { redis } from './cache/redis.js';
import { startPolygonStream, stopPolygonStream } from './realtime/polygon-ws.js';
import { attachRealtime, detachRealtime } from './realtime/server-events.js';
import { startNewsIngestion, stopNewsIngestion } from './pipelines/news-ingestion.js';

import authRoutes from './routes/auth.js';
import intelRoutes from './routes/intel.js';
import aiRoutes from './routes/ai.js';
import portfolioRoutes from './routes/portfolio.js';
import signalsRoutes from './routes/signals.js';
import healthRoutes from './routes/health.js';

const PORT = parseInt(process.env.PORT || '4000', 10);
const NODE_ENV = process.env.NODE_ENV || 'development';
const APP_URL = process.env.APP_URL || 'https://quant.entelloq.com';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || APP_URL)
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const app = express();
const server = http.createServer(app);

/* ------------------------------------------------------------------ *
 * 0. Sentry — must be first so it captures everything below.         *
 * ------------------------------------------------------------------ */
initSentry();
app.use(sentryRequestHandler());

/* ------------------------------------------------------------------ *
 * 1. Trust proxy + request ID + structured logger                    *
 * ------------------------------------------------------------------ */
app.set('trust proxy', 1);

app.use((req, res, next) => {
  req.id = req.headers['x-request-id'] || uuid();
  res.setHeader('x-request-id', req.id);
  next();
});

app.use(httpLogger);

/* ------------------------------------------------------------------ *
 * 2. Security headers                                                *
 * ------------------------------------------------------------------ */
app.use(
  helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://accounts.google.com', 'https://apis.google.com'],
        connectSrc: [
          "'self'",
          ...ALLOWED_ORIGINS,
          'https://accounts.google.com',
          'https://oauth2.googleapis.com',
          'https://www.googleapis.com',
        ],
        imgSrc: ["'self'", 'data:', 'https:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        frameSrc: ["'self'", 'https://accounts.google.com'],
      },
    },
    hsts: NODE_ENV === 'production' ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
  })
);

/* ------------------------------------------------------------------ *
 * 3. CORS                                                            *
 * ------------------------------------------------------------------ */
app.use(
  cors({
    origin(origin, cb) {
      // Allow same-origin / curl / server-to-server (no origin header)
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      logger.warn({ origin }, 'CORS rejected');
      return cb(new Error('Origin not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 86400,
  })
);

/* ------------------------------------------------------------------ *
 * 4. Body parsers + compression + cookies                            *
 * ------------------------------------------------------------------ */
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: true, limit: '256kb' }));
app.use(cookieParser(process.env.COOKIE_SECRET || 'change-me'));
app.use(compression());

/* ------------------------------------------------------------------ *
 * 5. Global rate limiter (per-IP).                                   *
 *    Tighter limiters live on /auth + /ai routes.                    *
 * ------------------------------------------------------------------ */
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 240, // 4 req/sec average
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: (req) => req.path === '/health' || req.path === '/health/ready',
    message: { error: 'rate_limited', message: 'Too many requests' },
  })
);

/* ------------------------------------------------------------------ *
 * 6. Routes                                                          *
 * ------------------------------------------------------------------ */
app.use('/health', healthRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/intel', intelRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/portfolio', portfolioRoutes);
app.use('/api/signals', signalsRoutes);

app.get('/', (req, res) => {
  res.json({
    name: 'Quant Entelloq API',
    version: process.env.npm_package_version || '1.0.0',
    status: 'ok',
    docs: 'https://quant.entelloq.com/docs',
  });
});

/* ------------------------------------------------------------------ *
 * 7. 404 + error handlers (must be last)                             *
 * ------------------------------------------------------------------ */
app.use(notFoundHandler);
app.use(sentryErrorHandler());
app.use(errorHandler);

/* ------------------------------------------------------------------ *
 * 8. Realtime: Socket.io                                             *
 * ------------------------------------------------------------------ */
const io = new SocketServer(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    credentials: true,
  },
  transports: ['websocket', 'polling'],
  pingInterval: 25000,
  pingTimeout: 60000,
});
attachRealtime(io);

/* ------------------------------------------------------------------ *
 * 9. Boot sequence                                                   *
 * ------------------------------------------------------------------ */
async function boot() {
  // Connect DB + run pending migrations
  try {
    const { rows } = await pool.query('SELECT NOW() AS now');
    logger.info({ now: rows[0].now }, 'Postgres connected');
    await runMigrationsIfPending();
  } catch (err) {
    logger.error({ err }, 'Postgres connection failed — exiting');
    process.exit(1);
  }

  // Connect Redis
  try {
    await redis.ping();
    logger.info('Redis connected');
  } catch (err) {
    logger.error({ err }, 'Redis connection failed — exiting');
    process.exit(1);
  }

  // Background pipelines (only on the primary server process — workers run separately)
  if (process.env.RUN_PIPELINES_INLINE === 'true') {
    startNewsIngestion();
  }

  // Polygon realtime stream (optional — requires POLYGON_API_KEY)
  if (process.env.POLYGON_API_KEY) {
    startPolygonStream(io);
  } else {
    logger.warn('POLYGON_API_KEY not set — realtime market data disabled');
  }

  server.listen(PORT, () => {
    logger.info({ port: PORT, env: NODE_ENV }, 'Quant Entelloq backend listening');
  });
}

/* ------------------------------------------------------------------ *
 * 10. Graceful shutdown                                              *
 * ------------------------------------------------------------------ */
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutdown signal received');

  // Stop accepting new connections
  server.close((err) => {
    if (err) logger.error({ err }, 'HTTP server close error');
    else logger.info('HTTP server closed');
  });

  // 30s grace period
  const grace = setTimeout(() => {
    logger.error('Force exit after 30s grace');
    process.exit(1);
  }, 30_000);
  grace.unref();

  try {
    stopPolygonStream();
    stopNewsIngestion();
    detachRealtime(io);
    await new Promise((resolve) => io.close(resolve));
    await pool.end();
    await redis.quit();
    logger.info('Clean shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Error during shutdown');
    process.exit(1);
  }
}

['SIGTERM', 'SIGINT'].forEach((s) => process.on(s, () => shutdown(s)));
process.on('unhandledRejection', (reason) => logger.error({ reason }, 'unhandledRejection'));
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaughtException');
  shutdown('uncaughtException');
});

boot().catch((err) => {
  logger.fatal({ err }, 'Boot failed');
  process.exit(1);
});

export { app, server, io };
