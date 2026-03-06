# Arena Data Audit Report

**Date**: 2026-03-06
**Scope**: Full audit of data completeness, stability, and freshness across all exchanges, categories, and time windows.

---

## 1. Data Coverage Matrix

### 1.1 Exchange x Category x Time Window

Legend:
- **OK** = Connector implemented + fetcher registered + cron scheduled
- **PARTIAL** = Some gaps (e.g., missing 90d, stub connector)
- **STUB** = Connector exists but returns empty/error data (no working API)
- **NONE** = No connector or fetcher exists
- **FETCH-ONLY** = Has inline fetcher but no new-style connector in registry

#### CEX Exchanges

| Exchange | Category | 7D | 30D | 90D | Connector | Fetcher | Cron Group | Avatar Backfill |
|----------|----------|:--:|:---:|:---:|:---------:|:-------:|:----------:|:---------------:|
| Binance Futures | futures | OK | OK | OK | New+Legacy | OK | A (3h) | OK |
| Binance Spot | spot | OK | OK | OK | Legacy only | OK | A (3h) | OK |
| Binance Web3 | onchain | OK | OK | OK | NONE | OK | C (6h) | NONE |
| Bybit | futures | OK | OK | OK | New+Legacy | OK | A (3h) | OK |
| Bybit Spot | spot | OK | OK | OK | NONE | OK | C (6h) | NONE |
| Bitget Futures | futures | OK | OK | OK | New+Legacy | OK | A (3h) | OK |
| Bitget Spot | spot | OK | OK | OK | Legacy only | OK | C (6h) | NONE |
| OKX Futures | futures | OK | OK | OK | New | OK | A (3h) | OK |
| OKX Web3 | onchain | OK | OK | OK | NONE | OK | B (4h) | NONE |
| MEXC | futures | OK | OK | OK | New+Legacy | OK | B (4h) | OK |
| KuCoin | futures | OK | OK | OK | New+Legacy | OK | B (4h) | OK |
| CoinEx | futures | OK | OK | **NONE** | New+Legacy | OK | C (6h) | OK |
| HTX | futures | OK | OK | OK | New | OK | D (6h) | OK |
| Phemex | futures | OK | OK | OK | New | OK | D (6h) | OK |
| WEEX | futures | OK | OK | **NONE** | New | OK | D (6h) | OK |
| BingX | futures | OK | OK | OK | New | OK | E (8h) | OK |
| Gate.io | futures | OK | OK | OK | New | OK | E (8h) | NONE |
| XT | futures | OK | OK | OK | New | OK | C (6h) | OK |
| LBank | futures | **STUB** | **STUB** | **STUB** | New (stub) | OK | D (6h) | OK |
| BloFin | futures | OK | OK | OK | New | OK | E (8h) | OK |
| BitMart | futures | OK | OK | **NONE** | New | NONE | NONE | NONE |
| Pionex | futures | **STUB** | **STUB** | **STUB** | NONE | OK | NONE | NONE |

#### DEX / On-chain Exchanges

| Exchange | Category | 7D | 30D | 90D | Connector | Fetcher | Cron Group | Avatar |
|----------|----------|:--:|:---:|:---:|:---------:|:-------:|:----------:|:------:|
| Hyperliquid | perp/onchain | OK | OK | PARTIAL* | New+Legacy | OK | B (4h) | N/A |
| dYdX | perp/onchain | OK | OK | OK | New | OK | D (6h) | N/A |
| GMX | perp/onchain | OK | OK | OK | New | OK | B (4h) | N/A |
| Gains Network | perp/onchain | OK | OK | OK | New | OK | D (6h) | N/A |
| Jupiter Perps | perp/onchain | OK | OK | OK | NONE | OK | B (4h) | N/A |
| Aevo | perp/onchain | OK | OK | OK | NONE | OK | B (4h) | N/A |
| Kwenta | perp/onchain | OK | OK | OK | NONE | FETCH-ONLY | NONE | N/A |
| MUX | perp/onchain | OK | OK | OK | NONE | FETCH-ONLY | NONE | N/A |

*Hyperliquid 90d uses "allTime" as proxy since native 90d is not available.

#### Config-Driven / New Exchanges (fetcher only, no connector)

