-- Keep the score-input JSON contract intact while removing its dependency on
-- the all-window arena.score_inputs view. The direct base-table plan narrows
-- snapshots to the requested numeric timeframe, applies age/rank gates before
-- JSON aggregation, and binds leaderboard entries to both snapshot identity
-- columns so PostgreSQL can prune the monthly scraped_at partitions at runtime.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $preflight$
DECLARE
  v_function oid := pg_catalog.to_regprocedure(
    'public.arena_score_inputs_json(text,integer,integer)'
  );
BEGIN
  IF v_function IS NULL THEN
    RAISE EXCEPTION 'arena_score_inputs_json(text,integer,integer) must exist';
  END IF;

  IF pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_snapshots') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_entries') IS NULL
     OR pg_catalog.to_regclass('arena.traders') IS NULL
     OR pg_catalog.to_regclass('arena.trader_stats') IS NULL THEN
    RAISE EXCEPTION 'score-input base relations must exist';
  END IF;

  IF pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL THEN
    RAISE EXCEPTION 'PostgREST API roles must exist';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
       'service_role', v_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege('anon', v_function, 'EXECUTE')
     OR pg_catalog.has_function_privilege(
       'authenticated', v_function, 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'arena_score_inputs_json execution boundary drifted';
  END IF;

  -- scraped_at is the leaderboard_entries partition key and is deliberately
  -- denormalized from its snapshot. Refuse the rewrite if currently served
  -- boards violate that invariant; silently dropping such rows would change
  -- the score-input payload.
  IF EXISTS (
    WITH latest_passed AS (
      SELECT DISTINCT ON (snapshot.source_id, snapshot.timeframe)
        snapshot.id AS snapshot_id,
        snapshot.source_id,
        snapshot.timeframe,
        snapshot.scraped_at
      FROM arena.leaderboard_snapshots AS snapshot
      WHERE snapshot.count_check_passed
        AND snapshot.timeframe = ANY (
          ARRAY[7, 30, 90]::pg_catalog.int2[]
        )
      ORDER BY
        snapshot.source_id,
        snapshot.timeframe,
        snapshot.scraped_at DESC
    )
    SELECT 1
    FROM latest_passed AS latest
    JOIN arena.sources AS source
      ON source.id = latest.source_id
    JOIN arena.leaderboard_entries AS entry
      ON entry.snapshot_id = latest.snapshot_id
    WHERE source.status = 'active'
      AND source.serving_mode = 'serving'
      AND source.currency = ANY (
        ARRAY['USDT', 'USDx', 'USDC', 'USD']::pg_catalog.text[]
      )
      AND entry.scraped_at IS DISTINCT FROM latest.scraped_at
  ) THEN
    RAISE EXCEPTION
      'latest served leaderboard entry scraped_at disagrees with its snapshot';
  END IF;
END
$preflight$;

-- CREATE OR REPLACE must retain the callable object's identity and every
-- externally relevant catalog property other than its implementation body.
CREATE TEMP TABLE arena_score_inputs_json_contract_before
ON COMMIT DROP
AS
SELECT
  function_row.oid,
  function_row.proowner,
  function_row.proacl,
  function_row.prorettype,
  function_row.pronargdefaults,
  function_row.proargdefaults::pg_catalog.text AS proargdefaults,
  function_row.prosecdef,
  function_row.proconfig,
  function_row.provolatile
FROM pg_catalog.pg_proc AS function_row
WHERE function_row.oid =
  'public.arena_score_inputs_json(text,integer,integer)'::pg_catalog.regprocedure;

CREATE OR REPLACE FUNCTION public.arena_score_inputs_json(
  p_window text,
  p_per_platform_limit int DEFAULT 1000,
  p_max_age_hours int DEFAULT 48
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
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
  score_latest_passed AS MATERIALIZED (
    -- Keep the score_inputs view's historical tie semantics: unlike the board
    -- watermark below, equal scraped_at values have no id tie-breaker.
    SELECT DISTINCT ON (snapshot.source_id)
      snapshot.id AS snapshot_id,
      snapshot.source_id,
      snapshot.timeframe,
      snapshot.scraped_at
    FROM arena.leaderboard_snapshots AS snapshot
    CROSS JOIN requested
    WHERE snapshot.count_check_passed
      AND snapshot.timeframe = requested.timeframe
    ORDER BY
      snapshot.source_id,
      snapshot.scraped_at DESC
  ),
  watermark_latest_passed AS MATERIALIZED (
    SELECT DISTINCT ON (snapshot.source_id)
      snapshot.source_id,
      snapshot.scraped_at
    FROM arena.leaderboard_snapshots AS snapshot
    CROSS JOIN requested
    WHERE snapshot.count_check_passed
      AND snapshot.timeframe = requested.timeframe
    ORDER BY
      snapshot.source_id,
      snapshot.scraped_at DESC,
      snapshot.id DESC
  ),
  alias_board_watermarks AS MATERIALIZED (
    SELECT
      COALESCE(
        NULLIF(source.meta->>'legacy_platform', ''),
        source.slug
      ) AS platform,
      pg_catalog.min(latest.scraped_at) AS board_as_of
    FROM watermark_latest_passed AS latest
    JOIN arena.sources AS source
      ON source.id = latest.source_id
    WHERE source.status = 'active'
      AND source.serving_mode = 'serving'
      AND source.currency = ANY (
        ARRAY['USDT', 'USDx', 'USDC', 'USD']::pg_catalog.text[]
      )
      AND (source.meta->>'legacy_platform') IS DISTINCT FROM 'null'
    GROUP BY
      COALESCE(
        NULLIF(source.meta->>'legacy_platform', ''),
        source.slug
      )
  ),
  fresh_first_party AS MATERIALIZED (
    SELECT stats.trader_id, stats.timeframe
    FROM arena.trader_stats AS stats
    JOIN arena.traders AS trader
      ON trader.id = stats.trader_id
    CROSS JOIN requested
    WHERE stats.timeframe = requested.timeframe
      AND trader.meta->>'claimed' = 'true'
      AND stats.extras->>'provenance' = 'first_party'
      AND stats.as_of > requested.stats_cutoff
  ),
  score_rows AS (
    SELECT
      COALESCE(source.meta->>'legacy_platform', source.slug) AS platform,
      CASE
        WHEN source.product_type = 'spot' THEN 'spot'
        ELSE 'futures'
      END AS market_type,
      trader.exchange_trader_id AS trader_key,
      entry.rank AS board_rank,
      CASE
        WHEN COALESCE(entry.headline_roi, stats.roi) IS NULL
          THEN NULL::pg_catalog.numeric
        ELSE LEAST(
          GREATEST(
            COALESCE(entry.headline_roi, stats.roi),
            -10000
          ),
          10000
        )
      END AS roi_pct,
      COALESCE(entry.headline_pnl, stats.pnl) AS pnl_usd,
      CASE
        WHEN COALESCE(entry.headline_win_rate, stats.win_rate) IS NULL
          THEN NULL::pg_catalog.numeric
        ELSE LEAST(
          GREATEST(
            COALESCE(entry.headline_win_rate, stats.win_rate),
            0
          ),
          100
        )
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
      trader.trader_kind,
      trader.nickname AS handle,
      COALESCE(
        trader.avatar_url_mirror,
        trader.avatar_url_origin
      ) AS avatar_url,
      source.currency,
      CASE
        WHEN stats.trader_id IS NULL THEN latest.scraped_at
        ELSE LEAST(latest.scraped_at, stats.as_of)
      END AS as_of
    FROM score_latest_passed AS latest
    JOIN arena.sources AS source
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
    WHERE source.serving_mode = 'serving'
      AND source.status = 'active'
      AND source.currency = ANY (
        ARRAY['USDT', 'USDx', 'USDC', 'USD']::pg_catalog.text[]
      )
      AND (source.meta->>'legacy_platform') IS DISTINCT FROM 'null'
      AND (entry.rank IS NULL OR entry.rank <= p_per_platform_limit)
      AND latest.scraped_at > requested.requested_cutoff
      AND NOT EXISTS (
        SELECT 1
        FROM fresh_first_party AS fresh
        WHERE fresh.trader_id = trader.id
          AND fresh.timeframe = latest.timeframe
      )

    UNION ALL

    SELECT
      COALESCE(source.meta->>'legacy_platform', source.slug) AS platform,
      CASE
        WHEN source.product_type = 'spot' THEN 'spot'
        ELSE 'futures'
      END AS market_type,
      trader.exchange_trader_id AS trader_key,
      board_rank.rank AS board_rank,
      CASE
        WHEN stats.roi IS NULL THEN NULL::pg_catalog.numeric
        ELSE LEAST(
          GREATEST(stats.roi, -10000),
          10000
        )
      END AS roi_pct,
      stats.pnl AS pnl_usd,
      CASE
        WHEN stats.win_rate IS NULL THEN NULL::pg_catalog.numeric
        ELSE LEAST(
          GREATEST(stats.win_rate, 0),
          100
        )
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
      trader.trader_kind,
      trader.nickname AS handle,
      COALESCE(
        trader.avatar_url_mirror,
        trader.avatar_url_origin
      ) AS avatar_url,
      source.currency,
      stats.as_of AS as_of
    FROM arena.traders AS trader
    JOIN arena.sources AS source
      ON source.id = trader.source_id
    JOIN arena.trader_stats AS stats
      ON stats.trader_id = trader.id
    CROSS JOIN requested
    LEFT JOIN LATERAL (
      SELECT entry.rank
      FROM score_latest_passed AS latest
      JOIN arena.leaderboard_entries AS entry
        ON entry.snapshot_id = latest.snapshot_id
       AND entry.scraped_at = latest.scraped_at
       AND entry.trader_id = trader.id
      WHERE latest.source_id = source.id
        AND latest.timeframe = stats.timeframe
      LIMIT 1
    ) AS board_rank ON true
    WHERE stats.timeframe = requested.timeframe
      AND source.serving_mode = 'serving'
      AND source.status = 'active'
      AND trader.meta->>'claimed' = 'true'
      AND stats.extras->>'provenance' = 'first_party'
      AND stats.as_of > requested.stats_cutoff
      AND stats.as_of > requested.requested_cutoff
      AND source.currency = ANY (
        ARRAY['USDT', 'USDx', 'USDC', 'USD']::pg_catalog.text[]
      )
      AND (
        board_rank.rank IS NULL
        OR board_rank.rank <= p_per_platform_limit
      )
  )
  SELECT COALESCE(
    pg_catalog.jsonb_agg(payload_row),
    '[]'::pg_catalog.jsonb
  )
  FROM (
    SELECT
      score_row.platform,
      score_row.market_type,
      score_row.trader_key,
      score_row.board_rank,
      score_row.roi_pct,
      score_row.pnl_usd,
      score_row.win_rate,
      score_row.max_drawdown,
      score_row.copiers,
      score_row.trades_count,
      score_row.sharpe_ratio,
      score_row.sortino_ratio,
      score_row.calmar_ratio,
      score_row.volatility_pct,
      score_row.trader_kind,
      score_row.handle,
      score_row.avatar_url,
      score_row.currency,
      score_row.as_of,
      board_watermark.board_as_of
    FROM score_rows AS score_row
    LEFT JOIN alias_board_watermarks AS board_watermark
      ON board_watermark.platform = score_row.platform
    CROSS JOIN requested
    WHERE score_row.as_of > requested.requested_cutoff
  ) AS payload_row;
$function$;

-- Preserve the existing service-only PostgREST boundary explicitly.
REVOKE ALL
  ON FUNCTION public.arena_score_inputs_json(text, int, int)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE
  ON FUNCTION public.arena_score_inputs_json(text, int, int)
  TO service_role;

DO $postflight$
DECLARE
  v_before arena_score_inputs_json_contract_before%ROWTYPE;
  v_after pg_catalog.pg_proc%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_before
  FROM arena_score_inputs_json_contract_before;

  SELECT * INTO STRICT v_after
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
    'public.arena_score_inputs_json(text,integer,integer)'::pg_catalog.regprocedure;

  IF v_after.oid IS DISTINCT FROM v_before.oid
     OR v_after.proowner IS DISTINCT FROM v_before.proowner
     OR v_after.proacl IS DISTINCT FROM v_before.proacl
     OR v_after.prorettype IS DISTINCT FROM v_before.prorettype
     OR v_after.pronargdefaults IS DISTINCT FROM v_before.pronargdefaults
     OR v_after.proargdefaults::pg_catalog.text
          IS DISTINCT FROM v_before.proargdefaults
     OR v_after.prosecdef IS DISTINCT FROM v_before.prosecdef
     OR v_after.proconfig IS DISTINCT FROM v_before.proconfig
     OR v_after.provolatile IS DISTINCT FROM v_before.provolatile THEN
    RAISE EXCEPTION
      'arena_score_inputs_json callable catalog contract changed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_depend AS dependency
    WHERE dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
      AND dependency.objid = v_after.oid
      AND dependency.refobjid = pg_catalog.to_regclass('arena.score_inputs')
  ) THEN
    RAISE EXCEPTION 'arena_score_inputs_json still depends on arena.score_inputs';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
