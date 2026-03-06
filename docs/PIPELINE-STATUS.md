# Pipeline Status

Last updated: 2026-03-05

## Platform Status Overview

### Working (Direct API)
| Platform | Status | Fallback Chain | Notes |
|----------|--------|----------------|-------|
| binance_futures | ✅ Working | Direct → CF Proxy → VPS | Geo-blocked from US, works from Vercel JP/SG |
| binance_spot | ✅ Working | Direct → CF Proxy → VPS | Same as futures |
| bybit | ✅ Working | Direct → CF Proxy → VPS → Stealth | WAF-blocked from US, proxy needed |
| okx_futures | ✅ Working | Direct | Works from most regions |
| okx_web3 | ✅ Working | Direct | Works from most regions |
| hyperliquid | ✅ Working | Direct | On-chain, no geo-blocking |
| gmx | ✅ Working | Direct | Subgraph-based |
| dydx | ✅ Working | Direct | On-chain |
| aevo | ✅ Working | Direct | On-chain |
| jupiter_perps | ✅ Working | Direct | Solana-based |
| gains | ✅ Working | Direct | On-chain |
| htx_futures | ✅ Working | Direct | API stable |
| mexc | ✅ Working | Direct | API stable |
| kucoin | ✅ Working | Direct | API stable |
| coinex | ✅ Working | Direct | API stable |
| lbank | ✅ Working | Direct | API stable |
| blofin | ✅ Working | Direct | API stable |
| xt | ✅ Working | Direct | API stable |

### Working with Proxy Required
| Platform | Status | Fallback Chain | Notes |
|----------|--------|----------------|-------|
| bingx | ⚠️ CF-Protected | Direct → VPS → Stealth | All endpoints behind Cloudflare |
| gateio | ⚠️ CF-Protected | Direct → VPS | Akamai WAF from US IPs |
| bitget_futures | ⚠️ Auth Required | Auth API → Public → CF Proxy → VPS | Needs BITGET_API_KEY/SECRET/PASSPHRASE |
| bitget_spot | ⚠️ Auth Required | Auth API → Public → CF Proxy | Same credentials as futures |

### Discontinued
| Platform | Status | Reason | Date |
|----------|--------|--------|------|
| phemex | ❌ Discontinued | API returns 401/403/404; copy trading possibly removed | 2026-02 |
| weex | ❌ Discontinued | All API endpoints return 404/521; requires browser session | 2025 |

### Lower Priority / Experimental
| Platform | Status | Notes |
|----------|--------|-------|
| cryptocom | ⚠️ Limited | Limited copy trading data available |
| bitfinex | ⚠️ Limited | Leaderboard-only, no copy trading |
| whitebit | ⚠️ Limited | Limited API |
| btse | ⚠️ Limited | Limited API |
| toobit | ⚠️ Limited | Limited API |
| uniswap | ⚠️ DEX | Top traders by volume, not copy trading |
| pancakeswap | ⚠️ DEX | Top traders by volume, not copy trading |

## Proxy Infrastructure

### Cloudflare Worker
- URL: `ranking-arena-proxy.broosbook.workers.dev`
- Routes: `/binance/copy-trading`, `/bitget/copy-trading`, `/bybit/copy-trading`
- Status: Alive but exchange IPs increasingly block Worker egress IPs

### VPS Proxy (Tokyo)
- Env: `VPS_PROXY_URL` / `VPS_PROXY_JP`
- Protocol: `POST /proxy` with `{ url, method, headers, body }` + `X-Proxy-Key` auth
- Used by: binance_futures, bybit, bitget_futures

### VPS Proxy (Singapore)
- Env: `VPS_PROXY_SG`
- Same protocol as Tokyo
- Used by: bingx, gateio, bitget_futures

## Failure Classification

The pipeline uses structured failure reasons for each fetch attempt:
- `geo_blocked` — 451/403 with geo-block indicators
- `waf_blocked` — Cloudflare/Akamai WAF (HTML response)
- `auth_required` — 401 (needs API key)
- `endpoint_gone` — 404 (API changed)
- `rate_limited` — 429 (too many requests)
- `timeout` — Request timed out
- `empty_data` — 200 but no usable data
- `parse_error` — Response couldn't be parsed

## Monitoring

- Pipeline metrics stored in `pipeline_metrics` table
- Consecutive failure tracking with Telegram alerts at threshold 3
- Health endpoint: `GET /api/pipeline/health`
- Diagnostic script: `node scripts/pipeline-health-check.mjs`

## Required Environment Variables

```
# VPS Proxy
VPS_PROXY_URL=https://your-tokyo-vps:3001/proxy
VPS_PROXY_JP=https://your-tokyo-vps:3001/proxy
VPS_PROXY_SG=https://your-sg-vps:3001/proxy
VPS_PROXY_KEY=your-shared-secret

# Bitget (optional, needed for authenticated API)
BITGET_API_KEY=...
BITGET_API_SECRET=...
BITGET_API_PASSPHRASE=...

# Gate.io (optional, needed for API v4)
GATEIO_API_KEY=...
GATEIO_API_SECRET=...

# CF Worker
CLOUDFLARE_PROXY_URL=https://ranking-arena-proxy.broosbook.workers.dev
```
