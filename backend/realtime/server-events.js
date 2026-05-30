/**
 * Tiny in-process pub/sub + Socket.io bridge.
 *
 * Use `realtime.publish(event, payload)` to broadcast to:
 *   - all SSE subscribers (via `realtime.subscribe(event, fn)`)
 *   - all Socket.io clients on the same event name
 *
 * Used by:
 *   - pipelines/rewriter.js (publishes `intel.new`)
 *   - realtime/polygon-ws.js (publishes `quote.<symbol>`)
 */

import { EventEmitter } from 'node:events';
import { logger } from '../lib/logger.js';

class Realtime extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    this.io = null;
  }

  attachIO(io) {
    this.io = io;
    io.on('connection', (socket) => {
      logger.debug({ sid: socket.id, ua: socket.handshake.headers['user-agent'] }, 'socket connected');
      socket.on('subscribe', (topic) => {
        if (typeof topic === 'string' && topic.length < 80) socket.join(topic);
      });
      socket.on('unsubscribe', (topic) => {
        if (typeof topic === 'string') socket.leave(topic);
      });
      socket.on('disconnect', (reason) => {
        logger.debug({ sid: socket.id, reason }, 'socket disconnect');
      });
    });
  }

  detachIO() {
    this.io = null;
  }

  publish(event, payload, { room } = {}) {
    this.emit(event, payload);              // notify SSE subscribers
    if (this.io) {
      const target = room ? this.io.to(room) : this.io;
      target.emit(event, payload);
    }
  }

  subscribe(event, fn) {
    this.on(event, fn);
    return () => this.off(event, fn);
  }
}

export const realtime = new Realtime();

export function attachRealtime(io) {
  realtime.attachIO(io);
  logger.info('Socket.io attached to realtime bus');
}

export function detachRealtime() {
  realtime.detachIO();
}
