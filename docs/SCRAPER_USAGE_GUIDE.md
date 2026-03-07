# Scraper Usage Guide

Quick reference for using and maintaining Arena's scraper infrastructure.

---

## Quick Start

### Test VPS Scraper Health

```bash
# Health check
npm run test:scraper-health

# Or manually
curl http://45.76.152.169:3456/health
```

### Run Full Scraper Test

```bash
npm run test:scrapers
# Or with specific platform
npx tsx scripts/test-vps-scrapers.ts
```

### Run Data Collection (Production)

```bash
# Single platform
npm run fetch:bybit
npm run fetch:mexc
npm run fetch:htx

# All platforms
npm run fetch:all
```

---

## Common Tasks

### 1. Add New Exchange

**Step 1**: Create fetcher in `lib/cron/fetchers/`

```typescript
// lib/cron/fetchers/newexchange.ts
import { type FetchResult, type TraderData, upsertTraders } from './shared'

export async function fetchNewExchange(
  supabase: SupabaseClient,
  periods: string[]
): Promise<FetchResult> {
  const result: FetchResult = { source: 'newexchange', periods: {}, duration: 0 }
  
  try {
    // Try direct API first
    const data = await fetch('https://newexchange.com/api/leaderboard')
    
    // If API blocked, use VPS scraper
    if (!data) {
      const scraped = await callVpsScraper('/newexchange/leaderboard')
      // Parse and save
    }
    
    // Transform to TraderData[]
    const traders: TraderData[] = []
    
    // Save to DB
    await upsertTraders(supabase, traders)
    
  } catch (err) {
    logger.error(`[newexchange] Fetch failed`, err)
  }
  
  return result
}
```

**Step 2**: Add to VPS scraper (if needed)

```bash
# SSH to VPS
ssh root@45.76.152.169

# Edit scraper code
cd /opt/scraper
nano exchanges.js

# Add new endpoint
async function scrapeNewExchange({ period }) {
  return withBrowser(async (browser) => {
    const page = await browser.newPage()
    await page.goto('https://newexchange.com/leaderboard')
    // ... intercept API
  })
}

# Restart service
pm2 restart arena-scraper
```

**Step 3**: Test

```bash
curl http://45.76.152.169:3456/newexchange/leaderboard \
  -H "X-Proxy-Key: arena-proxy-sg-2026" \
  -m 60
```

---

### 2. Debug Failing Scraper

**Symptoms**: Fetcher returns 0 traders or timeout

**Step 1**: Check VPS scraper health

```bash
curl http://45.76.152.169:3456/health
```

If `ok: false` or timeout → VPS scraper is down

**Step 2**: Check VPS scraper logs

```bash
ssh root@45.76.152.169
pm2 logs arena-scraper --lines 100
```

Look for:
- `ERR_HTTP2_PROTOCOL_ERROR` → WAF blocked
- `Timeout` → Exchange is slow/down
- `Challenge detected` → Cloudflare challenge

**Step 3**: Test endpoint manually

```bash
curl http://45.76.152.169:3456/bybit/leaderboard?pageSize=10 \
  -H "X-Proxy-Key: arena-proxy-sg-2026" \
  -m 120
```

**Step 4**: Check exchange site manually

```bash
# Open in browser
open https://www.bybit.com/copyTrade/trade/leader-list

# Check if page loads, if there's a captcha, etc.
```

**Step 5**: Restart VPS scraper (rotates fingerprints)

```bash
ssh root@45.76.152.169
pm2 restart arena-scraper
pm2 logs arena-scraper --lines 50
```

---

### 3. Optimize Slow Fetchers

**Problem**: MEXC takes >2 minutes

**Solution 1**: Use API endpoints first, scraper as fallback

```typescript
// Try fast API endpoints first
await tryCopyFuturesApi()  // ~2s
if (allTraders.size === 0) await tryLegacyApi()  // ~3s

// Only use VPS scraper if APIs fail
if (allTraders.size === 0 && VPS_SCRAPER_KEY) {
  await callVpsScraper('/mexc/leaderboard')  // ~120s
}
```

**Solution 2**: Cache VPS scraper results

```typescript
const CACHE_TTL = 30 * 60 * 1000 // 30 minutes
const cache = new Map()

async function fetchWithCache(key, fetcher) {
  const cached = cache.get(key)
  if (cached && Date.now() < cached.expires) {
    return cached.data
  }
  
  const data = await fetcher()
  cache.set(key, { data, expires: Date.now() + CACHE_TTL })
  return data
}
```

**Solution 3**: Run in parallel

```typescript
// Instead of sequential
const bybit = await fetchBybit()
const mexc = await fetchMexc()
const htx = await fetchHtx()

// Run in parallel
const [bybit, mexc, htx] = await Promise.all([
  fetchBybit(),
  fetchMexc(),
  fetchHtx(),
])
```

---

### 4. Handle API Changes

**Symptoms**: Fetcher returns 0 traders but VPS scraper works

**Diagnosis**: Exchange changed API endpoint or response format

**Step 1**: Inspect current response

```bash
# Call VPS scraper and save response
curl http://45.76.152.169:3456/mexc/leaderboard?periodType=2&pageSize=10 \
  -H "X-Proxy-Key: arena-proxy-sg-2026" \
  -m 60 > mexc-response.json

# Check structure
cat mexc-response.json | jq '.data.resultList[0]'
```

**Step 2**: Update parser in fetcher

