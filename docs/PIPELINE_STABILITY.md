# Pipeline Stability, Freshness & Reliability Audit

Generated: 2026-03-06

---

## 1. Architecture Overview

The data pipeline follows a three-layer design:

1. **Discovery** (batch-fetch-traders) - Fetch leaderboard rankings from each exchange
2. **Enrichment** (batch-enrich) - Fetch detailed trader profiles, snapshots, equity curves
3. **Computation** (compute-leaderboard) - Calculate Arena Scores and aggregate rankings

All connectors extend `BaseConnector` (new) or `BaseConnectorLegacy`, both providing:
- HTTP request helpers with retry + exponential backoff
- Rate limiting via `TokenBucketRateLimiter` or `InlineRateLimiter`
- Circuit breaker pattern (5 failures -> open for 60s)
- Request timeout (default 30s)

---

## 2. Per-Exchange Connector Analysis

### Tier 1: High Reliability (Recommended reliability score: 8-10/10)

| Exchange | Scraping Difficulty | Circuit Breaker | Retry | Rate Limit | 429 Handling | Proxy | Timeout | Timeseries | Native Windows | Reliability Score |
|----------|-------------------|-----------------|-------|------------|--------------|-------|---------|------------|----------------|-------------------|
| **Bybit** | 2 | Yes (base) | 3x | 30 rpm / 2 conc | Yes (base) | CF Worker | 30s | Yes | 7d,30d,90d | **9/10** |
| **Hyperliquid** | 1 | Yes (base) | 3x | 60 rpm / 3 conc | Yes (base) | None needed | 30s | Yes | 7d,30d,90d | **9/10** |
| **dYdX** | 1 | Yes (base) | 3x | 60 rpm / 3 conc | Yes (base) | CF Worker (geo) | 30s | Yes | 7d,30d,90d | **9/10** |
| **Bitget** | 2 | Yes (base) | 3x | 20 rpm / 2 conc | Yes (base) | CF Worker | 30s | Yes | 7d,30d,90d | **8/10** |
| **GMX** | 1 | Yes (base) | 3x | 30 rpm / 3 conc | Yes (base) | CF Worker | 30s | Yes (subgraph) | 7d,30d,90d | **8/10** |

**Notes:**
- Bybit uses `api2.bybit.com` which bypasses Akamai WAF. Very stable.
- Hyperliquid and dYdX are DEX with public APIs and generous rate limits.
- dYdX has proxy fallback via `DYDX_PROXY_URL` or `CF_WORKER_PROXY_URL` for geo-blocked regions.
- GMX uses both REST API and subgraph. Subgraph may be slower but reliable.

### Tier 2: Moderate Reliability (Score: 5-7/10)

| Exchange | Scraping Difficulty | Circuit Breaker | Retry | Rate Limit | 429 Handling | Proxy | Timeout | Timeseries | Native Windows | Reliability Score |
|----------|-------------------|-----------------|-------|------------|--------------|-------|---------|------------|----------------|-------------------|
| **Binance** | 3 | Yes (base) | 3x | 20 rpm / 2 conc | Yes (base) | CF Worker | 30s | Yes | 7d,30d,90d | **7/10** |
| **OKX** | 3 | Yes (base) | 3x | 20 rpm / 2 conc | Yes (base) | CF Worker | 30s | Yes | 7d,30d,90d | **7/10** |
| **MEXC** | 2 | Yes (base) | 3x | 15 rpm / 1 conc | Yes (base) | None | 30s | No | 7d,30d,90d | **7/10** |
| **KuCoin** | 2 | Yes (base) | 3x | 15 rpm / 1 conc | Yes (base) | CF Worker | 30s | No | 7d,30d,90d | **6/10** |
| **CoinEx** | 2 | Yes (base) | 3x | 15 rpm / 1 conc | Yes (base) | None | 30s | No | 7d,30d (NO 90d) | **6/10** |
| **Phemex** | 2 | Yes (base) | 3x | 10 rpm / 1 conc | Yes (base) | None | 30s | No | 7d,30d,90d | **6/10** |
| **BingX** | 3 | Yes (base) | 3x | 20 rpm / 2 conc | Yes (base) | CF Worker | 30s | No | 7d,30d,90d | **6/10** |
| **Gains** | 2 | Yes (base) | 3x | 30 rpm / 5 conc | Yes (base) | CF Worker | 30s | No | 7d,30d,90d | **6/10** |

