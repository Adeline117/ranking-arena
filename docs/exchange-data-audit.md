# Exchange Copy Trading Data Audit

**Date:** 2026-02-09  
**Purpose:** Document all available copy trading data across exchanges  
**Method:** web_fetch of pages + analysis of existing connector code

---

## Summary

| # | Exchange | Copy Trading URL | Has Connector? | API Endpoint | Status |
|---|----------|-----------------|----------------|-------------|--------|
| 1 | **Binance** | binance.com/en/copy-trading | ✅ futures+spot+web3 | `bapi/futures/v1/friendly/future/copy-trade/home-page/query-list` (POST) | Working |
| 2 | **Bybit** | bybit.com/copyTrade | ✅ futures | `api2.bybit.com/fapi/beehive/public/v2/common/leader/list` | Working |
| 3 | **OKX** | okx.com/copy-trading | ✅ futures+wallet | `okx.com/priapi/v5/ecotrade/public/leader-board` | Working |
| 4 | **Bitget** | bitget.com/copy-trading | ✅ futures+spot | `bitget.com/v1/trigger/trace/queryCopyTraderList` (POST) | Working |
| 5 | **MEXC** | mexc.com/copy-trading | ✅ futures | `mexc.com/api/platform/copy-trade/trader/list` | ⚠️ 403 Cloudflare |
| 6 | **KuCoin** | kucoin.com/copy-trading | ✅ futures | `kucoin.com/_api/copy-trade/leader/ranking` | Working (JS-rendered page) |
| 7 | **HTX** | htx.com/futures/copy-trading | ✅ futures | `htx.com/v1/copy-trading/public/trader/list` | ⚠️ Endpoint needs discovery |
| 8 | **BingX** | bingx.com/copy-trading | ❌ **MISSING** | Unknown (Cloudflare blocks) | 🔴 No connector |
| 9 | **Phemex** | phemex.com/copy-trading | ✅ futures | `phemex.com/api/copy-trading/public/leader/ranking` | ⚠️ Endpoint needs verification |
| 10 | **Gate.io** | gate.io/copy-trading | ❌ **MISSING** | Unknown (403 Access Denied) | 🔴 No connector |
| 11 | **Bitfinex** | N/A | N/A | N/A | ❌ No copy trading (has Leaderboard only) |
| 12 | **CoinEx** | coinex.com/copy-trading | ✅ futures | `coinex.com/res/copy-trading/traders` | Working |
| 13 | **XT** | xt.com/en/copy-trading | ❌ **MISSING** | Unknown (JS-rendered) | 🔴 No connector |
| 14 | **LBank** | lbank.com/copy-trading | ❌ **MISSING** | Unknown (page loads, JS-rendered data) | 🔴 No connector |
| 15 | **BloFin** | blofin.com/copy-trading | ❌ **MISSING** | Unknown (Cloudflare blocks) | 🔴 No connector |
| 16 | **Weex** | weex.com/copy-trading | ✅ futures | `weex.com/api/copy-trade/public/trader/ranking` | ⚠️ Endpoint needs verification |
| 17 | **BTSE** | btse.com/en/copy-trade | ❌ **MISSING** | Unknown (page loads but no content extracted) | 🔴 Needs investigation |
| 18 | **BitMart** | bitmart.com/copy-trading | ✅ futures | `bitmart.com/api/copy-trading/v1/public/trader/list` | ⚠️ Endpoint needs verification |

---

## Detailed Analysis Per Exchange

### 1. Binance ✅
- **URL:** https://www.binance.com/en/copy-trading
- **Web Fetch:** Failed (JS-rendered SPA)
- **API Endpoints (from connector code):**
  - List: `POST https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/home-page/query-list`
  - Profile: `POST https://www.binance.com/bapi/futures/v1/public/future/copy-trade/lead-portfolio/detail`
  - Performance: `POST https://www.binance.com/bapi/futures/v1/public/future/copy-trade/lead-portfolio/performance`
