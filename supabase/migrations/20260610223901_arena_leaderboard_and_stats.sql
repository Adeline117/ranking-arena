-- Migration: 20260610223901_arena_leaderboard_and_stats.sql
-- Created: 2026-06-11T05:39:01Z
-- Description: ARENA_DATA_SPEC v1.2 §3 — arena schema M3 of 6: leaderboard
--   snapshots (publish-gate verdict per crawl), leaderboard entries
--   (monthly-partitioned membership rows), trader_stats (latest per-TF
--   superset metric block) and trader_series (monthly-partitioned chart
--   time series + weekly downsample target, spec §13.2).

-- ============================================================
-- arena.leaderboard_snapshots — one row per Tier-A crawl per (source, TF).
-- Carries the count-check verdict (spec §5.1): entries are only written
-- when count_check_passed; serving reads resolve "latest passed snapshot".
-- ============================================================
CREATE TABLE arena.leaderboard_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id) ON DELETE CASCADE,
  timeframe smallint NOT NULL CHECK (timeframe IN (7, 30, 90)),
  scraped_at timestamptz NOT NULL DEFAULT now(),
  expected_count int,
  actual_count int NOT NULL,
  baseline_used int,                 -- the rolling median compared against (auditability)
  count_check_passed boolean NOT NULL,
  is_derived boolean NOT NULL DEFAULT false,  -- MEXC/BTCC synthesized boards (spec §1.1-C)
  raw_object_id bigint,              -- → arena.raw_objects (M5; soft ref, no FK to keep
                                     --   RAW cleanup independent of snapshot retention)
  meta jsonb NOT NULL DEFAULT '{}'
);

-- "latest good snapshot" lookup — the serving read path's entry point
CREATE INDEX idx_arena_lb_snapshots_latest_good
  ON arena.leaderboard_snapshots (source_id, timeframe, scraped_at DESC)
  WHERE count_check_passed;
-- rolling-median baseline query (last 7 passing crawls)
CREATE INDEX idx_arena_lb_snapshots_baseline
  ON arena.leaderboard_snapshots (source_id, timeframe, count_check_passed, scraped_at DESC);

-- ============================================================
-- arena.leaderboard_entries — board membership per snapshot, monthly
-- partitions on scraped_at (spec §13.4). Rankings only ever use 7/30/90.
-- ============================================================
CREATE TABLE arena.leaderboard_entries (
  scraped_at timestamptz NOT NULL,   -- denormalized from snapshot = partition key
  snapshot_id bigint NOT NULL,
  trader_id bigint NOT NULL REFERENCES arena.traders(id) ON DELETE CASCADE,
  timeframe smallint NOT NULL CHECK (timeframe IN (7, 30, 90)),
  rank int NOT NULL CHECK (rank > 0),
  headline_roi numeric,
  headline_pnl numeric,
  headline_win_rate numeric,
  currency text NOT NULL,
  raw jsonb,                         -- board-card extras (sparkline, MDD, copiers, AUM...)
  PRIMARY KEY (scraped_at, snapshot_id, trader_id)
) PARTITION BY RANGE (scraped_at);

CREATE INDEX idx_arena_lb_entries_snapshot
  ON arena.leaderboard_entries (snapshot_id, rank);
CREATE INDEX idx_arena_lb_entries_trader
  ON arena.leaderboard_entries (trader_id, timeframe, scraped_at DESC);

