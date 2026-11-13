-- Public snapshot readers: serve only sealed, fresh rank evidence.
--
-- public.arena_weekly_leaders / arena_exchange_rankings / arena_first_screen /
-- arena_core_modules (last defined by 20261111134416) are anon-callable
-- SECURITY DEFINER readers that project straight from arena snapshots. They
-- bypassed the sealed public publication entirely: the "latest" board was the
-- newest count-check-passed snapshot with NO time bound (an August board is
-- still "latest" today), a 0-row board could become latest, and a source the
-- sealed leaderboard refuses or isolates was still ranked here.
--
-- Now (marker public-snapshot-reader-sealed-freshness@1):
--   * arena_weekly_leaders (7D) and arena_exchange_rankings (7/30/90D) read a
--     source only while it is part of the season's CURRENTLY SERVED sealed
--     publication (arena.public_sealed_rank_sources(): serving head valid now,
--     witness of that head's cohort), and only a non-empty passed board that
--     is no newer than the sealed watermark and no older than 48h.
--   * arena_first_screen (profile rank entries) shows only non-empty passed
--     boards from the last 48h (profiles also cover non-ranked sources, so no
--     sealed-source requirement here).
--   * arena_core_modules (stats) is unchanged except for an additive 'stale'
--     flag (as_of NULL or older than 48h). Hard-filtering stats needs the
--     trader_stats as_of freeze fix first, or most profiles would blank.
-- Signatures, return types, owner, SECURITY DEFINER, search_path and grants
-- are unchanged; the Bitget-bot quarantine predicates are preserved verbatim.
--
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
DECLARE
  v_signature text;
BEGIN
  IF pg_catalog.to_regclass('arena.public_ranked_leaderboard_serving_heads') IS NULL
     OR pg_catalog.to_regclass('arena.public_ranked_leaderboard_serving_sources') IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.public_ranked_leaderboard_serving_seasons(timestamptz)'
     ) IS NULL THEN
    RAISE EXCEPTION 'sealed snapshot readers require the public serving authority (20260816184500)';
  END IF;
  FOREACH v_signature IN ARRAY ARRAY[
    'public.arena_weekly_leaders(integer)',
    'public.arena_exchange_rankings(integer)',
    'public.arena_first_screen(text,text)',
    'public.arena_core_modules(text,text,integer)'
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = pg_catalog.to_regprocedure(v_signature)
        AND pg_catalog.strpos(
          function_row.prosrc, 'bitget-bot-cumulative-public-reader-quarantine@1'
        ) > 0
    ) THEN
      RAISE EXCEPTION
        '% must already carry the Bitget-bot public reader quarantine (20261111134416)',
        v_signature;
    END IF;
  END LOOP;
END
$preflight$;

