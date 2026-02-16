# Exchange Screenshot & Data Field Investigation Report

**Date:** 2026-02-14
**Purpose:** Identify available data fields on exchange copy-trading/leaderboard pages to fill null win_rate, max_drawdown, trades_count values.

---

## 1. Hyperliquid

### Leaderboard Page (`https://app.hyperliquid.xyz/leaderboard`)
**Visible fields:**
- Rank
- Trader (wallet address / display name)
- Account Value
- PNL (30D)
- ROI (30D)
- Volume (30D)

**Trader Detail Page:** Clicking a trader opens the **block explorer** (transaction history), NOT a trader profile. Shows Hash, Action, Block, Time, User — **no trading statistics at all.**

**❌ No Win Rate, No Max Drawdown, No Trades Count, No Sharpe on the UI.**

### API Endpoints Found
| Endpoint | Method | Fields |
|----------|--------|--------|
| `POST https://api.hyperliquid.xyz/info` type=`clearinghouseState` | POST | accountValue, totalNtlPos, totalRawUsd, marginUsed |
| `POST https://api.hyperliquid.xyz/info` type=`userFills` | POST | Individual fills with `closedPnl` per trade |
| `POST https://api.hyperliquid.xyz/info` type=`portfolio` | POST | accountValueHistory, pnlHistory (time series) |

### Current Enrichment Script Status
- Script calculates **win_rate from userFills** (counting profitable closedPnl)
- **Max drawdown: NOT calculated** (could compute from portfolio/pnlHistory time series)
- **Trades count: calculable** from userFills length
- Log shows "Enriched 1000/1000" but many fills may be empty for inactive accounts

### Missing but Obtainable Fields
| Field | Obtainable? | Method |
|-------|------------|--------|
| win_rate | ✅ Yes (already done) | Calculate from userFills closedPnl |
| max_drawdown | ✅ Yes | Calculate from portfolio pnlHistory time series |
| trades_count | ✅ Yes | Count userFills |
| sharpe_ratio | ⚠️ Possible | Calculate from pnlHistory returns |

### Recommendation
**API direct call** — All data computable from existing Hyperliquid public API (POST, no auth needed). Need to add MDD calculation from portfolio endpoint.

---

## 2. OKX (Web3 & CEX Copy Trading)

### Page Access
- `https://www.okx.com/copy-trading` → **"This product isn't currently available in your country or region"** (geo-blocked for US)
- `https://www.okx.com/web3/copy-trading` → **404 page**

**Could not access any OKX copy trading page from this location.**

### Current Enrichment Script Status
- Log shows "Enriched 361/361" — **working via API**
- API endpoint used: likely `https://www.okx.com/api/v5/copytrading/` or similar

### API Endpoints (from existing code)
- OKX API endpoints are accessible even when the web UI is geo-blocked
- The existing enrichment appears to work fine

### Recommendation
**No action needed** — OKX enrichment already working (361/361 success). Verify data quality.

---

## 3. Gains Network / gTrade

### Leaderboard Page (`https://gains.trade/leaderboard`)
**Visible fields:**
- Rank (排名)
- Address (地址, wallet address truncated)
- Trades Count (交易数量)
- Win Rate (赢率) — shown as percentage
- PnL in USD (盈亏 ($))

**Time filters:** 24h, 7d, 30d, 90d

### Trader Detail Page
**Visible fields:**
- Total Volume (总成交量)
- 30-day Volume
- Trades Count (交易数量)
- Win Rate (赢率) — e.g. 83.5%
- PnL Chart (equity curve)
- Trade History table: Date, Pair, Type, Price, Collateral, Size, PnL per trade

**❌ No Max Drawdown, No Sharpe Ratio on the UI.**

### API Endpoints Found
| Endpoint | Method | Fields |
|----------|--------|--------|
| `https://backend-global.gains.trade/api/leaderboard/all?chainId=42161` | GET | address, count, count_win, count_loss, avg_win, avg_loss, total_pnl, total_pnl_usd |
| `https://backend-global.gains.trade/api/personal-trading-history/{addr}/stats?chainId=42161` | GET | totalVolume, totalTrades, winRate, thirtyDayVolume |
| `https://backend-global.gains.trade/api/personal-trading-history/{addr}?chainId=42161&limit=1000` | GET | Full trade history (for MDD/Sharpe calculation) |
| `https://backend-global.gains.trade/api/trading-history/24h?chainId=42161` | GET | Recent trades |

### API Response Sample (stats endpoint)
```json
{
  "totalVolume": 3231821.49,
  "totalTrades": 494,
  "winRate": "83.53659",
  "thirtyDayVolume": 3020268.53
}
```

### Current Enrichment Script Status
- Log shows "Enriched 518/518" — **working**
- Uses stats endpoint for win_rate

### Missing but Obtainable Fields
| Field | Obtainable? | Method |
|-------|------------|--------|
| win_rate | ✅ Already obtained | stats endpoint |
| trades_count | ✅ Yes | stats endpoint (totalTrades) |
| max_drawdown | ⚠️ Calculable | Full trade history → reconstruct equity curve |
| sharpe_ratio | ⚠️ Calculable | Full trade history → calculate from returns |
| avg_win / avg_loss | ✅ Yes | Leaderboard API directly provides |

