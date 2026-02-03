# Cloudflare Protected Platforms - Status Report

Date: 2026-02-02

## Summary

4 platforms consistently return 0 data due to Cloudflare protection, even when browser passes CF verification.

---

## KuCoin

**Status: ❌ CF Protected + No Public API**

- Website: `https://www.kucoin.com/copy-trading/leaderboard`
- Internal API: `/_api/copy-trade/leaderboard/query` → 404
- Browser intercept strategy works occasionally but unreliable
- Playwright/Puppeteer with stealth plugin: CF turnstile blocks most attempts
- Even when CF passes, API responses often not intercepted (SSR or WebSocket data)

**Attempted solutions:**
- puppeteer-extra-plugin-stealth ❌
- playwright with proxy ❌
- Multiple User-Agent rotations ❌

**Recommendation:** Monitor for public API release or consider official API partnership.

---

## BingX

**Status: ❌ SSR Rendering + CF Protected**

- Website: `https://bingx.com/en/copy-trading/`
- All API endpoints return 403 (CF protected)
- Page uses Server-Side Rendering - JSON APIs not exposed to browser intercept
- DOM scraping unreliable due to React hydration timing

**Attempted solutions:**
- API endpoint discovery ❌
- Browser API intercept ❌
- DOM scraping ❌

**Recommendation:** Platform appears to use websocket/SSR for data. No viable solution without official API access.

---

## Bitget

**Status: ❌ API Requires Authentication**

- Website: `https://www.bitget.com/copy-trading/futures/all`
- Public API v1 deprecated: "V1 API has been decommissioned"
- V2 API requires ACCESS_KEY authentication: `{"code":"40006","msg":"Invalid ACCESS_KEY"}`
- Browser scraping blocked by CF

**Tested endpoints:**
- `/api/v2/copy/mix-broker/query-traders` → Requires API key
- `/v1/trigger/trace/public/traderViewV3` → 403 (CF)
- `www.bitget.com` endpoints → 403 (CF)

**Recommendation:** Consider applying for Bitget API key for official data access.

---

## Phemex

**Status: ❌ CF Protected + Limited Data**

- Website: `https://phemex.com/copy-trading`
- All API endpoints return 403
- Browser intercept occasionally works but captures minimal data (10 traders)
- Platform may have small trader pool anyway

**Recommendation:** Low priority due to small platform size.

---

## Technical Notes

### Why Browser Intercept Fails
1. **CF Turnstile Challenge:** Modern CF uses JS challenges that detect automation
2. **SSR Data:** Some platforms embed data in initial HTML, not fetchable via XHR intercept
3. **WebSocket Data:** Real-time data delivered via WS, not traditional REST APIs
4. **Request Signing:** Some APIs require client-generated signatures

### Potential Future Solutions
1. **Official API Partnerships:** Contact exchanges for data access
2. **Residential Proxies:** May help bypass CF detection (cost consideration)
3. **Browser Extension:** Manual data export by users
4. **Third-party Data Providers:** CoinGecko, CryptoCompare may add copy-trading data

---

## Current Data Counts (season_id='30D')

| Platform | Count | Status |
|----------|-------|--------|
| KuCoin | 140 | ⚠️ Stale (from previous successful scrape) |
| BingX | 4 | ⚠️ Minimal |
| Bitget Futures | 218 | ⚠️ Stale |
| Phemex | 10 | ⚠️ Minimal |

**Note:** These counts are from previous successful scrapes. Data may become increasingly stale without refresh capability.