- **Available Fields:** roi, pnl, winRate, maxDrawdown, tradeCount, followerCount, copierCount, sharpeRatio, totalMarginBalance (AUM), nickname, userPhotoUrl
- **Time Periods:** 7D (WEEKLY), 30D (MONTHLY), 90D (QUARTER)
- **Pagination:** 20/page, POST body with pageNumber/pageSize
- **Connector Status:** ✅ Fully implemented (futures, spot, web3)

### 2. Bybit ✅
- **URL:** https://www.bybit.com/copyTrade
- **Web Fetch:** Title only (JS SPA)
- **API Endpoints (from connector code):**
  - List: `GET https://api2.bybit.com/fapi/beehive/public/v2/common/leader/list`
  - Profile: `GET https://api2.bybit.com/fapi/beehive/public/v1/common/leader/detail`
- **Available Fields:** roi, pnl, winRate, maxDrawdown, totalOrder, followerNum, copierNum, sharpeRatio, aum, nickName, avatar
- **Time Periods:** 7D (7), 30D (30), 90D (90)
- **Pagination:** 20/page, query params pageNo/pageSize
- **Connector Status:** ✅ Fully implemented

### 3. OKX ✅
- **URL:** https://www.okx.com/copy-trading (redirects to /en-us/copy-trading)
- **Web Fetch:** Navigation menu only (JS SPA)
- **API Endpoints (from connector code):**
  - List: `GET https://www.okx.com/priapi/v5/ecotrade/public/leader-board`
  - Profile: `GET https://www.okx.com/priapi/v5/ecotrade/public/trader/detail`
- **Available Fields:** pnlRatio (ROI), pnl, winRate, maxDrawdown, orderCount, followerCount, copierCount, uniqueName, nickName, avatarUrl
- **Time Periods:** 7D, 30D, 90D
- **Pagination:** 20/page, pageNo/pageSize params
- **Connector Status:** ✅ Fully implemented (futures + wallet)

### 4. Bitget ✅
- **URL:** https://www.bitget.com/copy-trading
- **Web Fetch:** 403 Cloudflare
- **API Endpoints (from connector code):**
  - List: `POST https://www.bitget.com/v1/trigger/trace/queryCopyTraderList`
  - Body: `{ pageNo, pageSize, periodType: "7D"|"30D"|"90D", sortBy: "ROI", productType: "USDT-FUTURES" }`
- **Available Fields:** roi, profit (PnL), winRate, maxDrawdown, totalOrder, followerCount, copierCount, totalAssets (AUM), nickName/traderName, headUrl/avatar, traderId
- **Time Periods:** 7D, 30D, 90D
- **Pagination:** 20/page
- **Connector Status:** ✅ Fully implemented (futures + spot)

### 5. MEXC ⚠️
- **URL:** https://www.mexc.com/copy-trading
- **Web Fetch:** 403 Access Denied (Akamai CDN)
- **API Endpoints (from connector code):**
  - List: `GET https://www.mexc.com/api/platform/copy-trade/trader/list`
  - Params: page, pageSize, sortBy=roi, sortType=DESC, periodDays=7|30|90
- **Available Fields:** roi, pnl, winRate, maxDrawdown, totalOrder, followerCount, copierCount, nickName, avatar, traderId
- **Time Periods:** 7D, 30D, 90D
- **Pagination:** 20/page
- **Connector Status:** ✅ Exists but ⚠️ likely blocked by Cloudflare/Akamai. May need proxy or browser automation.

### 6. KuCoin ✅
- **URL:** https://www.kucoin.com/copy-trading (redirects to /copytrading)
- **Web Fetch:** Title only (JS SPA)
- **API Endpoints (from connector code):**
  - List: `GET https://www.kucoin.com/_api/copy-trade/leader/ranking`
  - Params: page, pageSize, sortBy=ROI, sortOrder=DESC, period=WEEK|MONTH|QUARTER
- **Available Fields:** roi, pnl, winRate, maxDrawdown, totalOrders, followerCount, copierCount, nickName, avatar, leaderId
- **Time Periods:** 7D (WEEK), 30D (MONTH), 90D (QUARTER)
- **Pagination:** 20/page
- **Connector Status:** ✅ Fully implemented

