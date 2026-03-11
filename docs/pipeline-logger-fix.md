# Pipeline Logger Leak Fix

**Date:** 2026-03-11  
**Issue:** Enrichment jobs creating `pipeline_logs` records but never closing them  
**Impact:** Health monitor false alarms for "stuck" jobs

## Problem

Pipeline jobs create log entries via `PipelineLogger.start()` but some fail to call `.success()` or `.error()` on completion, leaving logs in "running" status forever.

### Evidence
- 8+ jobs stuck in "running" status after completion (historically)
- Jobs: `enrich-bybit`, `enrich-bybit_spot`, `enrich-binance_spot`, etc.
- 16 different enrichment job types affected
- Health monitor marks these as "stuck" after 30 minutes

## Root Cause

The `pipeline_job_status` view has this logic:

```sql
CASE
  WHEN status = 'running' AND started_at < (now() - INTERVAL '30 minutes') THEN 'stuck'
  WHEN status = 'error' THEN 'failed'
  WHEN status = 'success' AND started_at < (now() - INTERVAL '24 hours') THEN 'stale'
  WHEN status = 'success' THEN 'healthy'
  ELSE status
END AS health_status
```

Jobs that crash or timeout without calling `.success()`/`.error()` remain in "running" status. The view marks them as "stuck" for monitoring, but **no automated cleanup existed** to actually update them to "timeout".

## Investigation Results

### Code Audit
✅ **All current enrichment code properly closes logs:**
- `runEnrichment()` in `lib/cron/enrichment-runner.ts` (line 557-559)
- `batch-enrich` route in `app/api/cron/batch-enrich/route.ts` (line 185-192)
- Both have proper try/catch with `.success()` and `.error()` calls

### Database Check
✅ **No stuck logs found** (as of 2026-03-11):
```sql
SELECT * FROM pipeline_logs 
WHERE status = 'running' 
  AND started_at < NOW() - INTERVAL '30 minutes';
-- Returns 0 rows
```

### Historical Data
✅ **Recent enrichment jobs have proper status:**
- `enrich-binance_futures`: 205 success
- `enrich-bybit`: 131 success, 2 error
- `enrich-binance_spot`: 173 success, 1 error, 10 timeout
- All jobs show final status (success/error/timeout)

## Solution

### 1. Automated Cleanup Cron

Created `/api/cron/cleanup-stuck-logs/route.ts`:
- Runs every 15 minutes
- Finds logs with `status = 'running'` and `started_at < NOW() - 30 minutes`
- Marks them as `timeout` with appropriate error message
- Returns summary of cleaned jobs

**Schedule:** `*/15 * * * *` (every 15 minutes)

### 2. Configuration Updates

**Added to `vercel.json`:**
```json
{
  "path": "/api/cron/cleanup-stuck-logs",
  "schedule": "*/15 * * * *"
}
```

**Added to `infra/bullmq/jobs.js`:**
```javascript
{ 
  name: 'cleanup-stuck-logs', 
  path: '/api/cron/cleanup-stuck-logs', 
  cron: '*/15 * * * *' 
}
```

### 3. Testing

Created `scripts/test-cleanup-stuck-logs.mjs`:
1. Creates fake stuck log (40 min ago, status = running)
2. Calls cleanup API
3. Verifies log marked as timeout
4. Cleans up test data

**Run test:**
```bash
node scripts/test-cleanup-stuck-logs.mjs
```

## Defensive Recommendations

While current code properly closes logs, consider these additional safeguards:

### 1. Wrapper Function
```typescript
async function withPipelineLog<T>(
  jobName: string,
  fn: () => Promise<T>,
  metadata?: Record<string, unknown>
): Promise<T> {
  const plog = await PipelineLogger.start(jobName, metadata)
  try {
    const result = await fn()
    await plog.success(metadata?.recordsProcessed || 0)
    return result
  } catch (err) {
    await plog.error(err)
    throw err
  }
}
```

### 2. Global Error Handler
Add to Next.js middleware to catch unhandled errors and close logs.

### 3. Database Trigger
Auto-mark logs as timeout after 2 hours:
```sql
CREATE OR REPLACE FUNCTION auto_timeout_stuck_logs()
RETURNS void AS $$
BEGIN
  UPDATE pipeline_logs
  SET 
    status = 'timeout',
    ended_at = NOW(),
    error_message = 'Auto-timeout: stuck >2 hours'
  WHERE status = 'running'
    AND started_at < NOW() - INTERVAL '2 hours';
END;
$$ LANGUAGE plpgsql;
```

## Monitoring

The existing health monitor (`scripts/openclaw/pipeline-health-monitor.mjs`) will:
- Detect "stuck" jobs via `pipeline_job_status` view
- Alert if stuck jobs exist
- Now cleanup-stuck-logs will auto-resolve within 15 min

## Deployment

1. ✅ Created cleanup route
2. ✅ Updated vercel.json
3. ✅ Updated BullMQ jobs
4. ⏳ Deploy to production
5. ⏳ Run test script
6. ⏳ Monitor for 24h

## Commit Message

```
fix: add automated cleanup for stuck pipeline logs

Problem: Enrichment jobs that crash/timeout can leave pipeline_logs 
in "running" status forever, causing health monitor false alarms.

Solution: New cleanup-stuck-logs cron (every 15min) marks logs 
running >30min as "timeout" to match health monitor threshold.

Files:
- app/api/cron/cleanup-stuck-logs/route.ts (new)
- vercel.json (add cron schedule)
- infra/bullmq/jobs.js (add job)
- scripts/test-cleanup-stuck-logs.mjs (test script)
- docs/pipeline-logger-fix.md (documentation)

Evidence: All current enrichment code properly closes logs. No stuck 
logs found in DB. This is a defensive measure to prevent future false 
alarms from edge cases (OOM, process kills, etc).
```

## Related Files

- `lib/services/pipeline-logger.ts` - PipelineLogger class
- `lib/cron/enrichment-runner.ts` - Enrichment logic (properly closes logs)
- `app/api/cron/batch-enrich/route.ts` - Batch enrichment (properly closes logs)
- `app/api/health/pipeline/route.ts` - Health check API
- `scripts/openclaw/pipeline-health-monitor.mjs` - Health monitor

## Future Improvements

1. Add telemetry to track log close rate
2. Alert on high unclosed log rate
3. Add request timeout middleware that auto-closes logs
4. Database constraint: logs >6h old must have ended_at set
