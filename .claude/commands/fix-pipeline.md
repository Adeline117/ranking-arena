# Fix Data Pipeline

Diagnose and fix data pipeline issues for Arena trader data.

## Steps

1. **Check Data Freshness**
   ```bash
   npm run diagnose
   npm run check:freshness
   ```

2. **Identify Stale Platforms**
   - Look for platforms with `last_updated` > 6 hours ago
   - Check `trader_snapshots` for gaps

3. **Common Fixes**

   **If cron job failing:**
   - Check Vercel logs: `vercel logs --filter cron`
   - Verify `CRON_SECRET` is set
   - Check rate limits on exchange APIs

   **If geo-blocked:**
   - Verify Cloudflare Worker is deployed
   - Check proxy fallback in connector
   - Test from VPS: `npm run worker:discover`

   **If enrichment stuck:**
   - Check `trader_details` NULL counts
   - Run manual enrichment: `npm run backfill:24h`

4. **Verify Fix**
   - Wait for next cron cycle
   - Re-run `npm run diagnose`
   - Check Supabase dashboard for new records

## Key Files
- `vercel.json` - Cron schedules
- `app/api/cron/` - Cron route handlers
- `lib/connectors/` - Exchange connectors
- `scripts/diagnose.mjs` - Diagnostic tool

## Quick Commands
```bash
# Check specific platform
npm run check:platforms -- --platform binance_futures

# Manual fetch for platform
npx tsx scripts/manual-populate-binance-futures.ts

# Check enrichment coverage
npm run check:enrichment
```
