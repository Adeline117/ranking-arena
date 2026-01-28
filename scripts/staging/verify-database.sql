-- ============================================
-- Staging Database Verification Script
-- ============================================
-- Run this in Supabase SQL Editor to verify all migrations

\echo '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
\echo '  Ranking Arena - Database Verification'
\echo '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
\echo ''

-- ============================================
-- 1. Verify Smart Scheduler Migration (00026)
-- ============================================

\echo '▶ Checking Smart Scheduler columns...'

SELECT
    column_name,
    data_type,
    is_nullable
FROM information_schema.columns
WHERE table_name = 'trader_sources'
AND column_name IN (
    'activity_tier',
    'next_refresh_at',
    'last_refreshed_at',
    'refresh_priority',
    'tier_updated_at'
)
ORDER BY column_name;

\echo ''
\echo '✓ Expected: 5 rows (activity_tier, next_refresh_at, last_refreshed_at, refresh_priority, tier_updated_at)'
\echo ''

-- Check if default values are applied
\echo '▶ Checking tier distribution...'

SELECT
    activity_tier,
    COUNT(*) as trader_count,
    ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 2) as percentage
FROM trader_sources
WHERE is_active = true
GROUP BY activity_tier
ORDER BY
    CASE activity_tier
        WHEN 'hot' THEN 1
        WHEN 'active' THEN 2
        WHEN 'normal' THEN 3
        WHEN 'dormant' THEN 4
        ELSE 5
    END;

\echo ''
\echo '✓ Expected: Distribution across 4 tiers (hot/active/normal/dormant)'
\echo ''

-- ============================================
-- 2. Verify Anomaly Detection Migration (00027)
-- ============================================

\echo '▶ Checking Anomaly Detection table...'

SELECT
    table_name,
    table_type
FROM information_schema.tables
WHERE table_name = 'trader_anomalies';

\echo ''
\echo '✓ Expected: 1 row (trader_anomalies, BASE TABLE)'
\echo ''

\echo '▶ Checking Anomaly Detection columns...'

SELECT
    column_name,
    data_type,
    is_nullable
FROM information_schema.columns
WHERE table_name = 'trader_anomalies'
ORDER BY ordinal_position;

\echo ''
\echo '✓ Expected: 12+ columns (id, trader_id, platform, anomaly_type, field_name, etc.)'
\echo ''

-- Check if any anomalies exist
\echo '▶ Checking anomaly records...'

SELECT
    status,
    severity,
    COUNT(*) as count
FROM trader_anomalies
GROUP BY status, severity
ORDER BY
    CASE status
        WHEN 'pending' THEN 1
        WHEN 'investigating' THEN 2
        WHEN 'resolved' THEN 3
        WHEN 'false_positive' THEN 4
    END,
    CASE severity
        WHEN 'critical' THEN 1
        WHEN 'high' THEN 2
        WHEN 'medium' THEN 3
        WHEN 'low' THEN 4
    END;

\echo ''
\echo '✓ Note: May be 0 rows if anomaly detection has not run yet'
\echo ''

-- ============================================
-- 3. Verify Indexes
-- ============================================

\echo '▶ Checking Smart Scheduler indexes...'

SELECT
    indexname,
    tablename
FROM pg_indexes
WHERE tablename = 'trader_sources'
AND indexname LIKE '%tier%' OR indexname LIKE '%refresh%'
ORDER BY indexname;

\echo ''
\echo '✓ Expected: Multiple indexes for activity_tier, next_refresh_at, etc.'
\echo ''

\echo '▶ Checking Anomaly Detection indexes...'

SELECT
    indexname,
    tablename
FROM pg_indexes
WHERE tablename = 'trader_anomalies'
ORDER BY indexname;

\echo ''
\echo '✓ Expected: Indexes on trader_id, platform, severity, status, etc.'
\echo ''

-- ============================================
-- 4. Data Integrity Checks
-- ============================================

\echo '▶ Checking data integrity...'

-- Check for traders without tier
SELECT
    COUNT(*) as total_traders,
    COUNT(activity_tier) as traders_with_tier,
    COUNT(activity_tier) * 100.0 / NULLIF(COUNT(*), 0) as percentage_with_tier
FROM trader_sources
WHERE is_active = true;

\echo ''
\echo '✓ Expected: percentage_with_tier close to 100%'
\echo ''

-- Check for null values in critical fields
SELECT
    COUNT(CASE WHEN activity_tier IS NULL THEN 1 END) as null_tier,
    COUNT(CASE WHEN next_refresh_at IS NULL THEN 1 END) as null_next_refresh,
    COUNT(CASE WHEN last_refreshed_at IS NULL THEN 1 END) as null_last_refresh
FROM trader_sources
WHERE is_active = true;

\echo ''
\echo '✓ Expected: Low or zero null counts'
\echo ''

-- ============================================
-- 5. Performance Check
-- ============================================

\echo '▶ Checking query performance (sample queries)...'

EXPLAIN ANALYZE
SELECT * FROM trader_sources
WHERE activity_tier = 'hot'
ORDER BY roi DESC
LIMIT 100;

\echo ''

EXPLAIN ANALYZE
SELECT * FROM trader_sources
WHERE next_refresh_at < NOW()
ORDER BY refresh_priority ASC
LIMIT 100;

\echo ''
\echo '✓ Check: Execution time should be < 100ms'
\echo '✓ Check: Should use indexes (look for "Index Scan")'
\echo ''

-- ============================================
-- Summary
-- ============================================

\echo '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
\echo '  Verification Complete'
\echo '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
\echo ''
\echo 'Next Steps:'
\echo '1. Review the output above'
\echo '2. Verify all expected results match actual results'
\echo '3. Run API tests using test-runner.sh'
\echo '4. Test UI components manually'
\echo ''
