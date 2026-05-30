# Quant Entelloq — Backend

Production-grade Node.js backend for the Quant Entelloq trading intelligence platform.

## Stack

- **Runtime:** Node.js 20 (ESM)
- **HTTP:** Express 4
- **DB:** Postgres 16 (pg, pg_trgm, citext, FTS)
- **Cache + queues:** Redis 7 (ioredis + BullMQ)
- **Realtime:** Socket.io + SSE + Polygon WebSocket
- **AI:** Provider abstraction — Groq / OpenAI / Anthropic / Together (selected via `AI_PROVIDER`)
- **Observability:** Pino structured logs, Sentry, request IDs
- **Auth:** JWT (access + rotating refresh) with optional Google OAuth via ID token

## Layout

```
backend/
  server.js                # API process entry
  worker.js                # Pipeline / queue process entry
  package.json             # deps + scripts
  Dockerfile               # Multi-stage Node 20 image
  docker-compose.yml       # Local dev: api + worker + postgres + redis
  .env.example             # All env vars documented
  db/
    schema.sql             # Base schema (auto-applied once)
    migrate.js             # `npm run migrate`
    seed.js                # `npm run seed`
    connection.js          # pg pool + migration runner
    repositories/
      users.js
      intel.js
      portfolio.js
      assets.js
  cache/
    redis.js               # ioredis client + withCache(key, ttl, fn)
  services/
    ai.js                  # Provider-abstracted callOnce / callStream
    auth.js                # Password hashing, JWT, Google OAuth, sessions
    intel.js               # Feed orchestration + Redis caching
  routes/
    health.js  auth.js  intel.js  ai.js  portfolio.js  signals.js
  pipelines/
    news-ingestion.js      # node-cron, 32 RSS sources every 5 min
    rewriter.js            # BullMQ worker: AI rewrite raw → intel_items
    sentiment.js           # Zero-cost finance-tuned classifier
  realtime/
    server-events.js       # In-process pub/sub + Socket.io bridge
    polygon-ws.js          # Polygon.io WebSocket consumer
  middleware/
    auth.js  validation.js  error.js
  monitoring/
    sentry.js
  lib/
    logger.js  errors.js
  tests/
    auth.test.js  intel.test.js
```

## Local dev (Docker)

```bash
cp .env.example .env
# Fill at minimum:
#   JWT_SECRET, COOKIE_SECRET, AI_PROVIDER + matching key
docker compose up --build
```

That starts Postgres, Redis, the API on `:4000`, and the worker.
Migrations and base seed run automatically on first boot.

To run the seed manually:
```bash
docker compose exec api npm run seed
```

## Local dev (no Docker)

```bash
# Postgres 16 + Redis 7 running locally on default ports
cp .env.example .env
npm install
npm run migrate
npm run seed
npm run dev        # nodemon
# In another shell:
npm run worker
```

## Required env vars (minimum to boot)

| Var | Why |
|-----|-----|
| `DATABASE_URL` | Postgres connection |
| `REDIS_URL` | Redis connection |
| `JWT_SECRET` | Sign auth tokens (64-char hex) |
| `COOKIE_SECRET` | Cookie signing (32-char hex) |
| `AI_PROVIDER` + matching key | `/api/ai/*` requires this; otherwise returns 503 |
| `APP_URL`, `ALLOWED_ORIGINS` | CORS allowlist |

Optional but recommended in production: `SENTRY_DSN`, `GOOGLE_CLIENT_ID`, `MASSIVE_API_KEY` (realtime quotes), `STRIPE_SECRET_KEY` (subscriptions).

## Deployment runbook (Railway example)

You can swap Railway for Render, Fly, Heroku, or bare AWS — the steps are identical.

### 1. Provision Postgres + Redis
   - In Railway, add **PostgreSQL** and **Redis** plugins to the project.
   - Copy their connection strings.

### 2. Create the API service
   - **Source:** point Railway at the GitHub repo subfolder `backend/`.
   - **Builder:** Dockerfile (Railway auto-detects).
   - **Variables:** copy `.env.example` → Railway Variables. Fill secrets.
     Critical:
     - `DATABASE_URL` → use Railway's Postgres var reference: `${{Postgres.DATABASE_URL}}`
     - `REDIS_URL` → `${{Redis.REDIS_URL}}`
     - `DATABASE_SSL=require`
     - `JWT_SECRET`, `COOKIE_SECRET` → generate with `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`
     - `AI_PROVIDER=anthropic` + `ANTHROPIC_API_KEY=sk-ant-…` (or your chosen provider)
     - `APP_URL=https://quant.entelloq.com`
     - `ALLOWED_ORIGINS=https://quant.entelloq.com`
   - **Start command:** leave blank — Dockerfile CMD runs `node server.js`.
   - **Health check path:** `/health`