-- Sources of each season's currently served sealed publication, with the
-- sealed source watermark. Owner-only: called from the definer readers.
CREATE OR REPLACE FUNCTION arena.public_sealed_rank_sources()
RETURNS TABLE (season_id text, filter_source text, source_as_of timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT witness.season_id, witness.source, witness.source_as_of
  FROM arena.public_ranked_leaderboard_serving_seasons(
    pg_catalog.statement_timestamp()
  ) AS serving
  JOIN ONLY arena.public_ranked_leaderboard_serving_heads AS head
    ON head.season_id = serving.season_id
  JOIN ONLY arena.public_ranked_leaderboard_serving_sources AS witness
    ON witness.season_id = head.season_id
   AND witness.score_cohort_id = head.score_cohort_id;
$function$;

ALTER FUNCTION arena.public_sealed_rank_sources() OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.public_sealed_rank_sources()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION arena.public_sealed_rank_sources() TO service_role;

CREATE OR REPLACE FUNCTION public.arena_weekly_leaders(
  p_limit integer DEFAULT 25
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  WITH sealed AS MATERIALIZED (
    SELECT sealed_source.filter_source, sealed_source.source_as_of
    FROM arena.public_sealed_rank_sources() AS sealed_source
    WHERE sealed_source.season_id = '7D'
  ),
  latest AS (
    SELECT DISTINCT ON (snapshot.source_id)
      snapshot.id,
      snapshot.source_id,
      snapshot.scraped_at
    FROM arena.leaderboard_snapshots AS snapshot
    JOIN arena.sources AS source_row
      ON source_row.id = snapshot.source_id
    -- public-snapshot-reader-sealed-freshness@1
    JOIN sealed
      ON sealed.filter_source = COALESCE(
        NULLIF(pg_catalog.btrim(source_row.meta->>'legacy_platform'), ''),
        source_row.slug
      )
    WHERE snapshot.timeframe = 7
      AND snapshot.count_check_passed
      AND snapshot.actual_count > 0
      AND snapshot.scraped_at <= sealed.source_as_of
      AND snapshot.scraped_at > pg_catalog.statement_timestamp() - interval '48 hours'
      AND source_row.serving_mode <> 'legacy'
      AND source_row.status = 'active'
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
    ORDER BY snapshot.source_id, snapshot.scraped_at DESC
  ),
  pooled AS (
    SELECT
      entry.headline_roi,
      entry.headline_pnl,
      entry.headline_win_rate,
      entry.rank,
      COALESCE(entry.currency, source_row.currency) AS currency,
      latest.scraped_at AS as_of,
      trader.exchange_trader_id,
      trader.nickname,
      trader.trader_kind,
      trader.avatar_url_mirror,
      trader.avatar_url_origin,
      source_row.slug AS source,
      source_row.product_type,
      exchange_row.slug AS exchange_slug,
      exchange_row.name AS exchange_name,
      (7 = ANY(source_row.timeframes_derived)) AS derived
    FROM latest
    JOIN arena.leaderboard_entries AS entry
      ON entry.snapshot_id = latest.id
    JOIN arena.traders AS trader
      ON trader.id = entry.trader_id
    JOIN arena.sources AS source_row
      ON source_row.id = latest.source_id
    JOIN arena.exchanges AS exchange_row
      ON exchange_row.id = source_row.exchange_id
    WHERE entry.headline_roi IS NOT NULL
    ORDER BY entry.headline_roi DESC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100)
  )
  SELECT pg_catalog.jsonb_build_object(
    'nonLegacyCount', (
      SELECT pg_catalog.count(*)
      FROM arena.sources AS source_row
      WHERE source_row.serving_mode <> 'legacy'
        AND source_row.status = 'active'
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
    ),
    'rows', COALESCE((
      SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'source', source,
          'exchangeSlug', exchange_slug,
          'exchangeName', exchange_name,
          'productType', product_type,
          'exchangeTraderId', exchange_trader_id,
          'nickname', nickname,
          'traderKind', trader_kind,
          'avatarMirrorUrl', avatar_url_mirror,
          'avatarOriginUrl', avatar_url_origin,
          'sourceRank', rank,
          'roi', headline_roi,
          'pnl', CASE
            WHEN headline_pnl IS NULL THEN NULL
            ELSE pg_catalog.jsonb_build_object(
              'value', headline_pnl,
              'currency', currency
            )
          END,
          'winRate', headline_win_rate,
          'derived', derived,
          'asOf', as_of
        )
        ORDER BY headline_roi DESC
      )
      FROM pooled
    ), '[]'::pg_catalog.jsonb),
    'bitmartWeekly', (
      SELECT source_row.meta->'weekly_arena_latest'
      FROM arena.sources AS source_row
      WHERE source_row.slug = 'bitmart_futures'
        AND (source_row.meta->>'weekly_arena_surface')::boolean IS TRUE
    )
  );
$function$;

