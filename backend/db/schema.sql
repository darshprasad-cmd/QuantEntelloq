-- =====================================================================
-- Quant Entelloq — Base Postgres schema
-- Applied exactly once by db/connection.js#runMigrationsIfPending().
-- Subsequent changes go in db/migrations/NNN_description.sql files.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";          -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "pg_trgm";           -- ILIKE indexes + similarity()
CREATE EXTENSION IF NOT EXISTS "citext";            -- case-insensitive email

-- ---------------------------------------------------------------------
-- Users + authentication
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                    CITEXT NOT NULL UNIQUE,
  name                     TEXT NOT NULL,
  password_hash            TEXT NOT NULL DEFAULT '',         -- empty for OAuth-only users
  auth_provider            TEXT NOT NULL DEFAULT 'email',    -- email | google
  google_sub               TEXT UNIQUE,                       -- Google subject id
  avatar_url               TEXT,
  email_verified_at        TIMESTAMPTZ,
  subscription             TEXT NOT NULL DEFAULT 'free',     -- free | pro | enterprise | past_due
  subscription_expiry      TIMESTAMPTZ,
  stripe_customer_id       TEXT,
  stripe_subscription_id   TEXT,
  plan_interval            TEXT NOT NULL DEFAULT 'monthly',  -- monthly | yearly
  cancel_at_period_end     BOOLEAN NOT NULL DEFAULT FALSE,
  renewal_date             TIMESTAMPTZ,
  query_date               DATE,
  query_count              INTEGER NOT NULL DEFAULT 0,
  last_login_at            TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS users_subscription_idx ON users (subscription);
CREATE INDEX IF NOT EXISTS users_stripe_customer_idx ON users (stripe_customer_id);

-- Sessions / refresh tokens (rotation-friendly)
CREATE TABLE IF NOT EXISTS sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  jti           TEXT NOT NULL UNIQUE,
  refresh_hash  TEXT NOT NULL,
  user_agent    TEXT,
  ip            INET,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);

-- ---------------------------------------------------------------------
-- Global Asset Registry
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS assets (
  id            TEXT PRIMARY KEY,           -- 'AAPL:NASDAQ', 'BTC:CRYPTO', 'EURUSD:FX'
  ticker        TEXT NOT NULL,
  name          TEXT NOT NULL,
  asset_type    TEXT NOT NULL DEFAULT 'stock',    -- stock|etf|crypto|forex|index|commodity
  exchange      TEXT,
  country       TEXT,
  sector        TEXT,
  industry      TEXT,
  currency      TEXT NOT NULL DEFAULT 'USD',
  isin          TEXT,
  figi          TEXT,
  market_cap    NUMERIC(20, 2) DEFAULT 0,
  description   TEXT,
  logo_url      TEXT,
  aliases       JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  source        TEXT NOT NULL DEFAULT 'seed',     -- seed|fmp|finnhub|alphavantage|polygon|massive
  last_updated  TIMESTAMPTZ,
  view_count    INTEGER NOT NULL DEFAULT 0,
  search_count  INTEGER NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  search_tsv    TSVECTOR
);

CREATE INDEX IF NOT EXISTS assets_ticker_idx        ON assets (ticker);
CREATE INDEX IF NOT EXISTS assets_type_idx          ON assets (asset_type);
CREATE INDEX IF NOT EXISTS assets_country_idx       ON assets (country);
CREATE INDEX IF NOT EXISTS assets_sector_idx        ON assets (sector);
CREATE INDEX IF NOT EXISTS assets_market_cap_idx    ON assets (market_cap DESC);
CREATE INDEX IF NOT EXISTS assets_search_tsv_idx    ON assets USING GIN (search_tsv);
CREATE INDEX IF NOT EXISTS assets_ticker_trgm_idx   ON assets USING GIN (ticker gin_trgm_ops);
CREATE INDEX IF NOT EXISTS assets_name_trgm_idx     ON assets USING GIN (name gin_trgm_ops);

CREATE OR REPLACE FUNCTION assets_tsv_trigger() RETURNS trigger AS $$
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('simple', coalesce(NEW.ticker, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW.name, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW.sector, '') || ' ' || coalesce(NEW.industry, '')), 'C') ||
    setweight(to_tsvector('simple', coalesce(NEW.exchange, '')), 'D');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS assets_tsv_update ON assets;
