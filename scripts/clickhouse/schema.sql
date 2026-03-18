-- ============================================================
-- ClickHouse Schema for Arena Analytics Layer
-- Run against your ClickHouse instance to create tables.
--
-- Usage:
--   clickhouse-client --multiquery < scripts/clickhouse/schema.sql
-- ============================================================

-- 1. pipeline_logs
-- Mirrors Supabase pipeline_logs for fast aggregation queries.
-- ReplacingMergeTree deduplicates by created_at (latest row wins).
CREATE TABLE IF NOT EXISTS pipeline_logs (
  id UUID,
  job_name String,
  status String, -- 'running', 'success', 'error', 'timeout'
  started_at DateTime64(3),
  finished_at Nullable(DateTime64(3)),
  duration_ms Nullable(UInt32),
  records_processed Nullable(UInt32),
  error_message Nullable(String),
  metadata String DEFAULT '{}', -- JSON string
  created_at DateTime64(3) DEFAULT now()
) ENGINE = ReplacingMergeTree(created_at)
ORDER BY (job_name, started_at)
TTL started_at + INTERVAL 90 DAY;

-- 2. trader_snapshots_history
-- Append-only time series of trader performance snapshots.
-- Partitioned by month for efficient range scans and TTL drops.
CREATE TABLE IF NOT EXISTS trader_snapshots_history (
  platform LowCardinality(String),
  trader_key String,
  period LowCardinality(String), -- '7D', '30D', '90D'
  roi_pct Float64,
  pnl_usd Float64,
  arena_score Float32,
  win_rate Nullable(Float32),
  max_drawdown Nullable(Float32),
  sharpe_ratio Nullable(Float32),
  followers UInt32 DEFAULT 0,
  rank UInt16 DEFAULT 0,
  captured_at DateTime64(3)
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(captured_at)
ORDER BY (platform, trader_key, period, captured_at)
TTL captured_at + INTERVAL 365 DAY;

-- 3. equity_curves
-- Daily equity curve data points for charting and drawdown analysis.
-- 2-year retention. Partitioned by month.
CREATE TABLE IF NOT EXISTS equity_curves (
  platform LowCardinality(String),
  trader_key String,
  data_date Date,
  roi_pct Float64,
  pnl_usd Float64,
  captured_at DateTime64(3) DEFAULT now()
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(data_date)
ORDER BY (platform, trader_key, data_date)
TTL data_date + INTERVAL 730 DAY;

-- ============================================================
-- Materialized Views (optional, create after tables)
-- ============================================================

-- Daily pipeline success rate rollup
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_pipeline_daily_stats
ENGINE = SummingMergeTree()
ORDER BY (job_name, day)
AS
SELECT
  job_name,
  toDate(started_at) AS day,
  count() AS total_runs,
  countIf(status = 'success') AS success_count,
  countIf(status = 'error') AS error_count,
  countIf(status = 'timeout') AS timeout_count,
  avg(duration_ms) AS avg_duration_ms
FROM pipeline_logs
WHERE status != 'running'
GROUP BY job_name, day;

-- Hourly trader score summary for top movers detection
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_trader_hourly_scores
ENGINE = AggregatingMergeTree()
ORDER BY (platform, trader_key, period, hour)
AS
SELECT
  platform,
  trader_key,
  period,
  toStartOfHour(captured_at) AS hour,
  argMaxState(arena_score, captured_at) AS latest_score,
  argMinState(arena_score, captured_at) AS earliest_score,
  maxState(arena_score) AS max_score,
  minState(arena_score) AS min_score
FROM trader_snapshots_history
GROUP BY platform, trader_key, period, hour;
