<div align="center">

# Arena

**Crypto trader ranking platform with real-time data from 35+ exchanges.**

[![Production](https://img.shields.io/badge/production-live-brightgreen)](https://www.arenafi.org)
[![Next.js](https://img.shields.io/badge/Next.js-16-black)](https://nextjs.org)
[![Traders](https://img.shields.io/badge/traders-34%2C000%2B-blue)]()
[![Exchanges](https://img.shields.io/badge/exchanges-35%2B-orange)]()

[Live Site](https://www.arenafi.org) · [Features](#features) · [Architecture](#architecture) · [Data Pipeline](#data-pipeline) · [Getting Started](#getting-started)

</div>

## Overview

Arena aggregates, normalizes, and ranks 34,000+ crypto traders across 35+ centralized and decentralized exchanges. Every trader receives an Arena Score, a composite metric combining ROI and absolute PnL on a 0-100 scale, allowing apples-to-apples comparison regardless of the originating platform. The system ingests data continuously through 53 scheduled cron jobs via 42 exchange connectors, enriches trader profiles with equity curves, position history, and advanced statistics, and serves the results through a Next.js 16 frontend with ISR and edge caching.

Beyond rankings, Arena provides a 60,000+ item educational library (books, research papers, whitepapers), real-time market data via TradingView WebSocket, community features (groups, posts, comments, reputation-gated access), trading competitions, on-chain attestation via EAS, and a Pro membership tier. The platform supports 4 languages (English, Chinese, Japanese, Korean) and runs on both web and native mobile (iOS/Android via Capacitor).

## Features

### Trader Rankings and Arena Score

Arena Score is a two-dimension composite metric scored on a 0-100 scale:

- **Return Score (0-60 points)**: Measures ROI using annualized log returns with a tanh sigmoid curve. Period-specific calibration coefficients ensure fair comparison across 7D, 30D, and 90D windows.
- **PnL Score (0-40 points)**: Measures absolute realized profit in USD, log-scaled to handle the wide range from small retail accounts to whale-tier PnL.

**Overall composite score**: `0.70 × S90D + 0.25 × S30D + 0.05 × S7D`, with a momentum bonus based on short-term vs medium-term performance.

Score confidence is tracked as `full`, `partial`, or `minimal` via a Wilson Score multiplier checking 5 signals (ROI, PnL, max drawdown, win rate, Sharpe ratio).

**V3 Percentile Scoring** (advanced): Three-dimension model — Profitability (35%), Risk Control (40%), Execution (25%) — using percentile rank within peer groups.

Rankings are available across three time windows: 7 days, 30 days, and 90 days.

### Supported Exchanges

**CEX Futures (17):**
Binance Futures, Bybit, OKX Futures, Bitget Futures, MEXC, HTX, Gate.io, CoinEx, BingX, XT, BloFin, Phemex, KuCoin, Bitunix, Toobit, Bitfinex, BTCC

**CEX Spot (4):**
Binance Spot, Bybit Spot, OKX Spot, Bitget Spot

**CEX Web3/Wallet (2):**
Binance Web3, OKX Web3

**DEX Perpetuals (9):**
Hyperliquid, GMX, dYdX, Jupiter Perps, Drift, Aevo, Kwenta, Gains Network, Copin (multi-chain aggregator)

**Other (3):**
eToro (social trading), Polymarket (prediction market), WooX (copy trading)

### Trader Profiles

Each trader profile includes:

- Performance metrics across all available time windows (ROI, PnL, win rate, max drawdown, trade count, follower count)
- Equity curve charts with two-tone visualization (green above zero, red below) and gap-filled daily PnL
- Position history with asset breakdown analysis
- Advanced statistics: Sharpe ratio, Sortino ratio, Calmar ratio, profit factor (derived from equity curve data)
- Trading style radar chart (5 dimensions)
- Bot/Human classification with visual badges
- Verified trader badge (via claim system)
- Direct link back to the source exchange's copy-trading page

### DeSoc (Decentralized Social)

- **Trader Claim System**: Traders can claim and verify their exchange identities
- **Reputation-Driven Access**: Groups can set minimum Arena Score thresholds; posts carry author Arena Score
- **On-Chain Attestation**: Mint Arena Score to Base chain via EAS (Ethereum Attestation Service), server-side signing
- **Copy Trade Links**: Referral URLs for 8 exchanges

### Market Overview

- TradingView-powered interactive charts with real-time WebSocket price feeds for 12 major tokens (BTC, ETH, SOL, BNB, XRP, ADA, DOGE, AVAX, LINK, DOT, ARB, MATIC)
- Sector performance treemap
- Fear and Greed gauge
- Funding rates and open interest data (fetched via dedicated cron jobs)
- Flash news feed (aggregated every 30 minutes)

### Community

- Trading groups with membership, applications, and group-level analytics
- Post and comment system with voting, visibility controls (public/followers/group), and full-text search
- User level progression (food chain theme): Krill, Sardine, Dolphin, Shark, Orca
- Following system with activity feeds
- Ranking change notifications and trader alerts
- Trading competitions

### Library

- 60,000+ curated educational resources: books, research papers, whitepapers, articles
- EPUB reader with customizable settings (font, theme, layout)
- Bookshelf management with favorites

### Pro Membership

- $4.99/month, $29.99/year, or $49.99 lifetime (Founding Member)
- Stripe integration for payments, with subscription expiry monitoring via cron
- All Pro features currently free during beta

### Mobile

- Native iOS and Android apps via Capacitor
- BottomSheet, SwipeableView, PullToRefresh, MobileFilterSheet
- Push notifications, haptics, biometrics, camera, share
- Service Worker for offline support and caching
- Infinite scroll with IntersectionObserver

### Localization and Theming

- 4 languages: English, Chinese, Japanese, Korean (4,800+ keys each, 100% coverage)
- Dark and Light themes with design tokens (`lib/design-tokens.ts`)
- Simple object map i18n — zero runtime overhead, type-safe

## Tech Stack

| Layer | Technology | Details |
|-------|-----------|---------|
| Framework | Next.js 16 | App Router, React 19, Turbopack dev server |
| Language | TypeScript 5 | Strict mode, 139 test suites, 2,271 tests |
| Database | Supabase | PostgreSQL, Auth, Realtime subscriptions, RLS on all tables, 184 migrations |
| Caching | Upstash Redis | Edge-compatible, used for leaderboard cache, rate limiting, session data |
| Search | Meilisearch | Full-text search with fuzzy matching (pg_trgm fallback) |
| Hosting | Vercel | Edge + Serverless functions, primary region hnd1 (Tokyo), ISR for static pages |
| Payments | Stripe | Checkout, subscriptions, webhooks, customer portal |
| Auth | Supabase Auth + Privy | Email/password + Web3 wallet login |
| Styling | Tailwind CSS v4 | Design token system, dark/light theme |
| Charts | TradingView + lightweight-charts | Interactive charts, WebSocket real-time data |
| Exchange Data | 42 custom connectors + CCXT | Unified connector framework with BaseConnector abstract class |
| State | Zustand + React Query + SWR | Zustand for global state, React Query + SWR for server data fetching |
| Resilience | Cockatiel | Retry with exponential backoff + circuit breaker (ConsecutiveBreaker) |
| Validation | Zod | Input validation on all write routes, trader snapshot schemas |
| Monitoring | Sentry + PipelineLogger + Healthchecks.io | Structured JSON logging, correlation IDs, dead man's switch on critical jobs |
| Alerts | Telegram Bot | Automatic alerts on cron failures and data staleness |
| Mobile | Capacitor | iOS + Android native apps with push, haptics, biometrics |
| Web3 | viem + wagmi + RainbowKit + EAS | Wallet login, on-chain attestation |
| Security | CSP, HSTS, RLS, timingSafeEqual | Full security headers, Upstash rate limiting, input validation |

## Architecture

```
                        +-------------------+
                        |    Vercel CDN     |
                        |    (Edge/ISR)     |
                        +--------+----------+
                                 |
                        +--------+----------+
                        |    Next.js 16     |
                        |    App Router     |
                        |   292 API routes  |
                        +--+-----+-------+--+
                           |     |       |
              +------------+  +--+---+  ++------------+
              |               |      |                |
     +--------+-----+  +-----+---+  +-----+-----+   |
     |   Supabase   |  | Upstash  |  | Meilisearch|   |
     |  PostgreSQL  |  |  Redis   |  | Full-text  |   |
     | 184 migrations|  |  Cache   |  |  Search    |   |
     |  Auth + RLS  |  +---------+  +-----------+   |
     +--------------+                                |
                                       +-------------+---+
                                       | 53 Cron Jobs    |
                  +------------------->| Data Pipeline   |
                  |                    +--------+--------+
                  |                             |
         +--------+----------+        +--------+--------+
         | CF Worker Proxy   |        | VPS Scrapers    |
         | (geo-block bypass)|        | SG + JP nodes   |
         +-------------------+        | Playwright      |
                  |                    +-----------------+
         +--------+-------------------------------------------+
         | 35+ Exchange APIs                                    |
         | CEX: Binance, OKX, Bybit, Bitget, MEXC, KuCoin,   |
         |      Gate.io, HTX, CoinEx, BingX, Phemex, XT,      |
         |      Toobit, Bitfinex, Bitunix, BTCC, Crypto.com   |
         | DEX: Hyperliquid, GMX, dYdX, Jupiter, Drift,       |
         |      Aevo, Kwenta, Gains, Copin                     |
         | Other: eToro, Polymarket, WooX                      |
         +-----------------------------------------------------+
```

### Key Architectural Decisions

**Unified Connector Framework.** All 42 exchange connectors extend `BaseConnector`, which provides HTTP with retry/backoff (via Cockatiel), rate limiting, circuit breaker (`ConsecutiveBreaker(5)` with 60s recovery), quality flags, and data provenance tracking. Each connector implements `discoverTraders()`, `fetchProfile()`, `fetchSnapshot()`, and `fetchTimeseries()`. The connector registry lazily initializes singletons per (platform, marketType).

**Three-Tier Proxy Strategy.** WAF-protected exchanges (Bybit, Bitget, BingX, MEXC, XT, Toobit) route through VPS Playwright scrapers first. Geo-blocked exchanges (Binance in some regions) use Cloudflare Worker proxy as fallback. OKX uses direct API (v5 public endpoints are not WAF-blocked). The proxy chain is transparent to connector code via `fetchViaVPS()`.

**Two-Table Snapshot Architecture.** `trader_snapshots_v2` is the sole write table for connector output. `leaderboard_ranks` is the precomputed read table for rankings, rebuilt every 30 minutes by `compute-leaderboard`. This separation keeps writes fast and reads indexed.

**Two-Phase Enrichment.** Data ingestion happens in two phases: (1) `batch-fetch-traders` discovers and upserts basic trader data (ROI, PnL, win rate) across all exchanges via 16 batch groups, (2) `batch-enrich` adds equity curves, position history, stats detail, and derived metrics (Sharpe, Sortino, Calmar) for top traders per platform across 26 enrichment modules.

**Incremental Static Regeneration.** Trader profile pages use ISR with `revalidate=300`. The leaderboard cache in Redis is refreshed by `warm-cache` every 5 minutes, so page loads hit warm cache rather than running expensive aggregate queries.

## Data Pipeline

The data pipeline consists of 53 Vercel cron jobs organized into several categories:

### Trader Data Ingestion

| Job | Schedule | Description |
|-----|----------|-------------|
| `batch-fetch-traders?group=a..l` | Every 3-6 hours | Fetch leaderboard data from all 35+ exchanges, split into 16 batch groups to stay within Vercel function timeout limits |
| `batch-enrich?period=90D` | Every 4 hours | Enrich top traders with equity curves, position history, and stats detail |
| `batch-enrich?period=30D/7D` | Every 4 hours | Enrichment for shorter time windows |
| `fetch-details?tier=hot` | Every 15 minutes | Fetch detailed profiles for high-priority traders (top ranked, recently viewed) |
| `fetch-details?tier=normal` | Every 4 hours | Fetch detailed profiles for the broader trader set |

### Scoring and Aggregation

| Job | Schedule | Description |
|-----|----------|-------------|
| `compute-leaderboard` | Every 30 minutes | Recompute Arena Scores and update ranking positions |
| `precompute-composite` | Every 2 hours | Precompute composite leaderboard views for faster page loads |
| `aggregate-daily-snapshots` | Daily 00:05 UTC | Roll up point-in-time snapshots into daily aggregates |
| `compute-derived-metrics` | Daily 00:20 UTC | Compute Sharpe, MDD, win rate from ROI delta |
| `calculate-advanced-metrics` | Every 4 hours | Derive Sortino, Calmar, profit factor from equity curve data |
| `snapshot-ranks` | Daily 00:15 UTC | Snapshot ranking positions for historical tracking |

### Market Data

| Job | Schedule | Description |
|-----|----------|-------------|
| `fetch-market-data?type=prices` | Every hour | Fetch current crypto prices |
| `fetch-funding-rates` | Every 4 hours | Fetch perpetual futures funding rates |
| `fetch-open-interest` | Every 2 hours | Fetch open interest data |
| `flash-news-fetch` | Every 30 minutes | Aggregate crypto news |
| `snapshot-positions` | Every hour | Snapshot trader positions |

### Content and Social

| Job | Schedule | Description |
|-----|----------|-------------|
| `auto-post-market-summary` | Daily 10:05 UTC | Auto-generate market summary post |
| `auto-post-insights` | Daily 08:03 UTC | Auto-generate trading insights |
| `auto-post-twitter` | Daily 08:06 UTC | Auto-post to Twitter |
| `sync-meilisearch` | Every 30 minutes | Sync trader data to Meilisearch |
| `warm-cache` | Every 5 minutes | Warm Redis cache for hot data |
| `daily-digest` | Daily 00:02 UTC | Generate daily digest |
| `weekly-report` | Mondays 08:00 UTC | Generate weekly pipeline report |
| `generate-profiles` | Every 6 hours | Auto-generate trader profile content |
| `update-competitions` | Every 30 minutes | Update competition standings |

### Monitoring and Maintenance

| Job | Schedule | Description |
|-----|----------|-------------|
| `check-data-freshness` | Every 3 hours | Alert if any exchange data goes stale |
| `verify-fetchers` | Every 3 hours | Verify all fetcher modules are responding correctly |
| `check-data-gaps` | Every 4 hours | Identify missing data windows and trigger backfills |
| `backfill-data` | Every 2 hours | Auto-backfill detected data gaps |
| `cleanup-data` | Daily 01:00 UTC | Clean up stale data |
| `cleanup-deleted-accounts` | Daily 03:00 UTC | Remove data for deleted user accounts |
| `cleanup-stuck-logs` | Every hour | Clean stuck pipeline log entries |
| `subscription-expiry` | Daily 00:04 UTC | Process expired Pro subscriptions |
| `backfill-avatars` | Daily 02:30 UTC | Backfill missing trader avatar images |
| `check-trader-alerts` | Every 6 hours | Check and send trader rank change alerts |

All cron jobs use `PipelineLogger` for structured execution logging with three destinations: Supabase `pipeline_logs` table, ClickHouse (dual write), and Healthchecks.io dead man's switch for 5 critical jobs. Failures trigger Telegram alerts via the OpenClaw monitoring system on Mac Mini.

## Directory Structure

```
app/                          # Next.js App Router
  api/                        # 292 API route handlers
    cron/                     # 53 scheduled job endpoints (called by Vercel Cron)
    v2/, v3/                  # Versioned API endpoints
    admin/                    # Admin-only endpoints (metrics, monitoring)
    health/                   # Health check endpoints (pipeline, dependencies)
  rankings/                   # Leaderboard pages (by exchange, by period)
  trader/[id]/                # Trader profile pages
  u/[handle]/                 # User profile pages
  groups/                     # Trading groups (create, join, manage)
  library/                    # Educational resource library with EPUB reader
  market/                     # Market overview, flash news
  portfolio/                  # Portfolio analytics dashboard
  competitions/               # Trading competitions
  settings/                   # User settings
  components/                 # Shared UI components

lib/                          # Core business logic (60+ subdirectories)
  connectors/                 # Exchange API connectors (84 files)
    base.ts                   # BaseConnector abstract class (retry, circuit breaker, rate limit)
    platforms/                # 42 platform-specific connector modules
    registry.ts               # Connector registry and lazy singleton lookup
  cron/
    enrichment-runner.ts      # Enrichment configs for 26 platforms
    fetchers/                 # 35+ exchange-specific enrichment modules
  data/                       # Server-side data fetching
    unified.ts                # Unified data layer (getLeaderboard, getTraderDetail, searchTraders)
    trader/                   # Trader data functions with fallback chains
  services/                   # Business logic (22 files)
    pipeline-logger.ts        # 3-destination execution logging
    pipeline-self-heal.ts     # Auto-recovery
    anomaly-detection.ts      # Statistical anomaly detection
    telegram-bot.ts           # Telegram alerts
    trader-alerts.ts          # Rank change notifications
  hooks/                      # React hooks (41 files)
  stores/                     # Zustand stores (period, inbox, multiAccount, post)
  types/                      # TypeScript types (13 files)
    unified-trader.ts         # Canonical frontend type (UnifiedTrader)
    leaderboard.ts            # Pipeline types, platform configs, rate limits
  utils/                      # Utilities (68 files)
    arena-score.ts            # Arena Score V2 formula
  scoring/                    # Arena Score V3 percentile scoring
  cache/                      # Redis cache helpers
  i18n/                       # 4 languages (en/zh/ja/ko, 4,800+ keys each)
  web3/                       # EAS attestation, wallet integration
  supabase/                   # Supabase client (getSupabaseAdmin singleton)
  stripe/                     # Stripe integration
  logger/                     # Structured JSON logging with correlation IDs
  validation/                 # Zod schemas

scripts/                      # CLI tools and maintenance (110+ files)
  pipeline-health-check.mjs   # Full pipeline health diagnostic
  diagnose-enrichment.mjs     # Enrichment API diagnostic
  backfill-*.ts               # Data backfill jobs
  openclaw/                   # Mac Mini autonomous monitoring
  vps-scrapers/               # VPS Playwright scraper code
  maintenance/                # R2 backup, cleanup scripts

supabase/migrations/          # 184 PostgreSQL migration files

cloudflare-worker/            # CF Worker proxy for geo-blocked exchange APIs

e2e/                          # Playwright E2E tests
k6/                           # K6 load tests
contracts/                    # Smart contracts (Foundry)
android/ & ios/               # Capacitor mobile apps
```

## Database Schema

Core tables (all with Row Level Security enabled):

### Trader Data

| Table | Purpose |
|-------|---------|
| `leaderboard_ranks` | Precomputed ranked leaderboard (primary read path, rebuilt every 30 min) |
| `trader_snapshots_v2` | Point-in-time performance data — sole write table for connectors |
| `traders` | Trader identity registry, keyed by `(platform, trader_key)` |
| `trader_profiles_v2` | Enriched profile data (bio, avatar, display name) |
| `trader_equity_curve` | Historical equity curve data points per period |
| `trader_position_history` | Past trading positions with PnL |
| `trader_stats_detail` | Advanced statistics (Sharpe, Sortino, Calmar, profit factor) per period |
| `trader_asset_breakdown` | Asset allocation analysis per period |
| `trader_daily_snapshots` | Daily ROI/PnL rollups (377K+ rows, 142 days depth) |
| `trader_portfolio` | Current open positions |
| `trader_sources` | Unique trader identities, keyed by `(source, source_trader_id)` |

### User and Social

| Table | Purpose |
|-------|---------|
| `user_profiles` | User accounts with level progression and reputation score |
| `posts` | Community posts with visibility, full-text search, author Arena Score |
| `comments` | Post comments |
| `groups` | Trading groups with optional Arena Score threshold |
| `group_members` | Group membership with roles |
| `follows` | User following relationships |
| `trader_claims` | Trader identity claim requests |
| `verified_traders` | Verified trader identities |
| `trader_attestations` | EAS on-chain attestation records |

### System

| Table | Purpose |
|-------|---------|
| `pipeline_logs` | Cron job execution logs (status, duration, record counts) |
| `pipeline_job_status` (View) | Latest status per job |
| `pipeline_job_stats` (View) | 7-day success rate and avg duration per job |
| `subscriptions` | Pro membership records |
| `stripe_customers` | Stripe customer mapping |

## Getting Started

### Prerequisites

- Node.js 20+
- npm

### Installation

```bash
git clone https://github.com/Tyche1107/ranking-arena.git
cd ranking-arena
npm install
```

### Environment Setup

Copy the example environment file and fill in your credentials:

```bash
cp .env.example .env.local
```

Required environment variables:

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anonymous key (client-side) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (server-side only) |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST endpoint |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis auth token |
| `CRON_SECRET` | Bearer token for cron job authentication |
| `STRIPE_SECRET_KEY` | Stripe API secret key |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret |

Optional variables for monitoring and proxy:

| Variable | Description |
|----------|-------------|
| `CLOUDFLARE_PROXY_URL` | CF Worker proxy URL |
| `VPS_PROXY_KEY` | API key for VPS proxy authentication |
| `SENTRY_DSN` | Sentry error tracking |
| `HEALTHCHECKS_PING_URL` | Healthchecks.io ping URL for dead man's switch |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token for alerts |
| `TELEGRAM_CHAT_ID` | Telegram chat ID for alerts |
| `MEILISEARCH_HOST` | Meilisearch host URL |
| `MEILISEARCH_API_KEY` | Meilisearch API key |

### Development

```bash
npm run dev
```

The dev server starts at `http://localhost:3000` using Turbopack. The dev server requires `--max-old-space-size=3584` (already configured in the npm script).

### Build and Type Check

```bash
npm run build          # Production build
npm run type-check     # TypeScript strict mode check
npm run lint           # ESLint (no-console: error, no-explicit-any: warn)
npm run test           # Jest test suite (139 suites, 2,271 tests)
npm run test:e2e       # Playwright E2E tests
```

### Diagnostic Scripts

```bash
node scripts/pipeline-health-check.mjs          # Full pipeline health check
node scripts/pipeline-health-check.mjs --quick   # Quick data freshness check
node scripts/pipeline-health-check.mjs --fix     # Generate fix scripts
node scripts/diagnose-enrichment.mjs             # Enrichment API diagnostic
node scripts/check-data-distribution.mjs         # Data distribution analysis
```

## Deployment

The application is deployed on Vercel with automatic deployments from the `main` branch.

```bash
vercel --prod          # Manual production deploy via Vercel CLI
git push origin main   # Triggers automatic deployment
```

All environment variables must be configured in the Vercel dashboard. The primary serverless function region is `hnd1` (Tokyo) to minimize latency to Asian exchange APIs and avoid geo-blocking.

### Cron Jobs

Cron schedules are defined in `vercel.json`. All 53 cron endpoints require an `Authorization: Bearer CRON_SECRET` header. Schedules are staggered to avoid database connection contention (no two heavy jobs share the same minute offset).

### Infrastructure

| Component | Details |
|-----------|---------|
| **Vercel** | Edge + Serverless, region hnd1, 53 cron jobs |
| **SG VPS** (45.76.152.169) | Proxy :3456 + Playwright Scraper :3457 (PM2) |
| **JP VPS** (149.28.27.242) | Polymarket + exchange proxy |
| **Mac Mini** (OpenClaw) | Health monitor (30min), daily reports, auto-fix, weekly self-check |
| **Cloudflare Worker** | Geo-block bypass proxy with ALLOWED_HOSTS whitelist |

### Monitoring

- Pipeline health: `/api/health/pipeline` (used by OpenClaw Mac Mini monitor)
- Dependency health: `/api/health/dependencies` (checks Supabase, Redis, Stripe connectivity)
- Admin metrics: `/api/admin/metrics/trends` (pipeline success rates, error rates, active users)
- Healthchecks.io: dead man's switch on 5 critical cron jobs
- Sentry: client/server/edge error tracking
- Telegram alerts: automatic on cron job failures and data staleness

### Key Metrics

| Metric | Value |
|--------|-------|
| Total Traders | 34,000+ |
| Active Platforms | 35 |
| Exchange Connectors | 42 |
| Enrichment Modules | 26 |
| Cron Jobs | 53 |
| API Routes | 292 |
| SQL Migrations | 184 |
| Test Suites | 139 (2,271 tests) |
| Languages | 4 (en/zh/ja/ko, 4,800+ keys each) |
| Lighthouse | Performance ~65+, Accessibility 97, Best Practices 96, SEO 100 |

## License

All rights reserved. Copyright 2026 Arena.
