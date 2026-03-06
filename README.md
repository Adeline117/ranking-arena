<div align="center">

# Arena

**Crypto trader ranking platform with real-time data from 39 exchanges.**

[![Production](https://img.shields.io/badge/production-live-brightgreen)](https://www.arenafi.org)
[![Next.js](https://img.shields.io/badge/Next.js-16-black)](https://nextjs.org)
[![Traders](https://img.shields.io/badge/traders-32%2C000%2B-blue)]()
[![Exchanges](https://img.shields.io/badge/exchanges-39-orange)]()

[Live Site](https://www.arenafi.org) · [Features](#features) · [Architecture](#architecture) · [Data Pipeline](#data-pipeline) · [Getting Started](#getting-started)

</div>

## Overview

Arena aggregates, normalizes, and ranks 32,000+ crypto copy-trading leaders across 39 centralized and decentralized exchanges. Every trader receives an Arena Score, a composite metric combining ROI and absolute PnL, allowing apples-to-apples comparison regardless of the originating platform. The system ingests data continuously through 44 scheduled cron jobs, enriches trader profiles with equity curves, position history, and advanced statistics, and serves the results through a Next.js 16 frontend with ISR and edge caching.

Beyond rankings, Arena provides a 60,000+ item educational library (books, research papers, whitepapers), real-time market data via TradingView WebSocket, community features (groups, posts, comments), and a Pro membership tier.

## Features

### Trader Rankings and Arena Score

Arena Score is a two-dimension composite metric scored on a 0-100 scale:

- **Return Score (60%)**: Measures ROI using a log-scaled sigmoid curve. Period-specific calibration: 7D baseline 15%, 30D baseline 30%, 90D baseline 60%. Scores are compressed so that median traders land around 25-30 points and only genuinely exceptional returns approach the ceiling.
- **PnL Score (40%)**: Measures absolute realized profit in USD. Also log-scaled to handle the wide range from small retail accounts to whale-tier PnL. The median trader maps to roughly 13 points.

Score confidence is tracked as `full`, `partial`, or `minimal` depending on whether win rate and max drawdown data are available from the source exchange.

Rankings are available across three time windows: 7 days, 30 days, and 90 days.

### Supported Exchanges

**CEX (Centralized):**
Binance Futures, Binance Spot, Binance Web3, Bybit Futures, Bybit Spot, OKX Futures, OKX Web3, Bitget Futures, Bitget Spot, MEXC, KuCoin, Gate.io, HTX, CoinEx, BingX, LBank, Phemex, Pionex, Toobit, BTSE, Crypto.com, WhiteBit, XT, Weex, BloFin, Bitfinex

**DEX (Decentralized):**
Hyperliquid, GMX, dYdX, Jupiter Perps, Vertex, Drift, Aevo, Kwenta, Gains Network, Synthetix, MUX Protocol, PancakeSwap, Uniswap

### Trader Profiles

Each trader profile includes:

- Performance metrics across all available time windows (ROI, PnL, win rate, max drawdown, trade count, follower count)
- Equity curve charts (fetched from exchange APIs, stored per period)
- Position history with asset breakdown analysis
- Advanced statistics: Sharpe ratio, Sortino ratio, Calmar ratio, profit factor (derived from equity curve data)
- Direct link back to the source exchange's copy-trading page

### Market Overview

- TradingView-powered interactive charts with real-time WebSocket price feeds for 12 major tokens (BTC, ETH, SOL, BNB, XRP, ADA, DOGE, AVAX, LINK, DOT, ARB, MATIC)
- Sector performance treemap
- Fear and Greed gauge
- Funding rates and open interest data (fetched via dedicated cron jobs)

### Community

- Trading groups with membership, applications, and group-level analytics
- Post and comment system with voting
- User level progression (food chain theme): Krill, Sardine, Dolphin, Shark, Orca
- Flash news feed (aggregated via cron)
- Following system with activity feeds
- Ranking change notifications

### Library

- 60,000+ curated educational resources: books, research papers, whitepapers, articles
- EPUB reader with customizable settings (font, theme, layout)
- Bookshelf management with favorites

### Pro Membership

- $4.99/month, $29.99/year, or $49.99 lifetime (Founding Member)
- Stripe integration for payments, with subscription expiry monitoring via cron
- All Pro features currently free during beta

### Localization and Theming

- Chinese (primary) and English language support via `lib/i18n.ts`
- Dark and Light themes with design tokens (`lib/design-tokens.ts`)

## Tech Stack

| Layer | Technology | Details |
|-------|-----------|---------|
| Framework | Next.js 16 | App Router, React 19, Turbopack dev server |
| Language | TypeScript | Strict mode, 135+ test suites |
| Database | Supabase | PostgreSQL, Auth, Realtime subscriptions, RLS on all tables, 108 migrations |
| Caching | Upstash Redis | Edge-compatible, used for leaderboard cache, rate limiting, session data |
| Hosting | Vercel | Edge + Serverless functions, primary region hnd1 (Tokyo), ISR for static pages |
| Payments | Stripe | Checkout, subscriptions, webhooks, customer portal |
| Auth | Supabase Auth + Privy | Email/password + Web3 wallet login |
| Styling | Tailwind CSS v4 | Design token system, dark/light theme |
| Charts | TradingView + lightweight-charts | Interactive charts, WebSocket real-time data |
| Exchange Data | Custom fetchers + CCXT | 39 exchange-specific fetcher modules with config-driven framework |
| State | Zustand + SWR | Zustand for global state, SWR for server data fetching |
| Monitoring | PipelineLogger + Telegram alerts | Structured JSON logging, correlation IDs, anomaly detection |
| Security | CSP, HSTS, Zod validation | Full security headers, input validation on all write routes |

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
                        |   298 API routes  |
                        +--+-----+-------+--+
                           |     |       |
              +------------+  +--+---+  ++------------+
              |               |      |                |
     +--------+-----+  +-----+---+  +-----+-----+   |
     |   Supabase   |  | Upstash  |  | TradingView|   |
     |  PostgreSQL  |  |  Redis   |  | WebSocket  |   |
     |  108 tables  |  |  Cache   |  |  12 tokens |   |
     |  Auth + RLS  |  +---------+  +-----------+   |
     +--------------+                                |
                                       +-------------+---+
                                       | 44 Cron Jobs    |
                  +------------------->| Data Pipeline   |
                  |                    +--------+--------+
                  |                             |
         +--------+----------+        +--------+--------+
         | CF Worker Proxy   |        | VPS Proxies     |
         | (geo-block bypass)|        | SG + JP nodes   |
         +-------------------+        +-----------------+
                  |
         +--------+-------------------------------------------+
         | 39 Exchange APIs                                    |
         | CEX: Binance, OKX, Bybit, Bitget, MEXC, KuCoin,   |
         |      Gate.io, HTX, CoinEx, BingX, LBank, Phemex,   |
         |      Pionex, Toobit, BTSE, Crypto.com, ...          |
         | DEX: Hyperliquid, GMX, dYdX, Jupiter, Vertex,       |
         |      Drift, Aevo, Kwenta, Gains, Synthetix, ...     |
         +-----------------------------------------------------+
```

### Key Architectural Decisions

**Config-Driven Fetcher Framework.** New exchanges can be added by writing a declarative config object (URL pattern, pagination style, field mapping) rather than a full fetcher module. The `createConfigDrivenFetcher()` function in `lib/cron/fetchers/config-driven-fetcher.ts` handles the HTTP request loop, pagination, deduplication, and upsert logic. Currently 3 exchanges (Toobit, BTSE, Crypto.com) use this pattern; the remaining 36 use custom fetcher modules for exchanges with non-standard APIs.

**Three-Tier Proxy Fallback.** Several exchanges (notably Binance, OKX) geo-block API requests from US IP ranges. The system attempts requests in order: (1) Vercel direct (region hnd1/Tokyo), (2) Cloudflare Worker proxy, (3) VPS proxy (Singapore preferred, Japan fallback). The proxy chain is transparent to the fetcher code via `fetchWithProxyFallback()`.

**Incremental Static Regeneration.** Trader profile pages and ranking pages use ISR with stale-while-revalidate patterns. The leaderboard cache in Redis is refreshed by a dedicated `refresh-leaderboard-cache` cron job, so page loads hit warm cache rather than running expensive aggregate queries.

**Two-Phase Enrichment.** Data ingestion happens in two phases: (1) `batch-fetch-traders` discovers and upserts basic trader data (ROI, PnL, win rate) across all exchanges, (2) `batch-enrich` and `fetch-details` add equity curves, position history, stats detail, and derived metrics (Sharpe, Sortino, Calmar ratios) for the top N traders per platform.

## Data Pipeline

The data pipeline consists of 44 Vercel cron jobs organized into several categories:

### Trader Data Ingestion

| Job | Schedule | Description |
|-----|----------|-------------|
| `batch-fetch-traders?group=a..f` | Every 2-6 hours | Fetch leaderboard data from all 39 exchanges, split into 6 batch groups to stay within Vercel function timeout limits |
| `batch-enrich` | Every 4 hours | Enrich top traders with equity curves, position history, and stats detail for 90D period |
| `batch-enrich?period=7D/30D` | Every 6 hours | Enrichment for shorter time windows |
| `fetch-details?tier=hot` | Every 2 hours | Fetch detailed profiles for high-priority traders (top ranked, recently viewed) |
| `fetch-details?tier=normal` | Every 4 hours | Fetch detailed profiles for the broader trader set |

### Scoring and Aggregation

| Job | Schedule | Description |
|-----|----------|-------------|
| `compute-leaderboard` | Every 2 hours | Recompute Arena Scores and update ranking positions |
| `precompute-composite` | Daily | Precompute composite leaderboard views for faster page loads |
| `aggregate-daily-snapshots` | Daily | Roll up point-in-time snapshots into daily aggregates |
| `calculate-advanced-metrics` | Every 6 hours | Derive Sharpe, Sortino, Calmar ratios from equity curve data |

### Market Data

| Job | Schedule | Description |
|-----|----------|-------------|
| `fetch-market-data?type=prices` | Every 5 minutes | Fetch current crypto prices |
| `fetch-funding-rates` | Every hour | Fetch perpetual futures funding rates |
| `fetch-open-interest` | Every hour | Fetch open interest data |
| `flash-news-fetch` | Every 15 minutes | Aggregate crypto news |

### Monitoring and Maintenance

| Job | Schedule | Description |
|-----|----------|-------------|
| `check-data-freshness` | Every 30 minutes | Alert if any exchange data goes stale (threshold: 8 hours) |
| `verify-fetchers` | Every 6 hours | Verify all fetcher modules are responding correctly |
| `check-data-gaps` | Daily | Identify missing data windows and trigger backfills |
| `detect-anomalies` | Every 4 hours | Flag statistical anomalies in trader data (sudden ROI spikes, etc.) |
| `check-enrichment-freshness` | Daily | Monitor enrichment data age |
| `cleanup-deleted-accounts` | Daily | Remove data for deleted user accounts |
| `subscription-expiry` | Daily | Process expired Pro subscriptions |
| `backfill-avatars` | Daily | Backfill missing trader avatar images (10 platform-specific jobs) |

All cron jobs use `PipelineLogger` for structured execution logging with success/failure tracking, duration recording, and record counts. Failures trigger Telegram alerts via the OpenClaw monitoring system.

## Directory Structure

```
app/                          # Next.js App Router
  api/                        # 298 API route handlers across 79 route groups
    cron/                     # Scheduled job endpoints (called by Vercel Cron)
    admin/                    # Admin-only endpoints (metrics, monitoring)
    health/                   # Health check endpoints (pipeline, dependencies)
  rankings/                   # Leaderboard pages (by exchange, by period)
  trader/[handle]/            # Trader profile pages
  u/[handle]/                 # User profile pages
  groups/                     # Trading groups (create, join, manage)
  library/                    # Educational resource library with EPUB reader
  exchange/                   # Exchange OAuth flow (authorize, callback)
  messages/                   # User messaging system
  components/                 # Shared UI components

lib/                          # Core business logic
  connectors/                 # Exchange API connectors (unified interface)
    platforms/                # 24 platform-specific connector modules
    registry.ts               # Connector registry and lookup
  cron/
    fetchers/                 # 39 exchange-specific data fetcher modules
      shared.ts               # Shared utilities (fetchJson, upsertTraders, parseNum, etc.)
      enrichment.ts           # Enrichment functions (equity curve, position history, stats)
      config-driven-fetcher.ts # Config-driven fetcher framework
      exchange-configs.ts     # Declarative configs for config-driven exchanges
  data/                       # Server-side data fetching functions
  services/                   # Business logic (pipeline-logger, anomaly-detection, etc.)
  hooks/                      # React hooks (client-side)
  stores/                     # Zustand stores
  types/                      # TypeScript type definitions
  utils/                      # Utilities (arena-score, logger, currency, i18n, etc.)
  validation/                 # Zod schemas for input validation
  cache/                      # Redis cache helpers
  alerts/                     # Alert system (Telegram, Slack, Feishu, Email)
  compliance/                 # GDPR consent management
  supabase/                   # Supabase client initialization and helpers
  i18n.ts                     # Internationalization (zh/en)
  design-tokens.ts            # UI design token system

scripts/                      # CLI tools and maintenance scripts
  openclaw/                   # Mac Mini autonomous monitoring (health-monitor, daily-report)
  import/                     # Data import scripts
  backfill-*.ts               # Backfill jobs for missing data
  pipeline-health-check.mjs   # Full pipeline health diagnostic
  diagnose-enrichment.mjs     # Enrichment API diagnostic
  check-data-distribution.mjs # Data distribution analysis

supabase/migrations/          # 108 PostgreSQL migration files

cloudflare-worker/            # CF Worker proxy for geo-blocked exchange APIs

worker/                       # Background job runner

docs/                         # Documentation
  DEGRADATION.md              # Service failure behavior documentation
```

## Database Schema

Core tables (all with Row Level Security enabled):

### Trader Data

| Table | Purpose |
|-------|---------|
| `trader_sources` | Unique trader identities, keyed by `(source, source_trader_id)` |
| `trader_snapshots` | Point-in-time performance data (ROI, PnL, rank, Arena Score) per period |
| `trader_details` | Enriched profile data (bio, avatar, advanced stats) |
| `trader_equity_curves` | Historical equity curve data points |
| `trader_position_history` | Past trading positions with asset breakdown |
| `trader_stats_detail` | Advanced statistics (Sharpe, Sortino, Calmar, profit factor) |
| `trader_asset_breakdown` | Asset allocation analysis derived from position history |
| `trader_anomalies` | Flagged data quality anomalies |

### User and Social

| Table | Purpose |
|-------|---------|
| `user_profiles` | User accounts with level progression |
| `posts` | Community posts |
| `comments` | Post comments |
| `groups` | Trading groups |
| `group_members` | Group membership with roles |
| `follows` | User following relationships |
| `favorites` | Bookmarked traders and resources |

### System

| Table | Purpose |
|-------|---------|
| `pipeline_logs` | Cron job execution logs (success/failure, duration, record counts) |
| `subscriptions` | Pro membership records |
| `stripe_customers` | Stripe customer mapping |
| `leaderboard_cache` | Precomputed leaderboard data for fast page loads |

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

Optional variables for geo-block proxy fallback:

| Variable | Description |
|----------|-------------|
| `CLOUDFLARE_PROXY_URL` | CF Worker proxy URL |
| `VPS_PROXY_SG` | Singapore VPS proxy endpoint |
| `VPS_PROXY_JP` | Japan VPS proxy endpoint |
| `VPS_PROXY_KEY` | API key for VPS proxy authentication |

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
npm run test           # Jest test suite (135+ suites, 2000+ tests)
npm run test:e2e       # Playwright E2E tests
```

### Diagnostic Scripts

```bash
node scripts/pipeline-health-check.mjs          # Full pipeline health check
node scripts/pipeline-health-check.mjs --quick   # Quick data freshness check
node scripts/diagnose-enrichment.mjs             # Enrichment API diagnostic
node scripts/check-data-distribution.mjs         # Data distribution analysis
```

## Deployment

The application is deployed on Vercel with automatic deployments from the `main` branch.

```bash
vercel --prod          # Manual production deploy via Vercel CLI
git push origin main   # Triggers automatic deployment
```

All environment variables must be configured in the Vercel dashboard. The primary serverless function region is `hnd1` (Tokyo) to avoid geo-blocking from major exchange APIs.

### Cron Jobs

Cron schedules are defined in `vercel.json`. All 44 cron endpoints require an `Authorization: Bearer CRON_SECRET` header. Schedules are staggered to avoid database connection contention (no two jobs share the same minute offset).

### Monitoring

- Pipeline health: `/api/health/pipeline` (used by OpenClaw Mac Mini monitor)
- Dependency health: `/api/health/dependencies` (checks Supabase, Redis, Stripe connectivity)
- Admin metrics: `/api/admin/metrics/trends` (pipeline success rates, error rates, active users)
- Telegram alerts: automatic on cron job failures and data staleness

## License

All rights reserved. Copyright 2026 Arena.