| Exchange | Category | 7D | 30D | 90D | Cron Group | Notes |
|----------|----------|:--:|:---:|:---:|:----------:|:------|
| Toobit | futures | OK | OK | OK | F (12h) | Config-driven fetcher |
| BTSE | futures | OK | OK | OK | F (12h) | Config-driven fetcher |
| Crypto.com | futures | OK | OK | OK | E (8h) | Config-driven fetcher |
| Bitfinex | futures | OK | OK | OK | E (8h) | Inline fetcher |
| WhiteBIT | futures | OK | OK | OK | F (12h) | Inline fetcher |
| Uniswap | spot/onchain | OK | OK | OK | F (12h) | DEX inline fetcher |
| PancakeSwap | spot/onchain | OK | OK | OK | F (12h) | DEX inline fetcher |

#### Not-Yet-Functional / Blocked

| Exchange | Status | Notes |
|----------|--------|-------|
| Drift | BLOCKED | Requires API key (DRIFT_API_KEY env). Fetcher code exists. |
| Vertex | BLOCKED | No public leaderboard API. Stub fetcher returns error. |
| Synthetix V3 | BLOCKED | Requires THEGRAPH_API_KEY. Fetcher code exists. |
| Dune GMX | NOT IMPL | Type defined, rate limits set, but no connector or fetcher |
| Dune Hyperliquid | NOT IMPL | Type defined, rate limits set, but no connector or fetcher |
| Dune Uniswap | NOT IMPL | Type defined, rate limits set, but no connector or fetcher |
| Dune DeFi | NOT IMPL | Type defined, rate limits set, but no connector or fetcher |

### 1.2 Summary Counts

| Metric | Count |
|--------|-------|
| Total exchanges with working fetchers | **31** |
| Exchanges with new-style connectors (registry) | **20** |
| Exchanges with legacy connectors | **10** |
| Exchanges with cron scheduling | **~29** (across 6 groups) |
| Exchanges with 90d gap | **3** (CoinEx, BitMart, WEEX) |
| Stub/non-functional connectors | **2** (LBank, Pionex) |
| Blocked pending API keys | **3** (Drift, Vertex, Synthetix) |
| Defined but unimplemented | **4** (Dune_* sources) |

---

## 2. Avatar Coverage

### 2.1 Avatar Backfill Cron Jobs (vercel.json)

The following platforms have dedicated avatar backfill cron jobs running daily:

| Platform | Schedule | Limit | Bulk Fetcher | Individual Fetcher |
|----------|----------|-------|:------------:|:------------------:|
| binance_futures | 2:30 AM | 200 | OK | OK |
| bybit | 3:30 AM | 200 | OK | OK |
| bitget_futures | 4:30 AM | 200 | OK | OK |
| okx_futures | 5:30 AM | 200 | OK (bulk) | OK |
| mexc | 6:30 AM | 200 | NONE | OK |
| kucoin | 7:30 AM | 200 | NONE | OK |
| htx_futures | 8:30 AM | 200 | OK (bulk) | OK |
| bingx | 9:30 AM | 200 | NONE | OK |
| coinex | 10:30 AM | 200 | NONE | OK |
| lbank | 11:30 AM | 200 | NONE | OK |

### 2.2 Platforms WITH Avatar Support (but no scheduled backfill)

These have individual or bulk fetchers but no cron entry:

| Platform | Bulk | Individual | Missing Cron |
|----------|:----:|:----------:|:------------:|
| binance_spot | OK | OK | YES - should add |
| bitget_spot | OK | OK | YES - should add |
| weex | NONE | OK | YES - should add |
| phemex | NONE | OK | YES - should add |
| blofin | NONE | OK | YES - should add |
| xt | OK (bulk) | OK | YES - should add |

### 2.3 Platforms WITHOUT Avatar (by design)

DEX platforms (wallet addresses only, no profile images):
- Hyperliquid, dYdX, GMX, Gains, Jupiter Perps, Aevo, Kwenta, MUX, Uniswap, PancakeSwap

### 2.4 Avatar Fallback in UI

The trader detail page fetches `avatar_url` from `trader_sources` table. If null, the UI should use a fallback (blockie/identicon for DEX addresses, generic avatar for CEX). This is handled by the frontend component.

---

## 3. Trader Page Data Gaps

### 3.1 Trader Profile Page Data Requirements

The trader detail page (`/trader/[handle]/`) reads from:
- `trader_sources`: handle, source, source_trader_id, avatar_url
- `leaderboard_ranks`: rank, arena_score, roi, pnl
- Additional: equity curves, positions, enrichment data

### 3.2 Per-Exchange Field Availability

