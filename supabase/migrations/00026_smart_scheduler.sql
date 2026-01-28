-- Migration: Add Smart Scheduler fields to trader_sources
-- Version: 00026
-- Purpose: Enable intelligent refresh scheduling based on trader activity tiers

-- ============================================
-- 1. Add Smart Scheduler columns
-- ============================================

-- Add activity tier column
ALTER TABLE trader_sources ADD COLUMN IF NOT EXISTS
  activity_tier VARCHAR(20);

-- Add scheduling columns
ALTER TABLE trader_sources ADD COLUMN IF NOT EXISTS
  next_refresh_at TIMESTAMPTZ;

ALTER TABLE trader_sources ADD COLUMN IF NOT EXISTS
  last_refreshed_at TIMESTAMPTZ;

ALTER TABLE trader_sources ADD COLUMN IF NOT EXISTS
  refresh_priority INTEGER;

ALTER TABLE trader_sources ADD COLUMN IF NOT EXISTS
  tier_updated_at TIMESTAMPTZ;

-- Add comment to document the tier values
COMMENT ON COLUMN trader_sources.activity_tier IS 'Trader activity tier: hot, active, normal, or dormant. Used for intelligent refresh scheduling.';
COMMENT ON COLUMN trader_sources.next_refresh_at IS 'Next scheduled refresh time based on activity tier';
COMMENT ON COLUMN trader_sources.last_refreshed_at IS 'Last successful data refresh timestamp';
COMMENT ON COLUMN trader_sources.refresh_priority IS 'Refresh priority (lower = higher priority). Range: 10 (hot) to 40 (dormant)';
COMMENT ON COLUMN trader_sources.tier_updated_at IS 'When the activity tier was last calculated';

-- ============================================
-- 2. Add check constraints
-- ============================================

-- Ensure activity_tier is valid
ALTER TABLE trader_sources DROP CONSTRAINT IF EXISTS trader_sources_activity_tier_check;
ALTER TABLE trader_sources ADD CONSTRAINT trader_sources_activity_tier_check
  CHECK (activity_tier IN ('hot', 'active', 'normal', 'dormant') OR activity_tier IS NULL);

-- Ensure refresh_priority is in valid range
ALTER TABLE trader_sources DROP CONSTRAINT IF EXISTS trader_sources_priority_check;
ALTER TABLE trader_sources ADD CONSTRAINT trader_sources_priority_check
  CHECK (refresh_priority >= 10 AND refresh_priority <= 40 OR refresh_priority IS NULL);

-- ============================================
-- 3. Create indexes for efficient queries
-- ============================================

-- Index for getting traders to refresh (most common query)
CREATE INDEX IF NOT EXISTS idx_trader_sources_schedule
  ON trader_sources(activity_tier, next_refresh_at)
  WHERE is_active = true;

-- Index for priority-based refresh ordering
CREATE INDEX IF NOT EXISTS idx_trader_sources_refresh_priority
  ON trader_sources(refresh_priority, next_refresh_at)
  WHERE is_active = true;

-- Index for platform-specific tier queries
CREATE INDEX IF NOT EXISTS idx_trader_sources_platform_tier
  ON trader_sources(platform, activity_tier, next_refresh_at)
  WHERE is_active = true;

-- Index for finding overdue traders
CREATE INDEX IF NOT EXISTS idx_trader_sources_overdue
  ON trader_sources(next_refresh_at)
  WHERE is_active = true AND next_refresh_at < NOW();

-- Index for tier statistics
CREATE INDEX IF NOT EXISTS idx_trader_sources_tier_stats
  ON trader_sources(activity_tier)
  WHERE is_active = true;

-- Index for tracking tier updates
CREATE INDEX IF NOT EXISTS idx_trader_sources_tier_updated
  ON trader_sources(tier_updated_at DESC)
  WHERE is_active = true;

-- ============================================
-- 4. Initialize default values for existing traders
-- ============================================

-- Set default tier to 'normal' for existing active traders
UPDATE trader_sources
SET
  activity_tier = 'normal',
  refresh_priority = 30,
  next_refresh_at = NOW() + INTERVAL '4 hours',
  tier_updated_at = NOW()
WHERE is_active = true
  AND activity_tier IS NULL;

-- ============================================
-- 5. Create helper functions
-- ============================================

-- Function to get next refresh time based on tier
CREATE OR REPLACE FUNCTION get_next_refresh_time(
  tier VARCHAR(20),
  base_time TIMESTAMPTZ DEFAULT NOW()
)
RETURNS TIMESTAMPTZ AS $$
BEGIN
  RETURN CASE tier
    WHEN 'hot' THEN base_time + INTERVAL '15 minutes'
    WHEN 'active' THEN base_time + INTERVAL '1 hour'
    WHEN 'normal' THEN base_time + INTERVAL '4 hours'
    WHEN 'dormant' THEN base_time + INTERVAL '24 hours'
    ELSE base_time + INTERVAL '4 hours'  -- Default to normal
  END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Function to get priority for a tier
CREATE OR REPLACE FUNCTION get_tier_priority(tier VARCHAR(20))
RETURNS INTEGER AS $$
BEGIN
  RETURN CASE tier
    WHEN 'hot' THEN 10
    WHEN 'active' THEN 20
    WHEN 'normal' THEN 30
    WHEN 'dormant' THEN 40
    ELSE 30  -- Default to normal
  END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Function to update next_refresh_at when last_refreshed_at changes
