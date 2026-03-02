# Exchange Connectors

Unified API connectors for all supported exchanges.

## Architecture

```
BaseExchangeConnector (abstract)
├── BitgetFuturesConnector
├── HTXFuturesConnector
├── BinanceWeb3Connector
└── BingXSpotConnector
```

## Usage

### Basic Example

```typescript
import { BitgetFuturesConnector } from '@/lib/connectors'

const connector = new BitgetFuturesConnector()

// Get trader detail
const trader = await connector.getTraderDetail('abc123def456', { period: '30d' })
console.log(trader)
// {
//   source_trader_id: 'abc123def456',
//   win_rate: 68.5,
//   max_drawdown: 12.3,
//   trades_count: 234,
//   roi: 125.5,
//   pnl: 45230.12
// }

// Enrich a snapshot
const snapshot = {
  source_trader_id: 'abc123',
  handle: 'TraderX',
  win_rate: null,
  max_drawdown: null,
}

const result = await connector.enrichSnapshot(snapshot)
console.log(result)
// {
//   success: true,
//   updates: { win_rate: 68.5, max_drawdown: 12.3 }
// }
```

### With Rate Limiting

```typescript
import { BitgetFuturesConnector, RateLimiter } from '@/lib/connectors'

const connector = new BitgetFuturesConnector()
const limiter = new RateLimiter(1, 200) // 1 concurrent, 200ms delay

const traders = ['id1', 'id2', 'id3']
const results = await Promise.all(
  traders.map(id =>
    limiter.add(() => connector.getTraderDetail(id))
  )
)
```

### Multi-Period Fetching

```typescript
import { BinanceWeb3Connector } from '@/lib/connectors'

const connector = new BinanceWeb3Connector()

// Fetch 7d, 30d, 90d data
const periods = ['7d', '30d', '90d'] as const
for (const period of periods) {
  const traders = await connector.getTraderList({
    page: 1,
    pageSize: 100,
    period,
    chainId: 56, // BSC
  })
  console.log(`${period}: ${traders.length} traders`)
}
```

### Factory Pattern

```typescript
import { getConnector } from '@/lib/connectors'

const sources = ['bitget_futures', 'htx_futures', 'binance_web3']

for (const source of sources) {
  const connector = getConnector(source)
  const traders = await connector.getTraderList({ page: 1, pageSize: 50 })
  console.log(`${source}: ${traders.length} traders`)
}
```

## Connector Details

### BitgetFuturesConnector

- **API**: `https://www.bitget.com/v1/trigger/trace/public/cycleData`
- **Auth**: None
- **Rate Limit**: 100-200ms
- **Multi-period**: ✅ (7d, 30d, 90d via `cycleTime` param)
- **Fields**: win_rate, max_drawdown, roi, pnl, trades_count, followers
- **Note**: Requires hex trader IDs (16+ chars, a-f0-9)

```typescript
const connector = new BitgetFuturesConnector()
const trader = await connector.getTraderDetail('abc123def456789', { period: '30d' })
```

### HTXFuturesConnector

- **API**: `https://futures.htx.com/-/x/hbg/v1/futures/copytrading/rank`
- **Auth**: None
- **Rate Limit**: 200-300ms
- **Multi-period**: ❌ (overall stats only)
- **Fields**: win_rate, max_drawdown, avatar_url, roi, pnl
- **Missing**: trades_count (not available from ranking API)

```typescript
const connector = new HTXFuturesConnector()
const traders = await connector.getTraderList({ page: 1, pageSize: 50 })
```

### BinanceWeb3Connector

- **API**: `https://web3.binance.com/bapi/defi/v1/public/wallet-direct/market/leaderboard/query`
- **Auth**: None
- **Rate Limit**: 300-500ms
- **Multi-period**: ✅ (7d, 30d, 90d)
- **Multi-chain**: ✅ (BSC=56, ETH=1, Base=8453)
- **Fields**: win_rate, roi, pnl, trades_count, avatar_url
- **Missing**: max_drawdown (not available from API)

```typescript
const connector = new BinanceWeb3Connector()
const traders = await connector.getTraderList({
  page: 1,
  pageSize: 100,
  period: '30d',
  chainId: 56, // BSC
})
```

### BingXSpotConnector

- **API**: `https://api-app.qq-os.com/api/copy-trade-facade/v2/spot/trader/search`
- **Auth**: ⚠️ CloudFlare protected - requires Playwright headers
- **Rate Limit**: 200-500ms
- **Multi-period**: ❌
- **Fields**: win_rate, max_drawdown (from equity curve), trades_count
- **Note**: Must call `setHeaders()` with browser-captured headers first

```typescript
import { chromium } from 'playwright'

// Capture headers via Playwright
const browser = await chromium.launch()
const page = await browser.newPage()
let capturedHeaders = null

page.on('request', req => {
  if (req.url().includes('spot/trader/search')) {
    capturedHeaders = req.headers()
  }
})

await page.goto('https://bingx.com/en/CopyTrading?type=spot')

// Use connector with captured headers
const connector = new BingXSpotConnector(capturedHeaders)
const traders = await connector.getTraderList({ page: 0, pageSize: 20 })
```

## Error Handling

All connectors return `null` for failed `getTraderDetail()` calls and empty arrays `[]` for failed `getTraderList()` calls. Errors are logged to console.

```typescript
const trader = await connector.getTraderDetail('invalid_id')
if (!trader) {
  console.log('Trader not found or API error')
}
```

## Data Quality Guarantees

✅ **NO fabricated values** - Only real API data is returned
✅ **Validation** - Win rate (0-100%), max drawdown (positive %), etc.
✅ **Type safety** - Full TypeScript interfaces
✅ **Null handling** - Missing fields are `null`, not `undefined` or defaults

## Integration with Enrichment Scripts

Connectors can be used in enrichment scripts to replace direct fetch calls:

```typescript
import { BitgetFuturesConnector, RateLimiter } from '@/lib/connectors'

const connector = new BitgetFuturesConnector()
const limiter = new RateLimiter(1, 150)

for (const row of rows) {
  const result = await limiter.add(() =>
    connector.enrichSnapshot(row, { period: '30d' })
  )
  
  if (result.success && Object.keys(result.updates).length > 0) {
    await supabase.from('leaderboard_ranks').update(result.updates).eq('id', row.id)
  }
}
```

## Future Connectors

To add a new exchange:

1. Extend `BaseExchangeConnector`
2. Implement `getTraderDetail()` and `getTraderList()`
3. Add to `getConnector()` factory
4. Add API docs to `docs/exchange-apis/<source>.md`

See `base-connector.ts` for the full interface.