CREATE TRIGGER assets_tsv_update
  BEFORE INSERT OR UPDATE OF ticker, name, sector, industry, exchange
  ON assets FOR EACH ROW EXECUTE FUNCTION assets_tsv_trigger();

-- ---------------------------------------------------------------------
-- Portfolio: holdings + watchlists + transactions
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS portfolios (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name        TEXT NOT NULL DEFAULT 'Main',
  base_ccy    TEXT NOT NULL DEFAULT 'USD',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, name)
);

CREATE TABLE IF NOT EXISTS holdings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id  UUID NOT NULL REFERENCES portfolios (id) ON DELETE CASCADE,
  asset_id      TEXT NOT NULL,                          -- soft FK to assets.id
  quantity      NUMERIC(24, 8) NOT NULL DEFAULT 0,
  avg_cost      NUMERIC(20, 4) NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL DEFAULT 'USD',
  notes         TEXT,
  opened_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (portfolio_id, asset_id)
);

CREATE INDEX IF NOT EXISTS holdings_portfolio_idx ON holdings (portfolio_id);
CREATE INDEX IF NOT EXISTS holdings_asset_idx     ON holdings (asset_id);

CREATE TABLE IF NOT EXISTS transactions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id  UUID NOT NULL REFERENCES portfolios (id) ON DELETE CASCADE,
  asset_id      TEXT NOT NULL,
  side          TEXT NOT NULL,                          -- buy|sell|dividend|split|fee
  quantity      NUMERIC(24, 8) NOT NULL,
  price         NUMERIC(20, 4) NOT NULL,
  fee           NUMERIC(20, 4) NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL DEFAULT 'USD',
  executed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes         TEXT
);

CREATE INDEX IF NOT EXISTS tx_portfolio_idx  ON transactions (portfolio_id, executed_at DESC);
CREATE INDEX IF NOT EXISTS tx_asset_idx      ON transactions (asset_id);

CREATE TABLE IF NOT EXISTS watchlists (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  asset_ids   TEXT[] NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, name)
);

-- ---------------------------------------------------------------------
-- Intelligence ingestion
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS intel_sources (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL UNIQUE,
  url           TEXT NOT NULL,
  kind          TEXT NOT NULL,                          -- rss|api|email|scraper
  category      TEXT,                                   -- markets|crypto|macro|tech|filings
  weight        SMALLINT NOT NULL DEFAULT 50,           -- 0–100 trust score
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  last_fetched_at TIMESTAMPTZ,
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS intel_items_raw (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id     UUID NOT NULL REFERENCES intel_sources (id) ON DELETE CASCADE,
  external_id   TEXT NOT NULL,                          -- GUID/link from feed
  url           TEXT NOT NULL,
  title         TEXT NOT NULL,
  raw_html      TEXT,
  raw_text      TEXT,
  author        TEXT,
  published_at  TIMESTAMPTZ,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  hash          TEXT NOT NULL,                          -- sha256(url + title)
  UNIQUE (source_id, external_id)
);

CREATE INDEX IF NOT EXISTS intel_raw_published_idx ON intel_items_raw (published_at DESC);
CREATE INDEX IF NOT EXISTS intel_raw_hash_idx      ON intel_items_raw (hash);

CREATE TABLE IF NOT EXISTS intel_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_id            UUID UNIQUE REFERENCES intel_items_raw (id) ON DELETE SET NULL,
  source_name       TEXT NOT NULL,                      -- denormalized for fast reads
  url               TEXT NOT NULL,
  title_original    TEXT NOT NULL,
  title_rewritten   TEXT NOT NULL,
  summary           TEXT NOT NULL,                      -- AI-rewritten, platform-native
  body              TEXT,                               -- longer-form AI rewrite
  category          TEXT,                               -- markets|crypto|macro|tech|filings
  sentiment         TEXT,                               -- bullish|bearish|neutral
  sentiment_score   NUMERIC(4, 3),                      -- -1.000 to 1.000
  confidence        NUMERIC(4, 3),                      -- 0.000 to 1.000
  impact_score      SMALLINT,                           -- 0–100 (estimated market impact)
  opportunity_score SMALLINT,                           -- 0–100 (actionability)
  tickers           TEXT[] NOT NULL DEFAULT '{}',       -- extracted tickers (uppercase)
  asset_ids         TEXT[] NOT NULL DEFAULT '{}',       -- resolved against assets table
  topics            TEXT[] NOT NULL DEFAULT '{}',
  published_at      TIMESTAMPTZ,
  rewritten_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  hash              TEXT NOT NULL UNIQUE,
  search_tsv        TSVECTOR
);

