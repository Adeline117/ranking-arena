# Quick Start - Staging Environment Testing

**Est. Time**: 30 minutes (basic) | 2-3 hours (comprehensive)
**Date**: 2026-01-28

---

## 🚀 Quick Start (5 Minutes)

### Step 1: Set Environment Variables

```bash
# Copy and customize these values
export STAGING_URL="https://your-staging-url.vercel.app"
export CRON_SECRET="your-cron-secret-from-vercel"
export ACCESS_TOKEN="your-admin-access-token"
```

**Where to find these**:
- `STAGING_URL`: Your Vercel staging deployment URL
- `CRON_SECRET`: Vercel Dashboard → Project → Settings → Environment Variables
- `ACCESS_TOKEN`: Login to staging, open DevTools → Application → Local Storage → `supabase.auth.token`

### Step 2: Run Automated Tests

```bash
# Make script executable
chmod +x scripts/staging/test-runner.sh

# Run all tests
./scripts/staging/test-runner.sh
```

**Expected Output**:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Ranking Arena - Staging Test Runner
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✓ curl is installed
✓ STAGING_URL is set: https://...
✓ CRON_SECRET is set

▶ Testing: Homepage
✓ Homepage returned 200 (expected 200)

▶ Testing: Advanced Search - Basic Query
✓ Advanced Search - Basic Query returned 200 (expected 200)

...

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Test Summary
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✓ Passed:  15
✗ Failed:  0
⊘ Skipped: 2

Pass Rate: 100%

✓ All tests passed! Staging environment is healthy.
```

### Step 3: Verify Database

```bash
# Open Supabase Dashboard → SQL Editor
# Copy and paste the contents of:
cat scripts/staging/verify-database.sql

# Run the script in SQL Editor
```

**Expected**: All checks should pass with expected row counts.

---

## 📋 Detailed Testing Checklist

### Phase 1: Database Verification (10 min)

- [ ] **Run SQL Verification Script**
  ```sql
  -- In Supabase SQL Editor
  -- Paste content from scripts/staging/verify-database.sql
  ```

- [ ] **Verify Migration 00026 (Smart Scheduler)**
  - [ ] 5 new columns exist in `trader_sources`
  - [ ] All active traders have `activity_tier`
  - [ ] Tier distribution looks reasonable

- [ ] **Verify Migration 00027 (Anomaly Detection)**
  - [ ] `trader_anomalies` table exists
  - [ ] 12+ columns present
  - [ ] Indexes created

- [ ] **Check Data Integrity**
  - [ ] No NULL values in required fields
  - [ ] Query performance acceptable (<100ms)

### Phase 2: API Testing (15 min)

Run automated test script OR test manually:

#### Smart Scheduler APIs

```bash
# Test tier calculation
curl -X GET "${STAGING_URL}/api/cron/calculate-tiers" \
  -H "Authorization: Bearer ${CRON_SECRET}"

# Expected: 200 OK with tier stats
```

```bash
# Test scheduler stats
curl -X GET "${STAGING_URL}/api/admin/scheduler/stats"

# Expected: 200 OK with tier distribution
```

#### Anomaly Detection APIs

```bash
# Test anomaly detection
curl -X GET "${STAGING_URL}/api/cron/detect-anomalies" \
  -H "Authorization: Bearer ${CRON_SECRET}"

# Expected: 200 OK with anomaly stats
```

```bash
# Test anomaly stats
curl -X GET "${STAGING_URL}/api/admin/anomalies/stats"

# Expected: 200 OK with anomaly breakdown
```

#### Monitoring Dashboard APIs

```bash
# Test monitoring overview
curl -X GET "${STAGING_URL}/api/admin/monitoring/overview" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}"

# Expected: 200 OK with health score and all metrics
```

#### Search Enhancement APIs

```bash
# Test advanced search
curl -X GET "${STAGING_URL}/api/search/advanced?q=BTC&type=traders&limit=5"

# Expected: 200 OK with search results
```

```bash
# Test recommendations
curl -X GET "${STAGING_URL}/api/search/recommend?type=trending&limit=10"

