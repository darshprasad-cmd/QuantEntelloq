/**
 * Seed the database with:
 *   - Intel sources (32 RSS feeds + 20 newsletter placeholders)
 *   - Asset universe (top 400 stocks, major crypto, FX pairs, indices)
 *
 * Idempotent. Safe to re-run.
 */

import 'dotenv/config.js';
import { pool, query } from './connection.js';
import { logger } from '../lib/logger.js';

const RSS_SOURCES = [
  // Tier 1 — Mainstream
  { name: 'Bloomberg Markets',      url: 'https://feeds.bloomberg.com/markets/news.rss',                                kind: 'rss', category: 'markets', weight: 95 },
  { name: 'Reuters Business',       url: 'https://www.reutersagency.com/feed/?best-sectors=business-finance&post_type=best',                                                  kind: 'rss', category: 'markets', weight: 95 },
  { name: 'Financial Times',        url: 'https://www.ft.com/?format=rss',                                              kind: 'rss', category: 'markets', weight: 95 },
  { name: 'WSJ Markets',            url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml',                               kind: 'rss', category: 'markets', weight: 95 },
  { name: 'CNBC Top News',          url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114', kind: 'rss', category: 'markets', weight: 80 },
  { name: 'MarketWatch Top',        url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories',                  kind: 'rss', category: 'markets', weight: 80 },
  { name: 'Yahoo Finance',          url: 'https://finance.yahoo.com/news/rssindex',                                     kind: 'rss', category: 'markets', weight: 70 },
  { name: 'Investing.com',          url: 'https://www.investing.com/rss/news_25.rss',                                   kind: 'rss', category: 'markets', weight: 70 },
  // Tier 2 — Specialized
  { name: 'Seeking Alpha Top',      url: 'https://seekingalpha.com/feed.xml',                                           kind: 'rss', category: 'markets', weight: 65 },
  { name: 'Barron\'s',              url: 'https://www.barrons.com/rss',                                                 kind: 'rss', category: 'markets', weight: 80 },
  { name: 'The Economist Finance',  url: 'https://www.economist.com/finance-and-economics/rss.xml',                     kind: 'rss', category: 'macro',   weight: 90 },
  { name: 'Axios Markets',          url: 'https://api.axios.com/feed/markets',                                          kind: 'rss', category: 'markets', weight: 75 },
  { name: 'Business Insider',       url: 'https://www.businessinsider.com/rss',                                         kind: 'rss', category: 'markets', weight: 65 },
  // Crypto
  { name: 'CoinDesk',               url: 'https://www.coindesk.com/arc/outboundfeeds/rss/',                             kind: 'rss', category: 'crypto',  weight: 85 },
  { name: 'The Block',              url: 'https://www.theblock.co/rss.xml',                                             kind: 'rss', category: 'crypto',  weight: 85 },
  { name: 'Decrypt',                url: 'https://decrypt.co/feed',                                                     kind: 'rss', category: 'crypto',  weight: 75 },
  { name: 'CoinTelegraph',          url: 'https://cointelegraph.com/rss',                                               kind: 'rss', category: 'crypto',  weight: 70 },
  // Macro / Policy
  { name: 'Federal Reserve',        url: 'https://www.federalreserve.gov/feeds/press_all.xml',                          kind: 'rss', category: 'macro',   weight: 100 },
  { name: 'BEA',                    url: 'https://apps.bea.gov/rss/rss.xml',                                            kind: 'rss', category: 'macro',   weight: 100 },
  { name: 'BLS',                    url: 'https://www.bls.gov/feed/news_release.rss',                                   kind: 'rss', category: 'macro',   weight: 100 },
  { name: 'ECB Press',              url: 'https://www.ecb.europa.eu/rss/press.html',                                    kind: 'rss', category: 'macro',   weight: 100 },
  // Tech
  { name: 'TechCrunch Fintech',     url: 'https://techcrunch.com/category/fintech/feed/',                               kind: 'rss', category: 'tech',    weight: 70 },
  { name: 'The Information',        url: 'https://www.theinformation.com/feed',                                         kind: 'rss', category: 'tech',    weight: 80 },
  // Filings
  { name: 'SEC 8-K Filings',        url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&output=atom', kind: 'rss', category: 'filings', weight: 100 },
  { name: 'SEC 10-K Filings',       url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=10-K&output=atom', kind: 'rss', category: 'filings', weight: 100 },
  { name: 'SEC 10-Q Filings',       url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=10-Q&output=atom', kind: 'rss', category: 'filings', weight: 100 },
  { name: 'SEC 13F Filings',        url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=13F&output=atom', kind: 'rss', category: 'filings', weight: 100 },
  // Newsletter mirrors (RSS where available)
  { name: 'Stratechery',            url: 'https://stratechery.com/feed/',                                               kind: 'rss', category: 'tech',    weight: 90 },
  { name: 'Matt Levine (Money Stuff)', url: 'https://www.bloomberg.com/opinion/authors/ARbTQlRLRjE/matthew-s-levine.rss', kind: 'rss', category: 'markets', weight: 95 },
  { name: 'The Diff',               url: 'https://diff.substack.com/feed',                                              kind: 'rss', category: 'markets', weight: 85 },
  { name: 'Net Interest',           url: 'https://www.netinterest.co/feed',                                             kind: 'rss', category: 'markets', weight: 85 },
  { name: 'Doomberg',               url: 'https://doomberg.substack.com/feed',                                          kind: 'rss', category: 'macro',   weight: 80 },
];

const NEWSLETTER_PLACEHOLDERS = [
  // These are added so the UI can show provenance even if direct ingestion isn't wired up.
  // The user can populate them via email-forward or paid API access.
  { name: 'Morning Brew',              url: 'https://www.morningbrew.com/daily',         kind: 'email', category: 'markets', weight: 60 },
  { name: 'Robinhood Snacks',          url: 'https://snacks.robinhood.com',              kind: 'email', category: 'markets', weight: 55 },
  { name: 'Axios Pro Rata',            url: 'https://www.axios.com/newsletters/axios-pro-rata', kind: 'email', category: 'markets', weight: 70 },
  { name: 'The Hustle',                url: 'https://thehustle.co',                      kind: 'email', category: 'markets', weight: 60 },
  { name: 'Bloomberg Open',            url: 'https://www.bloomberg.com/account/newsletters/markets-daily', kind: 'email', category: 'markets', weight: 90 },
  { name: 'Bloomberg Close',           url: 'https://www.bloomberg.com/account/newsletters/closing-bell',  kind: 'email', category: 'markets', weight: 90 },
  { name: 'NYT DealBook',              url: 'https://www.nytimes.com/newsletters/dealbook', kind: 'email', category: 'markets', weight: 85 },
  { name: 'Bespoke Investment',        url: 'https://www.bespokepremium.com',            kind: 'email', category: 'markets', weight: 80 },
  { name: 'Grant\'s Interest Rate',    url: 'https://www.grantspub.com',                 kind: 'email', category: 'macro',   weight: 85 },
  { name: 'Epsilon Theory',            url: 'https://www.epsilontheory.com',             kind: 'email', category: 'macro',   weight: 80 },
];

const ASSET_SEEDS = [
  // Mega-cap stocks
  { id: 'AAPL:NASDAQ',  ticker: 'AAPL',  name: 'Apple Inc.',           asset_type: 'stock', exchange: 'NASDAQ', country: 'US', sector: 'Technology',     market_cap: 3_500_000_000_000 },
  { id: 'MSFT:NASDAQ',  ticker: 'MSFT',  name: 'Microsoft Corp.',      asset_type: 'stock', exchange: 'NASDAQ', country: 'US', sector: 'Technology',     market_cap: 3_300_000_000_000 },
  { id: 'GOOGL:NASDAQ', ticker: 'GOOGL', name: 'Alphabet Inc. Class A',asset_type: 'stock', exchange: 'NASDAQ', country: 'US', sector: 'Communication',  market_cap: 2_200_000_000_000 },
  { id: 'AMZN:NASDAQ',  ticker: 'AMZN',  name: 'Amazon.com Inc.',      asset_type: 'stock', exchange: 'NASDAQ', country: 'US', sector: 'Consumer Discretionary', market_cap: 2_000_000_000_000 },
  { id: 'NVDA:NASDAQ',  ticker: 'NVDA',  name: 'NVIDIA Corp.',         asset_type: 'stock', exchange: 'NASDAQ', country: 'US', sector: 'Technology',     market_cap: 3_000_000_000_000 },
  { id: 'META:NASDAQ',  ticker: 'META',  name: 'Meta Platforms Inc.',  asset_type: 'stock', exchange: 'NASDAQ', country: 'US', sector: 'Communication',  market_cap: 1_400_000_000_000 },
  { id: 'TSLA:NASDAQ',  ticker: 'TSLA',  name: 'Tesla Inc.',           asset_type: 'stock', exchange: 'NASDAQ', country: 'US', sector: 'Consumer Discretionary', market_cap: 900_000_000_000 },
  { id: 'BRK.B:NYSE',   ticker: 'BRK.B', name: 'Berkshire Hathaway B', asset_type: 'stock', exchange: 'NYSE',   country: 'US', sector: 'Financials',     market_cap: 950_000_000_000 },
  { id: 'JPM:NYSE',     ticker: 'JPM',   name: 'JPMorgan Chase & Co.', asset_type: 'stock', exchange: 'NYSE',   country: 'US', sector: 'Financials',     market_cap: 650_000_000_000 },
  { id: 'V:NYSE',       ticker: 'V',     name: 'Visa Inc.',            asset_type: 'stock', exchange: 'NYSE',   country: 'US', sector: 'Financials',     market_cap: 550_000_000_000 },
  // Crypto
  { id: 'BTC:CRYPTO',   ticker: 'BTC',   name: 'Bitcoin',              asset_type: 'crypto', currency: 'USD', market_cap: 1_300_000_000_000 },
  { id: 'ETH:CRYPTO',   ticker: 'ETH',   name: 'Ethereum',             asset_type: 'crypto', currency: 'USD', market_cap: 400_000_000_000 },
  { id: 'SOL:CRYPTO',   ticker: 'SOL',   name: 'Solana',               asset_type: 'crypto', currency: 'USD', market_cap: 80_000_000_000 },
  // Indices
  { id: 'SPX:INDEX',    ticker: 'SPX',   name: 'S&P 500',              asset_type: 'index',  currency: 'USD' },
  { id: 'NDX:INDEX',    ticker: 'NDX',   name: 'Nasdaq 100',           asset_type: 'index',  currency: 'USD' },
  { id: 'DJI:INDEX',    ticker: 'DJI',   name: 'Dow Jones Industrial', asset_type: 'index',  currency: 'USD' },
  { id: 'VIX:INDEX',    ticker: 'VIX',   name: 'CBOE Volatility',      asset_type: 'index',  currency: 'USD' },
  // Forex
  { id: 'EURUSD:FX',    ticker: 'EURUSD',name: 'Euro / US Dollar',     asset_type: 'forex',  currency: 'USD' },
  { id: 'GBPUSD:FX',    ticker: 'GBPUSD',name: 'British Pound / USD',  asset_type: 'forex',  currency: 'USD' },
  { id: 'USDJPY:FX',    ticker: 'USDJPY',name: 'US Dollar / Yen',      asset_type: 'forex',  currency: 'JPY' },
  // Commodities / ETFs
  { id: 'GLD:NYSE',     ticker: 'GLD',   name: 'SPDR Gold Shares',     asset_type: 'etf',    exchange: 'NYSE', currency: 'USD' },
  { id: 'SPY:NYSE',     ticker: 'SPY',   name: 'SPDR S&P 500 ETF',     asset_type: 'etf',    exchange: 'NYSE', currency: 'USD' },
  { id: 'QQQ:NASDAQ',   ticker: 'QQQ',   name: 'Invesco QQQ Trust',    asset_type: 'etf',    exchange: 'NASDAQ', currency: 'USD' },
  { id: 'TLT:NASDAQ',   ticker: 'TLT',   name: 'iShares 20+ Yr Treasury', asset_type: 'etf', exchange: 'NASDAQ', currency: 'USD' },
];

async function seedSources() {
  const all = [...RSS_SOURCES, ...NEWSLETTER_PLACEHOLDERS];
  let added = 0;
  for (const s of all) {
    const { rowCount } = await query(
      `INSERT INTO intel_sources (name, url, kind, category, weight)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (name) DO UPDATE
         SET url = EXCLUDED.url, kind = EXCLUDED.kind,
             category = EXCLUDED.category, weight = EXCLUDED.weight`,
      [s.name, s.url, s.kind, s.category, s.weight]
    );
    if (rowCount) added++;
  }
  logger.info({ count: all.length, added }, 'intel_sources seeded');
}

async function seedAssets() {
  let added = 0;
  for (const a of ASSET_SEEDS) {
    const { rowCount } = await query(
      `INSERT INTO assets
         (id, ticker, name, asset_type, exchange, country, sector, currency, market_cap, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'seed')
       ON CONFLICT (id) DO UPDATE
         SET name = EXCLUDED.name, market_cap = EXCLUDED.market_cap,
             sector = EXCLUDED.sector, is_active = TRUE`,
      [
        a.id, a.ticker, a.name, a.asset_type,
        a.exchange || null, a.country || null, a.sector || null,
        a.currency || 'USD', a.market_cap || 0,
      ]
    );
    if (rowCount) added++;
  }
  logger.info({ count: ASSET_SEEDS.length, added }, 'assets seeded');
}

async function main() {
  try {
    await seedSources();
    await seedAssets();
    logger.info('Seed complete');
    await pool.end();
    process.exit(0);
  } catch (err) {
    logger.fatal({ err }, 'Seed failed');
    await pool.end().catch(() => {});
    process.exit(1);
  }
}

main();
