# Staging Environment Test & Verification Guide

**Version**: 1.0
**Date**: 2026-01-28
**Target**: Staging Environment
**Est. Time**: 2-3 hours full test

---

## 📋 Overview

This guide provides comprehensive testing procedures for validating all new features in the staging environment before production deployment:

1. ✅ Smart Scheduler System
2. ✅ Anomaly Detection System
3. ✅ Performance Monitoring Dashboard
4. ✅ Search Enhancements
5. ✅ Security Improvements
6. ✅ Database Migrations

---

## 🔧 Prerequisites

### Access Requirements
- [ ] Staging environment URL
- [ ] Admin credentials
- [ ] Database access (Supabase)
- [ ] API testing tool (Postman/curl)
- [ ] Browser DevTools

### Environment Variables
Verify all required env vars are set in staging:

```bash
# Core
NEXT_PUBLIC_SUPABASE_URL=
SUPABASE_SERVICE_KEY=
CRON_SECRET=

# Smart Scheduler
ENABLE_SMART_SCHEDULER=false  # Start disabled
SMART_SCHEDULER_HOT_INTERVAL=15
SMART_SCHEDULER_ACTIVE_INTERVAL=60
SMART_SCHEDULER_NORMAL_INTERVAL=240
SMART_SCHEDULER_DORMANT_INTERVAL=1440

# Anomaly Detection
ENABLE_ANOMALY_DETECTION=false  # Start disabled
ANOMALY_DETECTION_Z_SCORE_THRESHOLD=2.5
ANOMALY_DETECTION_IQR_MULTIPLIER=1.5

# Security
ADMIN_EMAILS=your-admin@example.com
```

---

## 📊 Test 1: Database Migrations

**Time**: 10 minutes
**Critical**: Yes

### 1.1 Verify Smart Scheduler Migration (00026)

```sql
-- Connect to staging database
-- Verify new columns exist
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'trader_sources'
AND column_name IN (
  'activity_tier',
  'next_refresh_at',
  'last_refreshed_at',
  'refresh_priority',
  'tier_updated_at'
);

-- Expected: 5 rows returned
```

**Expected Result**:
```
activity_tier     | character varying
next_refresh_at   | timestamp with time zone
last_refreshed_at | timestamp with time zone
refresh_priority  | integer
tier_updated_at   | timestamp with time zone
```

**Verification**:
- [ ] All 5 columns exist
- [ ] Data types correct
- [ ] No errors

### 1.2 Verify Anomaly Detection Migration (00027)

```sql
-- Verify anomaly table exists
SELECT table_name
FROM information_schema.tables
WHERE table_name = 'trader_anomalies';

-- Check table structure
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'trader_anomalies';

-- Expected: 12+ columns
```

**Expected Columns**:
- id, trader_id, platform
- anomaly_type, field_name
- detected_value, severity
- status, detected_at
- resolved_at, metadata

**Verification**:
- [ ] Table exists
- [ ] All columns present
- [ ] Indexes created
- [ ] No errors

### 1.3 Check Data Integrity

```sql
-- Check existing traders have defaults
SELECT
  COUNT(*) as total_traders,
  COUNT(activity_tier) as traders_with_tier,
  COUNT(CASE WHEN activity_tier = 'normal' THEN 1 END) as normal_tier
FROM trader_sources
WHERE is_active = true;

-- Expected: total_traders = traders_with_tier
-- Most should have 'normal' tier (default)
```

**Verification**:
- [ ] All traders have tier assigned
- [ ] No NULL values in required fields
- [ ] Data looks reasonable

---

## 🧪 Test 2: Smart Scheduler

**Time**: 30 minutes
**Critical**: Yes

### 2.1 Test Tier Calculation API

```bash
# Get CRON_SECRET from staging environment variables
STAGING_URL="https://your-staging-url.vercel.app"
CRON_SECRET="your-cron-secret"

# Test tier calculation endpoint
curl -X GET "${STAGING_URL}/api/cron/calculate-tiers" \
  -H "Authorization: Bearer ${CRON_SECRET}" \
  -v

# Expected: 200 OK with tier statistics
```

