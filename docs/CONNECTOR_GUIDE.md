# Connector Guide: Adding a New Exchange

Step-by-step guide for onboarding a new exchange platform into the Arena data pipeline.

## Prerequisites

- Familiarity with the exchange's public API (copy-trading or leaderboard endpoint)
- Access to the VPS if the exchange is geo-blocked or uses Cloudflare protection
- An understanding of the Arena connector framework (see `docs/CONNECTOR_ARCHITECTURE.md`)

---

## Step 1: Create the Connector File

Create a new file at `lib/connectors/platforms/<exchange>-<market_type>.ts`.

Convention: `<exchange>` is the lowercase exchange name, `<market_type>` is one of `futures`, `spot`, or `perp`.

Example: `lib/connectors/platforms/newex-futures.ts`

```typescript
import { BaseConnector } from '../base'
import type {
  DiscoverResult, ProfileResult, SnapshotResult, TimeseriesResult,
  TraderSource, TraderProfile, SnapshotMetrics, QualityFlags,
  PlatformCapabilities, Window,
} from '../../types/leaderboard'

export class NewexFuturesConnector extends BaseConnector {
  readonly platform = 'newex' as const
  readonly marketType = 'futures' as const
  readonly capabilities: PlatformCapabilities = {
    platform: 'newex',
    market_types: ['futures'],
    native_windows: ['7d', '30d', '90d'],
    available_fields: ['roi', 'pnl', 'win_rate', 'followers'],
    has_timeseries: false,
    has_profiles: true,
    scraping_difficulty: 2, // 1=easy, 5=very hard
    rate_limit: { rpm: 30, concurrency: 2 },
    notes: ['REST API', 'Requires VPS proxy for geo-blocked regions'],
  }

  async discoverLeaderboard(window: Window, limit = 100, _offset = 0): Promise<DiscoverResult> {
    // Implement: fetch leaderboard from exchange API
    // Return normalized TraderSource[]
  }

  async fetchTraderProfile(traderKey: string): Promise<ProfileResult | null> {
    // Implement: fetch individual trader profile
    // Return null if not supported
  }

  async fetchTraderSnapshot(traderKey: string, window: Window): Promise<SnapshotResult | null> {
    // Implement: fetch trader performance metrics for a specific window
    // Return null if not supported
  }

  async fetchTimeseries(traderKey: string): Promise<TimeseriesResult> {
    // Implement: fetch equity curve / PnL history
    // Return { series: [], fetched_at: ... }
  }

  normalize(raw: Record<string, unknown>): Record<string, unknown> {
    // Implement: map raw API fields to the 13-field standard
    // See "normalize() Field Standard" below
  }
}
```

---

## Step 2: Implement `normalize()` -- The 13-Field Standard

Every connector must implement `normalize(raw)` that maps exchange-specific fields to this standard output:

| # | Field | Type | Description |
|---|-------|------|-------------|
| 1 | `trader_key` | `string` | Unique trader identifier on the platform |
| 2 | `display_name` | `string \| null` | Human-readable name or nickname |
| 3 | `avatar_url` | `string \| null` | Profile image URL |
| 4 | `roi` | `number \| null` | Return on investment (percentage, e.g., 150 = 150%) |
| 5 | `pnl` | `number \| null` | Profit and loss (USD) |
| 6 | `win_rate` | `number \| null` | Win rate (percentage, 0-100) |
| 7 | `max_drawdown` | `number \| null` | Maximum drawdown (percentage, 0-100, positive number) |
| 8 | `trades_count` | `number \| null` | Total number of trades |
| 9 | `followers` | `number \| null` | Number of followers / subscribers |
| 10 | `copiers` | `number \| null` | Number of active copy-traders |
| 11 | `aum` | `number \| null` | Assets under management (USD) |
| 12 | `sharpe_ratio` | `number \| null` | Sharpe ratio (if provided by exchange) |
| 13 | `platform_rank` | `number \| null` | Rank on the exchange's own leaderboard |

**Important rules**:
- Return `null` (not `0`) for fields the exchange does not provide.
- ROI must be in percentage form (multiply by 100 if the API returns a decimal ratio).
- Clamp ROI to `[-100, 10000]` to catch data anomalies.
- PnL should be in USD.
- `trader_key` for DEX platforms is typically a lowercase Ethereum address.

Example:
```typescript
normalize(raw: Record<string, unknown>): Record<string, unknown> {
  const rawRoi = raw.roi != null ? Number(raw.roi) : null
  const roi = rawRoi != null ? Math.max(-100, Math.min(10000, rawRoi * 100)) : null

  return {
    trader_key: String(raw.uid || ''),
    display_name: (raw.nickName as string) || null,
    avatar_url: (raw.userPhotoUrl as string) || null,
    roi,
    pnl: raw.pnl != null ? Number(raw.pnl) : null,
    win_rate: raw.winRate != null ? Number(raw.winRate) * 100 : null,
    max_drawdown: raw.maxDrawdown != null ? Math.abs(Number(raw.maxDrawdown)) : null,
    trades_count: raw.tradeCount != null ? Number(raw.tradeCount) : null,
    followers: raw.followerCount != null ? Number(raw.followerCount) : null,
    copiers: raw.copierCount != null ? Number(raw.copierCount) : null,
    aum: raw.aum != null ? Number(raw.aum) : null,
    sharpe_ratio: null,
    platform_rank: raw.rank != null ? Number(raw.rank) : null,
  }
}
```

---

## Step 3: Register in ConnectorRegistry

