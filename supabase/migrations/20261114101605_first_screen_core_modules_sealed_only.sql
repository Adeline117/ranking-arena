-- Profile snapshot readers: sealed boards only, no stale stats.
--
-- 20261113012028 bound arena_weekly_leaders / arena_exchange_rankings to the
-- currently served sealed publication, but left two anon readers open:
--   * arena_first_screen returned any count-check-passed board of the last
--     48h, so a source the sealed leaderboard isolates or refuses (or one
--     never sealed at all) still showed rank/ROI/PnL on the profile, and a
--     board newer than the sealed watermark showed numbers the public
--     leaderboard does not serve;
--   * arena_core_modules only flagged stats older than 48h ('stale') and the
--     reader (lib/data/serving/core.ts) ignored the flag.
--
-- Now (marker public-snapshot-reader-sealed-profile@1):
--   * arena_first_screen entries come only from a board whose source is part
--     of that timeframe's currently served sealed season
--     (arena.public_sealed_rank_sources(), the same authority the two
--     leaderboard readers use) and that is no newer than the sealed source
--     watermark. Identity fields are unchanged.
--   * arena_core_modules returns NULL (cold) when the stats row is older than
--     48h or has no as_of; trader_stats.as_of no longer freezes (3a8d02667),
--     so a stale row really means the trader was not crawled for 48h.
-- Signatures, return types, owner, SECURITY DEFINER, search_path and grants
-- are unchanged; the Bitget-bot quarantine predicates are preserved verbatim.
--
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
BEGIN
  IF pg_catalog.to_regprocedure('arena.public_sealed_rank_sources()') IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.oid = pg_catalog.to_regprocedure('public.arena_first_screen(text,text)')
         AND pg_catalog.strpos(
           function_row.prosrc, 'public-snapshot-reader-sealed-freshness@1'
         ) > 0
     ) THEN
    RAISE EXCEPTION 'sealed profile readers require 20261113012028';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.arena_first_screen(
  p_source text,
  p_trader text
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT pg_catalog.jsonb_build_object(
    'source', source_row.slug,
    'exchangeTraderId', trader.exchange_trader_id,
    'nickname', trader.nickname,
    'avatarMirrorUrl', trader.avatar_url_mirror,
    'avatarOriginUrl', trader.avatar_url_origin,
    'walletAddress', trader.wallet_address,
    'traderKind', trader.trader_kind,
    'botStrategy', trader.bot_strategy,
    'currency', source_row.currency,
    'entries', COALESCE((
      SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'timeframe', entry.timeframe,
          'rank', entry.rank,
          'headlineRoi', LEAST(
            10000,
            GREATEST(-10000, entry.headline_roi)
          ),
          'headlinePnl', entry.headline_pnl,
          'headlineWinRate', CASE
            WHEN entry.headline_win_rate >= 0
             AND entry.headline_win_rate <= 100
            THEN entry.headline_win_rate
          END,
          'currency', entry.currency,
          'extras', COALESCE(entry.raw, '{}'::pg_catalog.jsonb),
          'asOf', entry.scraped_at
        )
        ORDER BY entry.timeframe
      )
      FROM (
        SELECT DISTINCT ON (candidate.timeframe) candidate.*
        FROM arena.leaderboard_entries AS candidate
        JOIN arena.leaderboard_snapshots AS snapshot
          ON snapshot.id = candidate.snapshot_id
        -- public-snapshot-reader-sealed-profile@1
        JOIN arena.public_sealed_rank_sources() AS sealed
          ON sealed.season_id = candidate.timeframe::text || 'D'
         AND sealed.filter_source = COALESCE(
           NULLIF(pg_catalog.btrim(source_row.meta->>'legacy_platform'), ''),
           source_row.slug
         )
        WHERE candidate.trader_id = trader.id
          AND snapshot.count_check_passed
          AND snapshot.actual_count > 0
          AND snapshot.scraped_at <= sealed.source_as_of
          AND snapshot.scraped_at > pg_catalog.statement_timestamp() - interval '48 hours'
          -- bitget-bot-cumulative-public-reader-quarantine@1
          AND NOT (
            source_row.slug = ANY (
              ARRAY[
                'bitget_bots_futures',
                'bitget_bots_spot'
              ]::pg_catalog.text[]
            )
            OR source_row.adapter_slug = 'bitget_bots'
          )
        ORDER BY candidate.timeframe, candidate.scraped_at DESC
      ) AS entry
    ), '[]'::pg_catalog.jsonb)
  )
  FROM arena.traders AS trader
  JOIN arena.sources AS source_row
    ON source_row.id = trader.source_id
  WHERE source_row.slug = p_source
    AND trader.exchange_trader_id = p_trader;
$function$;

