-- Migration: Materialized Views for Performance
-- Date: 2026-02-08
-- Purpose: Create materialized views for hourly prices and daily rankings
-- These are refreshed periodically via BullMQ cron jobs

-- ============================================================
-- 1. hourly_prices - Aggregated market price data per hour
-- ============================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_hourly_prices AS
SELECT
  date_trunc('hour', created_at) AS hour,
  symbol,
  AVG(price) AS avg_price,
  MIN(price) AS low_price,
  MAX(price) AS high_price,
  COUNT(*) AS data_points
FROM funding_rates
GROUP BY date_trunc('hour', created_at), symbol
ORDER BY hour DESC, symbol;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_hourly_prices_hour_symbol
  ON mv_hourly_prices(hour, symbol);

-- ============================================================
-- 2. daily_rankings - Pre-computed daily ranking snapshots
-- ============================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_daily_rankings AS
SELECT
  date_trunc('day', ts.captured_at) AS day,
  ts.source,
  ts.market_type,
  ts.window,
  ts.source_trader_id,
  ts2.handle,
  ts2.avatar_url,
  AVG(ts.arena_score) AS avg_arena_score,
  AVG(ts.roi) AS avg_roi,
  MAX(ts.pnl) AS max_pnl,
  COUNT(*) AS snapshot_count
FROM trader_snapshots ts
LEFT JOIN trader_sources ts2
  ON ts.source = ts2.source AND ts.source_trader_id = ts2.source_trader_id
WHERE ts.arena_score IS NOT NULL
GROUP BY
  date_trunc('day', ts.captured_at),
  ts.source,
  ts.market_type,
  ts.window,
  ts.source_trader_id,
  ts2.handle,
  ts2.avatar_url
ORDER BY day DESC, avg_arena_score DESC;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_daily_rankings_composite
  ON mv_daily_rankings(day, source, market_type, window, source_trader_id);

-- ============================================================
-- 3. Refresh function (can be called from pg_cron or app)
-- ============================================================

CREATE OR REPLACE FUNCTION refresh_materialized_views()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_hourly_prices;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_daily_rankings;
END;
$$ LANGUAGE plpgsql;
