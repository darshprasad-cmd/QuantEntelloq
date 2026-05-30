# 🚀 Quant Entelloq — Free Render Deployment

**Total cost: $0/mo.** Real launch-grade stack. Takes ~10 minutes.

## Architecture (free tier)

| Component | Service | Why |
|-----------|---------|-----|
| API + ingestion + rewriter (single process) | **Render Web Service** | Free, GitHub OAuth, no card |
| Postgres | **Neon** | 0.5 GB, no card, instant boot |
| Redis | **Upstash** | 10k commands/day, no card |
| AI provider | **Groq** | Free Llama 3.3 70B with generous rate limits |
| Keep-alive pinger | **cron-job.org** | Free, prevents 15-min sleep |
| Error tracking (optional) | **Sentry** | 5k events/mo free |

---

## STEP 1 — Get the 3 connection strings (5 min)

### 1A. Neon Postgres → `DATABASE_URL`
1. Go to https://neon.tech → **Sign up with GitHub**
2. Project name: `quant-entelloq` → region nearest you → **Create**
3. The dashboard shows a connection string. Copy it. It looks like:
   ```
   postgresql://neondb_owner:abc...@ep-cool-cloud-12345.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```
4. Paste into the env block below as `DATABASE_URL=…`

### 1B. Upstash Redis → `REDIS_URL`
1. Go to https://console.upstash.com → **Sign up with GitHub**
2. **Create Database** → Name: `quant-entelloq` → Region nearest you → **Free** plan → **Create**
3. Scroll to **Connect** → copy the **`redis://`** URL (NOT the `https://` one). Looks like:
   ```
   rediss://default:abc123@us1-cool-cat-12345.upstash.io:6379
   ```
4. Paste below as `REDIS_URL=…`

### 1C. Groq AI → `GROQ_API_KEY`
1. Go to https://console.groq.com → **Sign up with Google**
2. Left sidebar → **API Keys** → **Create API Key** → name it `quant-entelloq`
3. Copy the `gsk_…` token (you'll never see it again — save it now)
4. Paste below as `GROQ_API_KEY=…`

---

## STEP 2 — Deploy to Render (3 min)

1. Go to https://render.com → **Sign up with GitHub**
2. Top right → **+ New** → **Web Service**
3. **Connect your repo** → pick `darshprasad-cmd/QuantEntelloq`
4. Settings:
   - **Name:** `quant-entelloq-api`
   - **Region:** Oregon (or closest to you)
   - **Branch:** `main`
   - **Root Directory:** `backend`
   - **Runtime:** `Docker` (Render auto-detects from your Dockerfile)
   - **Instance Type:** `Free`
5. Scroll down → **Environment Variables** → click **Add from .env** and paste this whole block (after replacing the 3 placeholders):

```env
NODE_ENV=production
PORT=4000
APP_URL=https://quant.entelloq.com
ALLOWED_ORIGINS=https://quant.entelloq.com,https://www.quant.entelloq.com,https://darshprasad-cmd.github.io
RUN_PIPELINES_INLINE=true

# ── Paste your 3 connection strings from STEP 1 ──
DATABASE_URL=postgresql://PASTE_FROM_NEON_HERE
DATABASE_SSL=require
REDIS_URL=rediss://PASTE_FROM_UPSTASH_HERE
REDIS_TLS=true

# ── AI provider ──
AI_PROVIDER=groq
GROQ_API_KEY=gsk_PASTE_FROM_GROQ_HERE

# ── Auth secrets (already generated for you) ──
JWT_SECRET=fb630360a9a74a7c99823de591b270eb55b49802ffa947e4743e0000e02dca2537211a167f3fa8763f3f814331faee52d1cf4f2ff6c58a0d5257a6d97e0c2cf9
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=30d
COOKIE_SECRET=89cf0f556c634b4fc5f677e9ea04c2d8b5b94878081f485bd579cb5d8ec661c4
COOKIE_DOMAIN=

# ── Free tier limits ──
FREE_TIER_DAILY_AI_LIMIT=20
FREE_TIER_DAILY_DISCOVER_LIMIT=50
AI_MAX_TOKENS=2000
LOG_LEVEL=info
```

6. Click **Create Web Service**
7. Watch the deploy logs. First build is ~3–4 min. Look for:
   ```
   Postgres connected
   Redis connected
   Quant Entelloq backend listening
   ```
8. Top of the page shows your URL: `https://quant-entelloq-api.onrender.com`

---

## STEP 3 — Smoke test (30 sec)

Paste both into your browser (or terminal):

```bash
curl https://quant-entelloq-api.onrender.com/health
# → {"status":"ok","uptime":12,"version":"1.0.0","env":"production"}

curl https://quant-entelloq-api.onrender.com/api/auth/config
# → {"googleEnabled":false,"stripeEnabled":false,"aiProvider":"groq",…}
```

If both return JSON, **the backend is live.** ✅

---

## STEP 4 — Seed the database (one-time, 30 sec)

In the Render dashboard for your service → **Shell** tab → run:
```bash
npm run seed
```

This populates the 32 intel sources and the base asset universe. The news ingestion cron picks up from there.

---

## STEP 5 — Keep it awake (1 min)

Free Render web sleeps after 15 min idle. Cron-job.org pings it to stay warm during launch hours.

1. https://cron-job.org → sign up free (email)
2. **Cronjobs** → **Create cronjob**
3. **Title:** Keep Quant Entelloq alive
4. **URL:** `https://quant-entelloq-api.onrender.com/health`
5. **Schedule:** Every 14 minutes
6. **Save**

---

## STEP 6 — Flip the frontend to use the backend (1 line change)

Open `index.html` in your editor, find this block near the top of `<body>`:
```js
window._QZ_SERVER_MODE = false;
```
Change to:
```js
window._QZ_SERVER_MODE = true;
window._QZ_API_BASE   = 'https://quant-entelloq-api.onrender.com';
```

Commit + push. GitHub Pages auto-deploys. The site now talks to your real backend.

> **Optional:** Set up `api.quant.entelloq.com` as a custom domain on Render later (Free plan supports custom domains). Then change `_QZ_API_BASE` to `https://api.quant.entelloq.com`.

---

## Caveats (real talk)

- **First request after 15 min idle = ~30-50s** while the free dyno wakes. The keep-alive pinger reduces this during active hours.
- **Neon free Postgres auto-suspends after 5 min idle** (transparent — adds ~2s to the first query). Not a big deal.
- **Upstash limit: 10,000 commands/day.** Each `withCache` lookup uses ~2 commands. Should handle ~500 active users/day.
- **Polygon WebSocket disabled by default** (not in this env block). Frontend works without it. Add `POLYGON_API_KEY=…` later if you want real-time quotes.
- **Google OAuth disabled** until you add `GOOGLE_CLIENT_ID=…`. Email/password auth works immediately.

---

## When you outgrow free tier

Pay points (each ~$5–$20/mo):
- Render Starter ($7/mo) — no sleep, faster CPU
- Upstash Pay-as-you-go (~$0.20/100k commands) when you exceed 10k/day
- Neon Launch ($19/mo) — 10 GB, no auto-suspend
- Sentry Team ($26/mo) — more events + alerts

Total when scaling: $30–60/mo for a real production setup.