CREATE OR REPLACE FUNCTION public.arena_core_modules(
  p_source text,
  p_trader text,
  p_timeframe integer
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  WITH resolved AS (
    SELECT
      stats.*,
      (
        source_row.slug = ANY (
          ARRAY[
            'bitget_bots_futures',
            'bitget_bots_spot'
          ]::pg_catalog.text[]
        )
        OR source_row.adapter_slug = 'bitget_bots'
      ) AS is_bitget_bot,
      (
        NOT (
          source_row.slug = ANY (
            ARRAY[
              'bitget_bots_futures',
              'bitget_bots_spot'
            ]::pg_catalog.text[]
          )
          OR source_row.adapter_slug = 'bitget_bots'
        )
        OR stats.timeframe = 0
        OR CASE
          WHEN pg_catalog.jsonb_typeof(
            stats.extras -> '_arena_profile_publication_epoch_ms'
          ) = 'number'
          THEN (
            stats.extras ->> '_arena_profile_publication_epoch_ms'
          )::pg_catalog.numeric >= 0
          ELSE false
        END
      ) AS window_metrics_public
    FROM arena.traders AS trader
    JOIN arena.sources AS source_row
      ON source_row.id = trader.source_id
    JOIN arena.trader_stats AS stats
      ON stats.trader_id = trader.id
     AND stats.timeframe = p_timeframe
    WHERE source_row.slug = p_source
      AND trader.exchange_trader_id = p_trader
      -- public-snapshot-reader-sealed-profile@1
      AND stats.as_of > pg_catalog.statement_timestamp() - interval '48 hours'
  )
  SELECT pg_catalog.jsonb_build_object(
    'timeframe', resolved.timeframe,
    'asOf', resolved.as_of,
    'currency', resolved.currency,
    'stats', pg_catalog.jsonb_strip_nulls(
      pg_catalog.jsonb_build_object(
        -- bitget-bot-cumulative-public-reader-quarantine@1
        'roi', CASE
          WHEN NOT resolved.window_metrics_public OR resolved.roi IS NULL THEN NULL
          ELSE LEAST(
            10000,
            GREATEST(-10000, resolved.roi)
          )
        END,
        'pnl', CASE
          WHEN resolved.window_metrics_public THEN resolved.pnl
        END,
        'sharpe', CASE
          WHEN resolved.window_metrics_public THEN resolved.sharpe
        END,
        'mdd', CASE
          WHEN resolved.mdd >= 0
           AND resolved.mdd <= 100
           AND (
             resolved.window_metrics_public
             OR (resolved.is_bitget_bot AND resolved.timeframe = 30)
           )
          THEN resolved.mdd
        END,
        'win_rate', CASE
          WHEN resolved.window_metrics_public
           AND resolved.win_rate >= 0
           AND resolved.win_rate <= 100
          THEN resolved.win_rate
        END,
        'win_positions', CASE
          WHEN resolved.window_metrics_public THEN resolved.win_positions
        END,
        'total_positions', CASE
          WHEN resolved.window_metrics_public THEN resolved.total_positions
        END,
        'copier_pnl', CASE
          WHEN resolved.window_metrics_public THEN resolved.copier_pnl
        END,
        'copier_count', CASE
          WHEN resolved.window_metrics_public THEN resolved.copier_count
        END,
        'aum', CASE
          WHEN resolved.window_metrics_public THEN resolved.aum
        END,
        'volume', CASE
          WHEN resolved.window_metrics_public THEN resolved.volume
        END,
        'profit_share_rate', CASE
          WHEN resolved.window_metrics_public THEN resolved.profit_share_rate
        END,
        'holding_duration_avg', CASE
          WHEN resolved.window_metrics_public
           AND resolved.holding_duration_avg IS NOT NULL
          THEN pg_catalog.date_part(
            'epoch', resolved.holding_duration_avg
          ) / 3600
        END,
        'trading_preferences', CASE
          WHEN resolved.window_metrics_public
          THEN resolved.trading_preferences
        END
      )
    ),
    'extras', CASE
      WHEN resolved.window_metrics_public THEN resolved.extras
      ELSE '{}'::pg_catalog.jsonb
    END,
    'series', CASE
      WHEN NOT resolved.window_metrics_public THEN '{}'::pg_catalog.jsonb
      ELSE COALESCE((
        SELECT pg_catalog.jsonb_object_agg(series_by_metric.metric, series_by_metric.points)
        FROM (
          SELECT
            recent.metric,
            pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'ts', recent.ts,
                'value', recent.value
              )
              ORDER BY recent.ts
            ) AS points
          FROM (
            SELECT series.metric, series.ts, series.value
            FROM arena.trader_series AS series
            WHERE series.trader_id = resolved.trader_id
              AND series.timeframe = resolved.timeframe
            ORDER BY series.ts DESC
            LIMIT 1000
          ) AS recent
          GROUP BY recent.metric
        ) AS series_by_metric
      ), '{}'::pg_catalog.jsonb)
    END
  )
  FROM resolved;
$function$;

ALTER FUNCTION public.arena_first_screen(text, text) OWNER TO postgres;
ALTER FUNCTION public.arena_core_modules(text, text, integer) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.arena_first_screen(text, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.arena_core_modules(text, text, integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.arena_first_screen(text, text)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.arena_core_modules(text, text, integer)
  TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