**Expected Response**:
```json
{
  "success": true,
  "stats": {
    "hot": 150,
    "active": 800,
    "normal": 3000,
    "dormant": 8050,
    "total": 12000
  },
  "estimatedSavings": {
    "apiCallReduction": "67%",
    "costSavingsPerMonth": "$27,690"
  },
  "timestamp": "2026-01-28T10:00:00.000Z"
}
```

**Verification**:
- [ ] Status 200 OK
- [ ] All tier counts present
- [ ] Total matches sum of tiers
- [ ] Savings calculation present
- [ ] No error messages

### 2.2 Verify Tier Distribution in Database

```sql
-- Check tier distribution
SELECT
  activity_tier,
  COUNT(*) as count,
  ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 2) as percentage
FROM trader_sources
WHERE is_active = true AND activity_tier IS NOT NULL
GROUP BY activity_tier
ORDER BY
  CASE activity_tier
    WHEN 'hot' THEN 1
    WHEN 'active' THEN 2
    WHEN 'normal' THEN 3
    WHEN 'dormant' THEN 4
  END;
```

**Expected Distribution** (approximately):
```
hot      |  150 |  1.25%
active   |  800 |  6.67%
normal   | 3000 | 25.00%
dormant  | 8050 | 67.08%
```

**Verification**:
- [ ] 4 tiers present
- [ ] Distribution reasonable
- [ ] Hot tier small (<2%)
- [ ] Dormant tier large (>60%)

### 2.3 Test Scheduler Stats API

```bash
# Test scheduler statistics endpoint
curl -X GET "${STAGING_URL}/api/admin/scheduler/stats" \
  -v

# Note: This endpoint may not require auth in some configs
```

**Expected Response**:
```json
{
  "ok": true,
  "enabled": false,
  "tierDistribution": {...},
  "apiEfficiency": {...},
  "dataFreshness": {...},
  "configuration": {...}
}
```

**Verification**:
- [ ] Response successful
- [ ] Tier distribution matches database
- [ ] API efficiency calculations present
- [ ] Configuration shows expected values

### 2.4 Test Scheduler Integration (If Enabled)

**Only if `ENABLE_SMART_SCHEDULER=true`**

```bash
# Trigger fetch-details with tier filter
curl -X GET "${STAGING_URL}/api/cron/fetch-details?tier=hot" \
  -H "Authorization: Bearer ${CRON_SECRET}" \
  -v

# Expected: Processes only hot tier traders
```

**Verification**:
- [ ] Only hot tier traders processed
- [ ] Response within reasonable time
- [ ] No errors in logs

---

## 🔍 Test 3: Anomaly Detection

**Time**: 25 minutes
**Critical**: Yes

### 3.1 Test Anomaly Detection API

```bash
# Test anomaly detection cron
curl -X GET "${STAGING_URL}/api/cron/detect-anomalies" \
  -H "Authorization: Bearer ${CRON_SECRET}" \
  -v
```

**Expected Response**:
```json
{
  "success": true,
  "stats": {
    "tradersChecked": 1000,
    "anomaliesDetected": 45,
    "bySeverity": {
      "critical": 5,
      "high": 15,
      "medium": 20,
      "low": 5
    }
  },
  "timestamp": "2026-01-28T10:00:00.000Z"
}
```

**Verification**:
- [ ] Status 200 OK
- [ ] Traders checked > 0
- [ ] Anomalies detected (or 0 if data is clean)
- [ ] Severity breakdown present

### 3.2 Verify Anomalies in Database

```sql
-- Check detected anomalies
SELECT
  severity,
  anomaly_type,
  COUNT(*) as count
FROM trader_anomalies
WHERE status = 'pending'
GROUP BY severity, anomaly_type
ORDER BY
  CASE severity
    WHEN 'critical' THEN 1
    WHEN 'high' THEN 2
    WHEN 'medium' THEN 3
    WHEN 'low' THEN 4
  END;
```

**Verification**:
- [ ] Anomalies inserted if detected
- [ ] Severity levels correct
- [ ] Anomaly types valid (z_score, iqr, pattern)
- [ ] Trader references valid