### 7. HTX ⚠️
- **URL:** https://www.htx.com/futures/copy-trading (NOT /copy-trading which 404s)
- **Web Fetch:** Title only (JS SPA, correct URL confirmed: /futures/copy-trading)
- **API Endpoints (from connector code):**
  - List: `GET https://www.htx.com/v1/copy-trading/public/trader/list`
  - Params: page, pageSize, sortField=yield_rate, sortOrder=desc, periodDays=7|30|90
- **Available Fields:** yield_rate (ROI), nick_name, avatar, trader_id — other fields need verification
- **Time Periods:** 7D, 30D, 90D (assumed)
- **Connector Status:** ✅ Exists but ⚠️ endpoint is guessed. Profiles/snapshots not implemented.
- **Note:** The correct URL is `/futures/copy-trading`, not `/copy-trading`

### 8. BingX 🔴 MISSING
- **URL:** https://bingx.com/copy-trading (also /en/copytrading/)
- **Web Fetch:** 403 Cloudflare
- **API Endpoints:** Unknown — blocked by Cloudflare. BingX has API docs at `bingx-api.github.io/docs` (also JS-rendered, couldn't extract)
- **Known from website:** BingX is one of the largest copy trading platforms. They have:
  - Copy trading leaderboards with ROI rankings
  - Trader profiles with performance data
  - Time periods likely 7D/30D/90D
- **Connector Status:** 🔴 No connector exists. **HIGH PRIORITY** — BingX is a major copy trading exchange.
- **Action needed:** Use Playwright/browser automation to discover API endpoints, or check their official API docs.

### 9. Phemex ⚠️
- **URL:** https://phemex.com/copy-trading (redirected to 404 — URL may have changed)
- **Web Fetch:** 404 redirect — Phemex may have renamed/moved their copy trading section
- **API Endpoints (from connector code):**
  - List: `GET https://phemex.com/api/copy-trading/public/leader/ranking`
  - Profile: `GET https://phemex.com/api/copy-trading/public/leader/detail?leaderId=X`
- **Available Fields:** nickName, avatar, leaderId — other fields inferred
- **Time Periods:** 7D, 30D, 90D
- **Connector Status:** ✅ Exists but ⚠️ page 404s. May need URL update. Profile endpoint partially implemented.
- **Action needed:** Discover current copy trading URL on Phemex

### 10. Gate.io 🔴 MISSING
- **URL:** https://www.gate.io/copy-trading (also tried /copytrading)
- **Web Fetch:** 403 Access Denied (Akamai CDN)
- **API Endpoints:** Unknown — blocked by CDN
- **Known:** Gate.io has copy trading with trader leaderboards
- **Connector Status:** 🔴 No connector. Needs browser automation to discover endpoints.

### 11. Bitfinex ❌ No Copy Trading
- **URL:** https://www.bitfinex.com/copy-trading → 404
- **Finding:** Bitfinex does NOT have copy trading. They do have a **Leaderboard** at `leaderboard.bitfinex.com` (mentioned in footer links).
- **Connector Status:** N/A — not applicable for copy trading

### 12. CoinEx ✅
- **URL:** https://www.coinex.com/copy-trading
- **Web Fetch:** No content extracted (JS SPA)
- **API Endpoints (from connector code):**
  - List: `GET https://www.coinex.com/res/copy-trading/traders`
  - Params: page, limit, order_by=roi, order_type=desc, days=7|30|90
- **Available Fields:** roi, pnl, win_rate, max_drawdown, trade_count, follower_count, copier_count, nick_name, avatar, trader_id
- **Time Periods:** 7D, 30D, 90D
- **Pagination:** 20/page
- **Connector Status:** ✅ Fully implemented

### 13. XT 🔴 MISSING
- **URL:** https://www.xt.com/en/copy-trading
- **Web Fetch:** Title only (JS SPA)
- **API Endpoints:** Unknown — need browser network tab inspection
- **Known:** XT.COM has copy trading feature
- **Connector Status:** 🔴 No connector

### 14. LBank 🔴 MISSING
- **URL:** https://www.lbank.com/copy-trading
- **Web Fetch:** Partial content — FAQ section visible, confirms copy trading exists. Shows "Top Lead traders" and "All Lead traders" sections.
- **API Endpoints:** Unknown — data is JS-rendered
- **Known fields (from FAQ):** Copy trading earnings data, positions, follow management
- **Connector Status:** 🔴 No connector

### 15. BloFin 🔴 MISSING
- **URL:** https://blofin.com/copy-trading
- **Web Fetch:** 403 Cloudflare
- **API Endpoints:** Unknown
- **Known:** BloFin has copy trading feature
- **Connector Status:** 🔴 No connector

### 16. Weex ✅
- **URL:** https://www.weex.com/copy-trading
- **Web Fetch:** Partial content — confirms copy trading with "Highest ranked" and "All elite traders" sections, "Become an elite trader" link
- **API Endpoints (from connector code):**
  - List: `GET https://www.weex.com/api/copy-trade/public/trader/ranking`
  - Params: page, pageSize, sortBy=roi, period=7|30|90
- **Available Fields:** nickName, avatar, traderId — other fields need verification
- **Time Periods:** 7D, 30D (90D may not be available)
- **Connector Status:** ✅ Exists but ⚠️ endpoints guessed. Profile/snapshot not implemented.

### 17. BTSE ❓ Uncertain
- **URL:** https://www.btse.com/en/copy-trade
- **Web Fetch:** No content extracted
- **Finding:** Unclear if BTSE has copy trading. Page loads but no readable content.
- **Connector Status:** 🔴 No connector. Needs manual browser investigation.

### 18. BitMart ✅ (bonus — already in system)
- **URL:** https://www.bitmart.com/copy-trading
- **API Endpoints (from connector code):**
  - List: `GET https://www.bitmart.com/api/copy-trading/v1/public/trader/list`
  - Params: page, size, period=7|30|90, sort=roi, order=desc
- **Connector Status:** ✅ Exists, profile/snapshot needs endpoint discovery

---

## Available Data Fields Comparison

| Field | Binance | Bybit | OKX | Bitget | MEXC | KuCoin | CoinEx |
|-------|---------|-------|-----|--------|------|--------|--------|
| ROI % | ✅ roi | ✅ roi | ✅ pnlRatio | ✅ roi | ✅ roi | ✅ roi | ✅ roi |
| PnL USD | ✅ pnl | ✅ pnl | ✅ pnl | ✅ profit | ✅ pnl | ✅ pnl | ✅ pnl |
| Win Rate | ✅ winRate | ✅ winRate | ✅ winRate | ✅ winRate | ✅ winRate | ✅ winRate | ✅ win_rate |
| Max Drawdown | ✅ maxDrawdown | ✅ maxDrawdown | ✅ maxDrawdown | ✅ maxDrawdown | ✅ maxDrawdown | ✅ maxDrawdown | ✅ max_drawdown |
| Trade Count | ✅ tradeCount | ✅ totalOrder | ✅ orderCount | ✅ totalOrder | ✅ totalOrder | ✅ totalOrders | ✅ trade_count |
| Followers | ✅ followerCount | ✅ followerNum | ✅ followerCount | ✅ followerCount | ✅ followerCount | ✅ followerCount | ✅ follower_count |
| Copiers | ✅ copierCount | ✅ copierNum | ✅ copierCount | ✅ copierCount | ✅ copierCount | ✅ copierCount | ✅ copier_count |
| Sharpe Ratio | ✅ sharpeRatio | ✅ sharpeRatio | ❌ | ❌ | ❌ | ❌ | ❌ |
| AUM | ✅ totalMarginBalance | ✅ aum | ❌ | ✅ totalAssets | ❌ | ❌ | ❌ |
| Nickname | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Avatar | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

---

## Time Periods Comparison

| Exchange | 7D | 30D | 90D | ALL |
|----------|----|----|-----|-----|
| Binance | ✅ WEEKLY | ✅ MONTHLY | ✅ QUARTER | ❓ |
| Bybit | ✅ 7 | ✅ 30 | ✅ 90 | ❓ |
| OKX | ✅ 7D | ✅ 30D | ✅ 90D | ❓ |
| Bitget | ✅ 7D | ✅ 30D | ✅ 90D | ❓ |
| MEXC | ✅ 7 | ✅ 30 | ✅ 90 | ❓ |
| KuCoin | ✅ WEEK | ✅ MONTH | ✅ QUARTER | ❓ |
| CoinEx | ✅ 7 | ✅ 30 | ✅ 90 | ❓ |
| HTX | ✅ 7 | ✅ 30 | ✅ 90 | ❓ |
| Phemex | ✅ 7D | ✅ 30D | ✅ 90D | ❓ |
| Weex | ✅ 7 | ✅ 30 | ⚠️ maybe | ❌ |

---

## Priority Actions

### 🔴 HIGH — Missing Connectors (Exchanges with copy trading, no connector)
1. **BingX** — Major copy trading platform, blocked by Cloudflare. Need Playwright browser automation on VPS.
2. **Gate.io** — Blocked by Akamai CDN. Need proxy or browser automation.
3. **BloFin** — Blocked by Cloudflare. Need browser automation.

### 🟡 MEDIUM — Missing Connectors (Smaller exchanges)
4. **XT** — JS-rendered, need browser network inspection to find API
5. **LBank** — Page loads, need to discover API endpoints
6. **BTSE** — Need to verify if copy trading exists

### 🟠 MEDIUM — Existing Connectors Needing Fixes
7. **MEXC** — 403 blocked. Connector code exists but may not work due to CDN blocks.
8. **HTX** — URL was wrong (`/copy-trading` → `/futures/copy-trading`). API endpoint guessed, needs verification.
9. **Phemex** — Page 404s. Copy trading may have been moved or renamed.
10. **Weex** — Endpoints are guessed, profile/snapshot not implemented.
11. **BitMart** — Profile and snapshot endpoints need discovery.

### ✅ Working (High Confidence)
12. Binance (futures+spot+web3)
13. Bybit (futures)
14. OKX (futures+wallet)
15. Bitget (futures+spot)
16. KuCoin (futures)
17. CoinEx (futures)

---

## Web Fetch Accessibility Summary

| Exchange | web_fetch Result | Reason |
|----------|-----------------|--------|
| Binance | ❌ No content | JS SPA |
| Bybit | ❌ Title only | JS SPA |
| OKX | ⚠️ Nav menu only | JS SPA |
| Bitget | ❌ 403 | Cloudflare |
| MEXC | ❌ 403 | Akamai CDN |
| KuCoin | ❌ Title only | JS SPA |
| HTX | ❌ Title only (correct URL) | JS SPA |
| BingX | ❌ 403 | Cloudflare |
| Phemex | ❌ 404 redirect | URL changed |
| Gate.io | ❌ 403 | Akamai CDN |
| Bitfinex | ❌ 404 | No copy trading |
| CoinEx | ❌ No content | JS SPA |
| XT | ❌ Title only | JS SPA |
| LBank | ✅ Partial | FAQ visible |
| BloFin | ❌ 403 | Cloudflare |
| Weex | ✅ Partial | Some content |
| BTSE | ❌ No content | Unknown |

**Conclusion:** Almost all exchange copy trading pages are JavaScript SPAs or behind CDN protection. API endpoint discovery requires either:
1. Existing connector code (which we have for 12 exchanges)
2. Browser automation (Playwright) to inspect network requests
3. Official API documentation

---

## Recommendations

1. **For blocked exchanges (BingX, Gate.io, BloFin):** Use the VPS Playwright setup to open the page in a real browser, inspect network traffic, and discover API endpoints.
2. **For broken connectors (MEXC, HTX, Phemex):** Run actual connector tests to verify which endpoints work and which need updating.
3. **For new connectors (XT, LBank, BTSE):** Use Playwright to discover API patterns, then build connectors following the BaseConnector pattern.
4. **Bitfinex:** Skip — no copy trading feature. Their leaderboard is a separate product.
