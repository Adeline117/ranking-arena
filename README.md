<div align="center">

# Arena

**The definitive crypto trader ranking and community platform.**

[![Production](https://img.shields.io/badge/production-live-brightgreen)](https://www.arenafi.org)
[![Next.js](https://img.shields.io/badge/Next.js-16-black)](https://nextjs.org)
[![Traders](https://img.shields.io/badge/traders-32%2C000%2B-blue)]()
[![Exchanges](https://img.shields.io/badge/exchanges-27%2B-orange)]()

[Live Site](https://www.arenafi.org) | [Features](#features) | [Architecture](#architecture) | [Getting Started](#getting-started)

</div>

---

## Overview

Arena ranks and scores 32,000+ crypto traders across 27+ centralized and decentralized exchanges, delivering transparent, data-driven performance metrics to the trading community. With 60,000+ library items, real-time market data, and an active social layer, Arena is a comprehensive hub for serious traders.

## Features

### Trader Rankings

- **Arena Score V3** -- Percentile-based composite scoring system:
  - Risk Control: 40%
  - Profitability: 35%
  - Execution Quality: 25%
- Rankings across 27+ exchanges: Binance, OKX, Bybit, Bitget, MEXC, KuCoin, Gate.io, HTX, CoinEx, and DEX platforms including Hyperliquid, GMX, dYdX, Jupiter, Vertex, Drift, and more
- Real-time trade feed with live position tracking

### Market Overview

- TradingView-powered interactive charts
- Sector performance treemap
- Fear & Greed gauge
- Real-time WebSocket price feeds

### Community

- Trading groups with social features
- User level progression system (food chain theme): Krill > Sardine > Dolphin > Shark > Orca
- Flash news feed

### Library

- 60,000+ curated items: books, research papers, whitepapers, and educational resources

### Pro Membership

- $12.99/month or $99/year
- Advanced analytics, extended data access, and premium features

### Localization & Theming

- Chinese (primary) and English language support
- Dark and Light themes

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router) |
| Database | Supabase (PostgreSQL + Auth + Realtime) |
| Caching | Upstash Redis |
| Hosting | Vercel (Edge + Serverless) |
| Charts | TradingView |
| Data Pipeline | 38 automated cron jobs |

## Architecture

```
                        +------------------+
                        |     Vercel CDN   |
                        +--------+---------+
                                 |
                        +--------+---------+
                        |   Next.js 16     |
                        |   App Router     |
                        +--+-----+------+--+
                           |     |      |
              +------------+  +--+--+  ++-----------+
              |               |     |               |
     +--------+----+   +-----+--+  +----+-----+    |
     |  Supabase   |   | Upstash |  | WebSocket|    |
     |  PostgreSQL  |   | Redis   |  | Feeds    |    |
     |  Auth        |   | Cache   |  +----------+    |
     |  Realtime    |   +--------+                   |
     +-------------+                   +-------------+--+
                                       | 38 Cron Jobs   |
              +------------------------| Data Pipeline  |
              |  27+ Exchange APIs     +----------------+
              |  CEX + DEX
              +-------------------+
```

- **Data Pipeline** -- 38 automated cron jobs continuously ingest trader data, compute scores, and refresh market metrics
- **Real-time Layer** -- WebSocket connections deliver live price feeds and trade updates
- **Edge Caching** -- Upstash Redis reduces latency for frequently accessed rankings and market data

## Getting Started

### Prerequisites

- Node.js 20+
- pnpm

### Installation

```bash
git clone https://github.com/your-org/ranking-arena.git
cd ranking-arena
pnpm install
```

### Environment

Copy the example environment file and fill in your credentials:

```bash
cp .env.example .env.local
```

Required variables: Supabase URL/keys, Upstash Redis credentials, exchange API keys.

### Development

```bash
pnpm dev
```

The app will be available at `http://localhost:3000`.

### Build

```bash
pnpm build
```

## License

All rights reserved. Copyright 2024-2025 Arena.
