<div align="center">

# Arena

**Crypto trader discovery and ranking with registry-governed public CEX and DEX data.**

![V1 release status](https://img.shields.io/badge/V1_release-NO--GO-red)
[![Next.js](https://img.shields.io/badge/Next.js-16-black)](https://nextjs.org)
[![Ingest adapters](https://img.shields.io/badge/ingest_adapters-26-blue)]()
[![V1 schedule plan](https://img.shields.io/badge/V1_schedules-0-blue)]()

[Product reference (owner-approved read-only)](https://www.arenafi.org) · [Data API](#data-api) · [Features](#features) · [Architecture](#architecture) · [Data Pipeline](#data-pipeline) · [Getting Started](#getting-started)

</div>

## V1 NO-GO boundary

V1 work is limited to local development, isolated branches, and Draft PR review.
Production services, dashboards, hosts, schedulers, workers, and credentials are
owner-controlled. An agent or contributor may collect production evidence only when
the owner explicitly approves the exact read-only query; no approval authorizes a
write, deployment, migration, cache action, cron invocation, restart, or recovery.

The checked-in V1 source configuration has **zero Vercel schedules** and disables
Git-triggered Vercel deployment. These are source-only containment changes: they do
not prove or modify a deployed control plane. Historical route implementations are
code-review context only and do not authorize an operation.

This source revision also has narrow, immutable publication holds; none is an
environment toggle or a claim about a deployed process:

- For the documented ranking-command chain, `V1_CRON_EXECUTION_PUBLISHED=false`
  guards five direct endpoints: `GET /api/cron/compute-leaderboard`,
  `GET /api/cron/precompute-composite`, `GET /api/cron/sync-meilisearch`,
  `GET /api/cron/pipeline-evaluate`, and `GET`/`POST /api/hooks/post-deploy`. Each
  authenticates before doing work: missing or invalid service authentication returns
  `401`; valid authentication returns `410` with `CRON_EXECUTION_NOT_PUBLISHED`; both
  responses carry the three `no-store` headers before request parsing, locks, pipeline
  logs, stores, cache, or provider access. This ranking-command list does not classify
  other cron routes.
- `V1_RANKING_COMMAND_CHAIN_PUBLISHED=false` separately closes the checked-in legacy
  downstream ranking-command worker, scheduler, and caller chain. On this source
  revision its worker entry exits before dotenv, database, Redis, BullMQ, or HTTP
  initialization, and its scheduler/caller paths return before BullMQ, Redis, or
  network work. It cannot stop an already-running host process or a schedule stored
  outside this checkout.
- `V1_INGEST_EXECUTION_PUBLISHED=false` holds the checked-in native ingest command
  path: its worker entry exits before dotenv/runtime dependency initialization, and
  its scheduler and Redis connection do not start database, ioredis, or BullMQ work.
  The Tier-C and first-party bridges admit no new ingest work; `POST
/api/trader/onchain-enrich` is a fixed `410 INGEST_EXECUTION_NOT_PUBLISHED` response
  with three `no-store` headers before body parsing, rate limiting, provider, or
  serving-data work. Profile `core` and `records` retain their warm serving-read
  branches, while the cold Tier-C fallback resolves as pending without initializing a
  provider/ioredis/BullMQ bridge or reading a Tier-C result queue. Their public rate
  limiter may still use Redis; this hold is not a claim that those routes make zero
  Redis reads. Covered direct ingest scripts likewise do not initiate ingest. This
  source boundary neither stops nor proves a running host, persisted queue, or
  external schedule.

The checked-in legacy-refresh boundary, including the client-safe fixed-false
`V1_LEGACY_REFRESH_JOBS_PUBLISHED` marker, holds the legacy `refresh_jobs` path.
`batch-discover` is auth-first `401/410` with three
`no-store` headers; `batch-5min` no longer imports or consumes that queue and retains
only post hot-score maintenance. The public trader-refresh POST is auth-first
`401/410` without parsing a body, rate limiting, or touching the queue; legacy detail
returns `refresh_job: null`, and its compatibility hook neither posts nor polls.
This source boundary cannot stop or prove a running host, persisted queue, or external
schedule.

The checked-in legacy proxy/import acquisition boundary is deliberately narrower than
"all source writes are closed." It retires only these historical source entrypoints:
`GET /api/proxy/phemex`, `cloudflare-worker/src/index.ts`,
`scripts/import/import_all_platforms.mjs`, `scripts/import/refresh.sh`,
`scripts/import/import-all-blocked.sh`, `scripts/import/run_hl_enrichment.sh`,
`scripts/vps-deploy/scraper-v16-parallel.js`, `scripts/vps-deploy/arena-proxy.mjs`,
`scripts/archive/test-vps-scrapers.ts`, and
`scripts/archive/verify-data-accuracy.mjs`. The Phemex route authenticates first:
missing or invalid service authentication returns `401`; valid authentication returns
`410 LEGACY_PROXY_ACQUISITION_NOT_PUBLISHED`; both responses carry three `no-store`
headers before URL/query parsing, upstream fetch, or logging. The checked-in
Cloudflare Worker returns fixed `410 LEGACY_PROXY_IMPORT_NOT_PUBLISHED` with the same
three `no-store` headers and no upstream fetch. The listed script entrypoints report
`RETIRED` and exit `2` before proxy, browser, import, or host work. This is source-only:
it neither stops nor proves an already deployed Cloudflare Worker, VPS proxy/scraper,
host process, queue, or schedule. That proxy/import unit does not classify or close
avatar helpers, the worker `avatar-mirror`, adapters, unlisted writers, or
`GET /api/avatar`; each remains outside its bounded review.

A separate source-only tombstone covers the canonical `GET /api/cron/backfill-avatars`
route and its `/api/v1/cron/backfill-avatars` rewrite alias, which resolves to the same
handler. It is auth-first: missing or invalid service authentication returns `401`; valid
authentication returns `410 CRON_EXECUTION_NOT_PUBLISHED`. Both responses carry the
three `no-store` headers and return before parameter parsing, database access, logging,
or upstream fetch. This endpoint contract cannot stop, inspect, or prove an already
deployed host, external scheduler, or healthcheck. It does not cover avatar helpers,
the worker `avatar-mirror`, adapters, unlisted writers, or `GET /api/avatar`; those
remain outside the endpoint's bounded review.

## Data API

Arena provides a REST API for programmatic access to trader rankings, performance data, and search across the sources currently exposed by the serving registry.

**Pricing**: Free (100 req/day) · Starter $49/mo (10K req/day) · Pro $199/mo (unlimited)

The endpoint names below are API-contract reference only, not V1 operational checks.
Calling any production endpoint requires the owner's prior, query-specific read-only
approval.

**5 published endpoints**: `rankings`, `trader`, `search`, `platforms`, `bulk`.
The `history` compatibility endpoint is currently a no-store 503 quarantine response and does not consume API quota.

API-key issuance and live API documentation access are owner-controlled during V1.

## Overview

Arena aggregates, normalizes, and ranks public traders from centralized and decentralized sources selected by the active-serving database registry. Arena Score v4 combines profitability, drawdown, risk-adjusted return, consistency, and sample confidence on a 0-100 peer-relative scale. The repository contains 53 cron/worker route implementations and 26 registered ingest adapters; the checked-in V1 configuration schedules **none** of those routes through Vercel. Route code does not establish an active worker, schedule, or source connection.

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

- The source route contract is defined in code; do not query the live route without owner approval.
- Active-serving authority is modeled by `arena.sources` plus `arena_visible_sources(...)`.
- Freshness authority is modeled by `leaderboard_source_freshness.source_as_of`.

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
- Funding-rate and open-interest UI surfaces, when published with valid evidence
- Flash-news UI surfaces, when published with valid evidence

### Community

- Trading groups with membership, applications, and group-level analytics
- Post and comment system with voting, visibility controls (public/followers/group), and full-text search
- User level progression (food chain theme): Krill, Sardine, Dolphin, Shark, Orca
- Following system with activity feeds. Trader alerts and personalized
  ranking-change notifications are temporarily unavailable during V1
  verification; owners may only view or remove saved legacy alert
  configurations and history.

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

| Layer         | Technology                                | Details                                                                                |
| ------------- | ----------------------------------------- | -------------------------------------------------------------------------------------- |
| Framework     | Next.js 16                                | App Router, React 19, Turbopack dev server                                             |
| Language      | TypeScript 5                              | Strict mode; Jest, Playwright, and `node:test` contract suites                         |
| Database      | Supabase                                  | PostgreSQL, Auth, Realtime, explicit RLS policies and grants                           |
| Caching       | Upstash Redis                             | Edge-compatible, used for leaderboard cache, rate limiting, session data               |
| Search        | Meilisearch                               | Full-text search with fuzzy matching (pg_trgm fallback)                                |
| Hosting       | Vercel                                    | Edge + Serverless functions, primary region hnd1 (Tokyo), ISR for static pages         |
| Payments      | Stripe                                    | Checkout, subscriptions, webhooks, customer portal                                     |
| Auth          | Supabase Auth + Privy                     | Email/password + Web3 wallet login                                                     |
| Styling       | Tailwind CSS v4                           | Design token system, dark/light theme                                                  |
| Exchange Data | 26 registered `SourceAdapter`s            | Registry-driven RAW evidence, pure parsers, staging, and serving publication           |
| State         | Zustand + React Query + SWR               | Zustand for global state, React Query + SWR for server data fetching                   |
| Resilience    | Cockatiel                                 | Retry with exponential backoff + circuit breaker (`ConsecutiveBreaker`)                |
| Validation    | Zod                                       | Runtime validation for pipeline payloads and protected request bodies                  |
| Monitoring    | Sentry + PipelineLogger + Healthchecks.io | Historical/source observability integrations; V1 is report-only and does not remediate |
| Alerts        | Telegram Bot                              | Alert integration code; no V1 automated recovery or delivery is authorized             |
| Mobile        | Capacitor                                 | iOS + Android native apps with push, haptics, biometrics                               |
| Web3          | viem + wagmi + RainbowKit + EAS           | Wallet login, on-chain attestation                                                     |
| Security      | CSP, HSTS, RLS, timingSafeEqual           | Security headers, route authorization, rate limiting, and input validation             |

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
                                       +-------------------+
                                       | V1 schedule plan: |
                  +------------------->| 0 Vercel jobs     |
                  |                    +--------+----------+
                  |                             |
                  |                    +--------+----------+
                  |                    | Adapter/parser   |
                  |                    | code and evidence|
                  |                    | contracts only   |
                  |                    +-------------------+
         +--------+-------------------------------------------+
         | Registry-governed source APIs                     |
         | CEX + DEX leaderboards, profiles, and on-chain    |
         | evidence; active-serving coverage is data-driven  |
         +----------------------------------------------------+
```

### Key Architectural Decisions

**Registry-Driven Ingest Adapters.** The source bootstrap registers 26 `SourceAdapter` implementations in `lib/ingest/adapters/register.ts`; one adapter may serve multiple `arena.sources` rows. Each adapter declares supported surfaces, models durable RAW capture through a rate-budgeted `FetchSession`, and exposes pure parsers so stored evidence can be replayed without touching the network or clock. This is intended source architecture, not evidence that a worker is running. The database registry, not a static marketing list, decides which source/window promises are active and serving.

**Source-Native Fetch Paths.** Adapter code models the source-specific interfaces and captures durable RAW evidence before pure parsing. During V1 NO-GO, it is not an instruction to operate a proxy, host, browser worker, or upstream fetch path. Source-network evidence must be specifically approved by the owner and remain read-only.

**Snapshot Architecture.** The codebase separates ingest staging from serving tables such as **`arena.*`** and `public.leaderboard_ranks`. `trader_snapshots_v2` was dropped 2026-06-16. This is an architectural description, not V1 authority to write, recompute, or publish data. See `docs/ARENA_REBUILD_SPEC.md`.

**Gated Ingest Lifecycle.** The intended design gates RAW evidence, parsed data, and
complete-board publication. The fixed V1 ingest source hold prevents the covered
native worker, scheduler, connection, bridges, on-chain route, and direct scripts
from initiating new ingest. The separately fixed legacy refresh-job hold removes its
consumer and admissions while preserving only the unrelated post hot-score maintenance
command. A separately enumerated legacy proxy/import hold retires only its named
historical proxy, browser, and import entrypoints; it is not a declaration that every
source writer or helper is closed. A distinct canonical `GET /api/cron/backfill-avatars`
route—and its same-handler `/api/v1/cron/backfill-avatars` rewrite alias—is an auth-first
tombstone that returns `401` or `410 CRON_EXECUTION_NOT_PUBLISHED` with three `no-store`
headers before parameters, database, logging, or upstream fetch. It covers only that
handler—not avatar helpers, the worker `avatar-mirror`, adapters, unlisted writers, or
`GET /api/avatar`—and cannot prove a host, external scheduler, or healthcheck. None of
these source holds can stop or prove an already-running process, queue, worker, or
schedule. Code may be reviewed locally but does not prove that a source is scheduled or
healthy.

**Incremental Static Regeneration.** Trader profile pages declare `revalidate=300` in code. Any historical cache-warming or ingest-triggered schedule is outside the V1 plan and must not be invoked.

## Data Pipeline

The checked-in V1 source configuration contains **0 Vercel schedules**. The
repository's 53 cron/worker route implementations are not operational authority,
evidence of deployment, or permission to invoke a route. This source-only
containment deliberately makes no claim about any deployed control plane or host.

**Daily-snapshot and trader-alert containment.** `aggregate-daily-snapshots`, `cleanup-violations`, and `scan-data-quality` are unscheduled auth-first tombstones: anonymous requests return 401 and authenticated requests return 410 without touching data. The scanner's former admin RPC has no versioned function body, so it is not accepted as a read-only replacement. Legacy daily rows have no season, generation, cohort, or publication-proof identity and are not ranking authority. Movers, equity, indicators, public history, V3 history, and hot-trader recommendations now return fixed empty/unavailable, three-layer `no-store` contracts; the homepage does not request Movers, and the equity hook rejects old cached positive bodies without explicit availability plus publication proof. Trader-alert evaluation, personalized trader-event broadcasts, ranking-change triggers, and weekly digests are retired auth-first tombstones: authenticated callers receive a fixed 410 response and must not read trader data, advance alert state, or deliver email/push. V1 does not authorize manual backfill, cleanup, general-purpose SQL RPC, restoration of a retired schedule, or reopening alert delivery; any future design must be separately reviewed and provenance-bound.

The forward migrations `20260808090000_quarantine_legacy_trader_daily_snapshots.sql` and `20260816130000_quarantine_v1_trader_alert_browser_mutations.sql` are reviewed deployment candidates, not proof that the live database has these ACLs. They are not to be applied, verified against production, or used to infer live state during V1 NO-GO. Any future release requires a separately recorded owner GO and a bounded release plan.

### V1 scheduled work and monitoring

V1 authorizes no scheduled maintenance, fetch, cleanup, backfill, notification, or
recovery work. The checked-in Vercel configuration has zero schedules; separate
disabled workflow triggers and any external scheduler are not evidence of an approved
runtime. Monitoring integrations are report-only source interfaces. This does not
establish whether any external scheduler, host worker, or provider pipeline is
running. Collect production evidence only after the owner approves the exact read-only
query; never turn an observation into a route invocation, task, mutation, or automatic
fix.

## Directory Structure

```
app/                          # Next.js App Router
  api/                        # Public, authenticated, admin, health, and worker routes
    cron/                     # 53 route implementations; V1 schedule plan: none
    v2/, v3/                  # Versioned API endpoints
    admin/                    # Admin-only endpoints (metrics, monitoring)
    health/                   # Health check endpoints (pipeline, dependencies)
  (app)/rankings/             # Supplementary rankings routes
  (app)/trader/[handle]/      # Trader profile pages
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
    pipeline-logger.ts        # Historical/source execution-logging interface
    pipeline-self-heal.ts     # Legacy recovery implementation; no V1 authority
    anomaly-detection.ts      # Statistical anomaly detection
    telegram-bot.ts           # Telegram alerts
    trader-alerts.ts          # Legacy alert evaluator; no V1 publication authority
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
  diagnose.mjs                # Unified read-only diagnostics entrypoint
  check_status.mjs            # Public serving/freshness/platform checks
  check_seasons.mjs           # Current leaderboard inventory
  check_enrichment.mjs        # Non-authoritative enrichment inventory
  backfill-*.ts               # Legacy compatibility tombstones (V1 direct runs disabled)
  openclaw/                   # Retired/observation-only V1 compatibility paths
  vps-scrapers/               # Historical scraper source; no V1 host operation
  maintenance/                # R2 backup, cleanup scripts

supabase/migrations/          # versioned PostgreSQL migration history

cloudflare-worker/            # Historical proxy source; fixed V1 no-fetch response

e2e/                          # Playwright E2E tests
k6/                           # K6 load tests
contracts/                    # Smart contracts (Foundry)
android/ & ios/               # Capacitor mobile apps
```

## Database Schema

Core tables (all with Row Level Security enabled):

### Trader Data

| Table                     | Purpose                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `leaderboard_ranks`       | Precomputed ranked leaderboard; historical/design cadence was each season every 2h |
| `arena.trader_stats`      | Point-in-time performance per (trader, timeframe) — primary write table            |
| `arena.traders`           | Trader identity registry, keyed by `(source_id, exchange_trader_id)`               |
| `trader_sources`          | Trader source identities (legacy serving + enrichment)                             |
| `trader_equity_curve`     | Historical equity curve data points per period                                     |
| `arena.position_history`  | Current ingest history facts; not rank-eligible without authority proof            |
| `trader_position_history` | Frozen forensic archive; no application reads and never ranking authority          |
| `trader_stats_detail`     | Advanced statistics (Sharpe, Sortino, Calmar, profit factor) per period            |
| `trader_asset_breakdown`  | Asset allocation analysis per period                                               |
| `trader_daily_snapshots`  | Frozen legacy daily rows; producer retired; never ranking authority                |
| `trader_portfolio`        | Current open positions                                                             |
| `trader_sources`          | Unique trader identities, keyed by `(source, source_trader_id)`                    |

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

| Table                        | Purpose                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------- |
| `pipeline_logs`              | Historical/source job-execution log schema (status, duration, record counts) |
| `pipeline_job_status` (View) | Historical/source latest-status view per job                                 |
| `pipeline_job_stats` (View)  | Historical/source 7-day success-rate and duration view                       |
| `subscriptions`              | Pro membership records                                                       |
| `stripe_customers`           | Stripe customer mapping                                                      |

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

Copy the example environment file for local development:

```bash
cp .env.example .env.local
```

Ask the owner for the smallest set of **non-production** values needed for the
specific local task. Do not request, copy, inspect, or use production credentials,
dashboard tokens, service-role keys, cron secrets, or host keys. The V1 default is
no production-service access; an owner may separately approve an exact read-only
evidence query.

Common local configuration names:

| Variable                        | Description                               |
| ------------------------------- | ----------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`      | Owner-provisioned local/dev project URL   |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Owner-provisioned local/dev anonymous key |
| `UPSTASH_REDIS_REST_URL`        | Local/dev cache endpoint when needed      |
| `UPSTASH_REDIS_REST_TOKEN`      | Local/dev cache token when needed         |
| `STRIPE_SECRET_KEY`             | Test-mode key when payment work needs it  |
| `STRIPE_WEBHOOK_SECRET`         | Test-mode webhook secret when needed      |

Optional local observability/search variables:

| Variable              | Description                                |
| --------------------- | ------------------------------------------ |
| `SENTRY_DSN`          | Local/dev error tracking when provisioned  |
| `MEILISEARCH_HOST`    | Local/dev search endpoint when provisioned |
| `MEILISEARCH_API_KEY` | Local/dev search key when provisioned      |

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

The named `check:*` diagnostics may contact public services or controlled read
credentials; they are not default local commands. Obtain the owner's prior approval
for the exact read-only evidence query before running one. Inventory results do not
authorize a backfill, cron invocation, migration, cache action, or production repair.
The legacy paths covered by the V1 tombstone contract (old health, local-recompute,
source-fetch, checkpoint, and legacy-backfill entrypoints) are compatibility
tombstones: they report `RETIRED` and exit 2, so they are not current diagnostic
evidence.

### Development and review workflow

Use an isolated branch or worktree, make and verify the local code change, then open
a Draft PR for review. A branch push, local build, preview, approval, or merge does
not authorize a production operation or establish deployed state.

## Deployment

Production release is currently suspended by the V1 NO-GO in
[`docs/RUNBOOK.md`](./docs/RUNBOOK.md). A pushed commit, preview, or local build is
not proof that production advanced. Do not invoke a manual production deployment,
migration, cache purge, or release promotion without the separately recorded owner
GO and release gates.

Production environment configuration and hosting control planes are owner-managed
and outside this guide. Do not open or alter them as part of V1 development.

### Scheduled jobs

The checked-in V1 source configuration contains **0 Vercel schedules**. This is not
a statement that a deployed control plane has changed. Do not invoke, alter, add, or
inspect a scheduler except through an owner-approved, exact read-only evidence
request.

### Infrastructure

| Component                  | V1 boundary                                                                    |
| -------------------------- | ------------------------------------------------------------------------------ |
| **Vercel**                 | Owner-controlled; no deployment or control-plane action                        |
| **Managed services**       | No direct operation; only owner-approved, exact read-only evidence             |
| **OpenClaw compatibility** | Retired/report-only; no auto-fix, backfill, or release authority               |
| **Source routing code**    | Local review only; no proxy, worker, or host operation from this documentation |

### Monitoring

- Owner-approved, query-specific read-only evidence only
- Local test output and code review do not establish production state
- Alerts and monitors are observations, not remediation authority

### Key Metrics

| Metric                            | Value                 |
| --------------------------------- | --------------------- |
| Ingest Adapters                   | 26 registered         |
| Cron/worker route implementations | 53 (not V1-scheduled) |
| V1 Vercel schedule plan           | 0                     |
| UI Languages                      | 4 (en/zh/ja/ko)       |

## License

All rights reserved. Copyright 2026 Arena.
