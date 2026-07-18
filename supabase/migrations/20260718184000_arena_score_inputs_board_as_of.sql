-- Publish the source-board watermark independently from each score row's
-- oldest metric observation. A fresh exchange board can legitimately carry
-- older (but still admissible) trader statistics, so `as_of` alone cannot
-- answer whether the board itself is current.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $preflight$
BEGIN
  IF pg_catalog.to_regprocedure(
    'public.arena_score_inputs_json(text,integer,integer)'
  ) IS NULL THEN
    RAISE EXCEPTION 'arena_score_inputs_json(text,integer,integer) must exist';
  END IF;

  IF pg_catalog.to_regclass('arena.score_inputs') IS NULL
     OR pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_snapshots') IS NULL THEN
    RAISE EXCEPTION 'score inputs, sources, and snapshots must exist';
  END IF;

  IF pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL THEN
    RAISE EXCEPTION 'PostgREST API roles must exist';
  END IF;
END
$preflight$;

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
  WITH latest_passed AS MATERIALIZED (
    SELECT DISTINCT ON (snapshot.source_id)
      snapshot.source_id,
      snapshot.scraped_at
    FROM arena.leaderboard_snapshots AS snapshot
    WHERE snapshot.count_check_passed
      AND (snapshot.timeframe::pg_catalog.text || 'D') = p_window
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
    FROM latest_passed AS latest
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
  )
  SELECT COALESCE(
    pg_catalog.jsonb_agg(payload_row),
    '[]'::pg_catalog.jsonb
  )
  FROM (
    SELECT
      score_input.platform,
      score_input.market_type,
      score_input.trader_key,
      score_input.board_rank,
      score_input.roi_pct,
      score_input.pnl_usd,
      score_input.win_rate,
      score_input.max_drawdown,
      score_input.copiers,
      score_input.trades_count,
      score_input.sharpe_ratio,
      score_input.sortino_ratio,
      score_input.calmar_ratio,
      score_input.volatility_pct,
      score_input.trader_kind,
      score_input.handle,
      score_input.avatar_url,
      score_input.currency,
      score_input.as_of,
      board_watermark.board_as_of
    FROM arena.score_inputs AS score_input
    LEFT JOIN alias_board_watermarks AS board_watermark
      ON board_watermark.platform = score_input.platform
    WHERE score_input."window" = p_window
      AND (
        score_input.board_rank IS NULL
        OR score_input.board_rank <= p_per_platform_limit
      )
      AND score_input.as_of > pg_catalog.now()
        - pg_catalog.make_interval(hours => p_max_age_hours)
  ) AS payload_row;
$function$;

-- CREATE OR REPLACE preserves the function OID and owner. Reassert the only
-- supported execution boundary explicitly in case a prior live grant drifted.
REVOKE ALL
  ON FUNCTION public.arena_score_inputs_json(text, int, int)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE
  ON FUNCTION public.arena_score_inputs_json(text, int, int)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