### 3. Create the worker service
   - Same repo, same Dockerfile.
   - Override **Start command:** `node worker.js`
   - Same env vars as API.

### 4. Set up a custom domain
   - Railway: Settings → Domains → add `api.quant.entelloq.com`.
   - In your DNS, point a CNAME at the Railway target host.
   - Update the frontend's `_QZ_API_BASE` to `https://api.quant.entelloq.com`.

### 5. Migrations
   - On first deploy the server auto-runs the base schema.
   - Subsequent migrations: add a numbered file under `db/migrations/NNN_*.sql`.
     The runner applies pending ones on boot inside a transaction.
   - For one-shot manual runs: `railway run npm run migrate`

### 6. Smoke test
```bash
curl https://api.quant.entelloq.com/health
curl https://api.quant.entelloq.com/api/auth/config
```

### 7. Wire the frontend
In `index.html`, change `_QZ_SERVER_MODE = false` to:
```js
window._QZ_SERVER_MODE = true;
window._QZ_API_BASE   = 'https://api.quant.entelloq.com';
```
Each endpoint in `lp3Signup`, `lp3Login`, `doGoogleAuth` etc. is already pointed at `/api/auth/*` — they'll start working as soon as `_QZ_SERVER_MODE` flips to true.

## API surface

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| `GET`  | `/health` | — | Liveness |
| `GET`  | `/health/ready` | — | DB + Redis + ingestion freshness |
| `GET`  | `/api/auth/config` | — | Public capability flags |
| `POST` | `/api/auth/signup` | — | Email signup |
| `POST` | `/api/auth/login` | — | Email login |
| `POST` | `/api/auth/google` | — | Verify Google ID token |
| `POST` | `/api/auth/refresh` | — | Rotate refresh |
| `POST` | `/api/auth/logout` | — | Revoke session |
| `GET`  | `/api/auth/me` | ✓ | Hydrate current user |
| `GET`  | `/api/intel/feed` | optional | Public, cached intel feed |
| `GET`  | `/api/intel/portfolio` | ✓ | Scoped to user holdings |
| `GET`  | `/api/intel/opportunities` | optional | Top scored opportunities |
| `GET`  | `/api/intel/sources` | — | List of intel sources |
| `GET`  | `/api/intel/item/:id` | — | Single intel item |
| `GET`  | `/api/intel/stream` | optional | SSE realtime stream |
| `GET`  | `/api/ai/status` | — | Provider info |
| `POST` | `/api/ai/call` | ✓ | Single JSON / text response |
| `POST` | `/api/ai/stream` | ✓ | SSE token stream |
| `GET`  | `/api/portfolio` | ✓ | List portfolios |
| `POST` | `/api/portfolio` | ✓ | Create portfolio |
| `GET`  | `/api/portfolio/:id/holdings` | ✓ | List holdings |
| `PUT`  | `/api/portfolio/:id/holdings` | ✓ | Upsert holding |
| `POST` | `/api/portfolio/:id/transactions` | ✓ | Record trade |
| `GET`  | `/api/signals` | optional | Active signals, ranked |

Socket.io topics (after `socket.emit('subscribe', topic)`):

- `intel.new` — broadcast on every new processed intel item
- `quote.<SYMBOL>` — per-symbol trade/quote/bar updates from Polygon

## Scripts

```bash
npm run dev        # nodemon server.js
npm start          # node server.js
npm run worker     # node worker.js
npm run migrate    # apply pending migrations
npm run seed       # seed intel sources + assets (idempotent)
npm test           # vitest run
npm run lint
npm run fmt
```

## Security checklist (already implemented)

- Helmet with strict CSP
- CORS allowlist
- Per-route rate limiting (auth 20 / 15 min, AI 60 / min, global 240 / min)
- Cookie-based JWT with `httpOnly`, `secure`, `sameSite=lax`
- Rotating refresh tokens, jti-based session revocation, Redis revocation list
- Bcrypt 12-round password hashing
- Input null-byte stripping
- Joi validation on every mutating endpoint
- Pino redaction of `authorization`, `cookie`, `password`, `token` fields
- Sentry 5xx-only capture (no PII)
- Stripe webhook idempotency table

## Notes

- The frontend stays on GitHub Pages; this backend is the system-of-record. Endpoints already exist on the frontend at the right paths — flipping `_QZ_SERVER_MODE = true` makes them live.
- The rewriter intentionally never copies source text verbatim. See `pipelines/rewriter.js` SYSTEM_PROMPT.
- Polygon WebSocket is optional. Without `POLYGON_API_KEY`/`MASSIVE_API_KEY`, the API still works; only realtime quotes are disabled.
