# syntax=docker/dockerfile:1.7

# ---------- 1. Builder ------------------------------------------------
FROM node:20-alpine AS builder

WORKDIR /app

# Install deps with cache mount for faster rebuilds
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund

# ---------- 2. Runtime ------------------------------------------------
FROM node:20-alpine AS runtime

# Drop privileges
RUN addgroup -S app && adduser -S -G app app

WORKDIR /app

# Healthcheck helper
RUN apk add --no-cache curl tini

# Copy installed deps and source
COPY --from=builder /app/node_modules ./node_modules
COPY --chown=app:app . .

ENV NODE_ENV=production \
    PORT=4000 \
    LOG_LEVEL=info

EXPOSE 4000

USER app

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT}/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
# Default to the API; override to `node worker.js` for worker pods
CMD ["node", "server.js"]
