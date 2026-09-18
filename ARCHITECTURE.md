# Quant Entelloq architecture

## System overview
Quant Entelloq has two deployable surfaces:

1. A dependency-free browser SPA served from the repository root, currently suitable for GitHub Pages.
2. A Node.js backend in `backend/` that supplies authenticated, persistent, cached, AI-assisted, and realtime features when server mode is enabled.

```text
Browser SPA
  |-- static/local data and third-party browser feeds
  |-- REST + cookies ----------> Express API
  |-- SSE / Socket.io ---------> realtime bridge
                                  |-- Postgres (system of record)
                                  |-- Redis (cache, queues, revocation)
                                  |-- BullMQ worker
                                  |-- AI provider adapter
                                  |-- RSS ingestion/rewrite/sentiment pipelines
                                  `-- optional market-data websocket
```

## Frontend
- `index.html`: document shell, styles, and initial application markup.
- `js/app.js`: readable application source and client-side feature logic.
- `js/app.min.js`: minified production artifact; regenerate after modifying `app.js`.
- `js/lightweight-charts.min.js`: vendored charting library.
- `assets/`: brand, media, icons, and onboarding assets.
- `manifest.webmanifest`, `robots.txt`, `sitemap.xml`, and `CNAME`: PWA/SEO/domain configuration.

The frontend can run without the backend. Server-backed behavior is controlled by the server-mode/API-base configuration documented in `backend/README.md`.

## Backend request flow
- `backend/server.js`: creates Express and Socket.io servers, installs middleware, mounts routes, and starts infrastructure.
- `backend/routes/`: HTTP boundary and request/response handling.
- `backend/middleware/`: authentication, validation, and centralized error handling.
- `backend/services/`: reusable domain/integration logic for auth, intelligence feeds, and AI.
- `backend/db/repositories/`: SQL persistence boundary.
- `backend/db/schema.sql`, `migrate.js`, and `seed.js`: schema lifecycle and seed data.
- `backend/cache/redis.js`: Redis connection and caching helper.

Routes should validate input, delegate to services/repositories, and return stable response shapes.

## Background and realtime flow
- `backend/worker.js`: background-process entrypoint.
- `backend/pipelines/news-ingestion.js`: scheduled RSS ingestion.
- `backend/pipelines/rewriter.js`: BullMQ AI rewrite worker.
- `backend/pipelines/sentiment.js`: local finance sentiment classification.
- `backend/realtime/server-events.js`: in-process events and Socket.io bridge.
- `backend/realtime/polygon-ws.js`: optional external market-data stream.

The normal intelligence path is source ingestion -> raw storage/queue -> rewrite and sentiment -> persisted intelligence item -> cache/invalidation -> SSE or Socket.io notification.

## Security and configuration
- Secrets belong only in environment configuration; `backend/.env.example` documents supported keys.
- Auth is cookie-based JWT with rotating refresh tokens and Redis-backed revocation.
- CORS, Helmet/CSP, validation, logging redaction, and rate limits are part of the security boundary.
- Postgres is authoritative; Redis is disposable acceleration/coordination state.
- AI providers are selected through `AI_PROVIDER` and accessed only via the provider abstraction.

## Deployment
- The frontend is static and uses `CNAME` for its custom domain.
- `backend/Dockerfile` builds the API/worker image.
- `backend/docker-compose.yml` defines local API, worker, Postgres, and Redis services.
- `backend/DEPLOY_RENDER.md` and `backend/README.md` contain the operational runbook.
