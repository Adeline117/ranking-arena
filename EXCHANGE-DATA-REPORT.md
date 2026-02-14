# Exchange Spot Copy Trading — Data Field Report

**Date**: 2026-02-14  
**Investigator**: Automated exchange explorer  
**Scope**: 14 exchanges checked for spot copy trading availability and data fields

---

## 1. Summary: Spot Copy Trading Availability

| Exchange | Spot Copy Trading | Status | Traders | Notes |
|----------|:-:|--------|---------|-------|
| **Binance** | ✅ | Active, imported | ~500+ | Full API (bapi), geo-restricted (need VPS) |
| **Bybit** | ✅ | Active, imported | ~500+ | Internal API via Puppeteer session |
| **Bitget** | ✅ | Active, imported | ~500+ | CF-protected, Puppeteer intercept |
| **BingX** | ✅ | Active, imported | ~68 | DOM scrape via Playwright |
| OKX | ❌ | Futures only | — | `instType=SPOT` param ignored, returns SWAP data |
| MEXC | ❌ | Futures only | — | URL path: `/futures/copyTrade/home` |
| KuCoin | ❌ | Futures only | — | No spot tab on copy trading page |
| Gate.io | ⚠️ | Defunct | 41 (all paused) | API exists but all traders suspended, zero data |
| HTX | ❌ | No copy trading page | — | `/copy-trading` returns 404 |
| Phemex | ❌ | Futures only | — | `/copy-trading` redirects to 404 |
| CoinEx | ❌ | Futures only | — | API returns only contract traders |
| LBank | ❌ | Futures only | — | FAQ discusses margin/leverage only |
| Toobit | ❌ | Futures only | — | JS-rendered, contract traders only |
| BloFin | ❌ | Futures only | — | CF-protected, futures-focused |

**Conclusion: Only 4 exchanges have active spot copy trading: Binance, Bybit, Bitget, BingX** (all already imported).

---

## 2. Data Fields Available Per Platform

### Binance Spot
**List API**: `bapi/futures/v1/friendly/future/copy-trade/home-page/query-list`  
**Detail API**: `bapi/futures/v1/public/future/copy-trade/lead-portfolio/detail`  
**Performance API**: `bapi/futures/v1/public/future/copy-trade/lead-portfolio/performance`

| Field | List | Detail | Currently Captured |
|-------|:----:|:------:|:--:|
| ROI (%) | ✅ | ✅ | ✅ |
| PnL (USD) | ✅ | ✅ | ✅ |
| Win Rate | ❌ | ❌ | ⚠️ Computed from chartItems |
| Max Drawdown | ✅ | ✅ | ✅ |
| Trades Count | ✅ (tradingDays) | ✅ | ✅ |
| Followers | ✅ | ✅ | ✅ |
| Copiers | ✅ | ✅ | ✅ |
| AUM (totalAsset) | ❌ | ✅ | ✅ |
| Sharpe Ratio | ❌ | ❌ | ❌ (not available) |
| Sortino Ratio | ❌ | ❌ | ❌ |
| Profit Factor | ❌ | ❌ | ❌ |
| Equity Curve | ✅ (chartItems) | — | ❌ Not stored |
| Positions | ❌ | ❌ | ❌ |

**Key insight**: `chartItems` in list API provides daily equity curve data — can be stored as timeseries.

### Bybit Spot
**List API**: `/x-api/fapi/beehive/public/v1/common/dynamic-leader-list`  
**Detail API**: `/fapi/beehive/public/v1/common/leader/detail`  
**Equity Curve**: Available via detail API