CREATE OR REPLACE FUNCTION public.arena_exchange_rankings(
  p_timeframe integer
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT pg_catalog.jsonb_build_object(
    'nonLegacyCount', (
      SELECT pg_catalog.count(*)
      FROM arena.sources AS source_count
      WHERE source_count.serving_mode <> 'legacy'
        AND source_count.status = 'active'
        -- bitget-bot-cumulative-public-reader-quarantine@1
        AND NOT (
          source_count.slug = ANY (
            ARRAY[
              'bitget_bots_futures',
              'bitget_bots_spot'
            ]::pg_catalog.text[]
          )
          OR source_count.adapter_slug = 'bitget_bots'
        )
    ),
    'timeframe', p_timeframe,
    'rows', CASE
      WHEN p_timeframe NOT IN (7, 30, 90) THEN '[]'::pg_catalog.jsonb
      ELSE COALESCE((
        SELECT pg_catalog.jsonb_agg(
          source_projection.row_object
          ORDER BY source_projection.ranked_traders DESC
        )
        FROM (
          SELECT
            pg_catalog.jsonb_build_object(
              'source', source_row.slug,
              'exchangeSlug', exchange_row.slug,
              'exchangeName', exchange_row.name,
              'productType', source_row.product_type,
              'currency', source_row.currency,
              'derived', p_timeframe = ANY(source_row.timeframes_derived),
              'asOf', aggregate_row.as_of,
              'rankedTraders', aggregate_row.ranked_traders,
              'medianRoi', aggregate_row.median_roi,
              'topDecileRoi', aggregate_row.top_decile_roi,
              'pctProfitable', aggregate_row.pct_profitable,
              'copierPnl', CASE
                WHEN aggregate_row.copier_pnl IS NULL THEN NULL
                ELSE pg_catalog.jsonb_build_object(
                  'value', aggregate_row.copier_pnl,
                  'currency', source_row.currency
                )
              END,
              'botShare', aggregate_row.bot_share
            ) AS row_object,
            aggregate_row.ranked_traders
          FROM arena.sources AS source_row
          JOIN arena.exchanges AS exchange_row
            ON exchange_row.id = source_row.exchange_id
          CROSS JOIN LATERAL (
            SELECT
              latest.scraped_at AS as_of,
              pg_catalog.count(*) AS ranked_traders,
              pg_catalog.percentile_cont(0.5) WITHIN GROUP (
                ORDER BY entry.headline_roi
              ) FILTER (
                WHERE entry.headline_roi IS NOT NULL
              ) AS median_roi,
              pg_catalog.percentile_cont(0.9) WITHIN GROUP (
                ORDER BY entry.headline_roi
              ) FILTER (
                WHERE entry.headline_roi IS NOT NULL
              ) AS top_decile_roi,
              CASE
                WHEN pg_catalog.count(entry.headline_roi) = 0 THEN NULL
                ELSE pg_catalog.round(
                  100.0 * pg_catalog.count(*) FILTER (
                    WHERE entry.headline_roi > 0
                  ) / pg_catalog.count(entry.headline_roi),
                  1
                )
              END AS pct_profitable,
              pg_catalog.sum(stats.copier_pnl) AS copier_pnl,
              pg_catalog.round(
                100.0 * pg_catalog.count(*) FILTER (
                  WHERE trader.trader_kind = 'bot'
                ) / pg_catalog.count(*),
                1
              ) AS bot_share
            FROM (
              SELECT snapshot.id, snapshot.scraped_at
              FROM arena.leaderboard_snapshots AS snapshot
              -- public-snapshot-reader-sealed-freshness@1
              JOIN arena.public_sealed_rank_sources() AS sealed
                ON sealed.season_id = (p_timeframe::text || 'D')
               AND sealed.filter_source = COALESCE(
                 NULLIF(pg_catalog.btrim(source_row.meta->>'legacy_platform'), ''),
                 source_row.slug
               )
              WHERE snapshot.source_id = source_row.id
                AND snapshot.timeframe = p_timeframe
                AND snapshot.count_check_passed
                AND snapshot.actual_count > 0
                AND snapshot.scraped_at <= sealed.source_as_of
                AND snapshot.scraped_at > pg_catalog.statement_timestamp() - interval '48 hours'
              ORDER BY snapshot.scraped_at DESC
              LIMIT 1
            ) AS latest
            JOIN arena.leaderboard_entries AS entry
              ON entry.snapshot_id = latest.id
            JOIN arena.traders AS trader
              ON trader.id = entry.trader_id
            LEFT JOIN arena.trader_stats AS stats
              ON stats.trader_id = trader.id
             AND stats.timeframe = p_timeframe
            GROUP BY latest.scraped_at
          ) AS aggregate_row
          WHERE source_row.serving_mode <> 'legacy'
            AND source_row.status = 'active'
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
        ) AS source_projection
      ), '[]'::pg_catalog.jsonb)
    END
  );
$function$;

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
        WHERE candidate.trader_id = trader.id
          AND snapshot.count_check_passed
          -- public-snapshot-reader-sealed-freshness@1
          AND snapshot.actual_count > 0
          AND snapshot.scraped_at > pg_catalog.statement_timestamp() - interval '48 hours'
          AND snapshot.scraped_at <= pg_catalog.statement_timestamp() + interval '5 minutes'
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
  )
  SELECT pg_catalog.jsonb_build_object(
    'timeframe', resolved.timeframe,
    'asOf', resolved.as_of,
    -- public-snapshot-reader-sealed-freshness@1
    'stale', resolved.as_of IS NULL
      OR resolved.as_of <= pg_catalog.statement_timestamp() - interval '48 hours',
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

ALTER FUNCTION public.arena_weekly_leaders(integer) OWNER TO postgres;
ALTER FUNCTION public.arena_exchange_rankings(integer) OWNER TO postgres;
ALTER FUNCTION public.arena_first_screen(text, text) OWNER TO postgres;
ALTER FUNCTION public.arena_core_modules(text, text, integer) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.arena_weekly_leaders(integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.arena_exchange_rankings(integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.arena_first_screen(text, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.arena_core_modules(text, text, integer)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.arena_weekly_leaders(integer)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.arena_exchange_rankings(integer)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.arena_first_screen(text, text)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.arena_core_modules(text, text, integer)
  TO anon, authenticated, service_role;

DO $postflight$
DECLARE
  v_contract record;
  v_function_row pg_catalog.pg_proc%ROWTYPE;
BEGIN
  FOR v_contract IN
    SELECT *
    FROM (VALUES
      ('public.arena_weekly_leaders(integer)', 2),
      ('public.arena_exchange_rankings(integer)', 2),
      ('public.arena_first_screen(text,text)', 1),
      ('public.arena_core_modules(text,text,integer)', 1)
    ) AS contract(signature, bitget_markers)
  LOOP
    SELECT function_row.*
    INTO STRICT v_function_row
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = pg_catalog.to_regprocedure(v_contract.signature);

    IF (pg_catalog.length(v_function_row.prosrc) - pg_catalog.length(pg_catalog.replace(
          v_function_row.prosrc, 'public-snapshot-reader-sealed-freshness@1', '')))
         / pg_catalog.length('public-snapshot-reader-sealed-freshness@1') <> 1
       OR (pg_catalog.length(v_function_row.prosrc) - pg_catalog.length(pg_catalog.replace(
          v_function_row.prosrc, 'bitget-bot-cumulative-public-reader-quarantine@1', '')))
         / pg_catalog.length('bitget-bot-cumulative-public-reader-quarantine@1')
         <> v_contract.bitget_markers
       OR v_function_row.proowner <> 'postgres'::pg_catalog.regrole
       OR NOT v_function_row.prosecdef
       OR v_function_row.provolatile <> 's'
       OR v_function_row.proconfig IS DISTINCT FROM
            ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
       OR NOT pg_catalog.has_function_privilege('anon', v_function_row.oid, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('authenticated', v_function_row.oid, 'EXECUTE')
    THEN
      RAISE EXCEPTION 'sealed snapshot reader postflight failed in %', v_contract.signature;
    END IF;
  END LOOP;

  IF pg_catalog.has_function_privilege('anon', 'arena.public_sealed_rank_sources()', 'EXECUTE')
     OR pg_catalog.has_function_privilege(
       'authenticated', 'arena.public_sealed_rank_sources()', 'EXECUTE') THEN
    RAISE EXCEPTION 'arena.public_sealed_rank_sources must stay owner/service only';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
