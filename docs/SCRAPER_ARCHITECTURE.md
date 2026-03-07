# Arena Scraper Architecture

## Overview

Arena uses a **hybrid scraping approach** to collect trader data from exchanges with varying levels of WAF protection:

1. **Direct API** - For exchanges with open APIs (Binance, OKX, etc.)
2. **VPS Browser Scraper** - For exchanges with Cloudflare/Akamai WAF (Bybit, MEXC)
3. **Fallback strategies** - Multiple layers of redundancy

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                   Arena Data Collection                      │
└─────────────────────────────────────────────────────────────┘
                              │
                ┌─────────────┴─────────────┐
                │                           │
          ┌─────▼──────┐             ┌──────▼────────┐
          │ Direct API │             │ VPS Scraper   │
          │ (HTTP/JSON)│             │ (Playwright)  │
          └─────┬──────┘             └──────┬────────┘
                │                           │
      ┌─────────┼───────────┐      ┌────────┼─────────┐
      │         │           │      │        │         │
  ┌───▼──┐  ┌──▼───┐  ┌───▼──┐ ┌──▼───┐ ┌──▼──┐  ┌──▼───┐
  │Binance│ │ OKX  │ │Bitget│ │Bybit │ │MEXC │ │CoinEx│
  └───────┘ └──────┘ └──────┘ └──────┘ └─────┘ └──────┘
      │         │          │       │       │        │
      └─────────┴──────────┴───────┴───────┴────────┘
                          │
                  ┌───────▼────────┐
                  │  Supabase DB   │
                  │ leaderboard_   │
                  │   ranks        │
                  └────────────────┘
```

---

## VPS Scraper Service

### Location
- **Production**: `http://45.76.152.169:3456` (Singapore VPS)
- **Auth**: `X-Proxy-Key: arena-proxy-sg-2026` (from `.env.local`)

### Supported Endpoints

| Platform | Endpoint | Method | Speed | Status |
|----------|----------|--------|-------|--------|
| Bybit | `/bybit/leaderboard` | GET | ~65s | ✅ Working |
| Bybit | `/bybit/leaderboard-batch` | GET | ~65s | ✅ Working (preferred) |
| MEXC | `/mexc/leaderboard` | GET | >120s | ⚠️ Slow |
| Bitget | `/bitget/leaderboard` | GET | ~40s | ✅ Working |
| CoinEx | `/coinex/leaderboard` | GET | ~35s | ✅ Working |
| KuCoin | `/kucoin/leaderboard` | GET | ~45s | ✅ Working |
| BingX | `/bingx/leaderboard` | GET | ~30s | ✅ Working |
| LBank | `/lbank/leaderboard` | GET | ~40s | ✅ Working |
| GateIO | `/gateio/leaderboard` | GET | ~50s | ✅ Working |

### Usage Example

```typescript
const VPS_SCRAPER_URL = 'http://45.76.152.169:3456'
const VPS_SCRAPER_KEY = process.env.VPS_PROXY_KEY

// Batch scrape Bybit (all periods in one browser session)
const url = `${VPS_SCRAPER_URL}/bybit/leaderboard-batch?pageSize=50&durations=DATA_DURATION_THIRTY_DAY,DATA_DURATION_NINETY_DAY`
const res = await fetch(url, {
  headers: { 'X-Proxy-Key': VPS_SCRAPER_KEY },
  signal: AbortSignal.timeout(90_000),
})
const data = await res.json()

// Response format:
// {
//   "DATA_DURATION_THIRTY_DAY": {
//     "retCode": 0,
//     "result": {
//       "leaderDetails": [...]
//     }
//   },
//   "DATA_DURATION_NINETY_DAY": { ... }
// }
```

---

## Platform-Specific Strategies

### Bybit (`lib/cron/fetchers/bybit.ts`)

**Challenge**: Akamai WAF blocks all direct API access (HTTP 403)

**Strategy**:
1. ✅ **Prefetch batch** - Call `/bybit/leaderboard-batch` with all periods (~65s for 3 periods)
2. ⏭️ **Skip fallbacks** - Direct API returns 403, Cloudflare proxy fails
3. ❌ **No local scraper** - Local Playwright still gets blocked

**Performance**:
- Batch mode: ~65s for all 3 periods (7D, 30D, 90D)
- Single page: ~73s per period
- **Recommendation**: Always use batch mode

**Code**:
```typescript
// Prefetch all periods in one browser session
await prefetchBatch(['7D', '30D', '90D'])

// Use cached results
const data = _batchCache.get('DATA_DURATION_THIRTY_DAY')
```

---

### MEXC (`lib/cron/fetchers/mexc.ts`)

**Challenge**: Akamai WAF blocks most requests, API endpoints unstable

**Strategy**:
1. ✅ **Try new API endpoints** - `copyFutures/api/v1/traders/top` (no auth, faster)
2. ✅ **Try legacy POST API** - `copy-trade/rank/list` (needs auth)
3. ✅ **Try futures GET API** - `futures.mexc.com/api/v1/...`
4. ⏭️ **VPS scraper fallback** - Slow (>120s) but reliable