CREATE INDEX IF NOT EXISTS intel_items_published_idx  ON intel_items (published_at DESC);
CREATE INDEX IF NOT EXISTS intel_items_sentiment_idx  ON intel_items (sentiment);
CREATE INDEX IF NOT EXISTS intel_items_category_idx   ON intel_items (category);
CREATE INDEX IF NOT EXISTS intel_items_impact_idx     ON intel_items (impact_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS intel_items_opp_idx        ON intel_items (opportunity_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS intel_items_tickers_idx    ON intel_items USING GIN (tickers);
CREATE INDEX IF NOT EXISTS intel_items_asset_ids_idx  ON intel_items USING GIN (asset_ids);
CREATE INDEX IF NOT EXISTS intel_items_topics_idx     ON intel_items USING GIN (topics);
CREATE INDEX IF NOT EXISTS intel_items_search_idx     ON intel_items USING GIN (search_tsv);

CREATE OR REPLACE FUNCTION intel_tsv_trigger() RETURNS trigger AS $$
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('english', coalesce(NEW.title_rewritten, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.summary, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.body, '')), 'C') ||
    setweight(to_tsvector('simple', array_to_string(coalesce(NEW.tickers, '{}'), ' ')), 'A');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS intel_tsv_update ON intel_items;
CREATE TRIGGER intel_tsv_update
  BEFORE INSERT OR UPDATE OF title_rewritten, summary, body, tickers
  ON intel_items FOR EACH ROW EXECUTE FUNCTION intel_tsv_trigger();

-- ---------------------------------------------------------------------
-- Trading signals / opportunity engine
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS signals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id      TEXT NOT NULL,
  kind          TEXT NOT NULL,                          -- breakout|momentum|reversal|earnings|news|filing
  direction     TEXT NOT NULL,                          -- long|short|neutral
  score         NUMERIC(5, 2) NOT NULL,                 -- 0–100 conviction
  thesis        TEXT NOT NULL,                          -- one-line summary
  reasoning     TEXT,                                   -- long-form
  entry_zone    NUMRANGE,
  target        NUMERIC(20, 4),
  stop          NUMERIC(20, 4),
  horizon_days  INTEGER,
  source_items  UUID[] NOT NULL DEFAULT '{}',           -- intel_items.id references
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS signals_asset_idx       ON signals (asset_id);
CREATE INDEX IF NOT EXISTS signals_active_idx      ON signals (active, score DESC) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS signals_created_idx     ON signals (created_at DESC);

-- ---------------------------------------------------------------------
-- AI usage tracking (free-tier limits)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_usage (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  day             DATE NOT NULL,
  endpoint        TEXT NOT NULL,                        -- /api/ai/stream | /api/ai/call
  prompt_tokens   INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  model           TEXT,
  provider        TEXT,
  ms              INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ai_usage_user_day_idx ON ai_usage (user_id, day);

-- ---------------------------------------------------------------------
-- Stripe webhook idempotency
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_events (
  stripe_event_id TEXT PRIMARY KEY,
  event_type      TEXT NOT NULL,
  processed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payload         JSONB
);

-- ---------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID REFERENCES users (id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  resource    TEXT,
  resource_id TEXT,
  metadata    JSONB,
  ip          INET,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_user_idx      ON audit_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_resource_idx  ON audit_log (resource, resource_id);

-- ---------------------------------------------------------------------
-- updated_at trigger helper
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY['users', 'portfolios', 'holdings', 'watchlists'])
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS touch_%I ON %I;
       CREATE TRIGGER touch_%I BEFORE UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION touch_updated_at();', t, t, t, t
    );
  END LOOP;
END$$;