### Recommendation
**API direct call** — Public API, no auth, easily accessible. Add trades_count from stats. For MDD, fetch full trade history and calculate.

---

## 4. Gate.io

### Page Access
- `https://www.gate.io/copy-trading` → Redirects to `gate.com/zh/copy-trading` → **404**
- `https://www.gate.io/copy_trading` → **404**
- `https://www.gate.io/copy` → **404**
- Direct web_fetch: **403 Access Denied** (geo-blocked)

**Gate.io fully geo-restricted from US IP. Cannot access web UI or API.**

### API Endpoints (from existing code)
```
https://www.gate.io/api/copytrade/copy_trading/trader/detail/{trader_id}
```
Expected fields: win_rate, maxDrawdown

### Current Enrichment Script Status
- **No enrichment log found** — script likely failed due to geo-blocking
- The API endpoint `gate.io/api/copytrade/...` probably needs non-US IP
- Gate.io API v4 (`api.gateio.ws`) requires authentication headers (Timestamp, KEY, SIGN)

### Missing but Obtainable Fields
| Field | Obtainable? | Method |
|-------|------------|--------|
| win_rate | ❓ Unknown | API geo-blocked; needs proxy or VPN |
| max_drawdown | ❓ Unknown | Same |
| trades_count | ❓ Unknown | Same |

### Recommendation
**Needs proxy/VPN** — All Gate.io endpoints are geo-blocked from US. Options:
1. Use a non-US proxy server for API calls
2. Gate.io API v4 (`api.gateio.ws`) requires API key + signature — check if it works
3. Browser scraping through proxy

---

## 5. MEXC

### Page Access
- `https://www.mexc.com/copy-trading` → Redirects to **404** (zh-MY locale)
- `https://futures.mexc.com/api/v1/private/copy/...` → **403 Access Denied**
- Direct web_fetch: **403 Access Denied** (geo-blocked)

**MEXC fully geo-restricted from US IP. Cannot access web UI or API.**

### API Endpoints (from existing code)
```
https://futures.mexc.com/api/v1/private/copy/trader/detail?traderId={trader_id}
```
Expected fields: winRate, maxDrawdown/maxRetrace

### Current Enrichment Script Status
- Log shows **"Enriched 0/339"** — **Complete failure**
- All 339 API calls failed (geo-blocked)

### Missing but Obtainable Fields
| Field | Obtainable? | Method |
|-------|------------|--------|
| win_rate | ❌ Blocked | API geo-blocked; needs proxy |
| max_drawdown | ❌ Blocked | Same |
| trades_count | ❌ Blocked | Same |

### Recommendation
**Needs proxy/VPN** — Same as Gate.io. MEXC API is fully blocked from US. Options:
1. Non-US proxy server (e.g., Singapore, Hong Kong)
2. Run enrichment from Mac Mini if it has different network access
3. Use MEXC official API v3 with auth — may still be geo-blocked

---

## Summary Table

| Platform | Web Accessible? | API Accessible? | WR Available? | MDD Available? | Trades Count? | Current Status |
|----------|----------------|-----------------|---------------|----------------|---------------|----------------|
| Hyperliquid | ✅ | ✅ Public POST | ✅ Calculate from fills | ⚠️ Calculate from pnlHistory | ✅ From fills | 1000/1000 enriched |
| OKX | ❌ Geo-blocked | ✅ (works) | ✅ | ✅ | ✅ | 361/361 enriched |
| Gains/gTrade | ✅ | ✅ Public GET | ✅ Direct from API | ⚠️ Calculate from history | ✅ Direct from API | 518/518 enriched |
| Gate.io | ❌ Geo-blocked | ❌ Geo-blocked | ❌ Blocked | ❌ Blocked | ❌ Blocked | No log (failed) |
| MEXC | ❌ Geo-blocked | ❌ Geo-blocked | ❌ Blocked | ❌ Blocked | ❌ Blocked | 0/339 enriched |

## Key Findings

### 🔴 Critical Issues
1. **MEXC: 0/339 enriched** — Complete failure due to geo-blocking. 339 traders with null WR/MDD.
2. **Gate.io: No enrichment run** — Likely same geo-blocking issue.

### 🟡 Improvement Opportunities
3. **Hyperliquid: MDD calculable** — Portfolio API provides pnlHistory time series → can compute max drawdown and Sharpe ratio.
4. **Gains/gTrade: MDD calculable** — Full trade history available → can reconstruct equity curve for MDD.
5. **Gains/gTrade: trades_count available** — stats endpoint returns `totalTrades` directly.

### 🟢 Working Well
6. **OKX: Fully enriched** (361/361)
7. **Gains: Fully enriched** (518/518)
8. **Hyperliquid: WR enriched** (1000/1000)

## Recommended Actions (Priority Order)

1. **🔴 Set up proxy for MEXC + Gate.io** — Route API calls through non-US server to unblock 339+ traders
2. **🟡 Add MDD calculation for Hyperliquid** — Fetch `portfolio` type from API, compute drawdown from pnlHistory
3. **🟡 Add MDD calculation for Gains** — Fetch full trade history, reconstruct equity curve
4. **🟡 Add trades_count for Gains** — Use `totalTrades` from stats API
5. **🟢 Verify OKX data quality** — Spot check WR/MDD values against web UI (need VPN to verify)