| Field | Binance | Bybit | Bitget | OKX | MEXC | KuCoin | Hyperliq | dYdX | GMX | Gains |
|-------|:-------:|:-----:|:------:|:---:|:----:|:------:|:--------:|:----:|:---:|:-----:|
| ROI | OK | OK | OK | OK | OK | OK | Computed | Computed | Computed | Computed |
| PnL | OK | OK | OK | OK | OK | OK | OK | OK | OK | OK |
| Win Rate | null* | OK | OK | OK | OK | OK | null | null | OK | OK |
| Max Drawdown | null* | OK | OK | OK | OK | OK | null | null | null | OK |
| Sharpe Ratio | null | null | null | null | null | null | null | null | null | null |
| Sortino Ratio | null | null | null | null | null | null | null | null | null | null |
| Trades Count | null* | OK | OK | OK | null | null | null | null | OK | OK |
| Followers | null* | OK | OK | OK | OK | OK | N/A | N/A | N/A | N/A |
| Copiers | null | OK | OK | OK | OK | OK | N/A | N/A | N/A | N/A |
| AUM | null | OK | OK | OK | OK | null | OK | OK | OK* | null |
| Avatar | OK | OK | OK | OK | OK | OK | null | null | null | null |
| Bio | OK | OK | OK | OK | null | null | null | null | null | null |
| Timeseries | OK | OK | OK | OK | null | null | OK | OK | OK | null |

*Binance connector snapshot does not fetch win_rate/max_drawdown/trades_count/followers (requires additional API calls that are not implemented in the snapshot method).
*GMX AUM uses maxCapital as proxy.

### 3.3 Critical Data Gaps

1. **Binance Futures snapshot is incomplete**: The `fetchTraderSnapshot` only fetches ROI+PnL from the performance endpoint. Win rate, max drawdown, trades count, and followers require separate API calls that are NOT made. This is the **highest-volume exchange** and has the weakest per-trader enrichment.

2. **No exchange provides Sharpe/Sortino natively**: These are always null from connectors. The `calculate-advanced-metrics` cron job computes them, but only for traders with sufficient timeseries data.

3. **DEX platforms lack social metrics**: By design, Hyperliquid/dYdX/GMX/Gains have no followers/copiers/bio. Field degradation strategy handles this with "N/A" display.

4. **Timeseries sparse for many exchanges**: Only Binance, Bybit, Bitget, OKX, Hyperliquid, dYdX, and GMX provide timeseries. MEXC, KuCoin, CoinEx, HTX, WEEX, BingX, Gate.io, XT, LBank, BloFin, Phemex, Gains, Kwenta, MUX all return empty series.

---

## 4. Pipeline Stability Report

### 4.1 Cron Job Architecture

Total cron jobs in `vercel.json`: **43** (including 10 avatar backfills)

| Job Category | Count | Frequency |
|-------------|-------|-----------|
| Batch fetch traders (groups a-f) | 6 | 3h/4h/6h/8h/12h |
| Batch enrich (3 periods) | 3 | 4h/6h |
| Compute leaderboard | 1 | Hourly |
| Fetch details (hot/normal) | 2 | 15min/4h |
| Avatar backfill | 10 | Daily |
| Data quality checks | 3 | 3-4h |
| Backfill data | 2 | 2-3h |
| Market data/funding/OI | 3 | 1-4h |
| Other (alerts, analytics, etc.) | 13 | Various |

### 4.2 Geo-Blocking Status

| Exchange | Geo-Blocked | Mitigation |
|----------|:-----------:|:-----------|
| Binance | YES (from US/some regions) | CF Worker proxy in ALLOWED_HOSTS + Tokyo preferred region |
| OKX | YES (from US) | CF Worker proxy + priapi endpoints |
| dYdX v4 | YES (from some regions) | CF Worker proxy with DYDX_PROXY_URL env var |
| Bybit | PARTIAL | CF Worker proxy available |
| BingX | YES | CF Worker proxy (api-app.qq-os.com listed) |
| Others | No blocking observed | Direct API access |

The Cloudflare Worker proxy (`cloudflare-worker/src/index.ts`) supports a comprehensive allow-list of exchange API hosts including Binance, Bybit, Bitget, MEXC, OKX, KuCoin, CoinEx, HTX, dYdX, Hyperliquid, BloFin, and BingX.

### 4.3 Circuit Breaker Configuration

