# Exchange Adapters

Unified interface for fetching trader data from different exchanges using official APIs.

## Overview

Exchange adapters provide a consistent way to fetch trader leaderboard data from various exchanges, replacing web scraping with official API integrations where available.

### Supported Adapters

| Adapter | Status | Data Source | Rate Limit | Documentation |
|---------|--------|-------------|------------|---------------|
| **Bybit** | ✅ Ready | Official API | 120 req/s | [BybitAdapter](./bybit-adapter.ts) |
| **OKX** | 🚧 Planned | Official API | 20 req/2s | - |
| **Bitget** | 🚧 Planned | Official API | 20 req/s | - |
| **Binance** | ⚠️ Hybrid | Web Scraping + Internal API | 2400 req/min | See [Reality Check](../../docs/API_MIGRATION_REALITY_CHECK.md) |

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Application Layer                      │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  Cron Jobs / API Routes / Background Workers        │ │
│  └─────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────────┐
│                    Adapter Layer                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │    Bybit     │  │     OKX      │  │   Bitget     │  │
│  │   Adapter    │  │   Adapter    │  │   Adapter    │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
└──────────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────────┐
│                 Rate Limiting Layer                       │
│              (Upstash Redis + Sliding Window)             │
└──────────────────────────────────────────────────────────┘
                          ↓
┌──────────────────────────────────────────────────────────┐
│                   Exchange APIs                           │
│     (Bybit, OKX, Bitget, etc.)                           │
└──────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Setup Environment Variables

Add the following to your `.env.local`:

```bash
# Bybit API Credentials
BYBIT_API_KEY=your_bybit_api_key
BYBIT_API_SECRET=your_bybit_api_secret

# Upstash Redis (for rate limiting)
UPSTASH_REDIS_REST_URL=your_upstash_redis_url
UPSTASH_REDIS_REST_TOKEN=your_upstash_redis_token

# Cron Secret (for protecting cron endpoints)
CRON_SECRET=your_cron_secret
```

### 2. Basic Usage

```typescript
import { BybitAdapter } from '@/lib/adapters/bybit-adapter'
import { ExchangeRateLimiters } from '@/lib/ratelimit/exchange-limiter'

// Initialize adapter
const adapter = new BybitAdapter({
  apiKey: process.env.BYBIT_API_KEY,
  apiSecret: process.env.BYBIT_API_SECRET,
})

// Get rate limiter
const limiter = ExchangeRateLimiters.get('bybit')

// Fetch leaderboard with rate limiting
const result = await limiter.execute(
  () => adapter.fetchLeaderboard({
    platform: 'bybit',
    limit: 100,
    sortBy: 'roi',
    minFollowers: 50,
  }),
  'my-operation-id'
)

console.log(`Fetched ${result.traders.length} traders`)
```

### 3. Fetch Trader Detail

```typescript
const trader = await limiter.execute(
  () => adapter.fetchTraderDetail({
    platform: 'bybit',
    traderId: 'some-trader-id',
  }),
  'fetch-detail'
)

if (trader) {
  console.log(`${trader.nickname}: ROI ${trader.roi}%, PnL $${trader.pnl}`)
}
```

## API Reference

### ExchangeAdapter Interface

```typescript
interface ExchangeAdapter {
  // Metadata
  name: string
  type: 'cex' | 'dex'

  // Core methods
  fetchLeaderboard(query: LeaderboardQuery): Promise<LeaderboardResponse>
  fetchTraderDetail(query: TraderDetailQuery): Promise<TraderData | null>

  // Health check
  healthCheck(): Promise<boolean>

  // Rate limit info
  getRateLimitInfo(): RateLimitInfo
}
```

### LeaderboardQuery

```typescript
interface LeaderboardQuery {
  platform: string
  limit?: number // Default: 100
  sortBy?: 'roi' | 'pnl' | 'followers' | 'aum'
  minFollowers?: number
  periodDays?: 7 | 30 | 90 | 365 | 'all'
}
```

### TraderData

```typescript
interface TraderData {
  // Identity
  platform: string
  traderId: string
  nickname: string
  avatar?: string

  // Performance
  roi: number // %
  pnl: number // USDT
  aum?: number // USDT
  followers: number
  tradesCount: number

  // Risk metrics
  winRate: number // %
  maxDrawdown: number // %
  sharpeRatio?: number

  // Additional
  description?: string
  verified?: boolean
  dataSource: 'api' | 'scraper' | 'cache'
  fetchedAt: Date
}
```

