-- Quarantine generic BSC pnl_daily rows produced by the wallet-balance-delta
-- enrichment path. Quality schema v1 always marks that path partial, but the
-- legacy runner wrote its zero-filled estimates into provenance-free serving
-- tables. Future writes are blocked by isCanonicalOnchainEnrichment().

BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '120s';
SET LOCAL TIME ZONE 'UTC';

CREATE TABLE IF NOT EXISTS arena.trader_series_quarantine (
  batch_id text NOT NULL,
  source_slug text NOT NULL,
  original_table text NOT NULL CHECK (
    original_table IN ('trader_series', 'trader_series_weekly')
  ),
  trader_id bigint NOT NULL,
  timeframe smallint NOT NULL,
  metric text NOT NULL,
  point_at timestamptz NOT NULL,
  value numeric NOT NULL,
  currency text NOT NULL,
  reason text NOT NULL,
  quarantined_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (
    batch_id,
    original_table,
    trader_id,
    timeframe,
    metric,
    point_at
  )
);

ALTER TABLE arena.trader_series_quarantine ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE arena.trader_series_quarantine FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE arena.trader_series_quarantine TO service_role;

COMMENT ON TABLE arena.trader_series_quarantine IS
  'Private reversible archive of serving series removed by audited cleanup batches.';

-- The maintenance worker locks/upserts weekly before deleting old daily rows.
-- Match its lock order, then delete daily first so a missed future writer has
-- no source rows from which to recreate a weekly rollup.
LOCK TABLE arena.trader_series_weekly IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE arena.trader_series IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  v_batch_id constant text := '20260715_partial_onchain_pnl_daily';
  v_reason constant text := 'partial_wallet_balance_delta_series_without_provenance';
  v_daily_count bigint;
  v_weekly_count bigint;
  v_target_traders bigint;
  v_existing_archive bigint;
  v_archived_daily bigint;
  v_archived_weekly bigint;
  v_deleted_daily bigint;
  v_deleted_weekly bigint;
  v_other_daily_before bigint;
  v_other_weekly_before bigint;
  v_other_daily_after bigint;
  v_other_weekly_after bigint;