```typescript
// Old parser
const roi = parseNum(item.roi)

// If response changed from { roi: 0.1234 } to { roi: "12.34%" }
const roi = parsePercent(item.roi) // Use parsePercent instead
```

**Step 3**: Test locally

```bash
npm run fetch:mexc -- --limit 10
```

---

### 5. Monitor Production Performance

**View Cron Job Logs**

```bash
# Vercel logs (for API cron routes)
vercel logs --project ranking-arena --limit 100

# Mac Mini logs (for local cron scripts)
ssh adelinewen@100.91.73.20
tail -f ~/ranking-arena/logs/cron-*.log
```

**Check Supabase Data Freshness**

```sql
SELECT source, season_id, COUNT(*), MAX(captured_at) as last_captured
FROM leaderboard_ranks
GROUP BY source, season_id
ORDER BY last_captured DESC;
```

If `last_captured` > 2 hours ago → fetcher is failing

**Monitor VPS Scraper Uptime**

```bash
# Set up cron job on local machine
crontab -e

# Add:
*/5 * * * * curl -s http://45.76.152.169:3456/health | jq '.ok' || echo "VPS scraper down" | mail -s "Alert: VPS Scraper Down" your@email.com
```

---

## Environment Variables

### Required

```bash
# .env.local or .env.production
VPS_SCRAPER_URL=http://45.76.152.169:3456
VPS_PROXY_KEY=arena-proxy-sg-2026
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

### Optional (Fallback Proxies)

```bash
VPS_PROXY_SG=http://45.76.152.169:3457  # SG generic proxy
VPS_PROXY_JP=http://jp-proxy-url:3456    # Japan proxy
CLOUDFLARE_PROXY_URL=https://worker-url  # CF Worker proxy
```

---

## Scripts Reference

| Script | Purpose | Usage |
|--------|---------|-------|
| `test-vps-scrapers.ts` | Health check + performance test | `npx tsx scripts/test-vps-scrapers.ts` |
| `test-scrapers.ts` | Test local Playwright scrapers (deprecated) | `npx tsx scripts/test-scrapers.ts bybit` |
| `debug-bybit.ts` | Debug Bybit page navigation | `npx tsx scripts/debug-bybit.ts` |
| `fetch_details_fast.mjs` | Fetch trader details (enrichment) | `npm run scrape:details` |

---

## Performance Targets

| Platform | Target | Current | Status |
|----------|--------|---------|--------|
| Bybit (batch) | < 90s | ~65s | ✅ Good |
| MEXC (scraper) | < 60s | >120s | ❌ Slow |
| MEXC (API) | < 10s | ~3s | ✅ Good |
| HTX | < 5s | ~2s | ✅ Good |
| Bitget | < 45s | ~40s | ✅ Good |

---

## Alerts & Monitoring

### Set Up Alerts

**Option 1**: Vercel Cron Monitoring

```typescript
// In API route
import { captureException } from '@/lib/utils/logger'

try {
  const result = await fetchBybit()
  if (result.periods['30D'].saved === 0) {
    captureException(new Error('Bybit returned 0 traders'))
  }
} catch (err) {
  captureException(err)
}
```

**Option 2**: Healthchecks.io

```bash
# Add to cron job
npx tsx scripts/fetch-all.ts && curl https://hc-ping.com/your-uuid
```

**Option 3**: Custom Telegram Bot

```typescript
async function sendAlert(message: string) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: `🚨 Arena Alert\n\n${message}`,
    }),
  })
}

// In fetcher
if (saved === 0) {
  await sendAlert('Bybit fetcher returned 0 traders')
}
```

---

## Maintenance Checklist

### Daily
- [ ] Check VPS scraper health
- [ ] Review Vercel cron logs

### Weekly
- [ ] Run full scraper test suite
- [ ] Check Supabase data freshness
- [ ] Review Sentry errors

### Monthly
- [ ] Test each exchange manually in browser
- [ ] Update VPS scraper dependencies
- [ ] Rotate VPS scraper API key
- [ ] Review performance metrics

---

## FAQ

**Q: Why do we need a VPS scraper?**

A: Bybit and MEXC use Cloudflare/Akamai WAF that blocks all direct API access (HTTP 403). Browser-based scraping with realistic fingerprints is the only reliable way to bypass this.

**Q: Can we run scrapers locally instead of on VPS?**

A: No. Tested locally - Bybit still returns 403 even with stealth mode. VPS with rotating residential IPs is required.

**Q: Why is MEXC so slow?**

A: MEXC's WAF requires longer wait times for challenge resolution. Working on optimization (target: 60s).

**Q: What if VPS scraper goes down?**

A: Fetchers have fallback strategies:
1. Try direct API (may fail with 403)
2. Try Cloudflare Worker proxy
3. Try Japan VPS proxy
4. Return cached data (if available)

**Q: How to add a new exchange?**

A: See [Common Tasks](#common-tasks) → "Add New Exchange"

---

## Support

**VPS Access**:
- Host: `45.76.152.169`
- User: `root`
- SSH key: Ask Adeline

**Emergency Contacts**:
- VPS Provider: Vultr (account in 1Password)
- Cloudflare Worker: ranking-arena-proxy (account in 1Password)

**Helpful Resources**:
- [SCRAPER_ARCHITECTURE.md](./SCRAPER_ARCHITECTURE.md)
- VPS scraper source: `/opt/scraper/` on SG VPS
- Playwright docs: https://playwright.dev/
