-- Migration: 20260718140000_add_metric_completeness_daily.sql
-- Created: 2026-07-18T19:10:43Z
-- Description: Add the authoritative daily source x timeframe x metric
-- completeness evidence table. The older metric_fill_trend table is a
-- source-level progress trend; it cannot represent per-window membership,
-- the latest passed-board cohort, or evidence age.

-- Up
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE TABLE arena.metric_completeness_daily (
  taken_on date NOT NULL
    DEFAULT ((statement_timestamp() AT TIME ZONE 'UTC')::date),
  measured_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  source_id smallint NOT NULL
    REFERENCES arena.sources(id) ON DELETE RESTRICT,
  timeframe smallint NOT NULL
    CHECK (timeframe IN (7, 30, 90)),
  metric text NOT NULL
    CHECK (metric IN (
      'roi',
      'pnl',
      'sharpe',
      'mdd',
      'win_rate',
      'win_positions',
      'total_positions',
      'copier_pnl',
      'copier_count',
      'aum',
      'volume',
      'profit_share_rate',
      'holding_duration_avg'
    )),
  -- Membership denominator: entries in the latest count-check-passed board
  -- snapshot for this exact source and timeframe.
  board_snapshot_at timestamptz,
  -- Upstream last-good watermark from leaderboard_source_freshness. This is
  -- deliberately separate from board_snapshot_at: recomputing a board must
  -- never make upstream data look newer.
  upstream_source_as_of timestamptz,
  population_total bigint NOT NULL CHECK (population_total >= 0),
  stats_total bigint NOT NULL CHECK (stats_total >= 0),
  fresh_stats_total bigint NOT NULL CHECK (fresh_stats_total >= 0),
  filled bigint NOT NULL CHECK (filled >= 0),
  fresh_filled bigint NOT NULL CHECK (fresh_filled >= 0),
  oldest_stats_as_of timestamptz,
  newest_stats_as_of timestamptz,
  stats_freshness_hours smallint NOT NULL
    CHECK (stats_freshness_hours > 0),
  contract_hash text NOT NULL
    CHECK (contract_hash ~ '^[0-9a-f]{64}$'),
  measurement_state text NOT NULL
    CHECK (measurement_state IN (
      'measured',
      'missing_board_snapshot',
      'stale_board_snapshot',
      'missing_upstream_watermark',
      'stale_upstream_watermark',
      'empty_population',
      'no_stats',
      'no_fresh_stats'
    )),
  PRIMARY KEY (taken_on, source_id, timeframe, metric),
  CHECK (stats_total <= population_total),
  CHECK (fresh_stats_total <= stats_total),
  CHECK (filled <= stats_total),
  CHECK (fresh_filled <= filled),
  CHECK (fresh_filled <= fresh_stats_total),
  CHECK (taken_on = (measured_at AT TIME ZONE 'UTC')::date),
  CHECK (
    board_snapshot_at IS NULL
    OR board_snapshot_at <= measured_at + interval '5 minutes'
  ),
  CHECK (
    upstream_source_as_of IS NULL
    OR upstream_source_as_of <= measured_at + interval '5 minutes'
  ),
  CHECK (
    newest_stats_as_of IS NULL
    OR newest_stats_as_of <= measured_at + interval '5 minutes'
  ),
  CHECK (
    (stats_total = 0 AND oldest_stats_as_of IS NULL AND newest_stats_as_of IS NULL)
    OR
    (
      stats_total > 0
      AND oldest_stats_as_of IS NOT NULL
      AND newest_stats_as_of IS NOT NULL
      AND oldest_stats_as_of <= newest_stats_as_of
    )
  ),
  CHECK (
    stats_total = 0
    OR (
      fresh_stats_total = 0
      AND newest_stats_as_of
        < measured_at - (stats_freshness_hours * interval '1 hour')
    )
    OR (
      fresh_stats_total = stats_total
      AND oldest_stats_as_of
        >= measured_at - (stats_freshness_hours * interval '1 hour')
    )
    OR (
      fresh_stats_total > 0
      AND fresh_stats_total < stats_total
      AND oldest_stats_as_of
        < measured_at - (stats_freshness_hours * interval '1 hour')
      AND newest_stats_as_of
        >= measured_at - (stats_freshness_hours * interval '1 hour')
    )
  ),
  CHECK (
    board_snapshot_at IS NOT NULL
    OR (
      population_total = 0
      AND stats_total = 0
      AND fresh_stats_total = 0
      AND filled = 0
      AND fresh_filled = 0
    )
  ),
  -- State priority is deliberate and exhaustive. A row cannot claim a state
  -- that disagrees with its timestamps or counts.
  CHECK (
    measurement_state = CASE
      WHEN board_snapshot_at IS NULL
        THEN 'missing_board_snapshot'
      WHEN board_snapshot_at
        < measured_at - (stats_freshness_hours * interval '1 hour')
        THEN 'stale_board_snapshot'
      WHEN upstream_source_as_of IS NULL
        THEN 'missing_upstream_watermark'
      WHEN upstream_source_as_of
        < measured_at - (stats_freshness_hours * interval '1 hour')
        THEN 'stale_upstream_watermark'
      WHEN population_total = 0
        THEN 'empty_population'
      WHEN stats_total = 0
        THEN 'no_stats'
      WHEN fresh_stats_total = 0
        THEN 'no_fresh_stats'
      ELSE 'measured'
    END
  )
);

COMMENT ON TABLE arena.metric_completeness_daily IS
  'Daily active+serving source x declared timeframe x expected metric evidence, measured only against the latest count-check-passed board cohort.';
COMMENT ON COLUMN arena.metric_completeness_daily.board_snapshot_at IS
  'Latest count-check-passed board snapshot used as the population denominator; not an upstream freshness watermark.';
COMMENT ON COLUMN arena.metric_completeness_daily.upstream_source_as_of IS
  'Last-good upstream source watermark copied from leaderboard_source_freshness.';
COMMENT ON COLUMN arena.metric_completeness_daily.contract_hash IS
  'SHA-256 of the canonical active+serving source/window/expected-metric contract used for this measurement.';

CREATE INDEX metric_completeness_daily_latest_idx
  ON arena.metric_completeness_daily (
    source_id,
    timeframe,
    metric,
    taken_on DESC
  );

ALTER TABLE arena.metric_completeness_daily ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE arena.metric_completeness_daily
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE arena.metric_completeness_daily
  TO service_role;

COMMIT;