### 3.3 Test Anomaly Stats API

```bash
# Test anomaly statistics endpoint
curl -X GET "${STAGING_URL}/api/admin/anomalies/stats" \
  -v
```

**Expected Response**:
```json
{
  "ok": true,
  "enabled": false,
  "stats": {
    "total": 45,
    "byStatus": {
      "pending": 30,
      "investigating": 10,
      "resolved": 5
    },
    "bySeverity": {...},
    "byType": {...}
  },
  "recentAnomalies": [...]
}
```

**Verification**:
- [ ] Stats match database counts
- [ ] Recent anomalies list present
- [ ] All categories populated

### 3.4 Test Anomaly Management APIs

```bash
# List anomalies
curl -X GET "${STAGING_URL}/api/admin/anomalies?status=pending&limit=10" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -v

# Get specific anomaly (replace {id} with actual ID)
curl -X GET "${STAGING_URL}/api/admin/anomalies/{id}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -v

# Update anomaly status
curl -X PATCH "${STAGING_URL}/api/admin/anomalies/{id}" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"status": "investigating"}' \
  -v
```

**Verification**:
- [ ] List returns anomalies
- [ ] Get by ID works
- [ ] Update status successful
- [ ] Database updates correctly

---

## 📊 Test 4: Performance Monitoring Dashboard

**Time**: 20 minutes
**Critical**: Yes

### 4.1 Access Dashboard

**URL**: `https://your-staging-url.vercel.app/admin/monitoring`

**Manual Tests**:
1. Navigate to URL
2. Login as admin
3. Verify dashboard loads

**Verification**:
- [ ] Page loads without errors
- [ ] Authentication required
- [ ] Admin-only access enforced

### 4.2 Test Monitoring Overview API

```bash
# Test comprehensive monitoring endpoint
curl -X GET "${STAGING_URL}/api/admin/monitoring/overview" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -v
```

**Expected Response**:
```json
{
  "ok": true,
  "timestamp": "2026-01-28T10:00:00.000Z",
  "health": {
    "score": 87,
    "status": "healthy",
    "color": "#7CFFB2",
    "message": "System operating normally"
  },
  "alerts": {
    "total": 2,
    "critical": 0,
    "warning": 2,
    "items": [...]
  },
  "scheduler": {...},
  "anomalyDetection": {...},
  "system": {...}
}
```

**Verification**:
- [ ] Health score calculated (0-100)
- [ ] Status determined correctly
- [ ] Alerts generated if issues exist
- [ ] All subsystems reported

### 4.3 Test Dashboard Components

**Health Score Card**:
- [ ] Circular progress displays correctly
- [ ] Score matches API response
- [ ] Status badge shows correct color
- [ ] Factor breakdown visible

**Alerts Panel**:
- [ ] Alert counts match API
- [ ] Critical alerts highlighted (red)
- [ ] Warning alerts visible (yellow)
- [ ] Empty state if no alerts

**Scheduler Metrics**:
- [ ] Tier distribution displays
- [ ] API efficiency shown
- [ ] Cost savings calculated
- [ ] Data freshness visible

**Anomaly Metrics**:
- [ ] Detection overview shows
- [ ] Severity breakdown displays
- [ ] Recent anomalies list populated

**System Metrics**:
- [ ] User stats display
- [ ] Content stats visible
- [ ] Moderation queue shown
- [ ] Scraper health visible

### 4.4 Test Auto-Refresh

1. Enable auto-refresh (checkbox)
2. Wait 30 seconds
3. Observe data updates

**Verification**:
- [ ] Auto-refresh checkbox works
- [ ] Data refreshes every 30s
- [ ] Timestamp updates
- [ ] No errors in console

---

## 🔎 Test 5: Search Enhancements

**Time**: 20 minutes
**Critical**: Medium

### 5.1 Test Advanced Search API

```bash
# Test advanced search
curl -X GET "${STAGING_URL}/api/search/advanced?q=BTC&type=traders&limit=10" \
  -v

# Test with filters
curl -X GET "${STAGING_URL}/api/search/advanced?q=profitable&type=traders&minRoi=20&exchange=binance&sortBy=roi" \
  -v
```