**Notes:**
- Binance has CloudFlare protection, requires realistic headers. Works through CF Worker proxy.
- OKX uses `priapi` endpoints with CF protection. Geo-blocked in some regions.
- MEXC, Phemex have reasonable APIs but low rate limits.
- CoinEx lacks 90d window natively.
- BingX uses internal API (`api-app.qq-os.com`) which is CF-blocked directly; CF Worker proxy available.
- Gains calculates metrics from trade history (more expensive per-request).

### Tier 3: Low Reliability (Score: 2-4/10)

| Exchange | Scraping Difficulty | Circuit Breaker | Retry | Rate Limit | Proxy | Timeout | Native Windows | Reliability Score |
|----------|-------------------|-----------------|-------|------------|-------|---------|----------------|-------------------|
| **HTX** | 3 | Yes (base) | 3x | 10 rpm / 1 conc | None | 30s | 7d,30d,90d | **4/10** |
| **BitMart** | 3 | Yes (base) | 3x | 10 rpm / 1 conc | None | 30s | 7d,30d (NO 90d) | **4/10** |
| **WEEX** | 3 | Yes (base) | 3x | 10 rpm / 1 conc | None | 30s | 7d,30d (NO 90d) | **4/10** |
| **Gate.io** | 3 | Yes (base) | 3x | 20 rpm / 2 conc | None | 30s | 7d,30d,90d | **3/10** |
| **BloFin** | 3 | Yes (base) | 3x | 30 rpm / 3 conc | CF Worker | 30s | 7d,30d,90d | **3/10** |
| **XT** | 4 | Yes (base) | 3x | 15 rpm / 2 conc | None | 30s | 7d,30d,90d | **3/10** |
| **MUX** | 2 | Yes (base) | 3x | 30 rpm / 5 conc | None | 30s | 7d,30d,90d | **3/10** |

**Notes:**
- HTX (Huobi) has frequent API/DOM changes. No dedicated proxy.
- BitMart and WEEX lack 90d window. Aggressive CF protection.
- Gate.io API endpoints are speculative (may require web scraping).
- BloFin API may require authentication; freshness check has 48h/72h override thresholds.
- XT has no public API (scraping difficulty 4). Connector silently returns empty on failure.

### Tier 4: Non-functional / Stub (Score: 0-1/10)

| Exchange | Notes | Reliability Score |
|----------|-------|-------------------|
| **LBank** | No public API. Stub connector returns empty metrics. | **1/10** |
| **Pionex** | No public API. Bot-focused, not manual traders. Stub only. | **0/10** |
| **Kwenta** | File exists but not registered in connector registry. | **0/10** |

---

## 3. Error Handling Robustness Summary

### What every connector gets from `BaseConnector.request()`:
- **Circuit breaker**: Checked via `rateLimiter.isCircuitOpen()` before each request. Opens after 5 consecutive failures, recovers after 60s.
- **Retry logic**: 3 retries with exponential backoff (2s base, doubling + jitter).
- **429 handling**: Reads `Retry-After` header, marks as retryable, records failure in rate limiter.
- **Timeout**: 30s per request via `AbortController`.
- **Non-retryable errors**: 4xx (non-429) errors are thrown immediately without retry.
- **Server errors**: 5xx errors trigger retry with backoff.

### What is NOT handled:
- **Proxy fallback at connector level**: Only dYdX has built-in proxy URL resolution. Other exchanges use the CF Worker proxy at the cron/fetcher layer (legacy code), not in the new `BaseConnector` platform connectors.
- **HTML/WAF response detection**: Only the CF Worker detects HTML responses (Bybit handler). The platform connectors do NOT check if `response.json()` parses HTML garbage.
- **Adaptive rate limiting**: Rate limits are static. No dynamic adjustment based on observed 429 rates.
- **Connection pooling**: Each request creates a new `fetch()`. No keep-alive optimization.

---

## 4. Proxy / Geo-blocking Configuration

### Cloudflare Worker Proxy (`cloudflare-worker/src/index.ts`)

**Deployed at**: `ranking-arena-proxy.broosbook.workers.dev`

**Exchanges with dedicated shortcut endpoints:**
| Endpoint | Exchange |
|----------|----------|
| `/binance/copy-trading` | Binance Futures |
| `/binance/spot-copy-trading` | Binance Spot |
| `/bybit/copy-trading` | Bybit |
| `/bitget/copy-trading` | Bitget |
| `/kucoin/copy-trading` | KuCoin |
| `/dydx/leaderboard`, `/dydx/historical-pnl`, `/dydx/subaccount` | dYdX |
| `/bingx/leaderboard`, `/bingx/trader-detail` | BingX |
| `/blofin/leaderboard`, `/blofin/trader-info` | BloFin |
| `/gains/leaderboard-all`, `/gains/open-trades`, `/gains/trader-stats` | Gains Network |

