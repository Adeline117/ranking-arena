-- Migration: 20261116210122_publication_score_rows_require_stats_evidence.sql
-- Description: Score-input evidence binding, step 2b of 3 (PR #476 plan,
--   option B): publication reads a trader_stats value only when the bound
--   board attested it.
--
-- After step 1 (20261116204006) the headline metrics come from the board
-- entry, but drawdown, Sharpe, Sortino, Calmar, volatility, copiers and trade
-- count still came from whatever arena.trader_stats held. Step 2a
-- (20261116205144) records, per value, which attempt-bound board write
-- attested it. arena.publication_score_rows_json now accepts a trader_stats
-- value only when
--   * the row's evidence RAW is the selected board snapshot's own RAW,
--   * its source run is the source_run_id of an acquisition outcome of the
--     same source and timeframe whose source payload is that RAW, and
--   * the metric is listed in the row's evidence_metrics.
-- Every other value is published as NULL and named in unevidenced_metrics,
-- which the orchestrator counts as score_input_evidence_missing when the
-- metric is required for ranking (drawdown; ROI/PnL/win rate already since
-- step 1). Whether the acquisition is complete stays the board's own gate
-- (public.rank_publication_trust_evidence); an untrusted board is isolated
-- before scoring.
--
-- POSTDEPLOY, after 20261116204006: until the worker release that stamps
-- attempt-bound board writes serves, no trader_stats row is attested, so
-- applying this earlier would null every trader_stats metric. Rows become
-- attested at each source's first attempt-bound board publish after that
-- release; until then those rows are excluded, not mis-scored.
--
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('arena.leaderboard_acquisition_attempts') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_acquisition_outcomes') IS NULL
     OR pg_catalog.to_regprocedure('arena.trader_stats_score_input_evidence()') IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.oid = pg_catalog.to_regprocedure(
           'arena.publication_score_rows_json(text,integer,integer)'
         )
         AND (
           pg_catalog.strpos(function_row.prosrc, 'publication-score-rows@1') > 0
           OR pg_catalog.strpos(function_row.prosrc, 'publication-score-rows@2') > 0
         )
     )
     OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_attribute AS attribute
       WHERE attribute.attrelid = 'arena.trader_stats'::pg_catalog.regclass
         AND attribute.attname IN (
           'evidence_raw_object_id', 'evidence_source_run_id', 'evidence_metrics'
         )
         AND NOT attribute.attisdropped
     ) <> 3 THEN
    RAISE EXCEPTION 'stats evidence binding requires 20261116204006, 20261116205144 and the acquisition ledger';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION arena.publication_score_rows_json(
  p_window text,
  p_per_platform_limit int,
  p_max_age_hours int
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  -- publication-score-rows@2 (board headline + attested trader_stats)
  WITH requested AS MATERIALIZED (
    SELECT
      CASE p_window
        WHEN '7D' THEN 7::pg_catalog.int2
        WHEN '30D' THEN 30::pg_catalog.int2
        WHEN '90D' THEN 90::pg_catalog.int2
        ELSE NULL::pg_catalog.int2
      END AS timeframe,
      pg_catalog.now()
        - pg_catalog.make_interval(hours => p_max_age_hours)
        AS requested_cutoff,
      pg_catalog.now() - interval '48 hours' AS stats_cutoff
  ),
  serving_source AS MATERIALIZED (
    SELECT
      source.id,
      source.product_type,
      source.currency,
      COALESCE(
        NULLIF(pg_catalog.btrim(source.meta->>'legacy_platform'), ''),
        source.slug
      ) AS platform
    FROM arena.sources AS source
    WHERE source.status = 'active'
      AND source.serving_mode = 'serving'
      AND source.currency = ANY (
        ARRAY['USDT', 'USDx', 'USDC', 'USD']::pg_catalog.text[]
      )
      AND pg_catalog.btrim(
        COALESCE(source.meta->>'legacy_platform', '')
      ) <> 'null'
      AND NOT (
        source.slug = ANY (
          ARRAY['bitget_bots_futures', 'bitget_bots_spot']::pg_catalog.text[]
        )
        OR source.adapter_slug = 'bitget_bots'
      )
  ),
  latest_passed AS MATERIALIZED (
    SELECT DISTINCT ON (snapshot.source_id)
      snapshot.id AS snapshot_id,
      snapshot.source_id,
      snapshot.timeframe,
      snapshot.scraped_at,
      snapshot.raw_object_id
    FROM arena.leaderboard_snapshots AS snapshot
    JOIN serving_source AS source
      ON source.id = snapshot.source_id
    CROSS JOIN requested
    WHERE snapshot.count_check_passed
      AND snapshot.timeframe = requested.timeframe
    ORDER BY
      snapshot.source_id,
      snapshot.scraped_at DESC,
      snapshot.id DESC
  ),
  -- Source runs of the attempt-bound acquisitions whose source payload is the
  -- selected board's RAW (same source and timeframe). A trader_stats value is
  -- evidence only when an attempt-bound board write of exactly this RAW and
  -- one of these runs attested it (20261116205144). Whether that acquisition
  -- is complete is the board's own trust gate
  -- (public.rank_publication_trust_evidence; an unbound board is isolated).
  board_runs AS MATERIALIZED (
    SELECT
      latest.snapshot_id,
      pg_catalog.array_agg(DISTINCT outcome.source_run_id) AS source_run_ids
    FROM latest_passed AS latest
    JOIN arena.leaderboard_acquisition_outcomes AS outcome
      ON outcome.source_payload_raw_object_id = latest.raw_object_id
    JOIN arena.leaderboard_acquisition_attempts AS attempt
      ON attempt.attempt_seq = outcome.attempt_seq
     AND attempt.source_id = latest.source_id
     AND attempt.timeframe = latest.timeframe
    WHERE outcome.source_run_id IS NOT NULL
    GROUP BY latest.snapshot_id
  ),
  alias_board_watermarks AS MATERIALIZED (
    SELECT source.platform, pg_catalog.min(latest.scraped_at) AS board_as_of
    FROM latest_passed AS latest
    JOIN serving_source AS source
      ON source.id = latest.source_id
    GROUP BY source.platform
  ),
  attested_rows AS (
    SELECT
      latest.snapshot_id,
      latest.scraped_at AS board_scraped_at,
      source.platform,
      source.product_type,
      source.currency,
      entry.rank,
      entry.headline_roi,
      entry.headline_pnl,
      entry.headline_win_rate,
      trader.exchange_trader_id,
      trader.trader_kind,
      trader.nickname,
      trader.avatar_url_mirror,
      trader.avatar_url_origin,
      stats.trader_id AS stats_trader_id,
      stats.as_of AS stats_as_of,
      stats.roi AS stats_roi,
      stats.pnl AS stats_pnl,
      stats.win_rate AS stats_win_rate,
      stats.mdd AS stats_mdd,
      stats.copier_count AS stats_copier_count,
      stats.total_positions AS stats_total_positions,
      stats.sharpe AS stats_sharpe,
      (stats.extras->>'sortino')::pg_catalog.numeric AS stats_sortino,
      (stats.extras->>'calmar')::pg_catalog.numeric AS stats_calmar,
      (stats.extras->>'volatility')::pg_catalog.numeric AS stats_volatility,
      CASE
        WHEN stats.evidence_raw_object_id IS NOT NULL
         AND stats.evidence_raw_object_id = latest.raw_object_id
         AND stats.evidence_source_run_id = ANY (run.source_run_ids)
          THEN stats.evidence_metrics
        ELSE ARRAY[]::pg_catalog.text[]
      END AS attested
    FROM latest_passed AS latest
    JOIN serving_source AS source
      ON source.id = latest.source_id
    JOIN arena.leaderboard_entries AS entry
      ON entry.snapshot_id = latest.snapshot_id
     AND entry.scraped_at = latest.scraped_at
    JOIN arena.traders AS trader
      ON trader.id = entry.trader_id
    CROSS JOIN requested
    LEFT JOIN board_runs AS run
      ON run.snapshot_id = latest.snapshot_id
    LEFT JOIN arena.trader_stats AS stats
      ON stats.trader_id = trader.id
     AND stats.timeframe = latest.timeframe
     AND stats.as_of > requested.stats_cutoff
    WHERE (entry.rank IS NULL OR entry.rank <= p_per_platform_limit)
      AND latest.scraped_at > requested.requested_cutoff
  ),
  score_rows AS (
    SELECT
      attested_row.platform,
      CASE
        WHEN attested_row.product_type = 'spot' THEN 'spot'
        ELSE 'futures'
      END AS market_type,
      attested_row.exchange_trader_id AS trader_key,
      attested_row.rank AS board_rank,
      CASE
        WHEN attested_row.headline_roi IS NULL THEN NULL::pg_catalog.numeric
        ELSE LEAST(GREATEST(attested_row.headline_roi, -10000), 10000)
      END AS roi_pct,
      attested_row.headline_pnl AS pnl_usd,
      CASE
        WHEN attested_row.headline_win_rate IS NULL THEN NULL::pg_catalog.numeric
        ELSE LEAST(GREATEST(attested_row.headline_win_rate, 0), 100)
      END AS win_rate,
      CASE
        WHEN 'mdd' = ANY (attested_row.attested) AND attested_row.stats_mdd IS NOT NULL
          THEN LEAST(pg_catalog.abs(attested_row.stats_mdd), 100)
        ELSE NULL::pg_catalog.numeric
      END AS max_drawdown,
      CASE WHEN 'copier_count' = ANY (attested_row.attested) THEN attested_row.stats_copier_count END
        AS copiers,
      CASE WHEN 'total_positions' = ANY (attested_row.attested) THEN attested_row.stats_total_positions END
        AS trades_count,
      CASE WHEN 'sharpe' = ANY (attested_row.attested) THEN attested_row.stats_sharpe END AS sharpe_ratio,
      CASE WHEN 'sortino' = ANY (attested_row.attested) THEN attested_row.stats_sortino END AS sortino_ratio,
      CASE WHEN 'calmar' = ANY (attested_row.attested) THEN attested_row.stats_calmar END AS calmar_ratio,
      CASE WHEN 'volatility' = ANY (attested_row.attested) THEN attested_row.stats_volatility END
        AS volatility_pct,
      pg_catalog.array_remove(
        ARRAY[
          CASE WHEN attested_row.headline_roi IS NULL AND attested_row.stats_roi IS NOT NULL
            THEN 'roi_pct' END,
          CASE WHEN attested_row.headline_pnl IS NULL AND attested_row.stats_pnl IS NOT NULL
            THEN 'pnl_usd' END,
          CASE WHEN attested_row.headline_win_rate IS NULL AND attested_row.stats_win_rate IS NOT NULL
            THEN 'win_rate' END,
          CASE WHEN attested_row.stats_mdd IS NOT NULL AND NOT ('mdd' = ANY (attested_row.attested))
            THEN 'max_drawdown' END,
          CASE WHEN attested_row.stats_copier_count IS NOT NULL
                AND NOT ('copier_count' = ANY (attested_row.attested))
            THEN 'copiers' END,
          CASE WHEN attested_row.stats_total_positions IS NOT NULL
                AND NOT ('total_positions' = ANY (attested_row.attested))
            THEN 'trades_count' END,
          CASE WHEN attested_row.stats_sharpe IS NOT NULL AND NOT ('sharpe' = ANY (attested_row.attested))
            THEN 'sharpe_ratio' END,
          CASE WHEN attested_row.stats_sortino IS NOT NULL AND NOT ('sortino' = ANY (attested_row.attested))
            THEN 'sortino_ratio' END,
          CASE WHEN attested_row.stats_calmar IS NOT NULL AND NOT ('calmar' = ANY (attested_row.attested))
            THEN 'calmar_ratio' END,
          CASE WHEN attested_row.stats_volatility IS NOT NULL
                AND NOT ('volatility' = ANY (attested_row.attested))
            THEN 'volatility_pct' END
        ]::pg_catalog.text[],
        NULL
      ) AS unevidenced_metrics,
      attested_row.trader_kind,
      attested_row.nickname AS handle,
      COALESCE(attested_row.avatar_url_mirror, attested_row.avatar_url_origin) AS avatar_url,
      attested_row.currency,
      -- Only an attested trader_stats value is an observation of this row.
      CASE
        WHEN pg_catalog.cardinality(attested_row.attested) = 0 THEN attested_row.board_scraped_at
        ELSE LEAST(attested_row.board_scraped_at, attested_row.stats_as_of)
      END AS as_of
    FROM attested_rows AS attested_row
  )
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'platform', score_row.platform,
        'market_type', score_row.market_type,
        'trader_key', score_row.trader_key,
        'board_rank', score_row.board_rank,
        'roi_pct', score_row.roi_pct,
        'pnl_usd', score_row.pnl_usd,
        'win_rate', score_row.win_rate,
        'max_drawdown', score_row.max_drawdown,
        'copiers', score_row.copiers,
        'trades_count', score_row.trades_count,
        'sharpe_ratio', score_row.sharpe_ratio,
        'sortino_ratio', score_row.sortino_ratio,
        'calmar_ratio', score_row.calmar_ratio,
        'volatility_pct', score_row.volatility_pct,
        'unevidenced_metrics', pg_catalog.to_jsonb(score_row.unevidenced_metrics),
        'trader_kind', score_row.trader_kind,
        'handle', score_row.handle,
        'avatar_url', score_row.avatar_url,
        'currency', score_row.currency,
        'as_of', score_row.as_of,
        'board_as_of', board_watermark.board_as_of
      )
      ORDER BY score_row.platform, score_row.board_rank, score_row.trader_key
    ),
    '[]'::pg_catalog.jsonb
  )
  FROM score_rows AS score_row
  LEFT JOIN alias_board_watermarks AS board_watermark
    ON board_watermark.platform = score_row.platform
  CROSS JOIN requested
  WHERE score_row.as_of > requested.requested_cutoff
$function$;

ALTER FUNCTION arena.publication_score_rows_json(text, int, int) OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.publication_score_rows_json(text, int, int)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION arena.publication_score_rows_json(text, int, int) IS
  'Publication score rows: headline metrics from the bound board entry; other metrics only when an attempt-bound write of that board RAW attested them; unevidenced_metrics lists refused trader_stats values.';

NOTIFY pgrst, 'reload schema';

COMMIT;
