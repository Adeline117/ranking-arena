# Emergency Fix: Failed Jobs - 2026-03-15

## Current Status
- Health: 89/148 (60.1%)
- Target: 95%+
- Recent failures: batch-fetch-traders groups + KuCoin verify

## Investigation Results

### 1. KuCoin (verify-kucoin) - ALREADY FIXED ✅
- **Status**: No runs in last 24 hours
- **Last error**: 2026-03-14 15:30 (yesterday)
- **Root cause**: Already removed from verify-registry.ts
- **Action**: None needed - issue resolved

### 2. Batch-Fetch-Traders Failures (Active Issue)

#### Failed Jobs (Last 24h):
- `batch-fetch-traders-a2`: 27 failures (bybit, bitget_futures failing)
- `batch-fetch-traders-h`: 19 failures (gateio failing)
- `batch-fetch-traders-f`: 12 failures (mexc failing)
- `batch-fetch-traders-a`: 15 failures
- `batch-fetch-traders-e`: 11 failures
- `batch-fetch-traders-c`: 11 failures

#### Root Cause:
Error pattern: "Both direct API and VPS scraper failed for {platform}"

This indicates:
1. Direct API calls are failing (likely WAF/geo-blocks/rate limits)
2. VPS proxy fallback is also failing (VPS down, proxy misconfigured, or credentials wrong)

## Fix Strategy

### Priority 1: Check VPS Health
```bash
# Test VPS connectivity
ssh root@45.76.152.169 "curl http://localhost:3456/health"

# Check VPS scraper service
ssh root@45.76.152.169 "pm2 list"
ssh root@45.76.152.169 "pm2 logs arena-proxy --lines 50"
```

### Priority 2: Test Platform APIs Directly
For each failing platform, test if direct API works:
- bybit
- bitget_futures  
- mexc
- gateio

### Priority 3: Disable Permanently Broken Platforms
If a platform is confirmed dead (not just temporarily down):
1. Remove from GROUPS in `app/api/cron/batch-fetch-traders/route.ts`
2. Add to DEAD_BLOCKED_PLATFORMS in `lib/constants/exchanges.ts`
3. Git commit + push

### Priority 4: Fix VPS Issues
If VPS is the problem:
1. Restart services on VPS
2. Check proxy key configuration
3. Test endpoints manually
4. Verify env vars are set correctly

## Next Steps

1. SSH to VPS and check service health
2. Test individual platform APIs
3. Implement fixes based on findings
4. Git commit + push each fix
5. Monitor next cron run

## Expected Outcome
- Failed jobs: 5 → 0
- Health: 60% → 95%+
