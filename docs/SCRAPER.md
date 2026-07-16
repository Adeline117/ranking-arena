# Arena Scraper Architecture & Operations

## Overview

Arena uses a hybrid approach to collect trader data from 32+ exchanges:

1. **Direct API** — Exchanges with open APIs (Binance, OKX, HTX, Hyperliquid, etc.)
2. **VPS Browser Scraper** — Exchanges with WAF protection (Bybit, MEXC, Bitget, etc.)
3. **Fallback chain** — API -> CF Worker proxy -> VPS scraper -> cached data

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
  Binance    OKX      Hyperliquid Bybit   MEXC    Bitget ...
      │         │          │       │       │        │
      └─────────┴──────────┴───────┴───────┴────────┘
                          │
                  ┌───────▼────────┐
                  │  Supabase DB   │
                  └────────────────┘
```

---

## Quick Start

```bash
# Health check
curl http://45.76.152.169:3456/health

# Run full scraper test
npx tsx scripts/test-vps-scrapers.ts

# Trigger a single platform fetch
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://www.arenafi.org/api/cron/unified-connector?platform=hyperliquid&window=90d"

# Trigger batch fetch for a group
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://www.arenafi.org/api/cron/batch-fetch-traders?group=a"
```

---

## VPS Scraper Service

- **Host**: `http://45.76.152.169:3456` (Singapore VPS)
- **Auth**: `X-Proxy-Key` header (from `VPS_PROXY_KEY` env var)
- **PM2 name**: `arena-scraper`

### Endpoints

| Platform | Endpoint                   | Speed | Status  |
| -------- | -------------------------- | ----- | ------- |
| Bybit    | `/bybit/leaderboard-batch` | ~65s  | Working |
| MEXC     | `/mexc/leaderboard`        | >120s | Slow    |
| Bitget   | `/bitget/leaderboard`      | ~40s  | Working |
| CoinEx   | `/coinex/leaderboard`      | ~35s  | Working |
| KuCoin   | `/kucoin/leaderboard`      | ~45s  | Working |
| BingX    | `/bingx/leaderboard`       | ~30s  | Working |
| LBank    | `/lbank/leaderboard`       | ~40s  | Working |
| GateIO   | `/gateio/leaderboard`      | ~50s  | Working |

### Usage

```typescript
const VPS_SCRAPER_URL = 'http://45.76.152.169:3456'

// Batch scrape Bybit (all periods in one browser session)
const res = await fetch(
  `${VPS_SCRAPER_URL}/bybit/leaderboard-batch?pageSize=50&durations=DATA_DURATION_THIRTY_DAY,DATA_DURATION_NINETY_DAY`,
  {
    headers: { 'X-Proxy-Key': process.env.VPS_PROXY_KEY! },
    signal: AbortSignal.timeout(90_000),
  }
)
```

---

## Platform Strategies

### Bybit — WAF blocked, VPS only

- Akamai WAF blocks all direct API access (HTTP 403)
- **Always use batch mode** (`/bybit/leaderboard-batch`): ~65s for 3 periods
- Sequential mode: ~73s per period (3x slower)

### MEXC — API first, VPS fallback

1. Try `copyFutures/api/v1/traders/top` (~2-5s)
2. Try legacy POST API (~3s)
3. Try futures GET API (~3s)
4. VPS scraper fallback (~120s, last resort)

### HTX — Direct API, no VPS needed

- Public API: `futures.htx.com/-/x/hbg/v1/futures/copytrading/rank`
- ~1-3s response time

---

## Adding a New Exchange

**Step 1**: Create fetcher in `lib/cron/fetchers/`

```typescript
export async function fetchNewExchange(supabase, periods): Promise<FetchResult> {
  // Try direct API first
  // If blocked, use VPS scraper
  // Transform to TraderData[], save to DB
}
```

**Step 2**: Add VPS scraper endpoint (if WAF-blocked)

```bash
ssh root@45.76.152.169
cd /opt/scraper && nano exchanges.js
# Add new endpoint, restart: pm2 restart arena-scraper
```

**Step 3**: Test

```bash
curl http://45.76.152.169:3456/newexchange/leaderboard \
  -H "X-Proxy-Key: $VPS_PROXY_KEY" -m 60
```

**Step 4**: Add cron entry to `vercel.json`

---

## Troubleshooting

### VPS scraper returns 403

VPS IP blocked by exchange WAF. Fix: restart (rotates fingerprints)

```bash
ssh root@45.76.152.169
pm2 restart arena-scraper
```

### VPS scraper timeout

Browser session hung or WAF challenge too long. Fix: increase timeout in fetcher config.

### Fetcher returns 0 traders but VPS works

Exchange changed API endpoint or response format. Inspect response:

```bash
curl http://45.76.152.169:3456/mexc/leaderboard?periodType=2&pageSize=10 \
  -H "X-Proxy-Key: $VPS_PROXY_KEY" -m 60 | jq '.data.resultList[0]'
```

Then update parser in the fetcher.

### Platform has no fresh data

```bash
node scripts/pipeline-health-check.mjs        # Diagnose
node scripts/pipeline-health-check.mjs --fix   # Generate fix script
```

---

## Environment Variables

```bash
VPS_SCRAPER_URL=http://45.76.152.169:3456
VPS_PROXY_KEY=<set-in-secret-manager>
# Fallback proxies (optional)
VPS_PROXY_SG=http://45.76.152.169:3457
VPS_PROXY_JP=http://149.28.27.242:3001
CLOUDFLARE_PROXY_URL=https://ranking-arena-proxy.broosbook.workers.dev
```

---

## Monitoring

### Telegram alerts

Sent via `lib/alerts/send-alert.ts` with 5-minute rate limiting per platform:level.

| Alert Level | Action              |
| ----------- | ------------------- |
| `info`      | No action needed    |
| `warning`   | Check within 1 hour |
| `critical`  | Act immediately     |

### Data freshness

```sql
SELECT source, season_id, COUNT(*), MAX(captured_at) as last_captured
FROM leaderboard_ranks
GROUP BY source, season_id
ORDER BY last_captured DESC;
```

If `last_captured` > 2 hours ago, the fetcher is failing.

---

## Maintenance Checklist

**Daily**: Check VPS scraper health, review Vercel cron logs
**Weekly**: Run full scraper test suite, check Supabase data freshness, review Sentry errors
**Monthly**: Test each exchange manually, update VPS dependencies, rotate VPS API key

---

## Key Infrastructure

| Resource       | Value                                        |
| -------------- | -------------------------------------------- |
| VPS Singapore  | `45.76.152.169` (scraper :3456, proxy :3001) |
| VPS Japan      | `149.28.27.242` (proxy :3001)                |
| CF Worker      | `ranking-arena-proxy.broosbook.workers.dev`  |
| VPS SSH user   | `root` (key: ask Adeline)                    |
| VPS Provider   | Vultr (creds in 1Password)                   |
| Scraper source | `/opt/scraper/` on SG VPS                    |