Edit `lib/connectors/index.ts` to import and register your connector:

```typescript
import { NewexFuturesConnector } from './platforms/newex-futures'

// In the registration block:
registry.register(new NewexFuturesConnector())
```

Also add the platform to `lib/types/leaderboard.ts`:
- Add to `GRANULAR_PLATFORMS` array
- Add to `PLATFORM_CATEGORY` mapping (e.g., `newex_futures: 'futures'`)

And register in `lib/constants/exchanges.ts` if there is a platform metadata list.

---

## Step 4: Add to a Batch Fetch Group

Edit `vercel.json` to add the platform to an existing cron group or create a new one.

Each group should have at most 3 platforms and run within the 300-second Vercel function timeout.

```json
{
  "path": "/api/cron/batch-fetch-traders?group=g2",
  "schedule": "15 */6 * * *"
}
```

Then update the group mapping in the batch-fetch-traders route to include your platform.

**Scheduling rules**:
- Stagger cron schedules to avoid overlapping (use different minute offsets)
- CEX platforms: fetch every 6 hours minimum
- DEX platforms: can be less frequent (every 6-12 hours)
- Hot platforms (Binance, Bybit): fetch every 2-4 hours

---

## Step 5: Testing and Validation

### Local testing

```bash
# 1. Type check
npx tsc --noEmit

# 2. Test the connector directly (create a test script)
npx tsx -e "
  import { NewexFuturesConnector } from './lib/connectors/platforms/newex-futures'
  const c = new NewexFuturesConnector()
  const result = await c.discoverLeaderboard('90d', 10)
  console.log(JSON.stringify(result, null, 2))
"

# 3. Run pipeline health check
node scripts/pipeline-health-check.mjs
```

### Validation checklist

- [ ] `discoverLeaderboard()` returns > 0 traders
- [ ] `normalize()` output has all 13 fields
- [ ] ROI values are in percentage form (not decimal)
- [ ] `trader_key` is non-empty and unique per trader
- [ ] No `undefined` values (use `null` instead)
- [ ] PnL is in USD (convert if needed)
- [ ] win_rate is 0-100 range
- [ ] Rate limiting works (test with rapid sequential calls)
- [ ] Circuit breaker triggers after failures
- [ ] Error messages are descriptive

### Production verification

After deploying:

1. Wait for the first cron run.
2. Check `pipeline_logs` for success:
   ```sql
   SELECT * FROM pipeline_logs
   WHERE job_name LIKE '%newex%'
   ORDER BY started_at DESC LIMIT 5;
   ```
3. Verify data in `trader_snapshots`:
   ```sql
   SELECT count(*), max(captured_at)
   FROM trader_snapshots
   WHERE source = 'newex_futures';
   ```
4. Check the leaderboard UI for the new platform in the filter dropdown.

---

## Step 6: VPS Fallback Configuration

If the exchange blocks requests from Vercel's IP ranges:

### Option A: VPS Proxy (for API-based fetchers)

Configure the connector to use VPS proxy:

```typescript
constructor() {
  super({
    proxyUrl: process.env.VPS_PROXY_SG, // e.g., http://45.76.152.169:3001
  })
}
```

The proxy rewrites requests through the SG VPS, which has a residential-like IP.

### Option B: VPS Playwright Scraper (for browser-rendered pages)

Add a handler to the VPS scraper (`/opt/scraper/server.js`):

```javascript
app.get('/newex/leaderboard', async (req, res) => {
  // Launch browser, navigate to leaderboard page
  // Intercept API calls via page.on('response')
  // Return JSON data
})
```

Then update the fetcher to call the scraper as Strategy 0:

```typescript
// Strategy 0: VPS Scraper
const scraperUrl = process.env.VPS_SCRAPER_URL // http://45.76.152.169:3456
const data = await fetch(`${scraperUrl}/newex/leaderboard`).then(r => r.json())
```

### Option C: Mac Mini Scraper (for CloudFront/heavy anti-bot)

For exchanges that block all cloud IPs (like Phemex), use the Mac Mini Chrome scraper running locally.

---

## Common API Patterns

### REST (most common)

```typescript
const data = await this.request<ApiResponse>(
  'https://api.exchange.com/copy/leaderboard',
  { method: 'GET' }
)
```

### REST with POST body

```typescript
const data = await this.request<ApiResponse>(
  'https://api.exchange.com/v1/traders/list',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ page: 1, pageSize: 100, period: '90D' }),
  }
)
```

### GraphQL / Subgraph (for on-chain protocols)

```typescript
const query = `{
  traders(first: 100, orderBy: pnl, orderDirection: desc) {
    id account realizedPnl maxCapital wins losses
  }
}`

const data = await this.request<{ data: { traders: Trader[] } }>(
  'https://api.thegraph.com/subgraphs/name/protocol/stats',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  }
)
```

---

## Rate Limiting and Circuit Breaker

The `BaseConnector` provides built-in rate limiting and circuit breaking:

- **Rate limiter**: Configured via `capabilities.rate_limit` (`rpm` and `concurrency`). The `ConnectorRegistry` creates a `TokenBucketRateLimiter` automatically.
- **Circuit breaker**: Opens after 5 consecutive failures, resets after 60 seconds. Throws `CircuitOpenError` when open.

You do not need to implement these yourself -- they are handled by `BaseConnector.request()`.

To customize:
```typescript
constructor() {
  super({
    maxRetries: 3,      // Default: 2
    timeout: 30000,     // Default: 15000ms
    retryDelay: 2000,   // Default: 1000ms
  })
}
```
