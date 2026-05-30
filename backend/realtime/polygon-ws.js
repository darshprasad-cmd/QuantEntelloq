/**
 * Polygon.io (Massive Market Data) WebSocket consumer.
 *
 * Connects to the appropriate cluster, authenticates, subscribes to a
 * dynamic ticker universe, and rebroadcasts quotes / trades through the
 * realtime bus so Socket.io clients can opt-in via room `quote.<symbol>`.
 *
 * Reconnects with exponential backoff on disconnect.
 * Heartbeats every 25s to detect dead links.
 */

import WebSocket from 'ws';
import { logger } from '../lib/logger.js';
import { realtime } from './server-events.js';
import { query } from '../db/connection.js';

const POLYGON_KEY = process.env.POLYGON_API_KEY || process.env.MASSIVE_API_KEY;
const CLUSTER = process.env.POLYGON_CLUSTER || 'stocks'; // stocks|crypto|forex
const URL = `wss://socket.polygon.io/${CLUSTER}`;
const HEARTBEAT_MS = 25_000;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;

let ws = null;
let reconnectAttempts = 0;
let heartbeat = null;
let stopRequested = false;
let subscriptions = new Set();

async function defaultUniverse() {
  // Top 50 by market cap from our asset table — keeps WS msg volume sane
  try {
    const { rows } = await query(
      `SELECT ticker FROM assets
        WHERE is_active = TRUE AND asset_type IN ('stock', 'etf')
        ORDER BY market_cap DESC NULLS LAST
        LIMIT 50`
    );
    return rows.map((r) => `T.${r.ticker}`); // Trades channel
  } catch {
    return ['T.AAPL', 'T.MSFT', 'T.NVDA', 'T.GOOGL', 'T.AMZN', 'T.META', 'T.TSLA'];
  }
}

function backoffMs() {
  return Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
}

function clearHeartbeat() {
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
}

function startHeartbeat() {
  clearHeartbeat();
  heartbeat = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      try {
        ws.ping();
      } catch {
        /* ignore */
      }
    }
  }, HEARTBEAT_MS);
}

async function connect() {
  if (!POLYGON_KEY) return;
  if (stopRequested) return;

  logger.info({ url: URL, attempt: reconnectAttempts }, 'polygon ws connecting');

  ws = new WebSocket(URL, { handshakeTimeout: 10_000 });

  ws.on('open', () => {
    logger.info('polygon ws connected, authenticating');
    ws.send(JSON.stringify({ action: 'auth', params: POLYGON_KEY }));
  });

  ws.on('message', async (data) => {
    let messages;
    try {
      messages = JSON.parse(data.toString());
    } catch (err) {
      logger.warn({ err: err.message }, 'polygon ws bad json');
      return;
    }
    if (!Array.isArray(messages)) messages = [messages];

    for (const m of messages) {
      switch (m.ev) {
        case 'status':
          if (m.status === 'auth_success') {
            logger.info('polygon ws authenticated');
            reconnectAttempts = 0;
            startHeartbeat();
            if (!subscriptions.size) {
              for (const s of await defaultUniverse()) subscriptions.add(s);
            }
            ws.send(JSON.stringify({ action: 'subscribe', params: [...subscriptions].join(',') }));
          } else if (m.status === 'auth_failed') {
            logger.error({ msg: m.message }, 'polygon ws auth failed');
            stopRequested = true;
            try { ws.close(); } catch { /* */ }
          }
          break;
        case 'T': // Trade
          realtime.publish('quote', {
            symbol: m.sym,
            price: m.p,
            size: m.s,
            ts: m.t,
            ev: 'trade',
          }, { room: `quote.${m.sym}` });
          break;
        case 'Q': // Quote (NBBO)
          realtime.publish('quote', {
            symbol: m.sym,
            bid: m.bp,
            ask: m.ap,
            bidSize: m.bs,
            askSize: m.as,
            ts: m.t,
            ev: 'quote',
          }, { room: `quote.${m.sym}` });
          break;
        case 'A': // Per-second aggregate
        case 'AM': // Per-minute aggregate
          realtime.publish('bar', {
            symbol: m.sym,
            o: m.o, h: m.h, l: m.l, c: m.c, v: m.v,
            startTs: m.s, endTs: m.e,
            interval: m.ev === 'AM' ? '1m' : '1s',
          }, { room: `quote.${m.sym}` });
          break;
        default:
          // Unhandled event types ignored
      }
    }
  });

  ws.on('error', (err) => {
    logger.warn({ err: err.message }, 'polygon ws error');
  });

  ws.on('close', (code, reason) => {
    clearHeartbeat();
    logger.warn({ code, reason: reason?.toString() }, 'polygon ws closed');
    if (stopRequested) return;
    reconnectAttempts++;
    setTimeout(connect, backoffMs()).unref();
  });

  ws.on('pong', () => {
    logger.trace?.('polygon ws pong');
  });
}

export function startPolygonStream() {
  if (!POLYGON_KEY) {
    logger.warn('POLYGON_API_KEY/MASSIVE_API_KEY missing — Polygon WS disabled');
    return;
  }
  stopRequested = false;
  connect().catch((err) => logger.error({ err }, 'polygon ws boot failed'));
}

export function stopPolygonStream() {
  stopRequested = true;
  clearHeartbeat();
  try {
    ws?.close();
  } catch {
    /* */
  }
  ws = null;
}

/** Dynamically add a symbol to the subscription set. */
export function subscribeSymbol(symbol) {
  if (!symbol) return;
  const param = `T.${symbol.toUpperCase()}`;
  if (subscriptions.has(param)) return;
  subscriptions.add(param);
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: 'subscribe', params: param }));
  }
}