-- ============================================================
-- arena.trader_stats — LATEST per-timeframe superset metric block,
-- upserted each profile crawl (spec §3). NULL = "this exchange doesn't
-- expose it" — drives the UI's NULL-collapse rendering (spec §6).
-- timeframe 0 = "since inception" (Bitget bots, profile page only).
-- ============================================================
CREATE TABLE arena.trader_stats (
  trader_id bigint NOT NULL REFERENCES arena.traders(id) ON DELETE CASCADE,
  timeframe smallint NOT NULL CHECK (timeframe IN (0, 7, 30, 90)),
  as_of timestamptz NOT NULL,
  currency text NOT NULL,            -- spec §5.8: every money field carries its unit
  roi numeric,
  pnl numeric,
  sharpe numeric,
  mdd numeric,
  win_rate numeric,
  win_positions int,
  total_positions int,
  copier_pnl numeric,
  copier_count int,
  aum numeric,
  volume numeric,
  profit_share_rate numeric,
  holding_duration_avg interval,
  trading_preferences jsonb,
  extras jsonb NOT NULL DEFAULT '{}', -- style tags, risk rating, radar percentiles, NAV...
  PRIMARY KEY (trader_id, timeframe)
);

CREATE INDEX idx_arena_trader_stats_as_of ON arena.trader_stats (as_of);
-- derived-leaderboard synthesis (MEXC/BTCC): rank profile-level stats by ROI
CREATE INDEX idx_arena_trader_stats_tf_roi
  ON arena.trader_stats (timeframe, roi DESC NULLS LAST);

-- ============================================================
-- arena.trader_series — chart time series, monthly partitions on ts.
-- Full series only for ranked/topN traders; long tail keeps latest
-- snapshot only (spec §13.1). metric carries _trading/_bot scope variants
-- where the source splits them (spec §1.3 Bybit).
-- ============================================================
CREATE TABLE arena.trader_series (
  trader_id bigint NOT NULL,
  timeframe smallint NOT NULL CHECK (timeframe IN (0, 7, 30, 90)),
  metric text NOT NULL,
  ts timestamptz NOT NULL,
  value numeric NOT NULL,
  currency text NOT NULL,
  PRIMARY KEY (trader_id, timeframe, metric, ts)
) PARTITION BY RANGE (ts);

-- ============================================================
-- arena.trader_series_weekly — >90d downsample target (spec §13.2).
-- Small table (1 point/week/metric), not partitioned.
-- ============================================================
CREATE TABLE arena.trader_series_weekly (
  trader_id bigint NOT NULL,
  timeframe smallint NOT NULL,
  metric text NOT NULL,
  week_start date NOT NULL,
  value numeric NOT NULL,            -- last value of the week
  currency text NOT NULL,
  PRIMARY KEY (trader_id, timeframe, metric, week_start)
);

-- ============================================================
-- arena.ensure_month_partitions(parent, months_ahead) — idempotent monthly
-- partition creator. Called here for initial partitions and by the worker
-- maintenance job (RPC) to stay 2 months ahead (no pg_partman dependency).
-- Partition naming: {table}_yYYYYmMM.
-- ============================================================
CREATE OR REPLACE FUNCTION arena.ensure_month_partitions(
  parent_table text,
  months_ahead int DEFAULT 2
) RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = arena, public
AS $$
DECLARE
  m date;
  part_name text;
  created int := 0;
BEGIN
  IF parent_table NOT IN ('leaderboard_entries', 'trader_series',
                          'position_history', 'order_records',
                          'transfer_history', 'copier_records') THEN
    RAISE EXCEPTION 'ensure_month_partitions: unsupported table %', parent_table;
  END IF;

  FOR i IN 0..months_ahead LOOP
    m := date_trunc('month', now())::date + (i || ' months')::interval;
    part_name := format('%s_y%sm%s', parent_table,
                        to_char(m, 'YYYY'), to_char(m, 'MM'));
    IF to_regclass('arena.' || part_name) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE arena.%I PARTITION OF arena.%I FOR VALUES FROM (%L) TO (%L)',
        part_name, parent_table, m, (m + interval '1 month')::date
      );
      created := created + 1;
    END IF;
  END LOOP;
  RETURN created;
END;
$$;

REVOKE EXECUTE ON FUNCTION arena.ensure_month_partitions(text, int) FROM anon, authenticated;

-- Initial partitions: current month + 2 ahead
SELECT arena.ensure_month_partitions('leaderboard_entries', 2);
SELECT arena.ensure_month_partitions('trader_series', 2);
