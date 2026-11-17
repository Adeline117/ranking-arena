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

-- Point the bundle's scoreRows at the publication reader. The live body must
-- be the Bitget-bot-quarantined bundle (20261115013558, prosrc sha256
-- f1c2aa2f...) or this migration's own body; anything else is drift. The
-- replacement below is that body with exactly one change: the scoreRows call.
DO $bundle_preflight$
DECLARE
  v_sha256 text;
BEGIN
  SELECT pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc, 'UTF8')), 'hex'
  )
  INTO STRICT v_sha256
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = pg_catalog.to_regprocedure(
    'public.arena_score_inputs_publish_bundle_json(text,integer,integer)'
  );
  IF v_sha256 NOT IN (
    'f1c2aa2f9c5bb32c70fc585fce0a5a424028041ff4473fa89984f293e2eb85bc',
    'bb652e14c48fe612ba3ab3e957d840ce449f7ae74c78bd49a1e37467995fd682'
  ) THEN
    RAISE EXCEPTION 'score-input publish bundle body drifted: %', v_sha256;
  END IF;
END
$bundle_preflight$;

CREATE OR REPLACE FUNCTION public.arena_score_inputs_publish_bundle_json(p_window text, p_per_platform_limit integer DEFAULT 1000, p_max_age_hours integer DEFAULT 48)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  IF p_window IS NULL OR p_window NOT IN ('7D', '30D', '90D') THEN
    RAISE EXCEPTION 'invalid score-input publish window: %', p_window
      USING ERRCODE = '22023';
  END IF;

  IF p_per_platform_limit IS NULL OR p_per_platform_limit <= 0 THEN
    RAISE EXCEPTION 'score-input publish limit must be positive: %',
      p_per_platform_limit
      USING ERRCODE = '22023';
  END IF;

  IF p_max_age_hours IS NULL OR p_max_age_hours <= 0 THEN
    RAISE EXCEPTION 'score-input publish max age must be positive: %',
      p_max_age_hours
      USING ERRCODE = '22023';
  END IF;

  -- Every arena relation and the legacy score-row RPC are read by this one SQL
  -- statement, so scoreRows and physicalBoards share one statement snapshot.
  RETURN (
  WITH requested_window AS MATERIALIZED (
    SELECT CASE p_window
      WHEN '7D' THEN 7::pg_catalog.int2
      WHEN '30D' THEN 30::pg_catalog.int2
      WHEN '90D' THEN 90::pg_catalog.int2
      ELSE NULL::pg_catalog.int2
    END AS timeframe
  ),
  registry_boards AS MATERIALIZED (
    SELECT
      source_row.id AS source_id,
      source_row.slug AS registry_slug,
      COALESCE(
        NULLIF(pg_catalog.btrim(source_row.meta->>'legacy_platform'), ''),
        source_row.slug
      ) AS filter_source,
      requested.timeframe
    FROM arena.sources AS source_row
    CROSS JOIN requested_window AS requested
    WHERE requested.timeframe IS NOT NULL
      AND source_row.status = 'active'
      AND source_row.serving_mode = 'serving'
      -- bitget-bot-cumulative-rank-quarantine@1
      AND NOT (
        source_row.slug = ANY (
          ARRAY[
            'bitget_bots_futures',
            'bitget_bots_spot'
          ]::pg_catalog.text[]
        )
        OR source_row.adapter_slug = 'bitget_bots'
      )
      AND requested.timeframe = ANY (
        COALESCE(source_row.timeframes_native, ARRAY[]::pg_catalog.int4[])
        || COALESCE(source_row.timeframes_derived, ARRAY[]::pg_catalog.int4[])
      )
      AND pg_catalog.btrim(
        COALESCE(source_row.meta->>'legacy_platform', '')
      ) <> 'null'
  ),
  latest_snapshot_attempt AS MATERIALIZED (
    SELECT DISTINCT ON (snapshot.source_id)
      snapshot.source_id,
      snapshot.id AS latest_attempt_id,
      snapshot.scraped_at AS latest_attempt_scraped_at,
      snapshot.count_check_passed AS latest_attempt_passed
    FROM arena.leaderboard_snapshots AS snapshot
    JOIN registry_boards AS registry
      ON registry.source_id = snapshot.source_id
     AND registry.timeframe = snapshot.timeframe
    ORDER BY
      snapshot.source_id,
      snapshot.scraped_at DESC,
      snapshot.id DESC
  ),
  passed_snapshots AS MATERIALIZED (
    SELECT
      snapshot.source_id,
      snapshot.id AS snapshot_id,
      snapshot.scraped_at,
      snapshot.actual_count,
      pg_catalog.count(*) OVER (
        PARTITION BY snapshot.source_id, snapshot.scraped_at
      )::bigint AS latest_passed_tie_count,
      pg_catalog.row_number() OVER (
        PARTITION BY snapshot.source_id
        ORDER BY snapshot.scraped_at DESC, snapshot.id DESC
      ) AS selected_order
    FROM arena.leaderboard_snapshots AS snapshot
    JOIN registry_boards AS registry
      ON registry.source_id = snapshot.source_id
     AND registry.timeframe = snapshot.timeframe
    WHERE snapshot.count_check_passed
  ),
  latest_passed_snapshot AS MATERIALIZED (
    SELECT
      passed.source_id,
      passed.snapshot_id,
      passed.scraped_at,
      passed.actual_count,
      passed.latest_passed_tie_count
    FROM passed_snapshots AS passed
    WHERE passed.selected_order = 1
  ),
  passed_entry_counts AS MATERIALIZED (
    SELECT
      passed.snapshot_id,
      pg_catalog.count(entry.snapshot_id)::bigint AS entry_count,
      pg_catalog.count(entry.snapshot_id) FILTER (
        WHERE entry.rank <= p_per_platform_limit
      )::bigint AS rank_limited_entry_count
    FROM latest_passed_snapshot AS passed
    LEFT JOIN arena.leaderboard_entries AS entry
      ON entry.snapshot_id = passed.snapshot_id
     AND entry.scraped_at = passed.scraped_at
    GROUP BY passed.snapshot_id
  ),
  physical_board_evidence AS MATERIALIZED (
    SELECT
      registry.registry_slug,
      registry.filter_source,
      registry.timeframe,
      passed.snapshot_id,
      passed.scraped_at,
      passed.actual_count,
      CASE
        WHEN passed.snapshot_id IS NULL THEN NULL::bigint
        ELSE COALESCE(entry_count.entry_count, 0::bigint)
      END AS entry_count,
      p_per_platform_limit AS rank_limit,
      CASE
        WHEN passed.snapshot_id IS NULL THEN NULL::bigint
        ELSE COALESCE(entry_count.rank_limited_entry_count, 0::bigint)
      END AS rank_limited_entry_count,
      COALESCE(passed.latest_passed_tie_count, 0::bigint)
        AS latest_passed_tie_count,
      CASE
        WHEN passed.snapshot_id IS NULL
             AND attempt.latest_attempt_id IS NULL THEN 'missing'
        WHEN passed.snapshot_id IS NULL THEN 'failed'
        WHEN passed.latest_passed_tie_count > 1 THEN 'ambiguous_latest'
        WHEN attempt.latest_attempt_passed IS FALSE
             AND attempt.latest_attempt_scraped_at >= passed.scraped_at
          THEN 'latest_attempt_failed'
        WHEN passed.scraped_at
             > pg_catalog.statement_timestamp() + interval '5 minutes'
          THEN 'future'
        WHEN passed.scraped_at
             <= pg_catalog.statement_timestamp()
                - pg_catalog.make_interval(hours => p_max_age_hours)
          THEN 'stale'
        WHEN passed.actual_count::bigint
             IS DISTINCT FROM COALESCE(entry_count.entry_count, 0::bigint)
          THEN 'entry_count_mismatch'
        ELSE 'passed'
      END AS evidence_status,
      attempt.latest_attempt_id,
      attempt.latest_attempt_scraped_at,
      attempt.latest_attempt_passed
    FROM registry_boards AS registry
    LEFT JOIN latest_passed_snapshot AS passed
      ON passed.source_id = registry.source_id
    LEFT JOIN passed_entry_counts AS entry_count
      ON entry_count.snapshot_id = passed.snapshot_id
    LEFT JOIN latest_snapshot_attempt AS attempt
      ON attempt.source_id = registry.source_id
  ),
  physical_boards_json AS MATERIALIZED (
    SELECT COALESCE(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'registry_slug', evidence.registry_slug,
          'filter_source', evidence.filter_source,
          'window', evidence.timeframe::text || 'D',
          'snapshot_id', evidence.snapshot_id,
          'scraped_at', evidence.scraped_at,
          'actual_count', evidence.actual_count,
          'entry_count', evidence.entry_count,
          'rank_limit', evidence.rank_limit,
          'rank_limited_entry_count', evidence.rank_limited_entry_count,
          'latest_passed_tie_count', evidence.latest_passed_tie_count,
          'evidence_status', evidence.evidence_status,
          'latest_attempt_id', evidence.latest_attempt_id,
          'latest_attempt_scraped_at', evidence.latest_attempt_scraped_at,
          'latest_attempt_passed', evidence.latest_attempt_passed
        )
        ORDER BY evidence.registry_slug
      ),
      '[]'::pg_catalog.jsonb
    ) AS payload
    FROM physical_board_evidence AS evidence
  )
  SELECT pg_catalog.jsonb_build_object(
    'scoreRows', arena.publication_score_rows_json(
      p_window,
      p_per_platform_limit,
      p_max_age_hours
    ),
    'physicalBoards', physical_boards.payload
  )
  FROM physical_boards_json AS physical_boards
  );
END;
$function$;

REVOKE ALL
  ON FUNCTION public.arena_score_inputs_publish_bundle_json(text, int, int)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE
  ON FUNCTION public.arena_score_inputs_publish_bundle_json(text, int, int)
  TO service_role;

DO $bundle_postflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = pg_catalog.to_regprocedure(
        'public.arena_score_inputs_publish_bundle_json(text,integer,integer)'
      )
      AND pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc, 'UTF8')), 'hex'
      ) = 'bb652e14c48fe612ba3ab3e957d840ce449f7ae74c78bd49a1e37467995fd682'
      AND function_row.proowner = 'postgres'::pg_catalog.regrole
      AND function_row.prosecdef
      AND function_row.provolatile = 's'
      AND function_row.proconfig =
        ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
  ) THEN
    RAISE EXCEPTION 'score-input publish bundle rewrite postflight failed';
  END IF;
END
$bundle_postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
