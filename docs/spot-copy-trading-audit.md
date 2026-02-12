# Spot Copy Trading Audit

**Date:** 2026-02-12  
**Purpose:** Investigate which exchanges offer spot copy trading (separate from futures)

## Current Spot Platforms

Already integrated: `binance_spot`, `bybit_spot`, `bitget_spot`

## Audit Results

| Exchange | Has Spot Page? | API Found? | Trader Count | API URL | Notes |
|----------|---------------|------------|-------------|---------|-------|
| **OKX** | ✅ Page exists (`/copy-trading/spot`) | ❌ API broken | 0 | `api/v5/copytrading/public-lead-traders?instType=SPOT` returns error 51000 | Page exists but API rejects `instType=SPOT`. Existing `import_okx_enhanced.mjs` already has this commented out. Only SWAP (futures) works. |
| **MEXC** | ❌ | ❌ | 0 | N/A | Geo-restricted (403). `/copy-trading` and `/copy-trading/spot` both blocked. No evidence of spot copy trading. |
| **Gate.io** | ❓ Unknown | ❌ | 0 | `gate.com/apiw/v2/copy/leader/list` (futures only) | API works (per discovered-apis.md) but no `type` filter for spot. Page `/copytrading/spot` returns 403. Likely futures-only. |
| **KuCoin** | ❓ SPA | ❌ | 0 | N/A | `/copy-trading/spot` returns 200 but empty SPA shell. No spot API endpoint found. All existing imports are futures (`kucoin`). |
| **HTX (Huobi)** | ❌ | ❌ | 0 | N/A | `/copy-trading` returns 404. No copy trading feature found. |
| **BingX** | ❌ (CF blocked) | ❌ | 0 | N/A | Cloudflare Turnstile blocks all access. No evidence of spot copy trading. Known for futures copy trading. |
| **Phemex** | ❌ | ❌ | 0 | N/A | `/copy-trading` → 404. `/copy-trading/spot` → 404. No copy trading feature. |
| **BTCC** | ❌ | ❌ | 0 | N/A | Page title: "Crypto **Futures** Copy Trading". Futures only. |
| **CoinEx** | ❌ | ❌ | 0 | N/A | `/copy-trading` → redirects to homepage (no copy trading feature). |
| **LBank** | ❌ | ❌ | 0 | N/A | Copy trading page exists but FAQ mentions "futures account" only. No spot. |
| **XT** | ✅ Page exists (`/copy-trading/spot`) | ❌ | Unknown | N/A | `/copy-trading/spot` returns 200 (SPA). Could not find API endpoint. Needs browser intercept to discover API. |
| **Weex** | ❌ | ❌ | 0 | N/A | No `/copy-trading/spot` (404). Futures only via `janapw.com` API (requires browser headers). |
| **BloFin** | ❌ | ❌ | 0 | N/A | Cloudflare blocked. `/copy-trading/spot` → 403. Likely futures only. |
| **Toobit** | ❌ | ❌ | 0 | N/A | SPA, no spot-specific page or API found. |

## Summary

### Exchanges with confirmed spot copy trading pages:
1. **OKX** — Page exists but API broken (`instType=SPOT` not supported). Already known issue in `import_okx_enhanced.mjs`.
2. **XT** — `/copy-trading/spot` returns 200. Needs browser-based API discovery.

### Exchanges that likely DON'T have spot copy trading:
- MEXC, Gate.io, KuCoin, HTX, BingX, Phemex, BTCC, CoinEx, LBank, Weex, BloFin, Toobit

### Actionable Next Steps

1. **OKX Spot** — Monitor OKX API. The `instType=SPOT` parameter might start working. The page is live, suggesting they may enable it soon. Keep the existing `import_okx_enhanced.mjs` spot section commented and check periodically.

2. **XT Spot** — Needs browser-based API discovery (Playwright intercepting network requests on `https://www.xt.com/copy-trading/spot`). This is the most promising new spot platform to add.

3. **No new import scripts created** — None of the investigated exchanges have a working spot copy trading API that can be accessed without a browser.

## Methodology

- Used `curl` and `web_fetch` to check page existence and HTTP status codes
- Tested known API patterns (priapi, _api, api/v5, etc.) for each exchange
- Cross-referenced with existing `docs/discovered-apis.md` and import scripts
- OKX API documentation at `/docs-v5/en/#copy-trading-rest-api` was consulted
- Browser-rendered SPAs could not be fully inspected without Playwright/browser access