## Rate Limiting

All adapters are automatically rate limited using Upstash Redis with a sliding window algorithm.

### Configured Limits

| Exchange | Limit | Period | Notes |
|----------|-------|--------|-------|
| Bybit | 120 req | 1 second | Per API key |
| OKX | 20 req | 2 seconds | Per API key |
| Bitget | 20 req | 1 second | Per API key |
| Binance | 2400 req | 1 minute | Per IP |

### Rate Limiter Usage

```typescript
import { ExchangeRateLimiters } from '@/lib/ratelimit/exchange-limiter'

const limiter = ExchangeRateLimiters.get('bybit')

// Check rate limit status
const status = await limiter.getStatus()
console.log(`Remaining: ${status.remaining}/${status.limit}`)

// Wait for rate limit if exceeded
await limiter.waitForLimit('operation-id')

// Execute with automatic rate limiting
const result = await limiter.execute(
  async () => {
    // Your API call here
    return await someApiCall()
  },
  'operation-id'
)
```

## Testing

### Run Test Script

```bash
# Test Bybit adapter
npx tsx scripts/test-bybit-adapter.ts
```

### Expected Output

```
🧪 Testing Bybit Adapter

✅ Adapter initialized
   Rate Limit: 120 req/1s

📊 Test 1: Health Check
✅ API is healthy

📊 Test 2: Fetch Leaderboard (Top 10)
✅ Fetched 10 traders
   Total: 10
   Has More: true

   Top 3 Traders:
   1. TraderABC
      • ROI: 156.42%
      • PnL: $125,432
      • Followers: 1,234
      • Win Rate: 67.80%
      • Max Drawdown: 12.34%
      • Data Source: api

...
```

## Cron Integration

The Bybit adapter is integrated into the cron system for automatic data fetching.

### Endpoint

```
POST /api/cron/fetch-bybit-traders
Authorization: Bearer ${CRON_SECRET}
```

### Schedule

```json
{
  "path": "/api/cron/fetch-bybit-traders",
  "schedule": "*/15 * * * *"
}
```

Runs every 15 minutes to fetch top 200 traders from Bybit.

### Manual Trigger

```bash
curl -X POST http://localhost:3000/api/cron/fetch-bybit-traders \
  -H "Authorization: Bearer ${CRON_SECRET}"
```

## Error Handling

Adapters implement retry logic with exponential backoff:

```typescript
// Retry configuration
{
  retries: 3,
  timeout: 30000, // 30 seconds
  backoff: 2^attempt * 1000 // 1s, 2s, 4s
}
```

### Common Errors

| Error Code | Description | Solution |
|------------|-------------|----------|
| `MISSING_CONFIG` | API key/secret not configured | Check `.env.local` |
| `REQUEST_FAILED` | Network or API error | Check logs, verify API health |
| `API_ERROR` | Exchange API returned error | Check response details |
| `RATE_LIMIT_EXCEEDED` | Too many requests | Wait for rate limit reset |

### Error Logging

All errors are logged using the centralized logger:

```typescript
logger.error('[Bybit] Failed to fetch leaderboard', {
  error,
  query,
})
```

## Best Practices

### 1. Always Use Rate Limiters

```typescript
// ❌ Bad - no rate limiting
const traders = await adapter.fetchLeaderboard({ platform: 'bybit' })

// ✅ Good - with rate limiting
const traders = await limiter.execute(
  () => adapter.fetchLeaderboard({ platform: 'bybit' }),
  'my-operation'
)
```

### 2. Handle Errors Gracefully

```typescript
try {
  const trader = await adapter.fetchTraderDetail({ platform: 'bybit', traderId })
  if (!trader) {
    console.log('Trader not found')
    return
  }
  // Process trader
} catch (error) {
  logger.error('Failed to fetch trader', { error, traderId })
  // Fall back to cached data or show error to user
}
```

### 3. Use Health Checks

```typescript
const isHealthy = await adapter.healthCheck()
if (!isHealthy) {
  // Use fallback data source
  return await fetchFromCache()
}
```

### 4. Batch Operations

```typescript
// Fetch leaderboard once, then process all traders
const leaderboard = await adapter.fetchLeaderboard({ limit: 200 })

for (const trader of leaderboard.traders) {
  // Process each trader
  await processTrader(trader)
}
```

