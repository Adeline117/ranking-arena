# Architecture

## Overview

Ranking Arena is a **Next.js 16** application that aggregates copy trading data from 20+ exchanges/protocols into a unified trader leaderboard. It runs on Vercel with Supabase as the primary database.

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│   Browser    │────▶│  Next.js App │────▶│    Supabase      │
│  (React 19)  │     │  (Vercel)    │     │  (PostgreSQL)    │
└─────────────┘     └──────┬───────┘     └─────────────────┘
                           │                       ▲
                    ┌──────▼───────┐               │
                    │  Cron Jobs   │───────────────┘
                    │  (QStash)    │
                    └──────┬───────┘
                           │
              ┌────────────▼────────────┐
              │   Exchange Connectors    │
              │  (Binance, Bybit, OKX,  │
              │   HTX, Hyperliquid...)   │
              └────────────┬────────────┘
                           │
                    ┌──────▼───────┐
                    │  CF Worker   │
                    │  (Proxy)     │
                    └──────────────┘
```

## Data Flow

1. **Scraping**: Cron jobs (Upstash QStash) trigger `/api/cron/*` endpoints on schedule
2. **Connectors** (`connectors/`): Each exchange has a connector that fetches trader data via API or Puppeteer scraping
3. **Proxy**: Cloudflare Worker proxies requests to bypass exchange IP restrictions
4. **Processing**: Data is normalized, scored (Arena Score algorithm in `lib/scoring/`), and stored in Supabase
5. **Serving**: Next.js Server Components fetch from Supabase with Redis caching (`lib/cache/`)
6. **Client**: React 19 with Zustand for state, TanStack Query for data fetching, Tailwind for UI

## Key Directories

```
app/                    # Next.js App Router pages & API routes
  api/                  # API endpoints (cron, rankings, auth, etc.)
  components/           # Shared UI components
  rankings/             # Rankings pages
  trader/               # Trader profile pages
  admin/                # Admin dashboard
connectors/             # Exchange data source connectors
lib/
  adapters/             # Exchange-specific data adapters
  cache/                # Redis caching layer
  cron/                 # Cron job utilities & scheduling config
  scoring/              # Arena Score algorithm
  supabase/             # Database client & queries
  ratelimit/            # Rate limiting (Upstash)
  security/             # Auth, CSRF, input sanitization
  web3/                 # Wallet connection (RainbowKit, wagmi)
  i18n/                 # Internationalization
  hooks/                # React hooks
  stores/               # Zustand stores
workers/                # Background worker scripts
scripts/                # Data import & maintenance scripts
e2e/                    # Playwright E2E tests
supabase/               # Database migrations
cloudflare-worker/      # CF Worker proxy
contracts/              # Solidity smart contracts
```

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Next.js 16 App Router** | Server Components reduce client bundle; streaming SSR for performance |
| **Supabase + RLS** | Row-Level Security for multi-tenant data; real-time subscriptions |
| **Upstash (Redis + QStash)** | Serverless-friendly caching and cron scheduling on Vercel |
| **Cloudflare Worker proxy** | Stable IP for exchange APIs that block Vercel's dynamic IPs |
| **Arena Score algorithm** | Composite score (ROI, drawdown, win rate, consistency) for fair ranking |
| **Zod validation** | Runtime type safety for all API inputs |
| **Design tokens** | Centralized theming via `lib/design-tokens.ts` for dark/light mode |
| **Capacitor** | Native iOS/Android apps from the same codebase |

## Infrastructure

- **Hosting**: Vercel (serverless)
- **Database**: Supabase (PostgreSQL)
- **Cache**: Upstash Redis
- **Cron**: Upstash QStash
- **Proxy**: Cloudflare Worker
- **Storage**: Cloudflare R2 (images, exports)
- **Auth**: Supabase Auth + Web3 wallet (SIWE)
- **Payments**: Stripe (Pro membership)
- **Monitoring**: Sentry
- **Analytics**: Vercel Analytics + Speed Insights
