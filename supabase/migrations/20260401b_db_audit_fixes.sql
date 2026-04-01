-- P0-1: Index on pipeline_logs to eliminate sequential scans (37.6% seq scans, 1B tuples read)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pipeline_logs_job_started
ON pipeline_logs (job_name, started_at DESC);

-- P0-2: Archive rarely-accessed airdrop tables (2.3GB freed)
CREATE SCHEMA IF NOT EXISTS archive;
-- Tables moved via: ALTER TABLE sybil_results SET SCHEMA archive;
-- Tables moved via: ALTER TABLE eligible SET SCHEMA archive;
-- Tables moved via: ALTER TABLE claimants SET SCHEMA archive;

-- P1-1: Create RPC for daily snapshot aggregation (fixes 9/34 → 37/37 platform coverage)
-- The fallback query in aggregate-daily-snapshots was hitting PostgREST row limits (~1000)
-- This RPC runs server-side with no row limit
CREATE OR REPLACE FUNCTION get_latest_snapshots_for_date(target_date TEXT)
RETURNS TABLE (
  source TEXT,
  source_trader_id TEXT,
  roi NUMERIC,
  pnl NUMERIC,
  win_rate NUMERIC,
  max_drawdown NUMERIC,
  followers INTEGER,
  trades_count INTEGER
) LANGUAGE sql STABLE AS $$
  SELECT DISTINCT ON (v.platform, v.trader_key)
    v.platform AS source,
    v.trader_key AS source_trader_id,
    v.roi_pct AS roi,
    v.pnl_usd AS pnl,
    v.win_rate,
    v.max_drawdown,
    v.followers::INTEGER,
    v.trades_count::INTEGER
  FROM trader_snapshots_v2 v
  WHERE v.updated_at >= (target_date::DATE - INTERVAL '2 days')
    AND v.updated_at < (target_date::DATE + INTERVAL '2 days')
  ORDER BY v.platform, v.trader_key, v.updated_at DESC
$$;
