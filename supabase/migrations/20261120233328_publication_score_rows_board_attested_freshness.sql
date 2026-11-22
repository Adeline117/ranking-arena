-- Migration: 20261120233328_publication_score_rows_board_attested_freshness.sql
-- Description: arena.publication_score_rows_json@4. A trader_stats value the
--   selected board attested is as fresh as that board; the row's as_of no
--   longer hides it.
--
-- Why: the board write (lib/ingest/serving/headline-stats-sql.ts) keeps
--   trader_stats.as_of at LEAST(old, new) whenever the row still holds a
--   headline column this board did not send. A trader who was profile-crawled
--   once, months ago, keeps e.g. a Sharpe or a volume the board never
--   re-sends, so his as_of stays frozen at that old crawl for good. @3 joined
--   trader_stats only when as_of was inside 48 hours and aged the row by
--   as_of, so for those traders the drawdown (and a win rate or PnL the board
--   entry lacks) the board had just written and attested was dropped: "only
--   deep-crawled traders have a drawdown". Measured in production on
--   2026-11-21 (7D): bitunix 2,494 of 4,812 board-attested drawdowns, and
--   bybit_copytrade 2,426 of 7,054, sat on rows with as_of older than 48h.
--
-- What changes, and nothing else:
--   * trader_stats is joined without the as_of cutoff;
--   * a board-attested value is accepted exactly as before: the row's
--     evidence_raw_object_id must be the selected board's RAW and its
--     evidence_source_run_id one of that board's runs, and the metric must be
--     listed in evidence_metrics (the table trigger strips a listed metric
--     another writer overwrites) - so the value was written by this very
--     board, whose own freshness (p_max_age_hours) is still enforced;
--   * a profile-attested value is accepted exactly as before: a COMPLETE
--     capture of this source, trader and timeframe inside the freshness
--     window;
--   * the row's as_of is the board scrape, or the older profile capture when
--     a profile-attested value is used. It no longer follows trader_stats.as_of.
--   A value with neither attestation stays NULL and is named in
--   unevidenced_metrics, as before. An old unattested value that @3 did not
--   even see is now named there too.
--
-- POSTDEPLOY, after 20261116215329 (whose @3 body it replaces). It depends on
-- no worker release and touches no table 20261111192134 guards.
--
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('arena.profile_acquisition_attempts') IS NULL
     OR pg_catalog.to_regclass('arena.profile_acquisition_outcomes') IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.oid = pg_catalog.to_regprocedure(
           'arena.publication_score_rows_json(text,integer,integer)'
         )
         AND (
           pg_catalog.strpos(function_row.prosrc, 'publication-score-rows@3') > 0
           OR pg_catalog.strpos(function_row.prosrc, 'publication-score-rows@4') > 0
         )
     ) THEN
    RAISE EXCEPTION 'board-attested freshness requires publication-score-rows@3 (20261116215329)';
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
  -- publication-score-rows@4 (board headline + board- or profile-attested trader_stats;
  -- a board-attested value is as fresh as its board)
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
        AS requested_cutoff
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
      END AS board_attested,
      COALESCE(profile.metrics, ARRAY[]::pg_catalog.text[]) AS profile_attested,
      profile.captured_at AS profile_captured_at
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
    -- No trader_stats.as_of cutoff: as_of is the row's OLDEST surviving
    -- headline fact (a column an old profile crawl left behind freezes it for
    -- good), not the age of the values used here. A board-attested value was
    -- written by the selected board (same RAW and run, enforced below), so it
    -- is as fresh as that board; a profile-attested value is as fresh as its
    -- capture (checked in the lateral). Every other value stays unevidenced.
    LEFT JOIN arena.trader_stats AS stats
      ON stats.trader_id = trader.id
     AND stats.timeframe = latest.timeframe
    -- A profile attestation (20261116215328) counts only when it is a
    -- COMPLETE capture of this very source, trader and timeframe whose
    -- capture time is inside the board's freshness window. Capture time is
    -- the database-owned attempt start (before the fetch): never newer than
    -- the data it attests. The table trigger
    -- already guarantees the stored values equal the captured ones and strips
    -- any value a later write changed.
    LEFT JOIN LATERAL (
      SELECT stats.profile_evidence_metrics AS metrics, attempt.recorded_started_at AS captured_at
      FROM arena.profile_acquisition_outcomes AS outcome
      JOIN arena.profile_acquisition_attempts AS attempt
        ON attempt.attempt_seq = outcome.attempt_seq
      WHERE outcome.attempt_seq = stats.profile_evidence_attempt_seq
        AND outcome.terminal_state = 'complete'
        AND attempt.source_id = latest.source_id
        AND attempt.trader_id = trader.id
        AND attempt.timeframe = latest.timeframe
        AND attempt.recorded_started_at > requested.requested_cutoff
        AND attempt.recorded_started_at <= pg_catalog.now()
    ) AS profile ON true
    WHERE (entry.rank IS NULL OR entry.rank <= p_per_platform_limit)
      AND latest.scraped_at > requested.requested_cutoff
  ),
  merged_rows AS (
    SELECT
      attested_row.*,
      attested_row.board_attested || attested_row.profile_attested AS attested
    FROM attested_rows AS attested_row
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
      -- Headline from the board entry; a value the board lacks only when an
      -- attestation covers the trader_stats value.
      -- (GREATEST/LEAST ignore NULL, so NULL is kept explicitly.)
      CASE
        WHEN attested_row.headline_roi IS NOT NULL
          THEN LEAST(GREATEST(attested_row.headline_roi, -10000), 10000)
        WHEN 'roi' = ANY (attested_row.attested) AND attested_row.stats_roi IS NOT NULL
          THEN LEAST(GREATEST(attested_row.stats_roi, -10000), 10000)
        ELSE NULL::pg_catalog.numeric
      END AS roi_pct,
      COALESCE(
        attested_row.headline_pnl,
        CASE WHEN 'pnl' = ANY (attested_row.attested) THEN attested_row.stats_pnl END
      ) AS pnl_usd,
      CASE
        WHEN attested_row.headline_win_rate IS NOT NULL
          THEN LEAST(GREATEST(attested_row.headline_win_rate, 0), 100)
        WHEN 'win_rate' = ANY (attested_row.attested) AND attested_row.stats_win_rate IS NOT NULL
          THEN LEAST(GREATEST(attested_row.stats_win_rate, 0), 100)
        ELSE NULL::pg_catalog.numeric
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
                AND NOT ('roi' = ANY (attested_row.attested))
            THEN 'roi_pct' END,
          CASE WHEN attested_row.headline_pnl IS NULL AND attested_row.stats_pnl IS NOT NULL
                AND NOT ('pnl' = ANY (attested_row.attested))
            THEN 'pnl_usd' END,
          CASE WHEN attested_row.headline_win_rate IS NULL AND attested_row.stats_win_rate IS NOT NULL
                AND NOT ('win_rate' = ANY (attested_row.attested))
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
      -- A board-attested value is an observation of the selected board; a
      -- profile-attested value is as old as its capture.
      LEAST(
        attested_row.board_scraped_at,
        CASE WHEN pg_catalog.cardinality(attested_row.profile_attested) > 0
          THEN attested_row.profile_captured_at END
      ) AS as_of
    FROM merged_rows AS attested_row
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
  'Publication score rows: headline metrics from the bound board entry; a trader_stats value only when an attempt-bound write of that board RAW, or a complete fresh profile capture of the same source/trader/timeframe, attested it; unevidenced_metrics lists refused trader_stats values.';

NOTIFY pgrst, 'reload schema';

COMMIT;