**Expected Response**:
```json
{
  "success": true,
  "data": {
    "query": "BTC",
    "filters": {...},
    "results": {
      "traders": [...],
      "posts": [],
      "users": []
    },
    "pagination": {
      "page": 1,
      "limit": 10,
      "total": 25
    }
  }
}
```

**Verification**:
- [ ] Search returns results
- [ ] Filters apply correctly
- [ ] Results match filter criteria
- [ ] Pagination works
- [ ] Sort order correct

### 5.2 Test Recommendations API

```bash
# Test trending recommendations
curl -X GET "${STAGING_URL}/api/search/recommend?type=trending&limit=10" \
  -v

# Test similar recommendations (replace with actual trader)
curl -X GET "${STAGING_URL}/api/search/recommend?type=similar&basedOn=trader:binance:123" \
  -v
```

**Expected Response**:
```json
{
  "success": true,
  "data": {
    "recommendations": [
      {
        "type": "trader",
        "id": "...",
        "title": "...",
        "reason": "trending",
        "url": "/trader/..."
      }
    ],
    "meta": {
      "type": "trending",
      "count": 10
    }
  }
}
```

**Verification**:
- [ ] Recommendations returned
- [ ] Reason labels present
- [ ] URLs valid
- [ ] Mix of types (traders/posts)

### 5.3 Test Search UI Components

**URL**: `https://your-staging-url.vercel.app`

**Manual Tests**:
1. Use search bar
2. Enter query
3. Click "Advanced Filters" (if available)
4. Apply filters
5. View results
6. Check recommendations

**Verification**:
- [ ] Search input works
- [ ] Suggestions appear
- [ ] Filters UI displays
- [ ] Results display correctly
- [ ] Recommendations visible

---

## 🔒 Test 6: Security Improvements

**Time**: 15 minutes
**Critical**: Yes

### 6.1 Verify Security Headers

```bash
# Check security headers
curl -I "${STAGING_URL}" | grep -E "strict-transport|content-security|x-frame"
```

**Expected Headers**:
```
strict-transport-security: max-age=31536000
content-security-policy: ...
x-frame-options: DENY
x-content-type-options: nosniff
```

**Verification**:
- [ ] HSTS header present
- [ ] CSP header present
- [ ] X-Frame-Options: DENY
- [ ] X-Content-Type-Options: nosniff

### 6.2 Test CRON Authentication

```bash
# Test without auth (should fail)
curl -X GET "${STAGING_URL}/api/cron/calculate-tiers" \
  -v

# Expected: 401 Unauthorized

# Test with wrong secret (should fail)
curl -X GET "${STAGING_URL}/api/cron/calculate-tiers" \
  -H "Authorization: Bearer wrong-secret" \
  -v

# Expected: 401 Unauthorized

# Test with correct secret (should succeed)
curl -X GET "${STAGING_URL}/api/cron/calculate-tiers" \
  -H "Authorization: Bearer ${CRON_SECRET}" \
  -v

# Expected: 200 OK
```

**Verification**:
- [ ] No auth = 401
- [ ] Wrong auth = 401
- [ ] Correct auth = 200

### 6.3 Check npm Audit

```bash
# Run security audit
npm audit

# Expected: 0 HIGH/CRITICAL vulnerabilities
```

**Verification**:
- [ ] No CRITICAL vulnerabilities
- [ ] No HIGH vulnerabilities
- [ ] LOW/MODERATE acceptable

---

## ⚡ Test 7: Performance

**Time**: 15 minutes
**Critical**: Medium

### 7.1 Page Load Performance

Use Chrome DevTools Lighthouse:

1. Open staging URL
2. Open DevTools (F12)
3. Go to Lighthouse tab
4. Run audit (Desktop)

**Target Scores**:
- Performance: >90
- Accessibility: >90
- Best Practices: >90
- SEO: >80

**Verification**:
- [ ] Performance score acceptable
- [ ] LCP < 2.5s
- [ ] FID < 100ms
- [ ] CLS < 0.1

### 7.2 API Response Times

