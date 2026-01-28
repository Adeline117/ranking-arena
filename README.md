# Arena

A cryptocurrency trader leaderboard and community platform. Aggregates copy trading data from 20+ CEX/DEX exchanges and DeFi protocols, providing transparent trader rankings and community discussion features.

---

## Table of Contents

- [Features](#features)
- [Supported Exchanges and Protocols](#supported-exchanges-and-protocols)
- [Tech Stack](#tech-stack)
- [System Architecture](#system-architecture)
- [Project Structure](#project-structure)
- [Quick Start](#quick-start)
- [Environment Variables](#environment-variables)
- [Database Setup](#database-setup)
- [Development Guide](#development-guide)
- [Testing](#testing)
- [Data Scraping System](#data-scraping-system)
- [Cron Jobs](#cron-jobs)
- [Deployment](#deployment)
- [API Documentation](#api-documentation)
- [Performance Optimization](#performance-optimization)
- [Security Features](#security-features)
- [Mobile Support](#mobile-support)
- [License](#license)

---

## Recent Updates

### v2.1 - January 26, 2026

**Platform Type Definition Updates:**
- Added `okx_futures` platform type to GRANULAR_PLATFORMS
- Added `okx_web3` platform type to GRANULAR_PLATFORMS
- Added PLATFORM_CATEGORY classification mapping for new platforms
- Added PLATFORM_RATE_LIMITS rate limiting configuration for new platforms

**Cron Job Configuration:**
- Added OKX Futures scheduled scraping task (runs every 4 hours)
- Added Weex scheduled scraping task (runs every 4 hours, offset by 5 minutes)
- Updated PLATFORM_SCRIPTS configuration in lib/cron/utils.ts
- Supports 7D/30D/90D time period data scraping

**Data Scraping Scripts:**
- Added scripts/import/import_okx_futures.mjs - OKX Futures copy trading leaderboard scraping
- Added scripts/import/import_hyperliquid.mjs - Hyperliquid DEX leaderboard scraping
- Added scripts/import/import_dydx.mjs - dYdX DEX leaderboard scraping
- OKX Futures API integration: Uses public API to fetch trader data
- Arena Score calculation: Comprehensive scoring based on ROI, drawdown, and win rate

### v2.0 - January 2026

**New Exchange Support:**
- HTX (Huobi) - Futures copy trading leaderboard, supports 7D/30D/90D periods
- Weex - Futures copy trading leaderboard, supports 7D/30D/90D periods
- Hyperliquid - L1 perpetual DEX leaderboard (requires Puppeteer scraping)
- dYdX - Perpetual DEX leaderboard (requires Puppeteer scraping)
- Uniswap - Spot trading leaderboard (via Dune Analytics)

**DeFi Data Integration:**
- Dune Analytics connector - On-chain data aggregation
- GMX / Hyperliquid / Uniswap on-chain leaderboards
- Nansen wallet analysis integration

**Architecture Upgrades:**
- Unified connector architecture (`connectors/`) - Standardized data source integration
- Cloudflare Worker proxy - Bypasses exchange IP restrictions
- Atomic counter functions - Prevents concurrent race conditions
- Rankings API optimization - Better filtering and sorting

**Mobile Improvements:**
- PullToRefresh pull-to-refresh component
- Push notification API
- Responsive CSS optimization

---

## Features

### Core Features

- **Multi-Exchange Leaderboard** - Aggregates Copy Trading data from major exchanges
- **Arena Score Rating System** - Comprehensive evaluation of trader's profit ability and risk control
  - Return Score (85%): Based on annualized return intensity, using tanh function to smooth extreme values
  - Drawdown Score (8%): Based on max drawdown risk, thresholds adjusted by time period
  - Stability Score (7%): Based on win rate stability, 45%-70% range mapping
- **Multiple Time Dimensions** - Supports 7-day/30-day/90-day ROI comparison
- **Trader Details** - Performance stats, history, position distribution, equity curve

### Community Features

- **Post System** - Post, comment, like, vote
- **Group Discussion** - Create and manage discussion groups
- **Favorites** - Bookmark traders and posts
- **Follow System** - Follow traders and users
- **Messaging System** - Private messages and notifications
- **Translation** - Automatic Chinese-English translation

### Advanced Features

- **Exchange Account Binding** - Bind exchange account to unlock more data
- **Trader Claiming** - Traders can claim their own accounts
- **Risk Alerts** - Monitor followed traders for abnormal changes
- **Portfolio Suggestions** - Trader portfolio recommendations based on risk preference
- **Premium Subscription** - Unlock premium features
- **Cloudflare Worker Proxy** - Bypasses exchange IP restrictions
- **Mobile Push Notifications** - Real-time trader updates

---

## Supported Exchanges and Protocols

### CEX Futures Exchanges

| Exchange | Platform ID | Data Source | Scrape Frequency | Supported Periods |
|----------|-------------|-------------|------------------|-------------------|
| Binance | binance_futures | Public API | Every 4 hours | 7D/30D/90D |
| Bybit | bybit | Public API | Every 4 hours | 7D/30D/90D |
| Bitget | bitget_futures | Public API | Every 4 hours | 7D/30D/90D |
| OKX | okx_futures | Public API | Every 4 hours | 7D/30D/90D |
| MEXC | mexc | Public API | Every 4 hours | 7D/30D/90D |
| HTX (Huobi) | htx_futures | Public API | Every 4 hours | 7D/30D/90D |
| KuCoin | kucoin | Public API | Every 4 hours | 7D/30D/90D |
| CoinEx | coinex | Public API | Every 4 hours | 7D/30D/90D |
| Weex | weex | Public API | Every 4 hours | 7D/30D/90D |
| BitMart | bitmart | Public API | Every 4 hours | 7D/30D/90D |
| Phemex | phemex | Public API | Every 4 hours | 7D/30D/90D |
| LBank | lbank | Public API | Every 4 hours | 7D/30D/90D |
| BloFin | blofin | Public API | Every 4 hours | 7D/30D/90D |

### CEX Spot Exchanges

| Exchange | Platform ID | Data Source | Scrape Frequency | Supported Periods |
|----------|-------------|-------------|------------------|-------------------|
| Binance | binance_spot | Public API | Every 4 hours | 7D/30D/90D |
| Bitget | bitget_spot | Public API | Every 4 hours | 7D/30D/90D |

### DeFi / On-chain Protocols

| Protocol | Platform ID | Data Source | Scrape Frequency | Notes |
|----------|-------------|-------------|------------------|-------|
| GMX | gmx | Arbitrum On-chain | Every 4 hours | Arbitrum perpetual contract protocol |
| Hyperliquid | hyperliquid | L1 API | Every 4 hours | L1 perpetual DEX, requires Puppeteer |
| dYdX | dydx | dYdX API | Every 4 hours | Perpetual DEX, v4 version |
| Gains Network | gains | Arbitrum On-chain | Every 4 hours | Arbitrum perpetual protocol |
| Uniswap | dune_uniswap | Dune Analytics | Every 6 hours | Spot DEX trading leaderboard |

### Web3 Wallets

| Platform | Platform ID | Data Source | Scrape Frequency | Notes |
|----------|-------------|-------------|------------------|-------|
| Binance Web3 | binance_web3 | Binance API | Every 4 hours | Binance Web3 wallet leaderboard |
| OKX Web3 | okx_web3 | OKX API | Every 4 hours | OKX Web3 wallet leaderboard |

### On-chain Data Sources

| Data Source | Platform ID | Notes |
|-------------|-------------|-------|
| Dune Analytics GMX | dune_gmx | GMX on-chain trading leaderboard |
| Dune Analytics Hyperliquid | dune_hyperliquid | Hyperliquid on-chain trading leaderboard |
| Dune Analytics Uniswap | dune_uniswap | Uniswap trading leaderboard |
| Dune Analytics DeFi | dune_defi | Comprehensive DeFi leaderboard |
| Nansen | nansen | Wallet analysis and Smart Money tracking |

---

## Tech Stack

| Layer | Technology | Version | Notes |
|-------|------------|---------|-------|
| Frontend Framework | Next.js | 16 | App Router, Server Components, Turbopack |
| UI Library | React | 19 | Latest React features including Suspense and Server Components |
| Type System | TypeScript | 5 | Strict type checking, no any types |
| Styling | Tailwind CSS | 4 | Atomic CSS, responsive design |
| State Management | Zustand | 5 | Lightweight state management with persistence support |
| Data Fetching | SWR | Latest | Data caching, revalidation, optimistic updates |
| Form Validation | Zod | Latest | Schema validation, type inference |
| Charts | Lightweight Charts | Latest | Lightweight financial charts, equity curve display |
| Database | Supabase (PostgreSQL) | - | Managed database + Auth + Realtime + RLS |
| Cache | Upstash Redis | - | Distributed cache + rate limiting + session storage |
| Payments | Stripe | - | Subscription payments and tipping |
| Deployment | Vercel | - | Edge deployment + Serverless + Cron Jobs |
| Monitoring | Sentry | - | Error tracking + performance monitoring + session replay |
| Scraping | Puppeteer | - | Headless browser data scraping, supports Stealth mode |
| Proxy | Cloudflare Worker | - | Bypasses exchange IP restrictions |

---

## System Architecture

```
                         Client (Browser / Mobile / Capacitor App)
                                           |
                                           v
                              Cloudflare CDN / Edge Cache
                                           |
                                           v
                              Next.js Middleware Layer
                     (Auth / CORS / CSP / CSRF / IP Rate Limiting)
                                           |
                                           v
                                     API Route Layer
                       (withApiMiddleware unified wrapper / versioning)
                                           |
               +---------------+-----------+-----------+---------------+
               |               |           |           |               |
               v               v           v           v               v
          Supabase        Upstash      External     Stripe      Cloudflare
        (PostgreSQL)      (Redis)        APIs      (Payments)     Worker
               |               |           |                      (Proxy)
               v               v           |
          Realtime         Rate          |
          WebSocket       Limiter        |
                                         v
                              +-------------------+
                              | Exchange API List |
                              +-------------------+
                              | Binance API       |
                              | Bybit API         |
                              | Bitget API        |
                              | OKX API           |
                              | MEXC API          |
                              | HTX API           |
                              | KuCoin API        |
                              | CoinEx API        |
                              | Weex API          |
                              | GMX (Arbitrum)    |
                              | Hyperliquid API   |
                              | dYdX API          |
                              | Dune Analytics    |
                              +-------------------+
```

### Data Flow

1. **Trader Data Sync Process**:
   - Vercel Cron triggers scheduled task every 4 hours
   - Calls `/api/cron/fetch-traders/[platform]` endpoint
   - Executes corresponding scraping script (scripts/import/import_*.mjs)
   - Cleans and standardizes data, calculates Arena Score
   - Stores in trader_snapshots and trader_sources tables

2. **User Request Flow**:
   - Request arrives -> Middleware (Auth/Rate Limit/CSRF)
   - API Handler processes -> Data layer (Supabase + Redis cache)
   - Response returns -> CDN cache

3. **Real-time Updates**:
   - Supabase Realtime WebSocket push
   - Real-time updates for posts, comments, notifications

---

## Project Structure

```
ranking-arena/
├── app/                              # Next.js App Router
│   ├── api/                          # API routes (120+ endpoints)
│   │   ├── traders/                  # Trader-related APIs
│   │   ├── posts/                    # Post-related APIs
│   │   ├── groups/                   # Group-related APIs
│   │   ├── rankings/                 # Leaderboard APIs
│   │   ├── exchange/                 # Exchange binding APIs
│   │   ├── cron/                     # Scheduled task APIs
│   │   └── stripe/                   # Payment-related APIs
│   │
│   ├── components/                   # React components
│   │   ├── Base/                     # Base components (Button, Text, Box)
│   │   ├── UI/                       # UI components (Card, Modal, Toast, Skeleton)
│   │   ├── Trader/                   # Trader-related components
│   │   ├── Features/                 # Feature components (RankingTable, EnhancedSearch)
│   │   ├── Charts/                   # Chart components (EquityChart, PnLChart)
│   │   ├── Home/                     # Homepage components (StatsBar, FeedPage)
│   │   ├── Providers/                # Context Providers (Language, Theme)
│   │   └── Layout/                   # Layout components (TopNav, MobileBottomNav)
│   │
│   ├── trader/[handle]/              # Trader detail page
│   ├── rankings/                     # Leaderboard page
│   ├── groups/                       # Group features
│   ├── compare/                      # Trader comparison
│   ├── hot/                          # Hot traders
│   ├── search/                       # Search page
│   └── u/[handle]/                   # User profile
│
├── connectors/                       # Data connectors (unified interface)
│   ├── base/                         # Base connector interface and types
│   ├── binance/                      # Binance connector
│   ├── bybit/                        # Bybit connector
│   ├── bitget/                       # Bitget connector
│   ├── okx/                          # OKX connector
│   ├── mexc/                         # MEXC connector
│   ├── htx/                          # HTX (Huobi) connector
│   ├── kucoin/                       # KuCoin connector
│   ├── gmx/                          # GMX connector (Arbitrum)
│   ├── hyperliquid/                  # Hyperliquid connector
│   ├── dydx/                         # dYdX connector
│   └── dune/                         # Dune Analytics connector
│
├── cloudflare-worker/                # Cloudflare Worker proxy service
│
├── lib/                              # Shared libraries
│   ├── api/                          # API tools
│   ├── cron/                         # Cron task tools
│   ├── hooks/                        # React Hooks
│   ├── stores/                       # Zustand Stores
│   ├── supabase/                     # Supabase client
│   ├── utils/                        # Utility functions
│   ├── types/                        # TypeScript types
│   └── design-tokens.ts              # Design system tokens
│
├── scripts/                          # Data scripts
│   └── import/                       # Data import scripts
│
├── worker/                           # Independent scraper service
├── supabase/                         # Database migrations
├── e2e/                              # E2E tests (Playwright)
├── stories/                          # Storybook component documentation
├── android/                          # Android native project (Capacitor)
├── ios/                              # iOS native project (Capacitor)
├── vercel.json                       # Vercel configuration (Cron Jobs)
└── package.json                      # Project dependencies
```

---

## Quick Start

### Requirements

- Node.js >= 20
- npm >= 10
- PostgreSQL (hosted via Supabase)

### Installation Steps

```bash
# Clone the project
git clone https://github.com/your-username/ranking-arena.git
cd ranking-arena

# Install dependencies
npm install

# Configure environment variables
cp .env.example .env.local
# Edit .env.local with required configuration

# Setup database
# Execute scripts/setup_all.sql in Supabase SQL Editor

# Start development server
npm run dev
```

Visit http://localhost:3000

---

## Environment Variables

Create a `.env.local` file and configure the following variables:

```bash
# Supabase (Required)
NEXT_PUBLIC_SUPABASE_URL=your-supabase-url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Upstash Redis Cache (Recommended)
UPSTASH_REDIS_REST_URL=your-upstash-redis-rest-url
UPSTASH_REDIS_REST_TOKEN=your-upstash-redis-rest-token

# Stripe Payments (Optional)
STRIPE_SECRET_KEY=your-stripe-secret-key
STRIPE_WEBHOOK_SECRET=your-stripe-webhook-secret
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=your-stripe-publishable-key

# Sentry Error Monitoring (Optional)
NEXT_PUBLIC_SENTRY_DSN=your-sentry-dsn
SENTRY_DSN=your-sentry-dsn

# Dune Analytics (Optional)
DUNE_API_KEY=your-dune-api-key

# Other Configuration
NEXT_PUBLIC_APP_URL=http://localhost:3000
CRON_SECRET=your-cron-secret
```

---

## Database Setup

### Initialize Database

Execute the following scripts in order in Supabase SQL Editor:

```bash
# Base table structure
scripts/setup_supabase_tables.sql
scripts/setup_community_tables.sql
scripts/setup_comment_system.sql

# Feature tables
scripts/setup_bookmark_folders.sql
scripts/setup_trader_follows.sql
scripts/setup_trader_alerts.sql
scripts/setup_user_messaging.sql

# Advanced features
scripts/setup_stripe_tables.sql
scripts/setup_arena_score.sql
scripts/setup_premium_groups.sql

# Or execute all at once
scripts/setup_all.sql
```

### Core Data Tables

| Table Name | Description | Key Fields |
|------------|-------------|------------|
| trader_sources | Trader source info | source, source_trader_id, handle, profile_url |
| trader_snapshots | Trader snapshot data | source, source_trader_id, season_id, roi, pnl, arena_score |
| trader_profiles | Trader details | platform, trader_key, display_name, avatar_url |
| posts | Posts | content, author_id, like_count, comment_count |
| comments | Comments | content, author_id, post_id, parent_id |
| groups | Groups | name, description, member_count |
| user_follows | User follows | follower_id, following_id |
| trader_follows | Trader follows | user_id, platform, trader_key |

---

## Development Guide

### Common Commands

```bash
# Development
npm run dev              # Start dev server (Turbopack)
npm run build            # Build production version
npm run start            # Start production server

# Code Quality
npm run lint             # ESLint check
npm run lint:fix         # ESLint auto-fix
npm run format           # Prettier formatting
npm run type-check       # TypeScript type check

# Testing
npm run test             # Run unit tests (Jest)
npm run test:watch       # Watch mode testing
npm run test:coverage    # Test coverage
npm run test:e2e         # Run E2E tests (Playwright)

# Component Documentation
npm run storybook        # Start Storybook
npm run build-storybook  # Build Storybook

# Analysis
npm run analyze          # Bundle size analysis
```

### Code Standards

- Use TypeScript strict mode, no any types
- Follow ESLint + Prettier rules
- Components use functional components + Hooks
- APIs use `withApiMiddleware` wrapper
- Data fetching uses SWR or Server Components
- Use design tokens from `lib/design-tokens.ts`

---

## Testing

### Unit Tests (Jest)

```bash
npm run test                    # Run all tests
npm run test -- --watch         # Watch mode
npm run test -- path/to/file    # Run specific file
```

Test file naming: `*.test.ts` or `*.test.tsx`

### E2E Tests (Playwright)

```bash
npm run test:e2e            # Run all E2E tests
npm run test:e2e:ui         # UI mode
npm run test:e2e:report     # View test report
```

E2E test coverage:
- Homepage loading
- Authentication flow
- Post features
- Group features
- Search features
- Trader details
- Leaderboard filtering

---

## Data Scraping System

### Manual Scraping

```bash
# CEX Exchanges
node scripts/import/import_binance_futures_api.mjs 90D
node scripts/import/import_bybit.mjs 90D
node scripts/import/import_okx_futures.mjs ALL
node scripts/import/import_htx.mjs 90D
node scripts/import/import_weex.mjs 90D

# DeFi / On-chain
node scripts/import/import_gmx.mjs 30D
node scripts/import/import_hyperliquid.mjs 90D
node scripts/import/import_dydx.mjs 90D
```

### Arena Score Calculation Algorithm

```javascript
// Parameter configuration (adjusted by period)
const PARAMS = {
  '7D':  { tanhCoeff: 0.08, roiExponent: 1.8, mddThreshold: 15, winRateCap: 62 },
  '30D': { tanhCoeff: 0.15, roiExponent: 1.6, mddThreshold: 30, winRateCap: 68 },
  '90D': { tanhCoeff: 0.18, roiExponent: 1.6, mddThreshold: 40, winRateCap: 70 },
}

// Calculation formula
Return Score = 85 * tanh(coeff * intensity)^exponent
Drawdown Score = 8 * (1 - |maxDrawdown| / threshold)
Stability Score = 7 * (winRate - 45) / (cap - 45)

Arena Score = Return Score + Drawdown Score + Stability Score
```

---

## Cron Jobs

### Task Configuration (vercel.json)

| Task Path | Schedule | Description |
|-----------|----------|-------------|
| /api/cron/fetch-traders/binance_futures | 0 */4 * * * | Binance Futures, every 4 hours |
| /api/cron/fetch-traders/bybit | 5 */4 * * * | Bybit, every 4 hours |
| /api/cron/fetch-traders/bitget_futures | 10 */4 * * * | Bitget Futures, every 4 hours |
| /api/cron/fetch-traders/okx_futures | 0 */4 * * * | OKX Futures, every 4 hours |
| /api/cron/fetch-traders/mexc | 30 */4 * * * | MEXC, every 4 hours |
| /api/cron/fetch-traders/htx | 55 */4 * * * | HTX, every 4 hours |
| /api/cron/fetch-traders/weex | 5 */4 * * * | Weex, every 4 hours |
| /api/cron/fetch-traders/gmx | 50 */4 * * * | GMX, every 4 hours |
| /api/cron/fetch-details | 30 */2 * * * | Trader details, every 2 hours |
| /api/cron/refresh-hot-scores | */5 * * * * | Hot score refresh, every 5 minutes |

### Circuit Breaker Mechanism

Cron tasks integrate circuit breaker protection:

- Failure threshold: Circuit breaks after 3 consecutive failures
- Recovery threshold: Recovers after 1 success
- Timeout: Attempts recovery after 5 minutes
- States: CLOSED -> OPEN -> HALF_OPEN -> CLOSED

---

## Deployment

### Vercel Deployment

1. Fork the repository to GitHub
2. Import project in Vercel
3. Configure environment variables
4. Deployment complete

Automatic deployment:
- Push to `main` branch -> Production environment
- Pull Request -> Preview environment

---

## API Documentation

APIs follow RESTful design, main endpoints:

### Rankings API

```
GET /api/rankings

Query Parameters:
- window: Time window (required) - '7d' | '30d' | '90d'
- platform: Platform filter (optional) - 'binance_futures' | 'okx_futures' | 'weex' | ...
- category: Category filter (optional) - 'futures' | 'spot' | 'onchain'
- sort_by: Sort field (optional) - 'arena_score' | 'roi' | 'pnl' | 'drawdown' | 'copiers'
- sort_dir: Sort direction (optional) - 'asc' | 'desc'
- limit: Return count (optional) - default 100, max 500
- offset: Offset (optional) - default 0

Response:
{
  "traders": [...],
  "window": "90D",
  "total_count": 425,
  "as_of": "2026-01-26T10:00:00Z",
  "is_stale": false
}
```

### Trader APIs

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/traders | Get trader list |
| GET | /api/traders/[handle] | Get trader details |
| GET | /api/traders/[handle]/positions | Get position info |
| GET | /api/traders/[handle]/equity | Get equity curve |
| POST | /api/traders/claim | Claim trader account |

### Post APIs

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/posts | Get post list |
| POST | /api/posts | Create post |
| GET | /api/posts/[id] | Get post details |
| POST | /api/posts/[id]/like | Like/unlike |
| POST | /api/posts/[id]/comments | Post comment |

---

## Performance Optimization

### Caching Strategy

| Data Type | Cache Location | TTL | Configuration |
|-----------|----------------|-----|---------------|
| Trader list | Vercel CDN + Redis | 60s | s-maxage=60, stale-while-revalidate=300 |
| Post list | Vercel CDN | 30s | s-maxage=30, stale-while-revalidate=120 |
| Market data | Vercel CDN | 30s | s-maxage=30, stale-while-revalidate=60 |
| Leaderboard | Vercel CDN + Redis | 60s | s-maxage=60, stale-while-revalidate=300 |
| User profiles | Redis | 5m | - |
| Static assets | CDN | 1 year | - |

### Frontend Optimization

- Lazy image loading (LazyImage component)
- Virtual scroll list (VirtualList component)
- Page transition animations
- Service Worker offline cache
- Bundle size optimization (optimizePackageImports)
- Skeleton loading screens

### Expected Performance Metrics

| Metric | Target |
|--------|--------|
| Homepage LCP | < 1.5s |
| First Input Delay (FID) | < 50ms |
| Cumulative Layout Shift (CLS) | < 0.1 |
| API Response Time (P95) | < 200ms |

---

## Security Features

| Measure | Implementation | Description |
|---------|----------------|-------------|
| XSS Protection | DOMPurify | Content sanitization |
| CSRF Protection | Double Submit Cookie | Prevents cross-site request forgery |
| Rate Limiting | Upstash Ratelimit | Prevents API abuse |
| CSP | Content Security Policy | Content security policy |
| Sensitive Data Encryption | AES-256-GCM | Encrypted storage for API keys etc. |
| RLS | Row Level Security | Database access control |
| Input Validation | Zod | Schema validation |

### API Rate Limiting Configuration

| API Type | Limit |
|----------|-------|
| Public API | 150/min |
| Authenticated API | 300/min |
| Write Operations | 50/min |
| Read API | 500/min |
| Search API | 60/min |

---

## Mobile Support

The project uses Capacitor to support native mobile apps:

### Configuration

```json
{
  "appId": "com.arenafi.app",
  "appName": "Arena",
  "webDir": "public"
}
```

### Build

```bash
# Android
npx cap add android
npx cap sync android
npx cap open android

# iOS
npx cap add ios
npx cap sync ios
npx cap open ios
```

---

## Related Documentation

- [System Architecture](docs/ARCHITECTURE.md) - Detailed architecture
- [Arena Score Algorithm](docs/ARENA_SCORE_METHODOLOGY.md) - Scoring algorithm details
- [Supabase Setup](docs/SUPABASE_SETUP.md) - Database configuration guide
- [Performance Optimization](docs/OPTIMIZATION_SUMMARY.md) - Optimization summary
- [CLAUDE.md](CLAUDE.md) - AI assistant development guide

---

## Contributing

1. Fork the project
2. Create feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Create Pull Request

---

## License

MIT License

---

For questions or suggestions, please contact Adelinewen1107@outlook.com

---
---

# Arena (中文版)

加密货币交易员排行榜与社区平台。聚合 20+ CEX/DEX 交易所和 DeFi 协议的跟单数据，提供透明的交易员排名和社区讨论功能。

---

## 目录

- [功能特性](#功能特性)
- [支持的交易所和协议](#支持的交易所和协议)
- [技术栈](#技术栈)
- [系统架构](#系统架构)
- [项目结构](#项目结构)
- [快速开始](#快速开始)
- [环境变量配置](#环境变量配置)
- [数据库设置](#数据库设置)
- [开发指南](#开发指南)
- [测试](#测试)
- [数据抓取系统](#数据抓取系统)
- [Cron 定时任务](#cron-定时任务)
- [部署](#部署)
- [API 文档](#api-文档)
- [性能优化](#性能优化)
- [安全特性](#安全特性)
- [移动端支持](#移动端支持)
- [许可证](#许可证)

---

## 最近更新

### v2.1 - 2026年1月26日

**平台类型定义更新:**
- 新增 `okx_futures` 平台类型到 GRANULAR_PLATFORMS
- 新增 `okx_web3` 平台类型到 GRANULAR_PLATFORMS
- 新增 PLATFORM_CATEGORY 分类映射
- 新增 PLATFORM_RATE_LIMITS 限流配置

**Cron 定时任务配置:**
- 新增 OKX Futures 定时抓取任务（每4小时执行）
- 新增 Weex 定时抓取任务（每4小时执行，偏移5分钟）
- 更新 lib/cron/utils.ts 中的 PLATFORM_SCRIPTS 配置
- 支持 7D/30D/90D 时间周期数据抓取

**数据抓取脚本:**
- 新增 scripts/import/import_okx_futures.mjs - OKX 合约跟单排行榜抓取
- 新增 scripts/import/import_hyperliquid.mjs - Hyperliquid DEX 排行榜抓取
- 新增 scripts/import/import_dydx.mjs - dYdX DEX 排行榜抓取
- OKX Futures API 集成：使用公开 API 获取交易员数据
- Arena Score 计算：基于 ROI、回撤、胜率的综合评分

### v2.0 - 2026年1月

**新增交易所支持:**
- HTX (火币) - 合约跟单排行榜，支持 7D/30D/90D 周期
- Weex - 合约跟单排行榜，支持 7D/30D/90D 周期
- Hyperliquid - L1 永续 DEX 排行榜（需要 Puppeteer 抓取）
- dYdX - 永续 DEX 排行榜（需要 Puppeteer 抓取）
- Uniswap - 现货交易排行榜（通过 Dune Analytics）

**DeFi 数据集成:**
- Dune Analytics 连接器 - 链上数据聚合
- GMX / Hyperliquid / Uniswap 链上排行榜
- Nansen 钱包分析集成

**架构升级:**
- 统一连接器架构 (`connectors/`) - 标准化数据源接入
- Cloudflare Worker 代理 - 绕过交易所 IP 限制
- 原子计数器函数 - 防止并发竞态条件
- 排行榜 API 优化 - 更好的过滤和排序

**移动端改进:**
- PullToRefresh 下拉刷新组件
- 推送通知 API
- 响应式 CSS 优化

---

## 功能特性

### 核心功能

- **多交易所排行榜** - 聚合主流交易所的 Copy Trading 数据
- **Arena Score 评分系统** - 综合评估交易员的盈利能力和风险控制
  - 收益分数 (85%): 基于年化收益强度，使用 tanh 函数平滑极端值
  - 回撤分数 (8%): 基于最大回撤风险，阈值按时间周期调整
  - 稳定性分数 (7%): 基于胜率稳定性，45%-70% 区间映射
- **多时间维度** - 支持 7天/30天/90天 收益率对比
- **交易员详情** - 业绩统计、历史记录、持仓分布、权益曲线

### 社区功能

- **帖子系统** - 发帖、评论、点赞、投票
- **小组讨论** - 创建和管理讨论小组
- **收藏夹** - 收藏交易员和帖子
- **关注系统** - 关注交易员和用户
- **消息系统** - 私信和通知
- **翻译功能** - 自动中英文翻译

### 高级功能

- **交易所账户绑定** - 绑定交易所账户解锁更多数据
- **交易员认领** - 交易员可认领自己的账户
- **风险提醒** - 监控关注的交易员异常变化
- **组合建议** - 根据风险偏好推荐交易员组合
- **Premium 订阅** - 解锁高级功能
- **Cloudflare Worker 代理** - 绕过交易所 IP 限制
- **移动端推送通知** - 实时交易员动态更新

---

## 支持的交易所和协议

### CEX 期货交易所

| 交易所 | 平台 ID | 数据源 | 抓取频率 | 支持周期 |
|--------|---------|--------|----------|----------|
| Binance | binance_futures | 公开 API | 每4小时 | 7D/30D/90D |
| Bybit | bybit | 公开 API | 每4小时 | 7D/30D/90D |
| Bitget | bitget_futures | 公开 API | 每4小时 | 7D/30D/90D |
| OKX | okx_futures | 公开 API | 每4小时 | 7D/30D/90D |
| MEXC | mexc | 公开 API | 每4小时 | 7D/30D/90D |
| HTX (火币) | htx_futures | 公开 API | 每4小时 | 7D/30D/90D |
| KuCoin | kucoin | 公开 API | 每4小时 | 7D/30D/90D |
| CoinEx | coinex | 公开 API | 每4小时 | 7D/30D/90D |
| Weex | weex | 公开 API | 每4小时 | 7D/30D/90D |
| BitMart | bitmart | 公开 API | 每4小时 | 7D/30D/90D |
| Phemex | phemex | 公开 API | 每4小时 | 7D/30D/90D |
| LBank | lbank | 公开 API | 每4小时 | 7D/30D/90D |
| BloFin | blofin | 公开 API | 每4小时 | 7D/30D/90D |

### CEX 现货交易所

| 交易所 | 平台 ID | 数据源 | 抓取频率 | 支持周期 |
|--------|---------|--------|----------|----------|
| Binance | binance_spot | 公开 API | 每4小时 | 7D/30D/90D |
| Bitget | bitget_spot | 公开 API | 每4小时 | 7D/30D/90D |

### DeFi / 链上协议

| 协议 | 平台 ID | 数据源 | 抓取频率 | 备注 |
|------|---------|--------|----------|------|
| GMX | gmx | Arbitrum 链上 | 每4小时 | Arbitrum 永续合约协议 |
| Hyperliquid | hyperliquid | L1 API | 每4小时 | L1 永续 DEX，需要 Puppeteer |
| dYdX | dydx | dYdX API | 每4小时 | 永续 DEX，v4 版本 |
| Gains Network | gains | Arbitrum 链上 | 每4小时 | Arbitrum 永续协议 |
| Uniswap | dune_uniswap | Dune Analytics | 每6小时 | 现货 DEX 交易排行榜 |

### Web3 钱包

| 平台 | 平台 ID | 数据源 | 抓取频率 | 备注 |
|------|---------|--------|----------|------|
| Binance Web3 | binance_web3 | Binance API | 每4小时 | Binance Web3 钱包排行榜 |
| OKX Web3 | okx_web3 | OKX API | 每4小时 | OKX Web3 钱包排行榜 |

### 链上数据源

| 数据源 | 平台 ID | 备注 |
|--------|---------|------|
| Dune Analytics GMX | dune_gmx | GMX 链上交易排行榜 |
| Dune Analytics Hyperliquid | dune_hyperliquid | Hyperliquid 链上交易排行榜 |
| Dune Analytics Uniswap | dune_uniswap | Uniswap 交易排行榜 |
| Dune Analytics DeFi | dune_defi | 综合 DeFi 排行榜 |
| Nansen | nansen | 钱包分析和 Smart Money 追踪 |

---

## 技术栈

| 层级 | 技术 | 版本 | 备注 |
|------|------|------|------|
| 前端框架 | Next.js | 16 | App Router, Server Components, Turbopack |
| UI 库 | React | 19 | 最新 React 特性，包括 Suspense 和 Server Components |
| 类型系统 | TypeScript | 5 | 严格类型检查，禁止 any 类型 |
| 样式 | Tailwind CSS | 4 | 原子化 CSS，响应式设计 |
| 状态管理 | Zustand | 5 | 轻量级状态管理，支持持久化 |
| 数据获取 | SWR | 最新 | 数据缓存、重新验证、乐观更新 |
| 表单验证 | Zod | 最新 | Schema 验证，类型推断 |
| 图表 | Lightweight Charts | 最新 | 轻量级金融图表，权益曲线展示 |
| 数据库 | Supabase (PostgreSQL) | - | 托管数据库 + Auth + Realtime + RLS |
| 缓存 | Upstash Redis | - | 分布式缓存 + 限流 + 会话存储 |
| 支付 | Stripe | - | 订阅支付和打赏 |
| 部署 | Vercel | - | 边缘部署 + Serverless + Cron Jobs |
| 监控 | Sentry | - | 错误追踪 + 性能监控 + 会话回放 |
| 抓取 | Puppeteer | - | 无头浏览器数据抓取，支持 Stealth 模式 |
| 代理 | Cloudflare Worker | - | 绕过交易所 IP 限制 |

---

## 系统架构

```
                         客户端 (浏览器 / 移动端 / Capacitor App)
                                           |
                                           v
                              Cloudflare CDN / Edge Cache
                                           |
                                           v
                              Next.js 中间件层
                     (Auth / CORS / CSP / CSRF / IP 限流)
                                           |
                                           v
                                     API Route 层
                       (withApiMiddleware 统一包装 / 版本控制)
                                           |
               +---------------+-----------+-----------+---------------+
               |               |           |           |               |
               v               v           v           v               v
          Supabase        Upstash      外部         Stripe      Cloudflare
        (PostgreSQL)      (Redis)      APIs       (支付)        Worker
               |               |           |                      (代理)
               v               v           |
          Realtime         Rate          |
          WebSocket       Limiter        |
                                         v
                              +-------------------+
                              | 交易所 API 列表    |
                              +-------------------+
                              | Binance API       |
                              | Bybit API         |
                              | Bitget API        |
                              | OKX API           |
                              | MEXC API          |
                              | HTX API           |
                              | KuCoin API        |
                              | CoinEx API        |
                              | Weex API          |
                              | GMX (Arbitrum)    |
                              | Hyperliquid API   |
                              | dYdX API          |
                              | Dune Analytics    |
                              +-------------------+
```

### 数据流

1. **交易员数据同步流程**:
   - Vercel Cron 每4小时触发定时任务
   - 调用 `/api/cron/fetch-traders/[platform]` 端点
   - 执行对应的抓取脚本 (scripts/import/import_*.mjs)
   - 清洗和标准化数据，计算 Arena Score
   - 存储到 trader_snapshots 和 trader_sources 表

2. **用户请求流程**:
   - 请求到达 -> 中间件 (Auth/限流/CSRF)
   - API Handler 处理 -> 数据层 (Supabase + Redis 缓存)
   - 响应返回 -> CDN 缓存

3. **实时更新**:
   - Supabase Realtime WebSocket 推送
   - 帖子、评论、通知的实时更新

---

## 项目结构

```
ranking-arena/
├── app/                              # Next.js App Router
│   ├── api/                          # API 路由 (120+ 端点)
│   │   ├── traders/                  # 交易员相关 API
│   │   ├── posts/                    # 帖子相关 API
│   │   ├── groups/                   # 小组相关 API
│   │   ├── rankings/                 # 排行榜 API
│   │   ├── exchange/                 # 交易所绑定 API
│   │   ├── cron/                     # 定时任务 API
│   │   └── stripe/                   # 支付相关 API
│   │
│   ├── components/                   # React 组件
│   │   ├── Base/                     # 基础组件 (Button, Text, Box)
│   │   ├── UI/                       # UI 组件 (Card, Modal, Toast, Skeleton)
│   │   ├── Trader/                   # 交易员相关组件
│   │   ├── Features/                 # 功能组件 (RankingTable, EnhancedSearch)
│   │   ├── Charts/                   # 图表组件 (EquityChart, PnLChart)
│   │   ├── Home/                     # 首页组件 (StatsBar, FeedPage)
│   │   ├── Providers/                # Context Providers (Language, Theme)
│   │   └── Layout/                   # 布局组件 (TopNav, MobileBottomNav)
│   │
│   ├── trader/[handle]/              # 交易员详情页
│   ├── rankings/                     # 排行榜页面
│   ├── groups/                       # 小组功能
│   ├── compare/                      # 交易员对比
│   ├── hot/                          # 热门交易员
│   ├── search/                       # 搜索页面
│   └── u/[handle]/                   # 用户主页
│
├── connectors/                       # 数据连接器 (统一接口)
│   ├── base/                         # 基础连接器接口和类型
│   ├── binance/                      # Binance 连接器
│   ├── bybit/                        # Bybit 连接器
│   ├── bitget/                       # Bitget 连接器
│   ├── okx/                          # OKX 连接器
│   ├── mexc/                         # MEXC 连接器
│   ├── htx/                          # HTX (火币) 连接器
│   ├── kucoin/                       # KuCoin 连接器
│   ├── gmx/                          # GMX 连接器 (Arbitrum)
│   ├── hyperliquid/                  # Hyperliquid 连接器
│   ├── dydx/                         # dYdX 连接器
│   └── dune/                         # Dune Analytics 连接器
│
├── cloudflare-worker/                # Cloudflare Worker 代理服务
│
├── lib/                              # 共享库
│   ├── api/                          # API 工具
│   ├── cron/                         # Cron 任务工具
│   ├── hooks/                        # React Hooks
│   ├── stores/                       # Zustand Stores
│   ├── supabase/                     # Supabase 客户端
│   ├── utils/                        # 工具函数
│   ├── types/                        # TypeScript 类型
│   └── design-tokens.ts              # 设计系统 tokens
│
├── scripts/                          # 数据脚本
│   └── import/                       # 数据导入脚本
│
├── worker/                           # 独立抓取服务
├── supabase/                         # 数据库迁移
├── e2e/                              # E2E 测试 (Playwright)
├── stories/                          # Storybook 组件文档
├── android/                          # Android 原生项目 (Capacitor)
├── ios/                              # iOS 原生项目 (Capacitor)
├── vercel.json                       # Vercel 配置 (Cron Jobs)
└── package.json                      # 项目依赖
```

---

## 快速开始

### 环境要求

- Node.js >= 20
- npm >= 10
- PostgreSQL (通过 Supabase 托管)

### 安装步骤

```bash
# 克隆项目
git clone https://github.com/your-username/ranking-arena.git
cd ranking-arena

# 安装依赖
npm install

# 配置环境变量
cp .env.example .env.local
# 编辑 .env.local 填写必要配置

# 设置数据库
# 在 Supabase SQL Editor 中执行 scripts/setup_all.sql

# 启动开发服务器
npm run dev
```

访问 http://localhost:3000

---

## 环境变量配置

创建 `.env.local` 文件并配置以下变量：

```bash
# Supabase (必需)
NEXT_PUBLIC_SUPABASE_URL=your-supabase-url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# Upstash Redis 缓存 (推荐)
UPSTASH_REDIS_REST_URL=your-upstash-redis-rest-url
UPSTASH_REDIS_REST_TOKEN=your-upstash-redis-rest-token

# Stripe 支付 (可选)
STRIPE_SECRET_KEY=your-stripe-secret-key
STRIPE_WEBHOOK_SECRET=your-stripe-webhook-secret
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=your-stripe-publishable-key

# Sentry 错误监控 (可选)
NEXT_PUBLIC_SENTRY_DSN=your-sentry-dsn
SENTRY_DSN=your-sentry-dsn

# Dune Analytics (可选)
DUNE_API_KEY=your-dune-api-key

# 其他配置
NEXT_PUBLIC_APP_URL=http://localhost:3000
CRON_SECRET=your-cron-secret
```

---

## 数据库设置

### 初始化数据库

在 Supabase SQL Editor 中按顺序执行以下脚本：

```bash
# 基础表结构
scripts/setup_supabase_tables.sql
scripts/setup_community_tables.sql
scripts/setup_comment_system.sql

# 功能表
scripts/setup_bookmark_folders.sql
scripts/setup_trader_follows.sql
scripts/setup_trader_alerts.sql
scripts/setup_user_messaging.sql

# 高级功能
scripts/setup_stripe_tables.sql
scripts/setup_arena_score.sql
scripts/setup_premium_groups.sql

# 或者一次性执行
scripts/setup_all.sql
```

### 核心数据表

| 表名 | 描述 | 关键字段 |
|------|------|----------|
| trader_sources | 交易员来源信息 | source, source_trader_id, handle, profile_url |
| trader_snapshots | 交易员快照数据 | source, source_trader_id, season_id, roi, pnl, arena_score |
| trader_profiles | 交易员详细信息 | platform, trader_key, display_name, avatar_url |
| posts | 帖子 | content, author_id, like_count, comment_count |
| comments | 评论 | content, author_id, post_id, parent_id |
| groups | 小组 | name, description, member_count |
| user_follows | 用户关注 | follower_id, following_id |
| trader_follows | 交易员关注 | user_id, platform, trader_key |

---

## 开发指南

### 常用命令

```bash
# 开发
npm run dev              # 启动开发服务器 (Turbopack)
npm run build            # 构建生产版本
npm run start            # 启动生产服务器

# 代码质量
npm run lint             # ESLint 检查
npm run lint:fix         # ESLint 自动修复
npm run format           # Prettier 格式化
npm run type-check       # TypeScript 类型检查

# 测试
npm run test             # 运行单元测试 (Jest)
npm run test:watch       # 监听模式测试
npm run test:coverage    # 测试覆盖率
npm run test:e2e         # 运行 E2E 测试 (Playwright)

# 组件文档
npm run storybook        # 启动 Storybook
npm run build-storybook  # 构建 Storybook

# 分析
npm run analyze          # Bundle 大小分析
```

### 代码规范

- 使用 TypeScript 严格模式，禁止 any 类型
- 遵循 ESLint + Prettier 规则
- 组件使用函数式组件 + Hooks
- API 使用 `withApiMiddleware` 包装
- 数据获取使用 SWR 或 Server Components
- 使用 `lib/design-tokens.ts` 中的设计 tokens

---

## 测试

### 单元测试 (Jest)

```bash
npm run test                    # 运行所有测试
npm run test -- --watch         # 监听模式
npm run test -- path/to/file    # 运行特定文件
```

测试文件命名: `*.test.ts` 或 `*.test.tsx`

### E2E 测试 (Playwright)

```bash
npm run test:e2e            # 运行所有 E2E 测试
npm run test:e2e:ui         # UI 模式
npm run test:e2e:report     # 查看测试报告
```

E2E 测试覆盖:
- 首页加载
- 认证流程
- 帖子功能
- 小组功能
- 搜索功能
- 交易员详情
- 排行榜筛选

---

## 数据抓取系统

### 手动抓取

```bash
# CEX 交易所
node scripts/import/import_binance_futures_api.mjs 90D
node scripts/import/import_bybit.mjs 90D
node scripts/import/import_okx_futures.mjs ALL
node scripts/import/import_htx.mjs 90D
node scripts/import/import_weex.mjs 90D

# DeFi / 链上
node scripts/import/import_gmx.mjs 30D
node scripts/import/import_hyperliquid.mjs 90D
node scripts/import/import_dydx.mjs 90D
```

### Arena Score 计算算法

```javascript
// 参数配置 (按周期调整)
const PARAMS = {
  '7D':  { tanhCoeff: 0.08, roiExponent: 1.8, mddThreshold: 15, winRateCap: 62 },
  '30D': { tanhCoeff: 0.15, roiExponent: 1.6, mddThreshold: 30, winRateCap: 68 },
  '90D': { tanhCoeff: 0.18, roiExponent: 1.6, mddThreshold: 40, winRateCap: 70 },
}

// 计算公式
收益分数 = 85 * tanh(coeff * intensity)^exponent
回撤分数 = 8 * (1 - |maxDrawdown| / threshold)
稳定性分数 = 7 * (winRate - 45) / (cap - 45)

Arena Score = 收益分数 + 回撤分数 + 稳定性分数
```

---

## Cron 定时任务

### 任务配置 (vercel.json)

| 任务路径 | 调度 | 描述 |
|----------|------|------|
| /api/cron/fetch-traders/binance_futures | 0 */4 * * * | Binance Futures，每4小时 |
| /api/cron/fetch-traders/bybit | 5 */4 * * * | Bybit，每4小时 |
| /api/cron/fetch-traders/bitget_futures | 10 */4 * * * | Bitget Futures，每4小时 |
| /api/cron/fetch-traders/okx_futures | 0 */4 * * * | OKX Futures，每4小时 |
| /api/cron/fetch-traders/mexc | 30 */4 * * * | MEXC，每4小时 |
| /api/cron/fetch-traders/htx | 55 */4 * * * | HTX，每4小时 |
| /api/cron/fetch-traders/weex | 5 */4 * * * | Weex，每4小时 |
| /api/cron/fetch-traders/gmx | 50 */4 * * * | GMX，每4小时 |
| /api/cron/fetch-details | 30 */2 * * * | 交易员详情，每2小时 |
| /api/cron/refresh-hot-scores | */5 * * * * | 热度分数刷新，每5分钟 |

### 熔断器机制

Cron 任务集成熔断器保护：

- 失败阈值：连续3次失败后熔断
- 恢复阈值：1次成功后恢复
- 超时时间：5分钟后尝试恢复
- 状态：CLOSED -> OPEN -> HALF_OPEN -> CLOSED

---

## 部署

### Vercel 部署

1. Fork 仓库到 GitHub
2. 在 Vercel 中导入项目
3. 配置环境变量
4. 部署完成

自动部署：
- 推送到 `main` 分支 -> 生产环境
- Pull Request -> 预览环境

---

## API 文档

API 遵循 RESTful 设计，主要端点：

### 排行榜 API

```
GET /api/rankings

查询参数:
- window: 时间窗口 (必需) - '7d' | '30d' | '90d'
- platform: 平台过滤 (可选) - 'binance_futures' | 'okx_futures' | 'weex' | ...
- category: 类别过滤 (可选) - 'futures' | 'spot' | 'onchain'
- sort_by: 排序字段 (可选) - 'arena_score' | 'roi' | 'pnl' | 'drawdown' | 'copiers'
- sort_dir: 排序方向 (可选) - 'asc' | 'desc'
- limit: 返回数量 (可选) - 默认 100，最大 500
- offset: 偏移量 (可选) - 默认 0

响应:
{
  "traders": [...],
  "window": "90D",
  "total_count": 425,
  "as_of": "2026-01-26T10:00:00Z",
  "is_stale": false
}
```

### 交易员 API

| 方法 | 端点 | 描述 |
|------|------|------|
| GET | /api/traders | 获取交易员列表 |
| GET | /api/traders/[handle] | 获取交易员详情 |
| GET | /api/traders/[handle]/positions | 获取持仓信息 |
| GET | /api/traders/[handle]/equity | 获取权益曲线 |
| POST | /api/traders/claim | 认领交易员账户 |

### 帖子 API

| 方法 | 端点 | 描述 |
|------|------|------|
| GET | /api/posts | 获取帖子列表 |
| POST | /api/posts | 创建帖子 |
| GET | /api/posts/[id] | 获取帖子详情 |
| POST | /api/posts/[id]/like | 点赞/取消点赞 |
| POST | /api/posts/[id]/comments | 发表评论 |

---

## 性能优化

### 缓存策略

| 数据类型 | 缓存位置 | TTL | 配置 |
|----------|----------|-----|------|
| 交易员列表 | Vercel CDN + Redis | 60s | s-maxage=60, stale-while-revalidate=300 |
| 帖子列表 | Vercel CDN | 30s | s-maxage=30, stale-while-revalidate=120 |
| 市场数据 | Vercel CDN | 30s | s-maxage=30, stale-while-revalidate=60 |
| 排行榜 | Vercel CDN + Redis | 60s | s-maxage=60, stale-while-revalidate=300 |
| 用户资料 | Redis | 5m | - |
| 静态资源 | CDN | 1年 | - |

### 前端优化

- 图片懒加载 (LazyImage 组件)
- 虚拟滚动列表 (VirtualList 组件)
- 页面过渡动画
- Service Worker 离线缓存
- Bundle 大小优化 (optimizePackageImports)
- 骨架屏加载

### 预期性能指标

| 指标 | 目标 |
|------|------|
| 首页 LCP | < 1.5s |
| First Input Delay (FID) | < 50ms |
| Cumulative Layout Shift (CLS) | < 0.1 |
| API 响应时间 (P95) | < 200ms |

---

## 安全特性

| 措施 | 实现 | 描述 |
|------|------|------|
| XSS 防护 | DOMPurify | 内容净化 |
| CSRF 防护 | Double Submit Cookie | 防止跨站请求伪造 |
| 限流 | Upstash Ratelimit | 防止 API 滥用 |
| CSP | Content Security Policy | 内容安全策略 |
| 敏感数据加密 | AES-256-GCM | API Key 等加密存储 |
| RLS | Row Level Security | 数据库访问控制 |
| 输入验证 | Zod | Schema 验证 |

### API 限流配置

| API 类型 | 限制 |
|----------|------|
| 公开 API | 150/分钟 |
| 认证 API | 300/分钟 |
| 写操作 | 50/分钟 |
| 读取 API | 500/分钟 |
| 搜索 API | 60/分钟 |

---

## 移动端支持

项目使用 Capacitor 支持原生移动应用：

### 配置

```json
{
  "appId": "com.arenafi.app",
  "appName": "Arena",
  "webDir": "public"
}
```

### 构建

```bash
# Android
npx cap add android
npx cap sync android
npx cap open android

# iOS
npx cap add ios
npx cap sync ios
npx cap open ios
```

---

## 相关文档

- [系统架构](docs/ARCHITECTURE.md) - 详细架构说明
- [Arena Score 算法](docs/ARENA_SCORE_METHODOLOGY.md) - 评分算法详解
- [Supabase 设置](docs/SUPABASE_SETUP.md) - 数据库配置指南
- [性能优化](docs/OPTIMIZATION_SUMMARY.md) - 优化总结
- [CLAUDE.md](CLAUDE.md) - AI 助手开发指南

---

## 贡献指南

1. Fork 项目
2. 创建功能分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 创建 Pull Request

---

## 许可证

MIT License

---

如有问题或建议，请联系 Adelinewen1107@outlook.com