The `BaseConnector` class implements a circuit breaker with:
- **Failure threshold**: 5 consecutive failures to open circuit
- **Reset timeout**: 60 seconds before half-open attempt
- **Half-open max attempts**: 2

Each connector has per-platform rate limits defined in `PLATFORM_RATE_LIMITS`. DEX connectors have the most generous limits (30-60 rpm), while smaller CEX connectors are more conservative (10-15 rpm).

### 4.4 Known Failure Patterns

1. **LBank**: No public API. Connector is a stub that always returns empty metrics. The inline fetcher may attempt scraping but likely fails regularly.

2. **Pionex**: No public API. Bot-focused platform. Connector and fetcher are stubs.

3. **XT.com**: Marked scraping_difficulty=4. "Requires Puppeteer scraping" noted in connector. API attempts may fail with CF challenges.

4. **Gate.io**: "May require web scraping" noted. API endpoints are guessed/estimated.

5. **BitMart**: Not included in any batch-fetch-traders group or cron. Connector exists in the new registry but has no active scheduling. Aggressive CF protection noted.

6. **Kwenta/MUX**: Have connector files in `platforms/` directory and fetcher files, but are NOT registered in `initializeConnectors()` and NOT in any cron group. They are orphaned.

---

## 5. Connector Capabilities Matrix

### 5.1 New-Style Connectors (registered in `initializeConnectors`)

| Connector | Platform | Market | Windows | Profile | Timeseries | Positions | Difficulty |
|-----------|----------|--------|---------|:-------:|:----------:|:---------:|:----------:|
| BinanceFuturesConnector | binance | futures | 7d/30d/90d | OK | OK | OK | 3 |
| BybitFuturesConnector | bybit | futures | 7d/30d/90d | OK | OK | NONE | 2 |
| BitgetFuturesConnector | bitget | futures | 7d/30d/90d | OK | OK | NONE | 2 |
| OkxFuturesConnector | okx | futures | 7d/30d/90d | OK | OK | NONE | 3 |
| MexcFuturesConnector | mexc | futures | 7d/30d/90d | OK | NONE | NONE | 2 |
| CoinexFuturesConnector | coinex | futures | 7d/30d | OK | NONE | NONE | 2 |
| KucoinFuturesConnector | kucoin | futures | 7d/30d/90d | OK | NONE | NONE | 2 |
| BitmartFuturesConnector | bitmart | futures | 7d/30d | OK | NONE | NONE | 3 |
| PhemexFuturesConnector | phemex | futures | 7d/30d/90d | OK | NONE | NONE | 2 |
| HtxFuturesConnector | htx | futures | 7d/30d/90d | OK | NONE | NONE | 3 |
| WeexFuturesConnector | weex | futures | 7d/30d | OK | NONE | NONE | 3 |
| BingxFuturesConnector | bingx | futures | 7d/30d/90d | OK | NONE | NONE | 3 |
| GateioFuturesConnector | gateio | futures | 7d/30d/90d | OK | NONE | NONE | 3 |
| XtFuturesConnector | xt | futures | 7d/30d/90d | OK | NONE | NONE | 4 |
| LbankFuturesConnector | lbank | futures | stub | stub | NONE | NONE | 4 |
| BlofinFuturesConnector | blofin | futures | 7d/30d/90d | OK | NONE | NONE | 3 |
| HyperliquidPerpConnector | hyperliquid | perp | 7d/30d/90d* | minimal | OK | NONE | 1 |
| DydxPerpConnector | dydx | perp | 7d/30d/90d | minimal | OK | NONE | 1 |
| GmxPerpConnector | gmx | perp | 7d/30d/90d | minimal | OK | NONE | 1 |
| GainsPerpConnector | gains | perp | 7d/30d/90d | minimal | NONE | NONE | 2 |

### 5.2 Connector Files NOT Registered in Registry

These connector files exist in `lib/connectors/platforms/` but are NOT imported/registered in `initializeConnectors()`:

| File | Platform | Status |
|------|----------|--------|
| `pionex-futures.ts` | pionex | Stub - no API |
| `kwenta-perp.ts` | kwenta | Working - uses subgraph |
| `mux-perp.ts` | mux | Working - uses subgraph |

### 5.3 Legacy Connectors (separate registry)

These are in the old `getConnector()` registry and used by older code paths:

- binance_futures, binance_spot, bybit, bitget_futures, bitget_spot, okx, mexc, kucoin, hyperliquid, coinex

