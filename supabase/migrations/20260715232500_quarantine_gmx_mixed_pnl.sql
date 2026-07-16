-- Quarantine GMX serving rows written under the pre-v2 mixed PnL contract.
-- Stats alternated between a window-start-adjusted value and total MTM while
-- canonical `pnl` series/risk used total MTM. Preserve every old row before
-- clearing the misleading typed values and chart keys.

BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '180s';
SET LOCAL TIME ZONE 'UTC';

CREATE TABLE IF NOT EXISTS arena.trader_stats_quarantine (
  batch_id text NOT NULL,
  source_slug text NOT NULL,
  trader_id bigint NOT NULL,
  timeframe smallint NOT NULL,
  row_data jsonb NOT NULL,
  reason text NOT NULL,
  quarantined_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (batch_id, trader_id, timeframe)
);

ALTER TABLE arena.trader_stats_quarantine ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE arena.trader_stats_quarantine FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE arena.trader_stats_quarantine TO service_role;

COMMENT ON TABLE arena.trader_stats_quarantine IS
  'Private reversible archive of trader_stats rows removed or rewritten by audited cleanup batches.';

-- Block profile publication while counts, archives, and serving cleanup are
-- reconciled in one transaction. Stats first matches the publisher write path.
LOCK TABLE arena.trader_stats IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE arena.trader_series_weekly IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE arena.trader_series IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  v_batch_id constant text := '20260715_gmx_pnl_contract_v2';
  v_reason constant text := 'pre_v2_mixed_realized_and_total_mtm_pnl_contract';
  v_stats_count bigint;
  v_daily_count bigint;
  v_weekly_count bigint;
  v_existing_stats_archive bigint;
  v_existing_series_archive bigint;
  v_archived_stats bigint;
  v_archived_daily bigint;
  v_archived_weekly bigint;
  v_updated_stats bigint;
  v_deleted_daily bigint;
  v_deleted_weekly bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM arena.sources
    WHERE slug = 'gmx'
      AND meta->>'pnl_contract_version' = '2'
      AND meta->>'pnl_basis_board' = 'gmx_period_realized_net'
  ) THEN
    RAISE EXCEPTION 'refusing GMX cleanup before source contract v2';
  END IF;

  SELECT count(*)
  INTO v_stats_count
  FROM arena.trader_stats AS stats
  JOIN arena.traders AS trader ON trader.id = stats.trader_id
  JOIN arena.sources AS source ON source.id = trader.source_id
  WHERE source.slug = 'gmx';

  SELECT count(*)
  INTO v_daily_count
  FROM arena.trader_series AS series
  JOIN arena.traders AS trader ON trader.id = series.trader_id
  JOIN arena.sources AS source ON source.id = trader.source_id
  WHERE source.slug = 'gmx'
    AND series.metric = 'pnl';

  SELECT count(*)
  INTO v_weekly_count
  FROM arena.trader_series_weekly AS series
  JOIN arena.traders AS trader ON trader.id = series.trader_id
  JOIN arena.sources AS source ON source.id = trader.source_id
  WHERE source.slug = 'gmx'
    AND series.metric = 'pnl';

  IF v_stats_count = 0 AND v_daily_count = 0 AND v_weekly_count = 0 THEN
    RAISE NOTICE 'no pre-v2 GMX serving rows to quarantine';
    RETURN;
  END IF;

  -- Production preflight on 2026-07-15 found 543 stats rows, 27,591 daily
  -- points, and 779 weekly points. Broad guards tolerate only normal crawl
  -- drift; a different population must be re-audited instead of guessed.
  IF NOT (v_stats_count BETWEEN 500 AND 600) THEN
    RAISE EXCEPTION 'unexpected GMX stats count %, refusing cleanup', v_stats_count;
  END IF;
  IF NOT (v_daily_count BETWEEN 25000 AND 31000) THEN
    RAISE EXCEPTION 'unexpected GMX daily pnl count %, refusing cleanup', v_daily_count;
  END IF;
  IF NOT (v_weekly_count BETWEEN 700 AND 900) THEN
    RAISE EXCEPTION 'unexpected GMX weekly pnl count %, refusing cleanup', v_weekly_count;
  END IF;

  SELECT count(*)
  INTO v_existing_stats_archive
  FROM arena.trader_stats_quarantine
  WHERE batch_id = v_batch_id;

  SELECT count(*)
  INTO v_existing_series_archive
  FROM arena.trader_series_quarantine
  WHERE batch_id = v_batch_id;

  IF v_existing_stats_archive <> 0 OR v_existing_series_archive <> 0 THEN
    RAISE EXCEPTION
      'duplicate GMX cleanup archive: stats %, series %',
      v_existing_stats_archive,
      v_existing_series_archive;
  END IF;

  INSERT INTO arena.trader_stats_quarantine (
    batch_id, source_slug, trader_id, timeframe, row_data, reason
  )
  SELECT v_batch_id, source.slug, stats.trader_id, stats.timeframe, to_jsonb(stats), v_reason
  FROM arena.trader_stats AS stats
  JOIN arena.traders AS trader ON trader.id = stats.trader_id
  JOIN arena.sources AS source ON source.id = trader.source_id
  WHERE source.slug = 'gmx';
  GET DIAGNOSTICS v_archived_stats = ROW_COUNT;

  INSERT INTO arena.trader_series_quarantine (
    batch_id, source_slug, original_table, trader_id, timeframe,
    metric, point_at, value, currency, reason
  )
  SELECT v_batch_id, source.slug, 'trader_series', series.trader_id,
         series.timeframe, series.metric, series.ts, series.value,
         series.currency, v_reason
  FROM arena.trader_series AS series
  JOIN arena.traders AS trader ON trader.id = series.trader_id
  JOIN arena.sources AS source ON source.id = trader.source_id
  WHERE source.slug = 'gmx'
    AND series.metric = 'pnl';
  GET DIAGNOSTICS v_archived_daily = ROW_COUNT;

  INSERT INTO arena.trader_series_quarantine (
    batch_id, source_slug, original_table, trader_id, timeframe,
    metric, point_at, value, currency, reason
  )
  SELECT v_batch_id, source.slug, 'trader_series_weekly', series.trader_id,
         series.timeframe, series.metric, series.week_start::timestamptz,
         series.value, series.currency, v_reason
  FROM arena.trader_series_weekly AS series
  JOIN arena.traders AS trader ON trader.id = series.trader_id
  JOIN arena.sources AS source ON source.id = trader.source_id
  WHERE source.slug = 'gmx'
    AND series.metric = 'pnl';
  GET DIAGNOSTICS v_archived_weekly = ROW_COUNT;

  IF v_archived_stats <> v_stats_count
     OR v_archived_daily <> v_daily_count
     OR v_archived_weekly <> v_weekly_count THEN
    RAISE EXCEPTION
      'GMX archive mismatch: stats %/%, daily %/%, weekly %/%',
      v_archived_stats, v_stats_count,
      v_archived_daily, v_daily_count,
      v_archived_weekly, v_weekly_count;
  END IF;

  UPDATE arena.trader_stats AS stats
  SET pnl = NULL,
      roi = NULL,
      sharpe = NULL,
      mdd = NULL,
      extras = (
        COALESCE(stats.extras, '{}'::jsonb)
          - 'pnl_basis'
          - 'roi_basis'
          - 'pnl_includes_unrealized'
          - 'realized_pnl_usd'
          - 'pnl_components_complete'
          - 'total_pnl_incl_unrealized_usd'
          - 'total_pnl_source'
          - 'gmx_total_mark_to_market_pnl_usd'
          - 'gmx_total_mark_to_market_source'
          - 'risk_derivation'
          - 'risk_samples'
          - 'risk_self_derived'
          - 'risk_derived_samples'
          - 'sortino'
      ) || jsonb_build_object('gmx_pnl_contract_version', 2)
  FROM arena.traders AS trader
  JOIN arena.sources AS source ON source.id = trader.source_id
  WHERE stats.trader_id = trader.id
    AND source.slug = 'gmx';
  GET DIAGNOSTICS v_updated_stats = ROW_COUNT;

  DELETE FROM arena.trader_series AS series
  USING arena.traders AS trader, arena.sources AS source
  WHERE series.trader_id = trader.id
    AND source.id = trader.source_id
    AND source.slug = 'gmx'
    AND series.metric = 'pnl';
  GET DIAGNOSTICS v_deleted_daily = ROW_COUNT;

  DELETE FROM arena.trader_series_weekly AS series
  USING arena.traders AS trader, arena.sources AS source
  WHERE series.trader_id = trader.id
    AND source.id = trader.source_id
    AND source.slug = 'gmx'
    AND series.metric = 'pnl';
  GET DIAGNOSTICS v_deleted_weekly = ROW_COUNT;

  IF v_updated_stats <> v_stats_count
     OR v_deleted_daily <> v_daily_count
     OR v_deleted_weekly <> v_weekly_count THEN
    RAISE EXCEPTION
      'GMX cleanup mismatch: stats %/%, daily %/%, weekly %/%',
      v_updated_stats, v_stats_count,
      v_deleted_daily, v_daily_count,
      v_deleted_weekly, v_weekly_count;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM arena.trader_stats AS stats
    JOIN arena.traders AS trader ON trader.id = stats.trader_id
    JOIN arena.sources AS source ON source.id = trader.source_id
    WHERE source.slug = 'gmx'
      AND (
        stats.pnl IS NOT NULL
        OR stats.roi IS NOT NULL
        OR stats.sharpe IS NOT NULL
        OR stats.mdd IS NOT NULL
        OR stats.extras ?| ARRAY[
          'pnl_basis', 'realized_pnl_usd', 'risk_derivation',
          'risk_samples', 'risk_self_derived', 'risk_derived_samples', 'sortino'
        ]
      )
  ) THEN
    RAISE EXCEPTION 'GMX mixed-basis stats remain after cleanup';
  END IF;
END
$$;

COMMIT;