BEGIN
  SELECT count(*)
  INTO v_daily_count
  FROM arena.trader_series AS series
  JOIN arena.traders AS trader ON trader.id = series.trader_id
  JOIN arena.sources AS source ON source.id = trader.source_id
  WHERE source.slug = 'binance_web3_bsc'
    AND series.metric = 'pnl_daily';

  SELECT count(*)
  INTO v_weekly_count
  FROM arena.trader_series_weekly AS series
  JOIN arena.traders AS trader ON trader.id = series.trader_id
  JOIN arena.sources AS source ON source.id = trader.source_id
  WHERE source.slug = 'binance_web3_bsc'
    AND series.metric = 'pnl_daily';

  IF v_daily_count = 0 AND v_weekly_count = 0 THEN
    RAISE NOTICE 'no partial binance_web3_bsc pnl_daily rows to quarantine';
    RETURN;
  END IF;

  SELECT count(DISTINCT target.trader_id)
  INTO v_target_traders
  FROM (
    SELECT series.trader_id
    FROM arena.trader_series AS series
    JOIN arena.traders AS trader ON trader.id = series.trader_id
    JOIN arena.sources AS source ON source.id = trader.source_id
    WHERE source.slug = 'binance_web3_bsc'
      AND series.metric = 'pnl_daily'
    UNION ALL
    SELECT series.trader_id
    FROM arena.trader_series_weekly AS series
    JOIN arena.traders AS trader ON trader.id = series.trader_id
    JOIN arena.sources AS source ON source.id = trader.source_id
    WHERE source.slug = 'binance_web3_bsc'
      AND series.metric = 'pnl_daily'
  ) AS target;

  SELECT count(*)
  INTO v_existing_archive
  FROM arena.trader_series_quarantine
  WHERE batch_id = v_batch_id;

  -- Production preflight on 2026-07-15 found 140,730 daily points and 517
  -- weekly rollups. A small or unexpectedly broad non-zero set indicates a
  -- different writer/environment and must be reviewed instead of guessed.
  IF NOT (v_daily_count BETWEEN 130000 AND 160000) THEN
    RAISE EXCEPTION
      'refusing partial on-chain daily series quarantine: unexpected row count %',
      v_daily_count;
  END IF;

  IF v_weekly_count <> 0 AND NOT (v_weekly_count BETWEEN 400 AND 700) THEN
    RAISE EXCEPTION
      'refusing partial on-chain weekly series quarantine: unexpected row count %',
      v_weekly_count;
  END IF;

  IF v_target_traders <> 1429 THEN
    RAISE EXCEPTION
      'refusing partial on-chain series quarantine: expected 1429 traders, found %',
      v_target_traders;
  END IF;

  IF v_existing_archive <> 0 THEN
    RAISE EXCEPTION
      'refusing duplicate series quarantine batch: existing rows %',
      v_existing_archive;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM arena.trader_series AS series
    JOIN arena.traders AS trader ON trader.id = series.trader_id
    JOIN arena.sources AS source ON source.id = trader.source_id
    WHERE source.slug = 'binance_web3_bsc'
      AND series.metric = 'pnl_daily'
      AND (
        series.currency <> 'USD'
        OR series.timeframe NOT IN (7, 30, 90)
        OR series.ts <> date_trunc('day', series.ts)
        OR series.ts < timestamptz '2026-04-01 00:00:00+00'
        OR series.ts > statement_timestamp()
      )
  ) THEN
    RAISE EXCEPTION 'refusing daily series quarantine: unexpected unit, timeframe, or date';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM arena.trader_series_weekly AS series
    JOIN arena.traders AS trader ON trader.id = series.trader_id
    JOIN arena.sources AS source ON source.id = trader.source_id
    WHERE source.slug = 'binance_web3_bsc'
      AND series.metric = 'pnl_daily'
      AND (
        series.currency <> 'USD'
        OR series.timeframe NOT IN (7, 30, 90)
        OR series.week_start < date '2026-04-01'
        OR series.week_start > current_date
      )
  ) THEN
    RAISE EXCEPTION 'refusing weekly series quarantine: unexpected unit, timeframe, or date';
  END IF;

  SELECT count(*)
  INTO v_other_daily_before
  FROM arena.trader_series AS series
  JOIN arena.traders AS trader ON trader.id = series.trader_id
  JOIN arena.sources AS source ON source.id = trader.source_id
  WHERE source.slug = 'binance_web3_bsc'
    AND series.metric <> 'pnl_daily';

  SELECT count(*)
  INTO v_other_weekly_before
  FROM arena.trader_series_weekly AS series
  JOIN arena.traders AS trader ON trader.id = series.trader_id
  JOIN arena.sources AS source ON source.id = trader.source_id
  WHERE source.slug = 'binance_web3_bsc'
    AND series.metric <> 'pnl_daily';

  INSERT INTO arena.trader_series_quarantine (
    batch_id,
    source_slug,
    original_table,
    trader_id,
    timeframe,
    metric,
    point_at,
    value,
    currency,
    reason
  )
  SELECT
    v_batch_id,
    source.slug,
    'trader_series',
    series.trader_id,
    series.timeframe,
    series.metric,
    series.ts,
    series.value,
    series.currency,
    v_reason
  FROM arena.trader_series AS series
  JOIN arena.traders AS trader ON trader.id = series.trader_id
  JOIN arena.sources AS source ON source.id = trader.source_id
  WHERE source.slug = 'binance_web3_bsc'
    AND series.metric = 'pnl_daily';

  INSERT INTO arena.trader_series_quarantine (
    batch_id,
    source_slug,
    original_table,
    trader_id,
    timeframe,
    metric,
    point_at,
    value,
    currency,
    reason
  )
  SELECT
    v_batch_id,
    source.slug,
    'trader_series_weekly',
    series.trader_id,
    series.timeframe,
    series.metric,
    series.week_start::timestamp AT TIME ZONE 'UTC',
    series.value,
    series.currency,
    v_reason
  FROM arena.trader_series_weekly AS series
  JOIN arena.traders AS trader ON trader.id = series.trader_id
  JOIN arena.sources AS source ON source.id = trader.source_id
  WHERE source.slug = 'binance_web3_bsc'
    AND series.metric = 'pnl_daily';

  SELECT count(*)
  INTO v_archived_daily
  FROM arena.trader_series_quarantine
  WHERE batch_id = v_batch_id
    AND original_table = 'trader_series';

  SELECT count(*)
  INTO v_archived_weekly
  FROM arena.trader_series_quarantine
  WHERE batch_id = v_batch_id
    AND original_table = 'trader_series_weekly';

  IF v_archived_daily <> v_daily_count OR v_archived_weekly <> v_weekly_count THEN
    RAISE EXCEPTION
      'series quarantine copy mismatch: daily %/%, weekly %/%',
      v_archived_daily,
      v_daily_count,
      v_archived_weekly,
      v_weekly_count;
  END IF;

  DELETE FROM arena.trader_series AS series
  USING arena.traders AS trader, arena.sources AS source
  WHERE series.trader_id = trader.id
    AND trader.source_id = source.id
    AND source.slug = 'binance_web3_bsc'
    AND series.metric = 'pnl_daily';
  GET DIAGNOSTICS v_deleted_daily = ROW_COUNT;

  DELETE FROM arena.trader_series_weekly AS series
  USING arena.traders AS trader, arena.sources AS source
  WHERE series.trader_id = trader.id
    AND trader.source_id = source.id
    AND source.slug = 'binance_web3_bsc'
    AND series.metric = 'pnl_daily';
  GET DIAGNOSTICS v_deleted_weekly = ROW_COUNT;

  IF v_deleted_daily <> v_daily_count OR v_deleted_weekly <> v_weekly_count THEN
    RAISE EXCEPTION
      'series quarantine delete mismatch: daily %/%, weekly %/%',
      v_deleted_daily,
      v_daily_count,
      v_deleted_weekly,
      v_weekly_count;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM arena.trader_series AS series
    JOIN arena.traders AS trader ON trader.id = series.trader_id
    JOIN arena.sources AS source ON source.id = trader.source_id
    WHERE source.slug = 'binance_web3_bsc'
      AND series.metric = 'pnl_daily'
  ) OR EXISTS (
    SELECT 1
    FROM arena.trader_series_weekly AS series
    JOIN arena.traders AS trader ON trader.id = series.trader_id
    JOIN arena.sources AS source ON source.id = trader.source_id
    WHERE source.slug = 'binance_web3_bsc'
      AND series.metric = 'pnl_daily'
  ) THEN
    RAISE EXCEPTION 'partial on-chain pnl_daily quarantine did not reach zero';
  END IF;

  SELECT count(*)
  INTO v_other_daily_after
  FROM arena.trader_series AS series
  JOIN arena.traders AS trader ON trader.id = series.trader_id
  JOIN arena.sources AS source ON source.id = trader.source_id
  WHERE source.slug = 'binance_web3_bsc'
    AND series.metric <> 'pnl_daily';

  SELECT count(*)
  INTO v_other_weekly_after
  FROM arena.trader_series_weekly AS series
  JOIN arena.traders AS trader ON trader.id = series.trader_id
  JOIN arena.sources AS source ON source.id = trader.source_id
  WHERE source.slug = 'binance_web3_bsc'
    AND series.metric <> 'pnl_daily';

  IF v_other_daily_after <> v_other_daily_before
    OR v_other_weekly_after <> v_other_weekly_before THEN
    RAISE EXCEPTION
      'series quarantine changed non-target rows: daily %/%, weekly %/%',
      v_other_daily_before,
      v_other_daily_after,
      v_other_weekly_before,
      v_other_weekly_after;
  END IF;

  RAISE NOTICE
    'quarantined partial binance_web3_bsc pnl_daily rows: daily=%, weekly=%, traders=%',
    v_deleted_daily,
    v_deleted_weekly,
    v_target_traders;
END
$$;

COMMIT;