### 5.4 Inline Fetchers WITHOUT Connectors

These exist only as inline fetchers (used by `fetch-traders/[platform]` cron) and do NOT have a corresponding `platforms/*.ts` connector:

| Fetcher | Source File |
|---------|-------------|
| binance_web3 | `lib/cron/fetchers/binance-web3.ts` |
| bybit_spot | `lib/cron/fetchers/bybit-spot.ts` |
| okx_web3 | `lib/cron/fetchers/okx-web3.ts` |
| jupiter_perps | `lib/cron/fetchers/jupiter-perps.ts` |
| aevo | `lib/cron/fetchers/aevo.ts` |
| kwenta | `lib/cron/fetchers/kwenta.ts` (not in cron group) |
| mux | `lib/cron/fetchers/mux.ts` (not in cron group) |
| synthetix | `lib/cron/fetchers/synthetix.ts` (blocked) |
| drift | `lib/cron/fetchers/drift.ts` (blocked) |
| vertex | `lib/cron/fetchers/vertex.ts` (blocked) |
| uniswap | `lib/cron/fetchers/uniswap.ts` |
| pancakeswap | `lib/cron/fetchers/pancakeswap.ts` |
| cryptocom | `lib/cron/fetchers/cryptocom.ts` |
| bitfinex | `lib/cron/fetchers/bitfinex.ts` |
| whitebit | `lib/cron/fetchers/whitebit.ts` |
| btse | `lib/cron/fetchers/btse.ts` |
| toobit | `lib/cron/fetchers/toobit.ts` |

---

## 6. Recommendations

### Priority 1 - Critical Fixes

| # | Issue | Impact | Effort |
|---|-------|--------|--------|
| 1 | **Binance snapshot enrichment gap** - `fetchTraderSnapshot` only gets ROI+PnL. Add calls to fetch win_rate, max_drawdown, followers, trades_count from the detail/base-info endpoints. | HIGH - largest exchange, incomplete profiles | Medium |
| 2 | **Add BitMart to a cron group** - Connector exists in registry but not scheduled in any batch-fetch-traders group or cron. | MEDIUM - orphaned exchange | Low |
| 3 | **Register Kwenta/MUX connectors** - Working connector files exist but are not registered in `initializeConnectors()`. Add them and add to cron group. | MEDIUM - lost data | Low |

### Priority 2 - Data Quality Improvements

| # | Issue | Impact | Effort |
|---|-------|--------|--------|
| 4 | **Add avatar backfill for missing platforms** - binance_spot, bitget_spot, weex, phemex, blofin, xt all have avatar fetchers but no scheduled cron. | MEDIUM - missing avatars | Low |
| 5 | **Add Jupiter/Aevo to enrichment PLATFORM_CONFIGS** - They are in batch-fetch-traders group B but not in batch-enrich PLATFORM_CONFIGS, so they never get enriched. | MEDIUM - partial data | Low |
| 6 | **Fix CoinEx/BitMart/WEEX 90d gap** - These platforms genuinely don't support 90d. Ensure the UI properly degrades (shows "N/A" instead of stale/zero data). Already handled by field degradation strategy. | LOW - working as designed | None |

### Priority 3 - New Source Enablement

| # | Issue | Impact | Effort |
|---|-------|--------|--------|
| 7 | **Enable Drift** - Fetcher code exists. Requires DRIFT_API_KEY env var. | MEDIUM - large Solana DEX | Low (config only) |
| 8 | **Enable Synthetix V3** - Fetcher code exists. Requires THEGRAPH_API_KEY. | LOW - overlaps with Kwenta | Low (config only) |
| 9 | **Implement Dune connectors** - Types and rate limits defined for dune_gmx, dune_hyperliquid, dune_uniswap, dune_defi but no implementation. | LOW - supplementary data | High |
| 10 | **Vertex Protocol** - No public leaderboard API available. Requires custom indexer or partner API access. | LOW - niche DEX | Very High |

### Priority 4 - Architecture Cleanup

| # | Issue | Impact | Effort |
|---|-------|--------|--------|
| 11 | **Dual registry consolidation** - Legacy `getConnector()` and new `connectorRegistry` serve overlapping platforms. Consider migrating all to new registry. | LOW - tech debt | High |
| 12 | **Add Kwenta/MUX to batch-fetch-traders groups** - They have fetchers in `lib/cron/fetchers/` but are not listed in any cron group. | MEDIUM | Low |
| 13 | **Pionex decision** - Either implement a Puppeteer scraper or remove from type definitions to reduce confusion. | LOW - clarity | Low |

