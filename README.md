<div align="center">

# Arena

**Crypto trader discovery and ranking with registry-governed public CEX and DEX data.**

[![Production](https://img.shields.io/badge/production-live-brightgreen)](https://www.arenafi.org)
[![Next.js](https://img.shields.io/badge/Next.js-16-black)](https://nextjs.org)
[![Ingest adapters](https://img.shields.io/badge/ingest_adapters-26-blue)]()
[![Vercel schedules](https://img.shields.io/badge/Vercel_schedules-44-orange)]()

[Live Site](https://www.arenafi.org) · [Data API](#data-api) · [Features](#features) · [Architecture](#architecture) · [Data Pipeline](#data-pipeline) · [Getting Started](#getting-started)

</div>

## Data API

Arena provides a REST API for programmatic access to trader rankings, performance data, and search across the sources currently exposed by the serving registry.

**Pricing**: Free (100 req/day) · Starter $49/mo (10K req/day) · Pro $199/mo (unlimited)

```bash
# Get top traders by Arena Score
curl "https://www.arenafi.org/api/v3?endpoint=rankings&period=90D&limit=10"
```

**6 endpoints**: `rankings`, `trader`, `search`, `platforms`, `history`, `bulk`

Full documentation and API keys: [arenafi.org/api-docs](https://www.arenafi.org/api-docs)

## Overview

Arena aggregates, normalizes, and ranks public traders from centralized and decentralized sources selected by the active-serving database registry. Arena Score v4 combines profitability, drawdown, risk-adjusted return, consistency, and sample confidence on a 0-100 peer-relative scale. The system has 53 cron/worker endpoints: 44 are production Vercel schedules, while database-driven ingest also runs on external workers. Its 26 registered ingest adapters collect leaderboard and profile surfaces, then the Next.js 16 frontend serves normalized results with ISR and edge caching.

Beyond rankings, Arena provides an educational library (books, research papers, whitepapers), market data via TradingView WebSocket, community features (groups, posts, comments, reputation-gated access), on-chain attestation via EAS, and a Pro membership tier. The platform supports 4 languages (English, Chinese, Japanese, Korean) and runs on both web and native mobile (iOS/Android via Capacitor).

## Features

### Trader Rankings and Arena Score

Arena Score v4 is computed separately inside each visible time-window cohort:

- **Profitability (50%)**: absolute PnL magnitude (30%) plus ROI percentile (20%).
- **Risk control (40%)**: lower drawdown percentile (20%) plus Sharpe percentile (20%).
- **Consistency (10%)**: available win-rate and profit-factor percentiles.
- **Confidence**: sample size and metric completeness discount the quality score; missing optional dimensions are reweighted rather than silently treated as observed zeroes.

The displayed 0-100 score blends the confidence-adjusted composite's cohort percentile (70%) with its relative magnitude (30%). The cross-window composite uses 90D/30D/7D weights from `ARENA_CONFIG.OVERALL_WEIGHTS`; missing windows are reweighted by the consuming route.

Rankings are available across three time windows: 7 days, 30 days, and 90 days.

### Source Coverage

Coverage is registry-driven, not a hard-coded exchange list. A registered adapter only means the parser/fetch implementation exists; a source appears in product navigation only when its `arena.sources` row is active, serving, and has a visible board for the requested 7D/30D/90D window.

- Public current set: `/api/sources/visible?timeRange=90D` (change the time range as needed).
- Operator authority: active-serving `arena.sources` plus `arena_visible_sources(...)`.
- Upstream freshness authority: `leaderboard_source_freshness.source_as_of`.

This fail-closed separation prevents retired, shadow, or empty integrations from being advertised as current coverage. Upstream staleness is surfaced separately; it does not silently remove an otherwise visible board from navigation.

### Trader Profiles

Each trader profile includes:

- Performance metrics across available time windows; optional metrics are shown only when the upstream surface or a labeled derivation supports them
- Equity curves when a verified series surface is available
- Position history and asset breakdown when the source exposes those surfaces
- Advanced statistics such as Sharpe, Sortino, Calmar, and profit factor, with provenance/estimation semantics preserved
- Trading style radar chart (5 dimensions)
- Bot/Human classification with visual badges
- Verified trader badge (via claim system)
- Direct source link when the registry has a verified URL template

### DeSoc (Decentralized Social)

- **Trader Claim System**: Traders can claim and verify their exchange identities
- **Reputation-Driven Access**: Groups can set minimum Arena Score thresholds; posts carry author Arena Score
- **On-Chain Attestation**: Mint Arena Score to Base chain via EAS (Ethereum Attestation Service), server-side signing
- **Copy Trade Links**: Referral URLs for 8 exchanges

### Market Overview

- TradingView-powered interactive charts and WebSocket price feeds for selected major assets
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

### Library

- Curated educational resources: books, research papers, whitepapers, articles
- EPUB reader with customizable settings (font, theme, layout)
- Bookshelf management with favorites

### Pro Membership

- Monthly, yearly, and lifetime plans backed by the deployed Stripe price catalog
- Stripe integration for checkout, webhooks, entitlement reconciliation, refunds, and the customer portal
- Promo access is controlled by the exact deployed `NEXT_PUBLIC_PRO_FREE_PROMO` value; documentation does not assume it is on or off

### Mobile

- Native iOS and Android apps via Capacitor
- BottomSheet, SwipeableView, PullToRefresh, MobileFilterSheet
- Push notifications, haptics, biometrics, camera, share
- Service Worker for offline support and caching
- Infinite scroll with IntersectionObserver

### Localization and Theming

- 4 languages: English, Chinese, Japanese, Korean
- Dark and Light themes with design tokens (`lib/design-tokens.ts`)
- Simple object map i18n — zero runtime overhead, type-safe

## Tech Stack

| Layer         | Technology                                | Details                                                                        |
| ------------- | ----------------------------------------- | ------------------------------------------------------------------------------ |
| Framework     | Next.js 16                                | App Router, React 19, Turbopack dev server                                     |
| Language      | TypeScript 5                              | Strict mode; Jest, Playwright, and `node:test` contract suites                 |
| Database      | Supabase                                  | PostgreSQL, Auth, Realtime, explicit RLS policies and grants                   |
| Caching       | Upstash Redis                             | Edge-compatible, used for leaderboard cache, rate limiting, session data       |
| Search        | Meilisearch                               | Full-text search with fuzzy matching (pg_trgm fallback)                        |
| Hosting       | Vercel                                    | Edge + Serverless functions, primary region hnd1 (Tokyo), ISR for static pages |
| Payments      | Stripe                                    | Checkout, subscriptions, webhooks, customer portal                             |
| Auth          | Supabase Auth + Privy                     | Email/password + Web3 wallet login                                             |
| Styling       | Tailwind CSS v4                           | Design token system, dark/light theme                                          |
| Exchange Data | 26 registered `SourceAdapter`s            | Registry-driven RAW evidence, pure parsers, staging, and serving publication   |
| State         | Zustand + React Query + SWR               | Zustand for global state, React Query + SWR for server data fetching           |
| Resilience    | Cockatiel                                 | Retry with exponential backoff + circuit breaker (`ConsecutiveBreaker`)        |
| Validation    | Zod                                       | Runtime validation for pipeline payloads and protected request bodies          |
| Monitoring    | Sentry + PipelineLogger + Healthchecks.io | Structured execution logs, health sentinels, and configured dead-man pings     |
| Alerts        | Telegram Bot                              | Automatic alerts on cron failures and data staleness                           |
| Mobile        | Capacitor                                 | iOS + Android native apps with push, haptics, biometrics                       |
| Web3          | viem + wagmi + RainbowKit + EAS           | Wallet login, on-chain attestation                                             |
| Security      | CSP, HSTS, RLS, timingSafeEqual           | Security headers, route authorization, rate limiting, and input validation     |

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
                        |    API + pages    |
                        +--+-----+-------+--+
                           |     |       |
              +------------+  +--+---+  ++------------+
              |               |      |                |
     +--------+-----+  +-----+---+  +-----+-----+   |
     |   Supabase   |  | Upstash  |  | Meilisearch|   |
     |  PostgreSQL  |  |  Redis   |  | Full-text  |   |
     |Versioned schema|  |  Cache   |  |  Search    |   |
     |  Auth + RLS  |  +---------+  +-----------+   |
     +--------------+                                |
                                       +-------------+---+
                                       | 44 Schedules     |
                  +------------------->| Data Pipeline   |
                  |                    +--------+--------+
                  |                             |
         +--------+----------+        +--------+--------+
         | CF Worker Proxy   |        | VPS Scrapers    |
         | (geo-block bypass)|        | SG + JP nodes   |
         +-------------------+        | Playwright      |
                  |                    +-----------------+
         +--------+-------------------------------------------+
         | Registry-governed source APIs                     |
         | CEX + DEX leaderboards, profiles, and on-chain    |
         | evidence; active-serving coverage is data-driven  |
         +----------------------------------------------------+
```

### Key Architectural Decisions

**Registry-Driven Ingest Adapters.** The worker bootstrap explicitly registers 26 `SourceAdapter` implementations in `lib/ingest/adapters/register.ts`; one adapter may serve multiple `arena.sources` rows. Each adapter declares its supported surfaces, fetches durable RAW payloads through a rate-budgeted `FetchSession`, and exposes pure parsers so stored evidence can be replayed without touching the network or clock. The database registry, not a static marketing list, decides which source/window promises are active and serving.

**Source-Native Fetch Paths.** Each ingest adapter owns the fetch path appropriate to its upstream: direct public API, region-pinned VPS egress, Playwright, or on-chain RPC/indexer. `FetchSession` applies rate budgets and captures durable RAW evidence before pure parsing; the source registry pins serving mode and execution region rather than assuming one proxy chain fits every source.

**Snapshot Architecture.** The arena ingest worker writes scraped data to the partitioned **`arena.*` schema** (`arena.trader_stats`, `arena.leaderboard_entries`, etc.); `trader_snapshots_v2` was dropped 2026-06-16. `compute-leaderboard` derives `public.leaderboard_ranks` (+ `lr_7d/30d/90d`) as the precomputed read tables for rankings. This separation keeps writes fast and reads indexed. See `docs/ARENA_REBUILD_SPEC.md`.

**Gated Ingest Lifecycle.** External workers schedule source discovery and profile jobs, persist RAW and parsed evidence, apply count/quality gates in staging, and publish only complete boards into the serving schema. Vercel routes provide supporting orchestration and watchdogs; their existence does not prove that a first-party source is scheduled or healthy.

**Incremental Static Regeneration.** Trader profile pages use ISR with `revalidate=300`. The `warm-cache` production schedule runs at UTC `:04` and `:34`, and a successful ingest chain may also trigger it after a complete leaderboard publish.

## Data Pipeline

The data pipeline combines 44 production schedules declared in `vercel.json` with external database-driven ingest workers. The repository has 53 cron/worker route implementations, but an endpoint's existence is not proof that Vercel schedules it. `vercel.json` is the only source of truth for Vercel cadence; the database registry and worker scheduler are the sources of truth for first-party ingest.

This README intentionally does not duplicate all 44 schedule rows. Inspect the deployed declarations directly:

```bash
jq -r '.crons[] | [.path, .schedule] | @tsv' vercel.json
```

### Launch-Critical Monitoring and Maintenance

| Job                        | Schedule                   | Description                                                                                              |
| -------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------- |
| `check-data-freshness`     | Every 3 hours at `:39` UTC | Compare every registry-promised visible board with its upstream `source_as_of`; page on unknown/critical |
| `meta-monitor`             | Every 6 hours at `:23` UTC | Detect missing cron successes against twice each job's expected interval                                 |
| `cleanup-data`             | Daily 01:06 UTC            | Clean up stale data                                                                                      |
| `cleanup-deleted-accounts` | Daily 03:00 UTC            | Remove data for deleted user accounts                                                                    |
| `cleanup-stuck-logs`       | Every 6 hours at `:27` UTC | Clean stuck pipeline log entries                                                                         |
| `subscription-expiry`      | Mondays 00:09 UTC          | Process expired Pro subscriptions                                                                        |
| `backfill-avatars`         | Daily 02:35 UTC            | Backfill missing trader avatar images                                                                    |
| `check-trader-alerts`      | Every 30 minutes           | Check and send Pro trader metric alerts                                                                  |

Cron handlers that adopt `PipelineLogger` write structured execution state to Supabase `pipeline_logs` and the ClickHouse dual-write path. A configured critical subset also pings Healthchecks.io; route-specific failures and health sentinels feed the shared alerting system.

## Directory Structure

```
app/                          # Next.js App Router
  api/                        # Public, authenticated, admin, health, and worker routes
    cron/                     # 53 cron/worker endpoints (44 scheduled by Vercel)
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
  settings/                   # User settings
  components/                 # Shared UI components

lib/                          # Core business logic
  ingest/
    adapters/                 # 26 registered SourceAdapter implementations
    core/                     # Contracts, registry loading, validation, normalization
    fetch/                    # Rate-budgeted FetchSession and durable RAW capture
    staging/                  # RAW/parsed evidence staging
    serving/                  # Complete-board publication into serving schema
  cron/
    meta-monitor-policy.ts    # Pure missing-success evaluation policy
    with-cron-lock.ts         # Distributed run lock and delivery deduplication
    with-cron-budget.ts       # Serverless execution budget guard
  data/                       # Server-side data fetching
    unified.ts                # Unified data layer (getLeaderboard, getTraderDetail, searchTraders)
    trader/                   # Trader data functions with fallback chains
  services/                   # Business logic
    pipeline-logger.ts        # 3-destination execution logging
    pipeline-self-heal.ts     # Auto-recovery
    anomaly-detection.ts      # Statistical anomaly detection
    telegram-bot.ts           # Telegram alerts
    trader-alerts.ts          # Rank change notifications
  hooks/                      # React hooks
  stores/                     # Zustand stores (period, inbox, multiAccount, post)
  types/                      # TypeScript types
    unified-trader.ts         # Canonical frontend type (UnifiedTrader)
    leaderboard.ts            # Pipeline types, platform configs, rate limits
  utils/                      # Utilities
    arena-score.ts            # Arena Score v4 plus rollback formulae
  scoring/                    # Score feature/provenance helpers
  cache/                      # Redis cache helpers
  i18n/                       # 4 languages (en/zh/ja/ko)
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

| Table                     | Purpose                                                                  |
| ------------------------- | ------------------------------------------------------------------------ |
| `leaderboard_ranks`       | Precomputed ranked leaderboard; each season is normally rebuilt every 2h |
| `arena.trader_stats`      | Point-in-time performance per (trader, timeframe) — primary write table  |
| `arena.traders`           | Trader identity registry, keyed by `(source_id, exchange_trader_id)`     |
| `trader_sources`          | Trader source identities (legacy serving + enrichment)                   |
| `trader_equity_curve`     | Historical equity curve data points per period                           |
| `trader_position_history` | Past trading positions with PnL                                          |
| `trader_stats_detail`     | Advanced statistics (Sharpe, Sortino, Calmar, profit factor) per period  |
| `trader_asset_breakdown`  | Asset allocation analysis per period                                     |
| `trader_daily_snapshots`  | Daily ROI/PnL rollups                                                    |
| `trader_portfolio`        | Current open positions                                                   |
| `trader_sources`          | Unique trader identities, keyed by `(source, source_trader_id)`          |

### User and Social

| Table                 | Purpose                                                               |
| --------------------- | --------------------------------------------------------------------- |
| `user_profiles`       | User accounts with level progression and reputation score             |
| `posts`               | Community posts with visibility, full-text search, author Arena Score |
| `comments`            | Post comments                                                         |
| `groups`              | Trading groups with optional Arena Score threshold                    |
| `group_members`       | Group membership with roles                                           |
| `follows`             | User following relationships                                          |
| `trader_claims`       | Trader identity claim requests                                        |
| `verified_traders`    | Verified trader identities                                            |
| `trader_attestations` | EAS on-chain attestation records                                      |

### System

| Table                        | Purpose                                                   |
| ---------------------------- | --------------------------------------------------------- |
| `pipeline_logs`              | Cron job execution logs (status, duration, record counts) |
| `pipeline_job_status` (View) | Latest status per job                                     |
| `pipeline_job_stats` (View)  | 7-day success rate and avg duration per job               |
| `subscriptions`              | Pro membership records                                    |
| `stripe_customers`           | Stripe customer mapping                                   |

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

| Variable                        | Description                                  |
| ------------------------------- | -------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`      | Supabase project URL                         |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anonymous key (client-side)         |
| `SUPABASE_SERVICE_ROLE_KEY`     | Supabase service role key (server-side only) |
| `UPSTASH_REDIS_REST_URL`        | Upstash Redis REST endpoint                  |
| `UPSTASH_REDIS_REST_TOKEN`      | Upstash Redis auth token                     |
| `CRON_SECRET`                   | Bearer token for cron job authentication     |
| `STRIPE_SECRET_KEY`             | Stripe API secret key                        |
| `STRIPE_WEBHOOK_SECRET`         | Stripe webhook signing secret                |

Optional variables for monitoring and proxy:

| Variable                | Description                                    |
| ----------------------- | ---------------------------------------------- |
| `CLOUDFLARE_PROXY_URL`  | CF Worker proxy URL                            |
| `VPS_PROXY_KEY`         | API key for VPS proxy authentication           |
| `SENTRY_DSN`            | Sentry error tracking                          |
| `HEALTHCHECKS_PING_URL` | Healthchecks.io ping URL for dead man's switch |
| `TELEGRAM_BOT_TOKEN`    | Telegram bot token for alerts                  |
| `TELEGRAM_CHAT_ID`      | Telegram chat ID for alerts                    |
| `MEILISEARCH_HOST`      | Meilisearch host URL                           |
| `MEILISEARCH_API_KEY`   | Meilisearch API key                            |

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
npm run test           # Jest test suite
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

The application is deployed on Vercel through the repository's CI deployment gate. A push to `main` must pass the required checks before the production deployment is created; a pushed commit alone is not proof that production advanced.

```bash
vercel --prod          # Manual production deploy; verify the linked project first
git push origin main   # Starts CI; deploy-gate promotes only after required checks pass
```

All environment variables must be configured in the Vercel dashboard. The primary serverless function region is `hnd1` (Tokyo) to minimize latency to Asian exchange APIs and avoid geo-blocking.

### Cron Jobs

Cron schedules are defined in `vercel.json`. The 44 production schedules call authenticated endpoints with `Authorization: Bearer CRON_SECRET`; Vercel injects that header from the Production environment. Schedules are staggered and should be checked with `node scripts/cron-schedule-heatmap.mjs` before adding another job.

### Infrastructure

| Component                  | Details                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| **Vercel**                 | Edge + Serverless, region hnd1, 44 production cron schedules       |
| **SG VPS** (45.76.152.169) | Proxy :3456 + Playwright Scraper :3457 (PM2)                       |
| **JP VPS** (149.28.27.242) | Polymarket + exchange proxy                                        |
| **Mac Mini** (OpenClaw)    | Health monitor (30min), daily reports, auto-fix, weekly self-check |
| **Cloudflare Worker**      | Geo-block bypass proxy with ALLOWED_HOSTS whitelist                |

### Monitoring

- Pipeline health: `/api/health/pipeline` (used by OpenClaw Mac Mini monitor)
- Dependency health: `/api/health/detailed?section=dependencies` (checks Supabase, Redis, Stripe connectivity)
- Admin metrics: `/api/admin/metrics/trends` (pipeline success rates, error rates, active users)
- Healthchecks.io: dead man's switch for the configured monitored `PipelineLogger` subset
- Sentry: client/server/edge error tracking
- Telegram alerts: automatic on cron job failures and data staleness

### Key Metrics

| Metric           | Value           |
| ---------------- | --------------- |
| Ingest Adapters  | 26 registered   |
| Cron Endpoints   | 53              |
| Vercel Schedules | 44              |
| UI Languages     | 4 (en/zh/ja/ko) |

## License

All rights reserved. Copyright 2026 Arena.