| Field | List | Detail | Currently Captured |
|-------|:----:|:------:|:--:|
| ROI (%) | ✅ metricValues[0] | ✅ | ✅ |
| Max Drawdown | ✅ metricValues[1] | ✅ | ✅ |
| Follower Profit | ✅ metricValues[2] | — | ✅ (as PnL) |
| Win Rate | ✅ metricValues[3] | ✅ | ✅ |
| P/L Ratio | ✅ metricValues[4] | — | ❌ **NOT CAPTURED** |
| **Sharpe Ratio** | ✅ metricValues[5] | ✅ | ❌ **NOT CAPTURED** |
| Followers | ✅ currentFollowerCount | ✅ | ✅ |
| AUM | ❌ | ✅ | ❌ |
| Equity Curve | ❌ | ✅ equityCurve[] | ❌ (futures connector has it, spot doesn't) |
| Positions | ❌ | ❌ | ❌ |
| Sortino Ratio | ❌ | ❌ | ❌ |
| Profit Factor | ❌ | ❌ | ❌ |

**🔴 Critical finding**: Bybit provides **Sharpe Ratio** and **P/L Ratio** in `metricValues[5]` and `[4]` but they're NOT being captured in `import_bybit_spot.mjs`.

### Bitget Spot
**List API**: `/v1/trigger/trace/queryCopyTraderList` (productType filter)  
**Detail API**: `/v1/trigger/trace/queryTraderDetail`

| Field | List | Detail | Currently Captured |
|-------|:----:|:------:|:--:|
| ROI (%) | ✅ | ✅ | ✅ |
| PnL (profit) | ✅ | ✅ | ✅ |
| Win Rate | ✅ | ✅ | ✅ |
| Max Drawdown | ✅ | ✅ | ✅ |
| Trades Count | ✅ | ✅ | ✅ |
| Followers | ✅ | ✅ | ✅ |
| AUM (totalAssets) | ✅ | ✅ | ✅ |
| Sharpe Ratio | ❌ | ❌ | ❌ |
| Equity Curve | ❌ | ❌ | ❌ |
| Positions | ❌ | ❌ | ❌ |

### BingX Spot
**Method**: DOM scrape (no public API, CF-protected)

| Field | Page | Currently Captured |
|-------|:----:|:--:|
| ROI (%) | ✅ | ✅ |
| Win Rate | ✅ | ✅ |
| Followers | ✅ | ✅ |
| PnL | ❌ | ❌ |
| Max Drawdown | ❌ | ❌ |
| AUM | ❌ | ❌ |
| Sharpe Ratio | ❌ | ❌ |

**Limited data**: BingX spot page shows minimal metrics compared to other exchanges.

---

## 3. Advanced Metrics Availability

| Metric | Binance | Bybit | Bitget | BingX |
|--------|:-------:|:-----:|:------:|:-----:|
| **Sharpe Ratio** | ❌ | ✅ (**available, not captured**) | ❌ | ❌ |
| **Sortino Ratio** | ❌ | ❌ | ❌ | ❌ |
| **Profit Factor** | ❌ | ❌ | ❌ | ❌ |
| **P/L Ratio** | ❌ | ✅ (**available, not captured**) | ❌ | ❌ |
| **Equity Curve** | ✅ (chartItems) | ✅ (detail API) | ❌ | ❌ |
| **Positions** | ❌ | ❌ | ❌ | ❌ |
| **AUM** | ✅ (detail) | ✅ (detail) | ✅ | ❌ |

---

## 4. Recommended Next Steps (Priority Order)

### 🔴 High Priority — Low Effort, High Value

1. **Capture Bybit Sharpe Ratio** — Already in API response (`metricValues[5]`), just not saved
   - File: `scripts/import/import_bybit_spot.mjs` line ~162
   - Add: `sharpeRatio: parsePercent(mv[5]) || null`
   - Save to `trader_snapshots.sharpe_ratio` column (if exists, else add)

2. **Capture Bybit P/L Ratio** — `metricValues[4]`, not saved
   - Same file, add `plRatio: parsePercent(mv[4]) || null`

### 🟡 Medium Priority — Some Effort

3. **Store Binance equity curve data** — `chartItems` from list API provides daily values
   - Can be stored in `trader_timeseries` table
   - Enables calculated Sharpe/Sortino ratios for Binance traders

4. **Fetch Bybit equity curve for spot** — Futures connector already has this logic
   - Port equity curve fetch from `connectors/bybit/index.ts` to spot import
   - Also enables calculated Sharpe/Sortino

5. **Enrich Bybit/Binance detail pages for AUM** — Available in detail APIs but not captured for all traders in spot

### 🟢 Low Priority — Future Consideration

6. **Calculate Sharpe/Sortino from equity curves** — Once we store equity curve data, compute these metrics ourselves for all platforms

7. **Monitor Gate.io** — Their spot copy trading API exists but is defunct; may reactivate

8. **Monitor OKX** — Largest exchange without spot copy trading; if they add it, high value

---

## 5. API Endpoints Reference

### Confirmed Working APIs

| Exchange | Endpoint | Auth | Geo-Restrict |
|----------|----------|------|:---:|
| Binance | `bapi/futures/v1/friendly/future/copy-trade/home-page/query-list` | None | ✅ US blocked |
| Binance | `bapi/futures/v1/friendly/future/spot-copy-trade/common/home-page-list` | None | ✅ US blocked |
| Bybit | `/x-api/fapi/beehive/public/v1/common/dynamic-leader-list` | Session cookie | ❌ |
| Bitget | `/v1/trigger/trace/queryCopyTraderList` | None | CF WAF |
| BingX | No API — DOM scrape only | — | CF WAF |
| OKX (futures only) | `/api/v5/copytrading/public-lead-traders?instType=SWAP` | None | ✅ US shows limited |
| Gate.io (defunct) | `/api/copytrade/spot-copy-trading/trader/profit` | None | ❌ |

---

## 6. Schema Gaps

Current `trader_snapshots` table likely missing columns for:
- `sharpe_ratio` — Check if column exists; Bybit can populate it immediately
- `pl_ratio` — New field from Bybit
- `profit_factor` — Not available from any exchange API currently

Current `trader_timeseries` table:
- Exists in types (`series_type: 'equity_curve' | 'daily_pnl' | 'positions'`)
- Bybit futures connector already fetches equity curves
- Binance `chartItems` and Bybit spot equity curves should be stored here

---

*Report generated 2026-02-14. No code, database, or .env files were modified.*