**Generic proxy**: `/proxy?url=<encoded_url>` for any host in the ALLOWED_HOSTS whitelist.

**Allowed hosts** (29 domains): Covers binance, bybit, bitget, mexc, okx, kucoin, coinex, htx, gmx, dydx, hyperliquid, blofin, bingx, gains.

### Exchanges Needing Proxy
| Exchange | Geo-blocked | CF-Protected | Proxy Available | Status |
|----------|-------------|--------------|-----------------|--------|
| Binance | Yes (some regions) | Yes | CF Worker | OK |
| Bybit | Partial | Yes (Akamai) | CF Worker + api2 bypass | OK |
| OKX | Yes (some regions) | Yes | CF Worker generic | OK |
| dYdX | Yes (some regions) | No | CF Worker dedicated | OK |
| BingX | N/A | Yes | CF Worker dedicated | OK |
| BloFin | N/A | Partial | CF Worker dedicated | OK |
| HTX | Partial | Yes | **NO proxy configured** | GAP |
| BitMart | N/A | Yes (aggressive) | **NO proxy configured** | GAP |
| WEEX | N/A | Yes (aggressive) | **NO proxy configured** | GAP |
| Gate.io | Partial | Yes | **NO proxy configured** | GAP |
| XT | N/A | Yes | **NO proxy configured** | GAP |

### Environment Variables Used
- `CLOUDFLARE_PROXY_URL` - Main CF Worker proxy URL (used by legacy fetchers)
- `DYDX_PROXY_URL` - dYdX-specific proxy (used by new connector)
- `CF_WORKER_PROXY_URL` - Alternative env var for CF Worker
- `VPS_PROXY_URL` / `VPS_PROXY_JP` - VPS proxy for Bybit fallback
- `VPS_PROXY_KEY` - Authentication key for VPS proxy

---

## 5. Cron Job Scheduling Analysis

### Discovery Jobs (batch-fetch-traders)

| Group | Platforms | Schedule | Interval | Potential Issues |
|-------|----------|----------|----------|-----------------|
| A | binance_futures, binance_spot, bybit, bitget_futures, okx_futures | `55 */3 * * *` | 3h | None - high priority |
| B | mexc, kucoin, okx_web3, hyperliquid, gmx, jupiter_perps, aevo | `2 */4 * * *` | 4h | None |
| C | coinex, bitget_spot, xt, bybit_spot, binance_web3 | `15 */6 * * *` | 6h | XT/binance_web3 may always fail |
| D | lbank, dydx, phemex, gains, htx_futures, weex | `25 */6 * * *` | 6h | lbank always fails (no API) |
| E | blofin, bingx, gateio, cryptocom, bitfinex | `35 */8 * * *` | 8h | gateio/cryptocom/bitfinex likely fail |
| F | whitebit, btse, toobit, uniswap, pancakeswap | `45 */12 * * *` | 12h | Most have no connectors |

**Schedule conflicts**: No overlaps. Groups are well-staggered (offset by 10-15 min).

**Gap identified**: Groups E and F contain platforms (cryptocom, bitfinex, whitebit, btse, toobit, uniswap, pancakeswap) that have NO connectors registered in `initializeConnectors()`. These cron calls will trigger HTTP 404 or empty results every cycle, wasting cron execution time.

### Enrichment Jobs

| Job | Schedule | Platforms | Period |
|-----|----------|-----------|--------|
| batch-enrich (default) | `10 */4 * * *` | HIGH + MEDIUM priority | 90D |
| batch-enrich period=30D | `20 */6 * * *` | HIGH priority only | 30D |
| batch-enrich period=7D | `30 */6 * * *` | HIGH priority only | 7D |

HIGH_PRIORITY: binance_futures, bybit, okx_futures, bitget_futures, hyperliquid, gmx
MEDIUM_PRIORITY: binance_spot, bybit_spot, bitget_spot, mexc, htx_futures, dydx
LOWER_PRIORITY: kucoin, gains, jupiter_perps, aevo

**Gap**: LOWER_PRIORITY platforms are never enriched unless `all=true` is passed. No cron job calls `batch-enrich?all=true`.

### Other Pipeline Jobs