**Performance**:
- API endpoints (if working): ~2-5s
- VPS scraper: >120s
- **Recommendation**: Prefer API endpoints, use scraper as last resort

**Code**:
```typescript
// Try API first
await tryCopyFuturesApi()  // Fastest
if (allTraders.size === 0) await tryLegacyApi()
if (allTraders.size === 0) await tryFuturesApi()

// VPS scraper fallback
if (allTraders.size === 0 && VPS_SCRAPER_KEY) {
  const data = await fetch(`${VPS_SCRAPER_URL}/mexc/leaderboard?periodType=2&pageSize=50`, {
    headers: { 'X-Proxy-Key': VPS_SCRAPER_KEY },
    signal: AbortSignal.timeout(120_000),
  })
}
```

---

### HTX (`lib/cron/fetchers/htx.ts`)

**Challenge**: None - API is publicly accessible

**Strategy**:
1. ✅ **Direct API** - `futures.htx.com/-/x/hbg/v1/futures/copytrading/rank`
2. No VPS scraper needed

**Performance**:
- Direct API: ~1-3s
- **Recommendation**: Always use direct API

---

## Monitoring & Health Checks

### VPS Scraper Health Check

```bash
curl http://45.76.152.169:3456/health
```

**Response**:
```json
{
  "ok": true,
  "busy": false,
  "queued": 0,
  "uptime": 1688.39,
  "version": "v12",
  "endpoints": [...]
}
```

### Test Script

```bash
npx tsx scripts/test-vps-scrapers.ts
```

**Output**:
```
🏥 VPS Scraper Health Check

✅ VPS Scraper Status:
   URL: http://45.76.152.169:3456
   Version: v12
   Uptime: 28 minutes
   Busy: false
   Queue: 0

🧪 Testing Bybit...
✅ Bybit: 50 traders in 64.6s

🧪 Testing MEXC...
✅ MEXC: 48 traders in 121.3s

📊 Summary:
   Success Rate: 2/2
   Avg Duration: 92.9s
```

---

## Troubleshooting

### "VPS scraper returned HTTP 403"
- **Cause**: VPS IP is blocked by exchange WAF
- **Fix**: Restart VPS scraper service (it rotates fingerprints)

```bash
ssh root@45.76.152.169
pm2 restart arena-scraper
```

### "VPS scraper timeout"
- **Cause**: Browser session hung or WAF challenge taking too long
- **Fix**: Increase timeout in fetcher config

```typescript
const data = await callVpsScraperWithRetry('/bybit/leaderboard', params, {
  retries: 2,
  timeout: 120_000, // Increase from 90s
})
```

### "No data from MEXC"
- **Cause**: All API endpoints + VPS scraper failed
- **Fix**: Check MEXC site manually, API structure may have changed

### "Bybit returns 0 traders"
- **Cause**: Batch cache miss, fell back to broken direct API
- **Fix**: Ensure `prefetchBatch()` is called before `fetchPeriod()`

---

## Performance Optimization

### 1. Use Batch Endpoints

**Bad** (sequential, ~219s total):
```typescript
for (const period of ['7D', '30D', '90D']) {
  await fetch(`/bybit/leaderboard?duration=${period}`) // 73s each
}
```

**Good** (parallel in one browser session, ~65s total):
```typescript
const data = await fetch('/bybit/leaderboard-batch?durations=DATA_DURATION_SEVEN_DAY,DATA_DURATION_THIRTY_DAY,DATA_DURATION_NINETY_DAY')
```

### 2. Cache VPS Scraper Results

```typescript
// In-memory cache (valid for 30 minutes)
const _cache = new Map<string, { data: any; expires: number }>()

function getCached(key: string) {
  const cached = _cache.get(key)
  if (cached && Date.now() < cached.expires) {
    return cached.data
  }
  return null
}

function setCache(key: string, data: any, ttlMs = 30 * 60 * 1000) {
  _cache.set(key, { data, expires: Date.now() + ttlMs })
}
```

### 3. Parallel Enrichment

```typescript
// Bad (sequential, ~50s total)
for (const trader of traders) {
  await fetchEquityCurve(trader.id) // 1s each
}

// Good (parallel with concurrency limit, ~10s total)
const CONCURRENCY = 5
for (let i = 0; i < traders.length; i += CONCURRENCY) {
  await Promise.all(
    traders.slice(i, i + CONCURRENCY).map(t => fetchEquityCurve(t.id))
  )
}
```

---

## Future Improvements

### Short-term
- [ ] Add MEXC batch endpoint to VPS scraper (reduce 360s → 120s)
- [ ] Implement Redis cache for VPS scraper results
- [ ] Add Prometheus metrics to VPS scraper

### Medium-term
- [ ] Migrate to residential proxy pool (bypass WAF more reliably)
- [ ] Add captcha solving service integration
- [ ] Implement smart rate limiting (adaptive based on exchange response)

### Long-term
- [ ] Build distributed scraper cluster (multiple VPS locations)
- [ ] Add ML-based fingerprint randomization
- [ ] Implement automatic fallback to archived data on scraper failure

---

## References

- VPS Scraper codebase: `/opt/scraper/` on SG VPS
- Playwright docs: https://playwright.dev/
- WAF bypass techniques: Internal docs (confidential)
