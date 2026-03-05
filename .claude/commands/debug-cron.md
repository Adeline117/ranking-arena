# Debug Cron Job

Troubleshoot failing or stuck Vercel cron jobs.

## Quick Diagnosis

```bash
# Check recent cron executions
vercel logs --filter cron --limit 50

# Check specific cron job
vercel logs --filter "batch-fetch-traders"
```

## Common Issues

### 1. Timeout (504 Gateway Timeout)
**Cause:** Job exceeds 60s limit (Pro) or 10s (Hobby)

**Fix:**
- Reduce batch size in query params
- Add pagination
- Move to VPS for long-running jobs

### 2. Auth Failure (401/403)
**Cause:** Missing or invalid `CRON_SECRET`

**Check:**
```bash
# Verify env var is set
vercel env ls | grep CRON_SECRET
```

**Fix:**
- Set `CRON_SECRET` in Vercel dashboard
- Ensure route checks `Authorization: Bearer ${CRON_SECRET}`

### 3. Rate Limited (429)
**Cause:** Exchange API rate limit exceeded

**Fix:**
- Increase delay between requests
- Reduce concurrency
- Check `lib/connectors/rate-limiter.ts` settings

### 4. Geo-Blocked
**Cause:** Vercel region (hnd1) blocked by exchange

**Symptoms:**
- Works locally but fails in prod
- 403 or connection timeout

**Fix:**
- Enable proxy fallback in connector
- Deploy Cloudflare Worker
- Use VPS for that platform

### 5. Database Error
**Cause:** Supabase connection or query issue

**Check:**
```sql
-- Check recent errors in Supabase logs
SELECT * FROM postgres_logs
WHERE error_severity = 'ERROR'
ORDER BY timestamp DESC
LIMIT 20;
```

## Manual Trigger

```bash
# Test cron locally
curl -X POST http://localhost:3000/api/cron/batch-fetch-traders?group=a \
  -H "Authorization: Bearer $CRON_SECRET"

# Test on production (be careful)
curl -X POST https://www.arenafi.org/api/cron/batch-fetch-traders?group=a \
  -H "Authorization: Bearer $CRON_SECRET"
```

## Cron Schedule Reference

```
*/5 * * * *   = Every 5 minutes
0 * * * *     = Every hour at :00
0 */4 * * *   = Every 4 hours
0 0 * * *     = Daily at midnight
```

## Key Files
- `vercel.json` - Cron definitions
- `app/api/cron/*/route.ts` - Cron handlers
- `lib/connectors/circuit-breaker.ts` - Fault tolerance
- `lib/cron/` - Cron utilities

## Monitoring
- Vercel Dashboard > Functions > Cron
- Sentry for error tracking
- `npm run diagnose` for data freshness