| Job | Schedule | Purpose |
|-----|----------|---------|
| compute-leaderboard | `0 * * * *` | Hourly Arena Score computation |
| check-data-freshness | `0 */3 * * *` | Every 3h freshness check |
| check-enrichment-freshness | `15 */6 * * *` | Every 6h enrichment freshness |
| fetch-details (hot) | `*/15 * * * *` | Every 15min, top 150 traders |
| fetch-details (normal) | `22 */4 * * *` | Every 4h, 500 traders |
| batch-5min | `*/5 * * * *` | High-frequency updates |
| aggregate-daily-snapshots | `5 0 * * *` | Daily rollup |
| backfill-data (snapshots) | `50 */2 * * *` | Every 2h, 200 records |
| backfill-data (enrichment) | `5 */3 * * *` | Every 3h, 150 records |
| calculate-advanced-metrics | `35 */4 * * *` | Every 4h |
| precompute-composite | `0 */2 * * *` | Every 2h |

**Total cron jobs**: 40 (including avatar backfills). Vercel Hobby plan limit is 2, Pro plan has no limit per the docs, but cost scales.

---

## 6. Data Freshness Monitoring

### Snapshot Freshness (`check-data-freshness`)
- **Stale threshold**: 8 hours (default)
- **Critical threshold**: 24 hours (default)
- **Platform overrides**:
  - BloFin: stale=48h, critical=72h
  - GMX: stale=48h, critical=72h
  - Gains: stale=48h, critical=72h
- **Alerting**: Sentry + Telegram + external (Slack/Feishu)

### Enrichment Freshness (`check-enrichment-freshness`)
- **Stale threshold**: 12 hours
- **Critical threshold**: 48 hours
- **Checks**: `trader_stats_detail` + `trader_equity_curve` for each platform/period combo
- **Bonus**: Also checks `sharpe_ratio` fill rate in `trader_snapshots`
- **Alerting**: Sentry + rate-limited alerts (1h cooldown)

### Gaps in Freshness Monitoring
1. No freshness override for platforms that are effectively stubs (LBank, Pionex, XT). These will always show as "critical" or "unknown".
2. No per-platform freshness check for the newer exchanges (BingX, BloFin, Gate.io, WEEX, BitMart) in the enrichment freshness check (only 11 platforms are monitored there).
3. The `PLATFORM_NAMES` map in `check-data-freshness` includes `okx_web3` but the connectors use `okx` as the platform key. Potential mismatch.

---

## 7. Specific Findings & Recommendations

### Critical Issues

1. **Silent failures in stub connectors**: LBank, Pionex, XT, Gate.io connectors silently catch all errors and return empty results. This masks persistent failures. Group E and F cron jobs waste execution time calling platforms with no functional connectors.

   **Recommendation**: Remove non-functional platforms from batch-fetch-traders groups or mark them as `status: 'disabled'` so cron jobs skip them.

2. **No HTML response detection in new connectors**: The `BaseConnector.request()` method calls `response.json()` directly. If an exchange returns an HTML error page (CloudFlare challenge, WAF block), the JSON parse will throw a generic error with no clear indication of what happened.

   **Recommendation**: Add content-type check before `response.json()`:
   ```typescript
   const contentType = response.headers.get('content-type') || ''
   if (!contentType.includes('application/json')) {
     throw new ConnectorError('Non-JSON response (possible WAF block)', ...)
   }
   ```

3. **Proxy not wired to new platform connectors**: The new `BaseConnector`-based connectors in `lib/connectors/platforms/` make direct API calls to exchange URLs. The CF Worker proxy is only used by legacy fetchers in `lib/cron/fetchers/` and `worker/src/lib/fetchers/`. Platforms like Binance, OKX, and Bybit that need proxy access will fail when called through the new connector system if deployed in a geo-blocked region.

   **Recommendation**: Add proxy URL resolution to `BaseConnector.request()` or configure it per-connector via `ConnectorConfig.proxyUrl`.

### High Priority Issues

4. **Missing enrichment for lower-priority platforms**: kucoin, gains, jupiter_perps, and aevo are in LOWER_PRIORITY and never enriched by any cron job (no `all=true` cron call exists).

   **Recommendation**: Add a weekly or bi-daily cron: `batch-enrich?all=true&period=90D` at a low-traffic time.

5. **HTX, BitMart, WEEX, Gate.io, XT have no proxy fallback**: These platforms have high scraping difficulty (3-4) but no proxy configured. They will fail in geo-blocked deployments.

   **Recommendation**: Add these hosts to the CF Worker ALLOWED_HOSTS (HTX/BitMart/WEEX are already there) and add dedicated shortcut endpoints for commonly blocked platforms.

6. **CoinEx, BitMart, WEEX lack 90d window**: These platforms return empty/null metrics for 90d. This affects Arena Score calculation for their traders.

   **Recommendation**: Document this limitation in the UI. Consider deriving approximate 90d stats from 30d data where possible.

### Medium Priority Issues