## Creating New Adapters

### 1. Implement the Interface

```typescript
// lib/adapters/okx-adapter.ts
import { BaseAdapter } from './base-adapter'
import type { ExchangeAdapter } from './types'

export class OKXAdapter extends BaseAdapter implements ExchangeAdapter {
  name = 'okx'
  type = 'cex' as const

  async fetchLeaderboard(query: LeaderboardQuery): Promise<LeaderboardResponse> {
    // Implementation
  }

  async fetchTraderDetail(query: TraderDetailQuery): Promise<TraderData | null> {
    // Implementation
  }
}
```

### 2. Add Rate Limit Config

```typescript
// lib/ratelimit/exchange-limiter.ts
const configs: Record<string, RateLimiterConfig> = {
  // ...
  okx: {
    exchangeName: 'okx',
    limit: 20,
    period: 2, // 20 requests per 2 seconds
  },
}
```

### 3. Create Test Script

```typescript
// scripts/test-okx-adapter.ts
import { OKXAdapter } from '@/lib/adapters/okx-adapter'

async function main() {
  const adapter = new OKXAdapter({
    apiKey: process.env.OKX_API_KEY,
    apiSecret: process.env.OKX_API_SECRET,
  })

  // Run tests
}

main()
```

### 4. Create Cron Endpoint

```typescript
// app/api/cron/fetch-okx-traders/route.ts
import { OKXAdapter } from '@/lib/adapters/okx-adapter'

export async function POST(request: NextRequest) {
  // Fetch and store traders
}
```

### 5. Update Vercel Config

```json
{
  "path": "/api/cron/fetch-okx-traders",
  "schedule": "*/15 * * * *"
}
```

## Monitoring

### Rate Limiter Dashboard

Get status for all exchanges:

```typescript
import { ExchangeRateLimiters } from '@/lib/ratelimit/exchange-limiter'

const statuses = await ExchangeRateLimiters.getAllStatuses()
console.log(statuses)
/*
{
  bybit: { remaining: 115, limit: 120, reset: Date },
  okx: { remaining: 18, limit: 20, reset: Date },
}
*/
```

### Metrics to Monitor

- **Success Rate**: % of successful API calls
- **Response Time**: P50, P95, P99 latencies
- **Rate Limit Usage**: Remaining / Total
- **Error Rate**: Errors per minute
- **Data Freshness**: Time since last successful fetch

## Migration Timeline

### Phase 1 (Completed): Bybit
- ✅ Adapter implementation
- ✅ Rate limiter integration
- ✅ Cron job setup
- ✅ Testing and validation

### Phase 2 (Week 1-2): OKX
- [ ] OKX adapter implementation
- [ ] Testing
- [ ] Production deployment

### Phase 3 (Week 3-4): Bitget
- [ ] Bitget adapter implementation
- [ ] Testing
- [ ] Production deployment

### Phase 4 (Week 5+): Additional Exchanges
- Evaluate other exchanges for API availability
- Implement adapters as appropriate

## Troubleshooting

### Issue: Rate limit exceeded

**Solution**: Check rate limiter configuration and adjust request frequency.

```typescript
const status = await limiter.getStatus()
console.log(`Remaining: ${status.remaining}, Reset: ${status.reset}`)
```

### Issue: API authentication failed

**Solution**: Verify API key and secret in `.env.local`:

```bash
# Test API credentials
npx tsx scripts/test-bybit-adapter.ts
```

### Issue: No data returned

**Solution**: Check exchange API health and response format:

```typescript
const isHealthy = await adapter.healthCheck()
console.log(`API Health: ${isHealthy}`)
```

## Resources

- [Bybit API Documentation](https://bybit-exchange.github.io/docs/v5/copy-trading/trader-list)
- [API Migration Plan](../../docs/API_MIGRATION_PLAN.md)
- [API Migration Reality Check](../../docs/API_MIGRATION_REALITY_CHECK.md)
- [Upstash Ratelimit Documentation](https://upstash.com/docs/oss/sdks/ts/ratelimit/overview)

## Contributing

When adding new adapters:

1. Follow the `ExchangeAdapter` interface
2. Extend `BaseAdapter` for common functionality
3. Add comprehensive error handling
4. Include test scripts
5. Update this README
6. Add monitoring and logging

## License

Internal use only - Ranking Arena project.