Test key API endpoints:

```bash
# Time each request
time curl -s "${STAGING_URL}/api/admin/monitoring/overview" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  > /dev/null

# Expected: < 1 second
```

**Target Response Times**:
- Monitoring Overview: <500ms
- Scheduler Stats: <300ms
- Anomaly Stats: <300ms
- Search Advanced: <500ms

**Verification**:
- [ ] All APIs respond < 1s
- [ ] No timeouts
- [ ] Consistent performance

### 7.3 Database Query Performance

```sql
-- Test expensive queries
EXPLAIN ANALYZE
SELECT * FROM trader_sources
WHERE activity_tier = 'hot'
ORDER BY roi DESC
LIMIT 100;

-- Expected: < 100ms execution time
```

**Verification**:
- [ ] Indexes used correctly
- [ ] Query time acceptable
- [ ] No full table scans on large tables

---

## 🐛 Test 8: Error Handling

**Time**: 10 minutes
**Critical**: Medium

### 8.1 Test API Error Responses

```bash
# Test with invalid parameters
curl -X GET "${STAGING_URL}/api/search/advanced" \
  -v

# Expected: 400 Bad Request (missing query)

curl -X GET "${STAGING_URL}/api/search/advanced?q=test&limit=1000" \
  -v

# Expected: Should limit to max (100)
```

**Verification**:
- [ ] Proper HTTP status codes
- [ ] Error messages clear
- [ ] No stack traces exposed
- [ ] Validation works

### 8.2 Test UI Error States

**Manual Tests**:
1. Disconnect network
2. Try to search
3. Observe error handling

4. Reconnect network
5. Retry action

**Verification**:
- [ ] Error messages displayed
- [ ] User can retry
- [ ] No crashes
- [ ] Graceful degradation

---

## 📝 Test Results Checklist

### Critical Systems

#### Database Migrations
- [ ] Migration 00026 (Smart Scheduler) applied successfully
- [ ] Migration 00027 (Anomaly Detection) applied successfully
- [ ] Data integrity verified
- [ ] Indexes created correctly

#### Smart Scheduler
- [ ] Tier calculation API works
- [ ] Tiers distributed correctly
- [ ] Stats API returns data
- [ ] Integration with fetch-details works

#### Anomaly Detection
- [ ] Detection API works
- [ ] Anomalies saved to database
- [ ] Stats API returns data
- [ ] Management APIs functional

#### Monitoring Dashboard
- [ ] Dashboard accessible
- [ ] Overview API works
- [ ] All components display correctly
- [ ] Auto-refresh functions
- [ ] Health score calculated

#### Search Enhancement
- [ ] Advanced search works
- [ ] Filters apply correctly
- [ ] Recommendations work
- [ ] UI components functional

#### Security
- [ ] Security headers present
- [ ] CRON authentication enforced
- [ ] No critical vulnerabilities
- [ ] Admin access protected

#### Performance
- [ ] Page load < 3s
- [ ] API responses < 1s
- [ ] Lighthouse scores acceptable
- [ ] Database queries optimized

---

## 🚨 Issue Reporting

If issues found, document:

```markdown
### Issue: [Short Description]

**Severity**: Critical/High/Medium/Low
**Component**: [Smart Scheduler/Anomaly Detection/etc]
**Steps to Reproduce**:
1. ...
2. ...

**Expected Behavior**:
...

**Actual Behavior**:
...

**Screenshots/Logs**:
...

**Environment**:
- URL: ...
- Browser: ...
- Time: ...
```

---

## ✅ Sign-Off

**Testing completed by**: _________________
**Date**: _________________
**Overall Status**: ⬜ PASS / ⬜ FAIL / ⬜ PASS WITH ISSUES

**Critical Issues Found**: _____
**Medium Issues Found**: _____
**Low Issues Found**: _____

**Ready for Production**: ⬜ YES / ⬜ NO / ⬜ WITH FIXES

**Notes**:
____________________________________________
____________________________________________
____________________________________________

---

**Last Updated**: 2026-01-28
**Version**: 1.0
**Next Steps**: Fix issues → Retest → Deploy to production