7. **Circuit breaker state is in-memory per-instance**: In a serverless environment (Vercel), each request may run in a different instance. The circuit breaker state is lost between invocations, making it less effective at preventing cascading failures.

   **Recommendation**: For critical protection, consider persisting circuit breaker state in Redis (Upstash).

8. **Rate limiter tokens reset per-instance**: Same serverless issue. Each cold start gets a fresh token bucket, potentially exceeding rate limits if many instances start simultaneously.

   **Recommendation**: Accept this trade-off for now but monitor 429 rates. If problematic, use Redis-based rate limiting.

9. **Duplicate circuit breaker implementations**: There are three separate implementations:
   - `base.ts` -> `CircuitBreaker` class (inline, for legacy)
   - `circuit-breaker.ts` -> `SimpleCircuitBreaker` and `CircuitBreakerManager`
   - `rate-limiter.ts` -> built-in circuit breaker in `TokenBucketRateLimiter`

   **Recommendation**: Consolidate to a single implementation.

10. **Gains connector discovers traders from open-trades only**: The `discoverLeaderboard()` method gets active traders from `/open-trades` endpoint, not from a ranked leaderboard. This means it only finds traders with currently open positions, missing profitable traders who are flat.

    **Recommendation**: Use the `/leaderboard/all` endpoint (already available in CF Worker) instead.

### Low Priority Issues

11. **kwenta-perp.ts** connector file exists in `platforms/` but is NOT registered in `initializeConnectors()`. Dead code.

12. **Pionex connector** has scraping difficulty 5 and will never return data. Should be removed or clearly documented as placeholder.

13. **MUX connector** uses The Graph's hosted service subgraph which may be deprecated. Should migrate to Subgraph Studio.

14. **Bybit connector** uses `api2.bybit.com` directly in the new connector but the CF Worker also has a dedicated `/bybit/copy-trading` endpoint. No fallback chain between them.

---

## 8. Refresh Frequency Summary

| Exchange | Discovery | Enrichment (90D) | Enrichment (30D/7D) | Effective Data Lag |
|----------|-----------|-------------------|---------------------|--------------------|
| Binance Futures | 3h | 4h | 6h | ~3h |
| Binance Spot | 3h | 4h | N/A (high only) | ~4h |
| Bybit | 3h | 4h | 6h | ~3h |
| Bitget Futures | 3h | 4h | 6h | ~3h |
| OKX Futures | 3h | 4h | 6h | ~3h |
| Hyperliquid | 4h | 4h | 6h | ~4h |
| GMX | 4h | 4h | 6h | ~4h |
| MEXC | 4h | 4h | N/A | ~4h |
| KuCoin | 4h | Never (lower priority) | Never | ~4h discovery only |
| dYdX | 6h | 4h (medium) | N/A | ~6h |
| CoinEx | 6h | Never | Never | ~6h discovery only |
| HTX | 6h | 4h (medium) | N/A | ~6h |
| Phemex | 6h | Never | Never | ~6h discovery only |
| Gains | 6h | Never (lower priority) | Never | ~6h discovery only |
| WEEX | 6h | Never | Never | ~6h discovery only |
| BloFin | 8h | Never | Never | ~8h discovery only |
| BingX | 8h | Never | Never | ~8h discovery only |
| Gate.io | 8h | Never | Never | ~8h discovery only |
| LBank | 8h | Never | Never | Never (stub) |
| XT | 6h | Never | Never | ~6h (likely fails) |
| BitMart | 6h | Never | Never | ~6h discovery only |

---

## 9. Action Items (Priority Order)

| # | Priority | Action | Impact |
|---|----------|--------|--------|
| 1 | Critical | Add HTML/WAF response detection to `BaseConnector.request()` | Prevents silent data corruption |
| 2 | Critical | Wire proxy URLs to new platform connectors (Binance, OKX, BingX at minimum) | Prevents geo-blocking failures |
| 3 | High | Remove non-functional platforms from cron groups E/F (or add connectors) | Saves cron execution time |
| 4 | High | Add `batch-enrich?all=true` cron for lower-priority platforms | Ensures enrichment coverage |
| 5 | High | Add proxy for HTX, BitMart, WEEX | Improves Tier 3 reliability |
| 6 | Medium | Add platform-specific freshness thresholds for stubs | Reduces false positive alerts |
| 7 | Medium | Fix Gains `discoverLeaderboard` to use `/leaderboard/all` | Better trader discovery |
| 8 | Low | Remove dead code: kwenta connector, Pionex stub | Code hygiene |
| 9 | Low | Consolidate circuit breaker implementations | Maintainability |
| 10 | Low | Consider Redis-based rate limiting for serverless | Better rate limit compliance |