CREATE OR REPLACE FUNCTION update_next_refresh_at()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.last_refreshed_at IS DISTINCT FROM OLD.last_refreshed_at THEN
    NEW.next_refresh_at = get_next_refresh_time(
      COALESCE(NEW.activity_tier, 'normal'),
      COALESCE(NEW.last_refreshed_at, NOW())
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to automatically update next_refresh_at
DROP TRIGGER IF EXISTS trg_update_next_refresh_at ON trader_sources;
CREATE TRIGGER trg_update_next_refresh_at
  BEFORE UPDATE ON trader_sources
  FOR EACH ROW
  EXECUTE FUNCTION update_next_refresh_at();

-- ============================================
-- 6. Create monitoring views
-- ============================================

-- View for tier distribution statistics
CREATE OR REPLACE VIEW v_scheduler_tier_stats AS
SELECT
  activity_tier,
  COUNT(*) as trader_count,
  ROUND(COUNT(*) * 100.0 / SUM(COUNT(*)) OVER (), 2) as percentage,
  MIN(next_refresh_at) as earliest_refresh,
  MAX(next_refresh_at) as latest_refresh,
  AVG(EXTRACT(EPOCH FROM (next_refresh_at - last_refreshed_at)) / 60) as avg_interval_minutes
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

-- View for refresh queue status
CREATE OR REPLACE VIEW v_scheduler_refresh_queue AS
SELECT
  platform,
  activity_tier,
  COUNT(*) as pending_count,
  COUNT(*) FILTER (WHERE next_refresh_at < NOW()) as overdue_count,
  MIN(next_refresh_at) as next_due,
  AVG(refresh_priority) as avg_priority
FROM trader_sources
WHERE is_active = true
  AND next_refresh_at IS NOT NULL
GROUP BY platform, activity_tier
ORDER BY platform, refresh_priority;

-- View for overdue traders by platform
CREATE OR REPLACE VIEW v_scheduler_overdue AS
SELECT
  platform,
  activity_tier,
  trader_key,
  handle,
  next_refresh_at,
  last_refreshed_at,
  EXTRACT(EPOCH FROM (NOW() - next_refresh_at)) / 60 as overdue_minutes,
  refresh_priority
FROM trader_sources
WHERE is_active = true
  AND next_refresh_at < NOW()
ORDER BY refresh_priority ASC, next_refresh_at ASC;

-- ============================================
-- 7. Create RPC functions for monitoring
-- ============================================

-- Function to calculate average freshness by tier
CREATE OR REPLACE FUNCTION calculate_freshness_by_tier()
RETURNS TABLE (
  activity_tier VARCHAR(20),
  trader_count BIGINT,
  avg_age_minutes NUMERIC,
  max_age_minutes NUMERIC,
  min_age_minutes NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    ts.activity_tier,
    COUNT(*) as trader_count,
    ROUND(AVG(EXTRACT(EPOCH FROM (NOW() - ts.last_refreshed_at)) / 60), 2) as avg_age_minutes,
    ROUND(MAX(EXTRACT(EPOCH FROM (NOW() - ts.last_refreshed_at)) / 60), 2) as max_age_minutes,
    ROUND(MIN(EXTRACT(EPOCH FROM (NOW() - ts.last_refreshed_at)) / 60), 2) as min_age_minutes
  FROM trader_sources ts
  WHERE ts.is_active = true
    AND ts.last_refreshed_at IS NOT NULL
  GROUP BY ts.activity_tier
  ORDER BY
    CASE ts.activity_tier
      WHEN 'hot' THEN 1
      WHEN 'active' THEN 2
      WHEN 'normal' THEN 3
      WHEN 'dormant' THEN 4
      ELSE 5
    END;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- 8. Grant permissions
-- ============================================

-- Grant select on views to authenticated users (read-only monitoring)
GRANT SELECT ON v_scheduler_tier_stats TO authenticated;
GRANT SELECT ON v_scheduler_refresh_queue TO authenticated;
GRANT SELECT ON v_scheduler_overdue TO authenticated;

-- Grant execute on RPC functions
GRANT EXECUTE ON FUNCTION calculate_freshness_by_tier() TO authenticated;

-- ============================================
-- 8. Add indexes for joined queries
-- ============================================

-- Index for schedule manager's fetchTradersWithActivity query
-- This optimizes the join with trader_profiles and trader_snapshots_v2
CREATE INDEX IF NOT EXISTS idx_trader_sources_active_platform
  ON trader_sources(is_active, platform, trader_key)
  WHERE is_active = true;

-- ============================================
-- Migration complete
-- ============================================

-- Log migration completion
DO $$
BEGIN
  RAISE NOTICE 'Smart Scheduler migration complete';
  RAISE NOTICE 'Added columns: activity_tier, next_refresh_at, last_refreshed_at, refresh_priority, tier_updated_at';
  RAISE NOTICE 'Created % indexes for efficient scheduling queries', 6;
  RAISE NOTICE 'Created % helper functions', 3;
  RAISE NOTICE 'Created % monitoring views', 3;
  RAISE NOTICE 'Initialized % active traders with default tier', (SELECT COUNT(*) FROM trader_sources WHERE is_active = true AND activity_tier = 'normal');
END $$;
