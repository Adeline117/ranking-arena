# Ranking Arena Worker Service

Standalone data fetching service for Ranking Arena, independent of Vercel serverless functions.

## Features

- 🔄 **Parallel Platform Fetching** - Run multiple fetchers concurrently
- 🌐 **Proxy Pool Management** - Auto-failover with ClashX REST API support
- 📊 **Configurable Scheduling** - Run on-demand or as a daemon
- 🔧 **Category-based Filtering** - Fetch by platform category
- 🐳 **Docker Ready** - Deploy anywhere with Docker

## Quick Start

### Prerequisites

- Node.js 18+ or Docker
- Supabase credentials
- Optional: ClashX for proxy support

### Environment Variables

```bash
# Required
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=xxx

# Optional - for specific platforms
THEGRAPH_API_KEY=xxx        # Synthetix subgraph
DRIFT_API_KEY=xxx           # Drift Protocol

# Optional - proxy support
CLASH_API_URL=http://127.0.0.1:9090
CLASH_API_SECRET=xxx
```

### Running with Node.js

```bash
# Install dependencies (from project root)
npm install

# Run all enabled platforms
npx tsx worker/src/index.ts

# Run specific platforms
npx tsx worker/src/index.ts --platforms hyperliquid,gmx,gains

# Run DeFi protocols only
npx tsx worker/src/index.ts --defi

# Run by category
npx tsx worker/src/index.ts --category dex-api

# Run as daemon
npx tsx worker/src/index.ts --daemon
```

### Running with Docker

```bash
cd worker

# Build and run
docker-compose up -d worker

# Run DeFi platforms only
docker-compose --profile defi up worker-defi

# View logs
docker-compose logs -f worker
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Worker Service                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐         │
│  │  Scheduler  │→ │   Workers   │→ │   Fetchers  │         │
│  │  (Queue)    │  │  (Parallel) │  │  (Platform) │         │
│  └─────────────┘  └─────────────┘  └─────────────┘         │
│                           ↓                                 │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              Proxy Pool Manager                      │   │
│  │   • Health checking   • Auto-failover               │   │
│  │   • Success tracking  • Region selection            │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                            ↓
                   ┌─────────────────┐
                   │    Supabase     │
                   │  (Data Store)   │
                   └─────────────────┘
```

## Platform Status

### CEX Platforms

| Platform | Status | Proxy | Notes |
|----------|--------|-------|-------|
| OKX Futures | ✅ | No | Stable API |
| HTX | ✅ | No | Stable API |
| Binance Futures | ✅ | Yes (SG/JP/HK) | Geo-restricted |
| Binance Spot | ✅ | Yes | Geo-restricted |
| Bybit | ⚠️ | Yes | WAF issues |
| Bitget | ⚠️ | No | May need auth |
| Gate.io | ✅ | No | Stable API |

### DEX/DeFi Platforms

| Platform | Status | Notes |
|----------|--------|-------|
| Hyperliquid | ✅ | Excellent API |
| GMX | ✅ | GraphQL subgraph |
| Gains Network | ✅ | GraphQL subgraph |
| Jupiter Perps | ✅ | `/top-traders` API |
| Aevo | ✅ | `/leaderboard` API |
| Synthetix | ✅ | Requires THEGRAPH_API_KEY |
| Drift | ⚠️ | Requires DRIFT_API_KEY |
| Vertex | ❌ | No public leaderboard API |

## CLI Options

```
Usage:
  npx tsx worker/src/index.ts [options]

Options:
  --daemon, -d           Run as daemon with scheduled execution
  --concurrency, -c N    Max parallel jobs (default: 4)
  --platforms, -p LIST   Comma-separated platform IDs
  --category CAT         Run all platforms in category
  --periods LIST         Comma-separated periods (default: 7D,30D,90D)
  --defi                 Run all DeFi protocols
  --help, -h             Show help

Categories:
  cex-api        CEX platforms with pure API
  cex-browser    CEX platforms requiring browser
  dex-api        DEX platforms with API
  dex-subgraph   DEX platforms using subgraph
```

## Proxy Pool

The worker includes a proxy pool manager that integrates with ClashX:

```typescript
// Features
- Auto-discover proxies from ClashX
- Region-based proxy selection (SG, JP, HK preferred)
- Health checking with latency tracking
- Automatic failover on errors
- Success rate tracking per proxy
```

### ClashX Setup

1. Ensure ClashX is running with REST API enabled (default: `127.0.0.1:9090`)
2. Set `CLASH_API_URL` and optionally `CLASH_API_SECRET`
3. The worker will automatically discover and use available proxies

## Development

```bash
# Run in development
npx tsx watch worker/src/index.ts --platforms hyperliquid

# Type check
npm run type-check

# Test individual fetcher
npx tsx -e "
import { fetchHyperliquid } from './lib/cron/fetchers/hyperliquid';
import { getSupabaseClient } from './lib/cron/fetchers/shared';
const sb = getSupabaseClient();
fetchHyperliquid(sb, ['30D']).then(console.log);
"
```

## Troubleshooting

### Proxy not connecting
- Verify ClashX is running: `curl http://127.0.0.1:9090/proxies`
- Check API secret if configured

### Platform returning errors
- Check API rate limits
- Verify required API keys are set
- Try with `--concurrency 1` to isolate issues

### Data not saving
- Verify Supabase credentials
- Check `trader_sources` and `trader_snapshots` table permissions
