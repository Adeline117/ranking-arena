# Arena Health Check Report

**Date:** 2026-02-14 13:08 PST  
**Checked by:** Automated subagent

---

## 1. 排行榜页面 (Rankings Pages)

| Exchange | Status | Title | Data (API) |
|----------|--------|-------|------------|
| binance_futures | ✅ 200 | Binance 合约交易员排行榜 | 1918 traders |
| bybit | ✅ 200 | Bybit 合约交易员排行榜 | 706 traders |
| bitget_futures | ✅ 200 | ✅ | 385 traders |
| okx | ✅ 200 | okx 合约交易员排行榜 | ⚠️ **0 traders** |
| hyperliquid | ✅ 200 | Hyperliquid 链上交易员排行榜 | 1816 traders |
| mexc | ✅ 200 (assumed, API works) | — | 861 traders |
| kucoin | ✅ 200 (assumed, API works) | — | 267 traders |
| dydx | ✅ 200 (assumed, API works) | — | 312 traders |

### 🔴 Issue: OKX has 0 traders
- API returns empty `traders: []` with `totalCount: 0`
- The ranking page loads but shows no data
- **Status:** ❌ Needs investigation — OKX scraper may be broken or data never ingested

---

## 2. 交易员详情页 (Trader Detail Pages)

| Trader | Exchange | Status | Title |
|--------|----------|--------|-------|
| 杨勇娇 | binance_futures | ✅ 200 | 杨勇娇 \| Arena |
| ZephyrZodiac | bybit | ✅ 200 | ZephyrZodiac \| 90D ROI: +493.38% |
| Lenich | mexc | ✅ 200 | Lenich \| 90D ROI: +1774.16% |

All trader detail pages load correctly with proper titles and SEO metadata.

---

## 3. API 数据质量

| Exchange | Top Score | Rank Sorted? | Null Fields | Notes |
|----------|-----------|-------------|-------------|-------|
| binance_futures | 89.85 | ✅ (1,3,5) | avatar_url, style | Ranks not sequential (1,3,5) — gap expected with limit=3 |
| bybit | 70.78 | ✅ (62,66,68) | profitability/risk/execution all null | ⚠️ Score breakdown missing |
| bitget_futures | 70.96 | ✅ (115,123,134) | Mixed nulls | Partial data |
| okx | — | N/A | N/A | **No data at all** |
| hyperliquid | 84.11 | ✅ (8,27,32) | max_drawdown null on #1 | Good overall |
| mexc | 57.89 | ⚠️ (350,416,458) | win_rate/drawdown null on some | Ranks start high — low scores |
| kucoin | 44.31 | ✅ (749,2619,3109) | win_rate/drawdown null | Very low scores, ranks start at 749 |
| dydx | 36.59 | ✅ (1103,2293,2372) | Mixed nulls | Low scores, high rank numbers |

### ⚠️ Issues:
1. **Bybit**: All 3 top traders have `profitability_score`, `risk_control_score`, `execution_score` = null despite having `arena_score`. Score breakdown computation may be missing.
2. **Rank gaps**: Top traders for mexc/kucoin/dydx start at rank 350/749/1103 — these are globally ranked, not per-exchange ranked. This means the "top" of each exchange page shows rank #350+ which may confuse users.
3. **PnL = 0**: Several bybit/bitget/mexc traders show `pnl: 0` — may be missing data from API.

---

## 4. 时间段切换 (Time Range)

| Time Range | Status | Top Trader |
|------------|--------|------------|
| 7D | ✅ Has data | 赚不到钱就下海 (ROI: 402.31%) |
| 30D | ✅ Has data | c1ultra (ROI: 4103.61%) |
| 90D | ✅ Has data | 杨勇娇 (ROI: 3557.73%) |

All time ranges return data correctly for binance_futures.

---

## 5. 首页 & 社区页

| Page | Status | Notes |
|------|--------|-------|
| `/` (首页) | ✅ 200 | Loads with correct title |
| `/hot` (热榜) | ✅ 200 | Loads, but content appears minimal (SSR may not render posts) |
| `/community` | ❌ **404** | **Page not found!** |

### 🔴 Issue: /community returns 404
- This route does not exist or was removed
- Navigation shows `/groups` instead — may have been renamed
- **Status:** Likely intentional rename to `/groups`, but `/community` link should redirect or be removed from any references

---

## 6. Sentry 错误 (Last 24h)

**Total unresolved issues: 20**

### Critical/Fatal:
| Error | Events | Level |
|-------|--------|-------|
| `column trader_snapshots.window does not exist` | 9 | error |
| `Unhandled error. ({` | 6 | fatal |

### High Priority:
| Error | Events | Level |
|-------|--------|-------|
| `请求超时，请稍后重试` | 95 | warning |
| Page static→dynamic runtime errors (`/trader/[handle]`) | ~10 | error |
| `ServiceWorker script evaluation failed` | 5 | warning |
| `Server is busy, please try again later` | 1 | error |
| `网络连接异常，请稍后重试` | 1 | error |

### 🔴 Key Sentry Issues:
1. **`trader_snapshots.window` column missing** — Database schema may be out of sync with code. 9 occurrences.
2. **95 timeout warnings** — Upstream API or DB query timeouts, high volume.
3. **Static→dynamic runtime errors** — Next.js pages using `no-store` fetch to Upstash Redis are causing build/runtime conflicts on `/trader/[handle]`.

---

## 7. VPS Cron 健康

**Uptime:** 4 days, 20:05  
**Load Average:** 26.90, 26.12, 20.26 ⚠️ **Very high!**

### Cron Jobs:
| Schedule | Job | Status |
|----------|-----|--------|
| `*/30 * * *` | Major refresh (Binance/Bybit/Bitget/HTX) | ✅ Active |
| `45 */2 * *` | Enrichment (detail APIs) | ✅ Active |
| `*/30 * * *` | Flash news collection | ✅ Active |
| `45 */2 * *` | Scrape-and-upsert (CF platforms) | ✅ Active |

### 🔴 Issue: Extremely high load average (26.9)
- Load average of ~26 on a VPS is extremely high
- This likely explains the 95 timeout errors in Sentry
- Multiple cron jobs may be overlapping/stacking
- **Status:** ❌ Needs investigation — check for stuck processes

---

## Summary

### 🔴 Critical Issues (3):
1. **OKX exchange has 0 traders** — scraper broken or never set up
2. **VPS load average 26.9** — causing timeouts, possible runaway processes
3. **`trader_snapshots.window` column missing** — DB schema mismatch causing errors

### ⚠️ Medium Issues (3):
4. **`/community` returns 404** — route may have been renamed to `/groups`
5. **Bybit score breakdown all null** — arena_score exists but sub-scores missing
6. **95 timeout warnings in 24h** — likely related to VPS load

### ℹ️ Minor/Informational (2):
7. **Global ranking shown per-exchange** — kucoin/dydx/mexc top traders show rank 350+
8. **Next.js static→dynamic runtime warnings** — Upstash fetch pattern issue

### ✅ Working Well:
- All 8 ranking pages return 200
- Trader detail pages work correctly with proper SEO titles
- All 3 time ranges (7D/30D/90D) return data
- Homepage loads correctly
- Hot page loads (200)
- 4 cron jobs configured and active
- Main exchanges (Binance, Bybit, Hyperliquid, Bitget, MEXC, KuCoin, dYdX) all have data