---

## 7. New Source Plan

### 7.1 Ready to Enable (config/key only)

| Exchange | What's Needed | Estimated Trader Count |
|----------|--------------|:----------------------:|
| Drift (Solana) | Set DRIFT_API_KEY env | ~500-1000 |
| Synthetix V3 (Base) | Set THEGRAPH_API_KEY | ~300-500 |

### 7.2 Recently Added (in fetchers, not yet mature)

| Exchange | Status | Cron Group |
|----------|--------|:----------:|
| Toobit | Config-driven, group F | F (12h) |
| BTSE | Config-driven, group F | F (12h) |
| Crypto.com | Config-driven, group E | E (8h) |
| Bitfinex | Inline fetcher, group E | E (8h) |
| WhiteBIT | Inline fetcher, group F | F (12h) |
| Uniswap | Inline fetcher, group F | F (12h) |
| PancakeSwap | Inline fetcher, group F | F (12h) |

### 7.3 Potential Future Sources

| Exchange | Difficulty | Notes |
|----------|:----------:|-------|
| Vertex Protocol | Very High | No public API; requires custom indexer |
| Dune Analytics (4 sources) | High | Requires Dune API key + query authoring |
| Rabby / DeBank | Medium | Wallet-level aggregation, not exchange-specific |
| Zeta Markets (Solana) | Medium | Solana perps DEX, may have public API |
| Orderly Network | Medium | Multi-chain orderbook DEX |

### 7.4 Exchanges Mentioned in Code But Not Connected

From `GRANULAR_PLATFORMS` type and `LEADERBOARD_PLATFORMS`:
- `pionex` - defined but stub (no API)
- `kwenta` - has working connector + fetcher but NOT registered/scheduled
- `mux` - has working connector + fetcher but NOT registered/scheduled
- `jupiter_perps` - has fetcher, scheduled in group B, but no connector
- `aevo` - has fetcher, scheduled in group B, but no connector
- `dune_gmx`, `dune_hyperliquid`, `dune_uniswap`, `dune_defi` - types defined, no implementation

---

## 8. Architecture Summary

### Data Flow

```
Exchange APIs
    |
    v
Inline Fetchers (lib/cron/fetchers/)     <-- Cron: batch-fetch-traders (groups a-f)
    |
    v
trader_sources table (Supabase)
    |
    v
New-style Connectors (lib/connectors/platforms/)  <-- Cron: batch-enrich, fetch-details
    |
    v
leaderboard_ranks + trader_stats_detail tables
    |
    v
compute-leaderboard cron  <-- Hourly
    |
    v
Rankings API / Trader Detail Pages
```

### Two Connector Systems

1. **Inline Fetchers** (`lib/cron/fetchers/`): 31 platform fetchers. Used by `fetch-traders/[platform]` cron route. Write directly to `trader_sources` table. This is the **primary data ingestion** path.

2. **Platform Connectors** (`lib/connectors/platforms/`): 20+3 connector classes. Used by enrichment pipeline, detail fetching, and the new connector registry. This is the **enrichment** path for profiles, snapshots, and timeseries.

The dual system means a platform can have data flowing through fetchers without having a connector for enrichment, resulting in basic leaderboard data (ROI/PnL) without detailed profiles/metrics.

---

## 9. Key Files Reference

| Purpose | Path |
|---------|------|
| Platform types/enums | `lib/types/leaderboard.ts` |
| Connector registry | `lib/connectors/registry.ts` |
| Base connector class | `lib/connectors/base.ts` |
| All platform connectors | `lib/connectors/platforms/*.ts` |
| All inline fetchers | `lib/cron/fetchers/*.ts` |
| Fetcher registry | `lib/cron/fetchers/index.ts` |
| Batch fetch groups | `app/api/cron/batch-fetch-traders/route.ts` |
| Batch enrich config | `app/api/cron/batch-enrich/route.ts` |
| Avatar backfill | `app/api/cron/backfill-avatars/route.ts` |
| Cron schedule | `vercel.json` |
| Cloudflare Worker proxy | `cloudflare-worker/src/index.ts` |
| Pipeline health API | `app/api/health/pipeline/route.ts` |
| Trader detail page | `app/trader/[handle]/page.tsx` |
| Trader data adapter | `lib/data/trader.ts` |