# Expected: 200 OK with recommendations
```

### Phase 3: UI Testing (30 min)

#### Monitoring Dashboard

1. **Access Dashboard**
   - Navigate to `${STAGING_URL}/admin/monitoring`
   - Login as admin
   - Verify dashboard loads

2. **Check Components**
   - [ ] Health Score Card displays (0-100 score)
   - [ ] Alerts Panel shows alerts or empty state
   - [ ] Scheduler Metrics displays tier distribution
   - [ ] Anomaly Metrics shows detection stats
   - [ ] System Metrics displays user/content stats

3. **Test Auto-Refresh**
   - [ ] Enable auto-refresh checkbox
   - [ ] Wait 30 seconds
   - [ ] Verify timestamp updates

#### Search Enhancement

1. **Test Search Bar**
   - Go to homepage
   - Enter search query
   - [ ] Suggestions appear
   - [ ] Click suggestion navigates correctly

2. **Test Advanced Search** (if integrated)
   - [ ] Filters UI displays
   - [ ] Apply filters works
   - [ ] Results update correctly

3. **Test Recommendations** (if integrated)
   - [ ] Recommendations display
   - [ ] Click navigates correctly

### Phase 4: Security Testing (5 min)

```bash
# Test CRON without auth (should fail)
curl -X GET "${STAGING_URL}/api/cron/calculate-tiers"
# Expected: 401 Unauthorized

# Test admin without auth (should fail)
curl -X GET "${STAGING_URL}/api/admin/monitoring/overview"
# Expected: 401 Unauthorized

# Check security headers
curl -I "${STAGING_URL}" | grep -E "strict-transport|content-security|x-frame"
# Expected: See security headers
```

### Phase 5: Performance Testing (10 min)

#### Lighthouse Audit

1. Open Chrome DevTools (F12)
2. Go to Lighthouse tab
3. Run audit (Desktop)
4. Verify scores:
   - [ ] Performance > 80
   - [ ] Accessibility > 90
   - [ ] Best Practices > 90

#### API Response Times

```bash
# Time each request
time curl -s "${STAGING_URL}/api/admin/monitoring/overview" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" > /dev/null

# Expected: < 1 second
```

---

## 🐛 Troubleshooting

### Issue: "curl: command not found"

**Solution**: Install curl
```bash
# macOS
brew install curl

# Ubuntu/Debian
sudo apt-get install curl

# Windows
# Use Git Bash or WSL
```

### Issue: "401 Unauthorized" on all endpoints

**Solution**: Check environment variables
```bash
echo $CRON_SECRET
echo $ACCESS_TOKEN

# If empty, set them again
export CRON_SECRET="your-secret"
export ACCESS_TOKEN="your-token"
```

### Issue: "Connection refused" or "Could not resolve host"

**Solution**: Check STAGING_URL
```bash
echo $STAGING_URL

# Make sure it includes https://
export STAGING_URL="https://your-staging-url.vercel.app"
```

### Issue: Database verification shows NULL values

**Solution**: Run tier calculation
```bash
curl -X GET "${STAGING_URL}/api/cron/calculate-tiers" \
  -H "Authorization: Bearer ${CRON_SECRET}"

# Then re-run database verification
```

### Issue: Test script permission denied

**Solution**: Make executable
```bash
chmod +x scripts/staging/test-runner.sh
```

---

## 📊 Expected Results Summary

### Database
- ✅ All migrations applied
- ✅ 5 new columns in `trader_sources`
- ✅ `trader_anomalies` table exists
- ✅ All indexes created
- ✅ Data integrity verified

### APIs
- ✅ Smart Scheduler APIs respond
- ✅ Anomaly Detection APIs respond
- ✅ Monitoring Dashboard API responds
- ✅ Search Enhancement APIs respond
- ✅ Security endpoints protected

### UI
- ✅ Monitoring Dashboard accessible
- ✅ All components display correctly
- ✅ Auto-refresh works
- ✅ Search enhancements work

### Performance
- ✅ Page load < 3s
- ✅ API responses < 1s
- ✅ Lighthouse scores acceptable

---

## ✅ Sign-Off Checklist

After completing all tests:

- [ ] Database migrations verified
- [ ] All API endpoints tested
- [ ] UI components working
- [ ] Security verified
- [ ] Performance acceptable
- [ ] No critical issues found

**Tested By**: _________________
**Date**: _________________
**Status**: ⬜ PASS / ⬜ FAIL / ⬜ PASS WITH MINOR ISSUES

**Notes**:
_________________________________________________
_________________________________________________

---

## 🚀 Next Steps

### If All Tests Pass
1. Document test results
2. Proceed to production deployment
3. Monitor for 24-48 hours
4. Enable Smart Scheduler (`ENABLE_SMART_SCHEDULER=true`)
5. Enable Anomaly Detection (`ENABLE_ANOMALY_DETECTION=true`)

### If Tests Fail
1. Document failures
2. Create GitHub issues
3. Fix issues
4. Re-run tests
5. Repeat until all pass

---

## 📞 Support

### Documentation
- Full Guide: `docs/STAGING_TEST_GUIDE.md`
- Test Script: `scripts/staging/test-runner.sh`
- DB Script: `scripts/staging/verify-database.sql`

### Issues
Report at: https://github.com/your-org/ranking-arena/issues

---

**Good Luck with Testing!** 🚀
