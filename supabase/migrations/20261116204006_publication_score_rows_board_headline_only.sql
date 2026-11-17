-- Migration: 20261116204006_publication_score_rows_board_headline_only.sql
-- Description: Score-input evidence binding, step 1 of 3 (PR #476 plan,
--   option B): the publication bundle's headline metrics come only from the
--   bound board.
--
-- public.arena_score_inputs_publish_bundle_json took its scoreRows from the
-- legacy reader public.arena_score_inputs_json, which:
--   * filled ROI, PnL and win rate with COALESCE(entry.headline_*, stats.*),
--     so a value the board never published came from the mutable
--     arena.trader_stats row (written by profile crawls, enrichment, repairs);
--   * replaced a claimed trader's board row with its first-party trader_stats
--     row (no board evidence at all).
-- The publication authority is the board snapshot, and the snapshot's RAW is
-- the attempt-bound acquisition's source payload
-- (public.rank_publication_trust_evidence). A headline metric is therefore
-- evidence only when the bound board entry carries it.
--
-- * arena.publication_score_rows_json(window, limit, max_age): the
--   publication-only score-row reader. One row per entry of each serving
--   source's latest PASSED board (same source, alias, currency, rank, age and
--   Bitget-bot quarantine rules as the legacy reader); roi_pct / pnl_usd /
--   win_rate from the entry only; every other metric from trader_stats as
--   before. Each row lists, in unevidenced_metrics, the metrics trader_stats
--   held but publication refused for lack of board evidence, so the
--   orchestrator can count the exclusion instead of reporting a missing value.
-- * the bundle's scoreRows call moves from the legacy reader to this one
--   (an exact, counted, digest-fenced rewrite of the live body). The legacy
--   reader is left untouched for its retired caller.
--
-- POSTDEPLOY: the deployed orchestrator's strict bundle schema rejects the new
-- unevidenced_metrics key, so this follows the worker release whose schema
-- accepts it (that release reads a bundle without the key as before).
--
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
BEGIN
  IF pg_catalog.to_regprocedure(
       'public.arena_score_inputs_publish_bundle_json(text,integer,integer)'
     ) IS NULL
     OR pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_snapshots') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_entries') IS NULL
     OR pg_catalog.to_regclass('arena.traders') IS NULL
     OR pg_catalog.to_regclass('arena.trader_stats') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL THEN
    RAISE EXCEPTION 'publication score rows require the score-input bundle and the arena serving relations';
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
  -- publication-score-rows@1 (board headline only)
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
      snapshot.scraped_at
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
  alias_board_watermarks AS MATERIALIZED (
    SELECT source.platform, pg_catalog.min(latest.scraped_at) AS board_as_of
    FROM latest_passed AS latest
    JOIN serving_source AS source
      ON source.id = latest.source_id
    GROUP BY source.platform
  ),
  score_rows AS (
    SELECT
      source.platform,
      CASE
        WHEN source.product_type = 'spot' THEN 'spot'
        ELSE 'futures'
      END AS market_type,
      trader.exchange_trader_id AS trader_key,
      entry.rank AS board_rank,
      CASE
        WHEN entry.headline_roi IS NULL THEN NULL::pg_catalog.numeric
        ELSE LEAST(GREATEST(entry.headline_roi, -10000), 10000)
      END AS roi_pct,
      entry.headline_pnl AS pnl_usd,
      CASE
        WHEN entry.headline_win_rate IS NULL THEN NULL::pg_catalog.numeric
        ELSE LEAST(GREATEST(entry.headline_win_rate, 0), 100)
      END AS win_rate,
      CASE
        WHEN stats.mdd IS NULL THEN NULL::pg_catalog.numeric
        ELSE LEAST(pg_catalog.abs(stats.mdd), 100)
      END AS max_drawdown,
      stats.copier_count AS copiers,
      stats.total_positions AS trades_count,
      stats.sharpe AS sharpe_ratio,
      (stats.extras->>'sortino')::pg_catalog.numeric AS sortino_ratio,
      (stats.extras->>'calmar')::pg_catalog.numeric AS calmar_ratio,
      (stats.extras->>'volatility')::pg_catalog.numeric AS volatility_pct,
      pg_catalog.array_remove(
        ARRAY[
          CASE WHEN entry.headline_roi IS NULL AND stats.roi IS NOT NULL
            THEN 'roi_pct' END,
          CASE WHEN entry.headline_pnl IS NULL AND stats.pnl IS NOT NULL
            THEN 'pnl_usd' END,
          CASE WHEN entry.headline_win_rate IS NULL AND stats.win_rate IS NOT NULL
            THEN 'win_rate' END
        ]::pg_catalog.text[],
        NULL
      ) AS unevidenced_metrics,
      trader.trader_kind,
      trader.nickname AS handle,
      COALESCE(trader.avatar_url_mirror, trader.avatar_url_origin) AS avatar_url,
      source.currency,
      CASE
        WHEN stats.trader_id IS NULL THEN latest.scraped_at
        ELSE LEAST(latest.scraped_at, stats.as_of)
      END AS as_of
    FROM latest_passed AS latest
    JOIN serving_source AS source
      ON source.id = latest.source_id
    JOIN arena.leaderboard_entries AS entry
      ON entry.snapshot_id = latest.snapshot_id
     AND entry.scraped_at = latest.scraped_at
    JOIN arena.traders AS trader
      ON trader.id = entry.trader_id
    CROSS JOIN requested
    LEFT JOIN arena.trader_stats AS stats
      ON stats.trader_id = trader.id
     AND stats.timeframe = latest.timeframe
     AND stats.as_of > requested.stats_cutoff
    WHERE (entry.rank IS NULL OR entry.rank <= p_per_platform_limit)
      AND latest.scraped_at > requested.requested_cutoff
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
  'Publication score rows: headline metrics from the bound board entry only; unevidenced_metrics lists trader_stats values publication refused.';

-- Point the bundle's scoreRows at the publication reader. The live body is
-- the Bitget-bot-quarantined bundle (20261115013558, sha256 f1c2aa2f...); any
-- other body is drift and refuses the migration. A body already rewritten by
-- this migration is left alone.
DO $rewrite_bundle$
DECLARE
  v_function oid := pg_catalog.to_regprocedure(
    'public.arena_score_inputs_publish_bundle_json(text,integer,integer)'
  );
  v_before jsonb;
  v_source text;
  v_sha256 text;
  v_count integer;
  v_needle constant text := 'public.arena_score_inputs_json(';
  v_replacement constant text := 'arena.publication_score_rows_json(';
  v_legacy_sha256 constant text :=
    'f1c2aa2f9c5bb32c70fc585fce0a5a424028041ff4473fa89984f293e2eb85bc';
  v_rewritten_sha256 constant text :=
    'bb652e14c48fe612ba3ab3e957d840ce449f7ae74c78bd49a1e37467995fd682';
BEGIN
  SELECT function_row.prosrc, pg_catalog.to_jsonb(function_row) - 'prosrc'
  INTO STRICT v_source, v_before
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_function;

  v_sha256 := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(v_source, 'UTF8')), 'hex'
  );
  IF v_sha256 = v_rewritten_sha256 THEN
    RETURN;
  ELSIF v_sha256 <> v_legacy_sha256 THEN
    RAISE EXCEPTION 'score-input publish bundle body drifted: %', v_sha256;
  END IF;

  v_count := (
    pg_catalog.length(v_source)
    - pg_catalog.length(pg_catalog.replace(v_source, v_needle, ''))
  ) / pg_catalog.length(v_needle);
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'score-input publish bundle rewrite anchor drifted: %/1', v_count;
  END IF;

  EXECUTE pg_catalog.replace(
    pg_catalog.pg_get_functiondef(v_function), v_needle, v_replacement
  );

  SELECT pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc, 'UTF8')), 'hex'
  )
  INTO STRICT v_sha256
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_function
    AND (pg_catalog.to_jsonb(function_row) - 'prosrc') = v_before;
  IF v_sha256 <> v_rewritten_sha256 THEN
    RAISE EXCEPTION 'score-input publish bundle rewrite digest mismatch: %', v_sha256;
  END IF;
END
$rewrite_bundle$;

NOTIFY pgrst, 'reload schema';

COMMIT;
