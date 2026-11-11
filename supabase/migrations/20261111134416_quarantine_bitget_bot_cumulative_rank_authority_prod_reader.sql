-- Forward replacement for
-- 20260728124000_quarantine_bitget_bot_cumulative_rank_authority.sql (never
-- applied to production). The body is identical except that the public-reader
-- preflight also accepts production's legacy public.arena_weekly_leaders(integer)
-- source digest 2aa0c4fe...6eaf. That body (2026-10-30 production backup)
-- differs from the reviewed 20260611215532 body (digest 7404871e...011c) only by
-- two removed comment lines and one trailing blank line; its SQL is identical.
-- The quarantined replacement body written below is unchanged. Apply it in the
-- original's launch slot; the original is superseded.
--
-- Migration: 20260728124000_quarantine_bitget_bot_cumulative_rank_authority.sql
-- Created: 2026-07-28T12:40:00Z
-- Description: Bitget bot-board profitRate/profitAmount are cumulative since
--   strategy inception, not 30D observations. Keep the canonical 30D board
--   available to bot/profile readers, but quarantine it from every public-rank
--   authority until composite capture and an explicit cumulative ranking
--   product contract are reviewed. Remove already-materialized public ranks and
--   reject delayed/legacy writers that try to restore them. Retire direct
--   PostgREST access to ranking substrate, scrub mislabeled serving values, and
--   make bot profile metrics RPC-only behind a canonical profile provenance gate.

BEGIN;

SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '2min';
SET LOCAL TIME ZONE 'UTC';

-- Freeze both registry relations before REPEATABLE READ takes its first source
-- snapshot. SHARE is compatible with publication's registry reads while no
-- concurrent INSERT/UPDATE/DELETE can commit an invisible identity drift.
LOCK TABLE arena.sources, arena.exchanges IN SHARE MODE;

DO $preflight$
DECLARE
  v_exact_sources integer;
  v_function oid;
BEGIN
  IF pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.exchanges') IS NULL
     OR pg_catalog.to_regclass('arena.traders') IS NULL
     OR pg_catalog.to_regclass('arena.bots') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_snapshots') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_entries') IS NULL
     OR pg_catalog.to_regclass('arena.trader_stats') IS NULL
     OR pg_catalog.to_regclass('arena.score_inputs') IS NULL
     OR pg_catalog.to_regclass('public.leaderboard_ranks') IS NULL
     OR pg_catalog.to_regclass('public.leaderboard_source_freshness') IS NULL
     OR pg_catalog.to_regclass('public.leaderboard_count_cache') IS NULL THEN
    RAISE EXCEPTION
      'Bitget cumulative rank quarantine requires source and public-rank foundations';
  END IF;

  IF pg_catalog.to_regprocedure(
       'public.arena_score_inputs_json(text,integer,integer)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.arena_score_inputs_publish_bundle_json(text,integer,integer)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.arena_freshness_expected_sources()'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.refresh_leaderboard_count_cache()'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'arena.leaderboard_rank_row_is_public_eligible(public.leaderboard_ranks,timestamptz)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.arena_weekly_leaders(integer)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.arena_exchange_rankings(integer)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.arena_first_screen(text,text)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.arena_core_modules(text,text,integer)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.arena_score_inputs(text,integer,integer)'
     ) IS NULL THEN
    RAISE EXCEPTION
      'Bitget cumulative rank quarantine requires score, publication, authority, eligibility, cache, and public reader functions';
  END IF;

  IF pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL THEN
    RAISE EXCEPTION 'Bitget cumulative rank quarantine requires Supabase runtime roles';
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO STRICT v_exact_sources
  FROM (
    VALUES
      (
        'bitget_bots_futures'::text,
        'futures'::text,
        '["futures_grid", "futures_martingale"]'::jsonb
      ),
      (
        'bitget_bots_spot'::text,
        'spot'::text,
        '["spot_grid", "spot_martingale"]'::jsonb
      )
  ) AS target(slug, product_type, boards)
  JOIN arena.sources AS source
    ON source.slug = target.slug
   AND source.product_type = target.product_type
  JOIN arena.exchanges AS exchange
    ON exchange.id = source.exchange_id
  WHERE exchange.slug = 'bitget'
    AND source.adapter_slug = 'bitget_bots'
    AND source.trader_kind_scope = 'bot'
    AND source.status = 'active'
    AND source.serving_mode = 'serving'
    AND source.currency = 'USDT'
    AND source.timeframes_native = ARRAY[30]::integer[]
    AND source.timeframes_derived = ARRAY[]::integer[]
    AND source.page_size = 20
    AND source.pagination_kind = 'numeric'
    AND source.meta->'boards' = target.boards
    AND COALESCE(
      NULLIF(pg_catalog.btrim(source.meta->>'legacy_platform'), ''),
      source.slug
    ) = source.slug;

  IF v_exact_sources <> 2 THEN
    RAISE EXCEPTION
      'Bitget cumulative rank quarantine requires two exact active serving canonical bot sources, found %',
      v_exact_sources;
  END IF;

  -- A new active source under the same adapter is rank-ineligible by default,
  -- but its product semantics still need an explicit reviewed migration.
  IF EXISTS (
    SELECT 1
    FROM arena.sources AS source
    WHERE source.status = 'active'
      AND source.adapter_slug = 'bitget_bots'
      AND source.slug <> ALL (
        ARRAY[
          'bitget_bots_futures',
          'bitget_bots_spot'
        ]::pg_catalog.text[]
      )
  ) THEN
    RAISE EXCEPTION
      'unexpected active Bitget bot source requires an explicit rank-authority review';
  END IF;

  FOR v_function IN
    SELECT requested.function_oid
    FROM (
      VALUES
        (
          'public.arena_score_inputs_json(text,integer,integer)'
            ::pg_catalog.regprocedure::oid,
          'sql'::text,
          false,
          false
        ),
        (
          'public.arena_score_inputs_publish_bundle_json(text,integer,integer)'
            ::pg_catalog.regprocedure::oid,
          'plpgsql'::text,
          false,
          false
        ),
        (
          'public.arena_freshness_expected_sources()'
            ::pg_catalog.regprocedure::oid,
          'sql'::text,
          true,
          true
        )
    ) AS requested(
      function_oid,
      language_name,
      returns_set,
      accepts_legacy_search_path
    )
    JOIN pg_catalog.pg_proc AS function_row
      ON function_row.oid = requested.function_oid
    JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.prokind = 'f'
      AND function_row.proowner = 'postgres'::pg_catalog.regrole
      AND function_row.prosecdef
      AND function_row.provolatile = 's'
      AND function_row.proretset = requested.returns_set
      AND language_row.lanname = requested.language_name
      AND (
        function_row.proconfig =
          ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
        OR (
          requested.accepts_legacy_search_path
          AND function_row.proconfig =
            ARRAY[
              'search_path=public, arena, pg_temp'
            ]::pg_catalog.text[]
        )
      )
  LOOP
    IF NOT pg_catalog.has_function_privilege(
         'service_role', v_function, 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege('anon', v_function, 'EXECUTE')
       OR pg_catalog.has_function_privilege(
         'authenticated', v_function, 'EXECUTE'
       ) THEN
      RAISE EXCEPTION
        'rank-authority function execution boundary drifted: %',
        v_function::pg_catalog.regprocedure;
    END IF;
  END LOOP;

  IF (
    SELECT pg_catalog.count(*)
    FROM (
      VALUES
        (
          'public.arena_score_inputs_json(text,integer,integer)'
            ::pg_catalog.regprocedure::oid,
          'sql'::text,
          false,
          false
        ),
        (
          'public.arena_score_inputs_publish_bundle_json(text,integer,integer)'
            ::pg_catalog.regprocedure::oid,
          'plpgsql'::text,
          false,
          false
        ),
        (
          'public.arena_freshness_expected_sources()'
            ::pg_catalog.regprocedure::oid,
          'sql'::text,
          true,
          true
        )
    ) AS required(
      function_oid,
      language_name,
      returns_set,
      accepts_legacy_search_path
    )
    JOIN pg_catalog.pg_proc AS function_row
      ON function_row.oid = required.function_oid
    JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.prokind = 'f'
      AND function_row.proowner = 'postgres'::pg_catalog.regrole
      AND function_row.prosecdef
      AND function_row.provolatile = 's'
      AND function_row.proretset = required.returns_set
      AND language_row.lanname = required.language_name
      AND (
        function_row.proconfig =
          ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
        OR (
          required.accepts_legacy_search_path
          AND function_row.proconfig =
            ARRAY[
              'search_path=public, arena, pg_temp'
            ]::pg_catalog.text[]
        )
      )
  ) <> 3 THEN
    RAISE EXCEPTION 'rank-authority function catalog contract drifted';
  END IF;

  v_function := pg_catalog.to_regprocedure(
    'arena.leaderboard_rank_row_is_public_eligible(public.leaderboard_ranks,timestamptz)'
  );
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.oid = v_function
      AND function_row.prokind = 'f'
      AND function_row.proowner = 'postgres'::pg_catalog.regrole
      AND NOT function_row.prosecdef
      AND function_row.provolatile = 'i'
      AND function_row.proparallel = 's'
      AND NOT function_row.proretset
      AND function_row.prorettype = 'pg_catalog.bool'::pg_catalog.regtype
      AND language_row.lanname = 'sql'
      AND function_row.proconfig =
        ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
      AND pg_catalog.encode(
            pg_catalog.sha256(
              pg_catalog.convert_to(function_row.prosrc, 'UTF8')
            ),
            'hex'
          ) = 'aa87e8343569cccdeeea84bee66fbf9cd20b8b75e39b1a6d63e78f110e4bf0df'
  )
  OR pg_catalog.has_function_privilege('anon', v_function, 'EXECUTE')
  OR pg_catalog.has_function_privilege(
       'authenticated', v_function, 'EXECUTE'
     )
  OR pg_catalog.has_function_privilege(
       'service_role', v_function, 'EXECUTE'
     )
  OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS privilege
    WHERE function_row.oid = v_function
      AND privilege.privilege_type = 'EXECUTE'
      AND privilege.grantee <> function_row.proowner
  ) THEN
    RAISE EXCEPTION 'leaderboard rank row eligibility contract drifted';
  END IF;
END
$preflight$;

DO $public_reader_preflight$
DECLARE
  v_target record;
  v_function oid;
  v_function_row pg_catalog.pg_proc%ROWTYPE;
  v_language text;
  v_source_sha256 text;
BEGIN
  FOR v_target IN
    SELECT *
    FROM (
      VALUES
        (
          'public.arena_weekly_leaders(integer)'::text,
          ARRAY['p_limit']::text[],
          1::smallint,
          '7404871e31d0cbc75d15d1dfad3ea2d71b3396e1c81910eab597988d73e0011c'::text,
          '82c7ae19c58882cc84fb15afcc1a1f8e971190e3aba0efae07f374373a4c5957'::text,
          2::integer
        ),
        (
          'public.arena_exchange_rankings(integer)'::text,
          ARRAY['p_timeframe']::text[],
          0::smallint,
          '2ae528a8c0e8ddbe3ce78b689a9c0d1ec2b6bd7fa841bba8855aa8367295cba8'::text,
          '6aca4293e2652d71fbb2fa58804f0091ea2a92c10f428b20d4e10a1412a14aa1'::text,
          2::integer
        ),
        (
          'public.arena_first_screen(text,text)'::text,
          ARRAY['p_source', 'p_trader']::text[],
          0::smallint,
          '9d6d7c3ab93ec25c3f0860df02549169cb1ebefa08ca8e001b1e636cbe1f1323'::text,
          '7e923b64c6b369a652f5806aa281a0146fdba50c6de5c5b113e78b7c2cbf0ea0'::text,
          1::integer
        ),
        (
          'public.arena_core_modules(text,text,integer)'::text,
          ARRAY['p_source', 'p_trader', 'p_timeframe']::text[],
          0::smallint,
          '17e93c1b96a0b81ae2698ec767c670a3fca7f255eb6e3785c63b8111ad4c9db5'::text,
          'caef116ff47e4b74bff0b8508717c2943f4a7a0beb5ba996d0793d46c18911fc'::text,
          1::integer
        )
    ) AS target(
      signature,
      expected_arg_names,
      expected_default_count,
      legacy_source_sha256,
      quarantined_source_sha256,
      expected_marker_count
    )
    ORDER BY target.signature
  LOOP
    v_function := pg_catalog.to_regprocedure(v_target.signature);
    SELECT function_row.*
    INTO STRICT v_function_row
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function;
    SELECT language_row.lanname
    INTO STRICT v_language
    FROM pg_catalog.pg_language AS language_row
    WHERE language_row.oid = v_function_row.prolang;

    v_source_sha256 := pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(v_function_row.prosrc, 'UTF8')
      ),
      'hex'
    );

    IF v_function_row.prokind <> 'f'
       OR v_function_row.proowner <> 'postgres'::pg_catalog.regrole
       OR NOT v_function_row.prosecdef
       OR v_function_row.provolatile <> 's'
       OR v_function_row.proparallel <> 'u'
       OR v_function_row.proretset
       OR v_function_row.prorettype <>
            'pg_catalog.jsonb'::pg_catalog.regtype
       OR v_function_row.proisstrict
       OR v_function_row.proleakproof
       OR v_language <> 'sql'
       OR v_function_row.proargnames IS DISTINCT FROM
            v_target.expected_arg_names
       OR v_function_row.pronargdefaults <>
            v_target.expected_default_count
       OR NOT (
         (
           (
             v_source_sha256 = v_target.legacy_source_sha256
             -- Production's comment-stripped but SQL-identical legacy body.
             OR (
               v_target.signature = 'public.arena_weekly_leaders(integer)'
               AND v_source_sha256 =
                 '2aa0c4fe43ea4fe48210c07245569f3b5dc005a3b0e542da89eb85a719266eaf'
             )
           )
           AND v_function_row.proconfig =
             ARRAY['search_path=arena, public']::pg_catalog.text[]
         )
         OR (
           v_source_sha256 = v_target.quarantined_source_sha256
           AND v_function_row.proconfig =
             ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
         )
       ) THEN
      RAISE EXCEPTION
        'Bitget public reader contract drifted in %: %',
        v_target.signature,
        v_source_sha256;
    END IF;

    IF NOT pg_catalog.has_function_privilege(
         'anon', v_function, 'EXECUTE'
       )
       OR NOT pg_catalog.has_function_privilege(
         'authenticated', v_function, 'EXECUTE'
       )
       OR NOT pg_catalog.has_function_privilege(
         'service_role', v_function, 'EXECUTE'
       )
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.aclexplode(
           COALESCE(
             v_function_row.proacl,
             pg_catalog.acldefault('f', v_function_row.proowner)
           )
         ) AS privilege
         WHERE privilege.privilege_type = 'EXECUTE'
           AND privilege.grantee <> ALL (
             ARRAY[
               0::oid,
               v_function_row.proowner,
               'anon'::pg_catalog.regrole::oid,
               'authenticated'::pg_catalog.regrole::oid,
               'service_role'::pg_catalog.regrole::oid
             ]::oid[]
           )
       ) THEN
      RAISE EXCEPTION
        'Bitget public reader execution boundary drifted in %',
        v_target.signature;
    END IF;
  END LOOP;
END
$public_reader_preflight$;

CREATE TEMP TABLE bitget_bot_public_reader_contract_before
ON COMMIT DROP
AS
SELECT
  target.signature,
  target.quarantined_source_sha256,
  target.expected_marker_count,
  function_row.oid
FROM (
  VALUES
    (
      'public.arena_weekly_leaders(integer)'::text,
      '82c7ae19c58882cc84fb15afcc1a1f8e971190e3aba0efae07f374373a4c5957'::text,
      2::integer
    ),
    (
      'public.arena_exchange_rankings(integer)'::text,
      '6aca4293e2652d71fbb2fa58804f0091ea2a92c10f428b20d4e10a1412a14aa1'::text,
      2::integer
    ),
    (
      'public.arena_first_screen(text,text)'::text,
      '7e923b64c6b369a652f5806aa281a0146fdba50c6de5c5b113e78b7c2cbf0ea0'::text,
      1::integer
    ),
    (
      'public.arena_core_modules(text,text,integer)'::text,
      'caef116ff47e4b74bff0b8508717c2943f4a7a0beb5ba996d0793d46c18911fc'::text,
      1::integer
    )
) AS target(signature, quarantined_source_sha256, expected_marker_count)
JOIN pg_catalog.pg_proc AS function_row
  ON function_row.oid = pg_catalog.to_regprocedure(target.signature);

-- The original freshness authority predates the hardened SECURITY DEFINER
-- baseline and is the only reviewed legacy exception above. Its body already
-- schema-qualifies both arena relations and has no public-schema dependency.
-- Converge it before the catalog snapshot so the body rewrite and every replay
-- preserve one exact hardened runtime contract.
ALTER FUNCTION public.arena_freshness_expected_sources()
  SET search_path TO pg_catalog, pg_temp;

-- Three older public readers bypass leaderboard_ranks and project directly
-- from arena snapshots. Keep bot identity/profile shells available, but remove
-- every cumulative bot board metric, rank, raw extra, and historical 7D/90D
-- snapshot from those public surfaces in this same atomic quarantine.
CREATE OR REPLACE FUNCTION public.arena_weekly_leaders(
  p_limit integer DEFAULT 25
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  WITH latest AS (
    SELECT DISTINCT ON (snapshot.source_id)
      snapshot.id,
      snapshot.source_id,
      snapshot.scraped_at
    FROM arena.leaderboard_snapshots AS snapshot
    JOIN arena.sources AS source_row
      ON source_row.id = snapshot.source_id
    WHERE snapshot.timeframe = 7
      AND snapshot.count_check_passed
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
              WHERE snapshot.source_id = source_row.id
                AND snapshot.timeframe = p_timeframe
                AND snapshot.count_check_passed
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

DO $public_reader_postflight$
DECLARE
  v_contract record;
  v_function oid;
  v_function_row pg_catalog.pg_proc%ROWTYPE;
  v_source_sha256 text;
  v_marker_count integer;
BEGIN
  FOR v_contract IN
    SELECT *
    FROM bitget_bot_public_reader_contract_before
    ORDER BY signature
  LOOP
    v_function := pg_catalog.to_regprocedure(v_contract.signature);
    SELECT function_row.*
    INTO STRICT v_function_row
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function;

    v_source_sha256 := pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(v_function_row.prosrc, 'UTF8')
      ),
      'hex'
    );
    v_marker_count := (
      pg_catalog.length(v_function_row.prosrc)
      - pg_catalog.length(
          pg_catalog.replace(
            v_function_row.prosrc,
            'bitget-bot-cumulative-public-reader-quarantine@1',
            ''
          )
        )
    ) / pg_catalog.length(
      'bitget-bot-cumulative-public-reader-quarantine@1'
    );

    IF v_function IS NULL
       OR v_function <> v_contract.oid
       OR v_source_sha256 <>
            v_contract.quarantined_source_sha256
       OR v_marker_count <> v_contract.expected_marker_count
       OR v_function_row.proowner <>
            'postgres'::pg_catalog.regrole
       OR NOT v_function_row.prosecdef
       OR v_function_row.provolatile <> 's'
       OR v_function_row.proconfig IS DISTINCT FROM
            ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
       OR NOT pg_catalog.has_function_privilege(
         'anon', v_function, 'EXECUTE'
       )
       OR NOT pg_catalog.has_function_privilege(
         'authenticated', v_function, 'EXECUTE'
       )
       OR NOT pg_catalog.has_function_privilege(
         'service_role', v_function, 'EXECUTE'
       )
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.aclexplode(
           COALESCE(
             v_function_row.proacl,
             pg_catalog.acldefault('f', v_function_row.proowner)
           )
         ) AS privilege
         WHERE privilege.privilege_type = 'EXECUTE'
           AND privilege.grantee <> ALL (
             ARRAY[
               v_function_row.proowner,
               'anon'::pg_catalog.regrole::oid,
               'authenticated'::pg_catalog.regrole::oid,
               'service_role'::pg_catalog.regrole::oid
             ]::oid[]
           )
       ) THEN
      RAISE EXCEPTION
        'Bitget public reader quarantine postflight failed in %',
        v_contract.signature;
    END IF;
  END LOOP;
END
$public_reader_postflight$;

-- pg_get_functiondef plus exact, counted source anchors avoids copying several
-- hundred lines of live function bodies into this hotfix. CREATE OR REPLACE
-- retains each object OID; the catalog snapshot/postflight below proves every
-- property other than prosrc remained byte-identical. Any body drift fails
-- before DDL rather than broadening the rewrite.
CREATE TEMP TABLE bitget_bot_rank_function_contract_before
ON COMMIT DROP
AS
SELECT
  requested.signature,
  requested.expected_source_sha256,
  function_row.oid,
  pg_catalog.to_jsonb(function_row) - 'prosrc' AS catalog_without_source
FROM (
  VALUES
    (
      'public.arena_score_inputs_json(text,integer,integer)'::text,
      'ac4d96ea0e3bdbf00a544d13337e2ec59d6f7074db3a36387f6e864792f05ebc'::text
    ),
    (
      'public.arena_score_inputs_publish_bundle_json(text,integer,integer)'::text,
      'f1c2aa2f9c5bb32c70fc585fce0a5a424028041ff4473fa89984f293e2eb85bc'::text
    ),
    (
      'public.arena_freshness_expected_sources()'::text,
      'c69d25e952d8f131f8873770325b3e12baf83080059c9cd8a48d9c4b094d9b86'::text
    )
) AS requested(signature, expected_source_sha256)
JOIN pg_catalog.pg_proc AS function_row
  ON function_row.oid = pg_catalog.to_regprocedure(requested.signature);

DO $rewrite_rank_authorities$
DECLARE
  v_target record;
  v_function oid;
  v_source text;
  v_definition text;
  v_needle text;
  v_replacement text;
  v_source_sha256 text;
  v_needle_count integer;
  v_marker_count integer;
  v_marker constant text := 'bitget-bot-cumulative-rank-quarantine@1';
BEGIN
  FOR v_target IN
    SELECT *
    FROM (
      VALUES
        (
          'public.arena_score_inputs_json(text,integer,integer)'::text,
          'source'::text,
          '      '::text,
          3::integer,
          'e2a24067c77ba495cf73b088468d292b6cc8ab36f2f1d251d290881b3938586d'::text,
          'ac4d96ea0e3bdbf00a544d13337e2ec59d6f7074db3a36387f6e864792f05ebc'::text
        ),
        (
          'public.arena_score_inputs_publish_bundle_json(text,integer,integer)'::text,
          'source_row'::text,
          '      '::text,
          1::integer,
          'd20a085c89371ddc5d5a9ee70645268433e385d6b32ab348d7fd9322a31521d1'::text,
          'f1c2aa2f9c5bb32c70fc585fce0a5a424028041ff4473fa89984f293e2eb85bc'::text
        ),
        (
          'public.arena_freshness_expected_sources()'::text,
          'source_row'::text,
          '    '::text,
          1::integer,
          'c1739275e302ac2a7429c79a0c3456680603418004cc9c3da44913de88d28b4e'::text,
          'c69d25e952d8f131f8873770325b3e12baf83080059c9cd8a48d9c4b094d9b86'::text
        )
    ) AS target(
      signature,
      source_alias,
      anchor_indent,
      expected_anchor_count,
      legacy_source_sha256,
      quarantined_source_sha256
    )
    ORDER BY target.signature
  LOOP
    v_function := pg_catalog.to_regprocedure(v_target.signature);
    SELECT function_row.prosrc
    INTO STRICT v_source
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function;

    v_source_sha256 := pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(v_source, 'UTF8')),
      'hex'
    );
    v_marker_count := (
      pg_catalog.length(v_source)
      - pg_catalog.length(pg_catalog.replace(v_source, v_marker, ''))
    ) / pg_catalog.length(v_marker);

    IF v_source_sha256 = v_target.quarantined_source_sha256 THEN
      IF v_marker_count <> v_target.expected_anchor_count THEN
        RAISE EXCEPTION
          'Bitget rank quarantine digest/marker mismatch in %',
          v_target.signature;
      END IF;
      CONTINUE;
    ELSIF v_source_sha256 <> v_target.legacy_source_sha256 THEN
      RAISE EXCEPTION
        'Bitget rank authority body drifted in %: %',
        v_target.signature,
        v_source_sha256;
    ELSIF v_marker_count <> 0 THEN
      RAISE EXCEPTION
        'partial Bitget rank quarantine marker set in %: %/%',
        v_target.signature,
        v_marker_count,
        v_target.expected_anchor_count;
    END IF;

    -- Match the shared semantic predicate rather than assuming it is always
    -- introduced by AND: the score-input function has two AND branches and
    -- one WHERE branch. Exact old/new body digests below fence this otherwise
    -- deliberately small textual anchor.
    v_needle := pg_catalog.format(
      '%s.serving_mode = ''serving''%s',
      v_target.source_alias,
      E'\n'
    );
    v_needle_count := (
      pg_catalog.length(v_source)
      - pg_catalog.length(pg_catalog.replace(v_source, v_needle, ''))
    ) / pg_catalog.length(v_needle);

    IF v_needle_count <> v_target.expected_anchor_count THEN
      RAISE EXCEPTION
        'Bitget rank quarantine rewrite anchor drifted in %: %/%',
        v_target.signature,
        v_needle_count,
        v_target.expected_anchor_count;
    END IF;

    v_replacement := v_needle || pg_catalog.format(
$predicate$%2$s-- bitget-bot-cumulative-rank-quarantine@1
%2$sAND NOT (
%2$s  %1$s.slug = ANY (
%2$s    ARRAY[
%2$s      'bitget_bots_futures',
%2$s      'bitget_bots_spot'
%2$s    ]::pg_catalog.text[]
%2$s  )
%2$s  OR %1$s.adapter_slug = 'bitget_bots'
%2$s)
$predicate$,
      v_target.source_alias,
      v_target.anchor_indent
    );

    v_definition := pg_catalog.replace(
      pg_catalog.pg_get_functiondef(v_function),
      v_needle,
      v_replacement
    );
    EXECUTE v_definition;

    SELECT pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc, 'UTF8')),
      'hex'
    )
    INTO STRICT v_source_sha256
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function;

    IF v_source_sha256 <> v_target.quarantined_source_sha256 THEN
      RAISE EXCEPTION
        'Bitget rank authority rewrite digest mismatch in %: %',
        v_target.signature,
        v_source_sha256;
    END IF;
  END LOOP;
END
$rewrite_rank_authorities$;

-- Serialize with board publication and every parent-table rank mutation. The
-- registry remains active+serving: only its authority to create public ranks
-- is removed.
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    '20260728_bitget_bot_cumulative_rank_authority_quarantine',
    0
  )
);

DO $publication_locks$
DECLARE
  v_source_id smallint;
BEGIN
  FOR v_source_id IN
    SELECT source.id
    FROM arena.sources AS source
    WHERE source.slug = ANY (
      ARRAY[
        'bitget_bots_futures',
        'bitget_bots_spot'
      ]::pg_catalog.text[]
    )
    ORDER BY source.id
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'arena.publish-board-series:' || v_source_id::text,
        0
      )
    );
  END LOOP;
END
$publication_locks$;

LOCK TABLE public.leaderboard_ranks IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.leaderboard_source_freshness IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.leaderboard_count_cache IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE arena.bots IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE arena.leaderboard_snapshots IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE arena.leaderboard_entries IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE arena.trader_stats IN SHARE ROW EXCLUSIVE MODE;

-- A replay after rollout may already contain newly crawled, canonical profile
-- values and identity-only entry projections. Distinguish that state from the
-- first historical cleanup, and fail closed if a same-named guard drifted.
DO $entry_guard_preflight$
DECLARE
  v_function oid := pg_catalog.to_regprocedure(
    'arena.guard_bitget_bot_leaderboard_entry()'
  );
  v_trigger_count integer;
  v_function_contract_count integer;
BEGIN
  SELECT pg_catalog.count(*)::integer
  INTO STRICT v_trigger_count
  FROM pg_catalog.pg_trigger AS trigger_row
  WHERE trigger_row.tgrelid =
        'arena.leaderboard_entries'::pg_catalog.regclass
    AND trigger_row.tgname = 'guard_bitget_bot_leaderboard_entry'
    AND NOT trigger_row.tgisinternal;

  SELECT pg_catalog.count(*)::integer
  INTO STRICT v_function_contract_count
  FROM pg_catalog.pg_proc AS function_row
  JOIN pg_catalog.pg_language AS language_row
    ON language_row.oid = function_row.prolang
  WHERE function_row.oid = v_function
    AND function_row.prokind = 'f'
    AND function_row.proowner = 'postgres'::pg_catalog.regrole
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.proparallel = 'u'
    AND function_row.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
    AND language_row.lanname = 'plpgsql'
    AND function_row.proconfig =
      ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
    AND pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(function_row.prosrc, 'UTF8')
      ),
      'hex'
    ) = 'b2260b83f3fd6cd2f636eff2bfc5b65cface86de23f7c1ed653d4d2197f3b4b0'
    AND NOT pg_catalog.has_function_privilege(
      'service_role', function_row.oid, 'EXECUTE'
    )
    AND NOT pg_catalog.has_function_privilege(
      'anon', function_row.oid, 'EXECUTE'
    )
    AND NOT pg_catalog.has_function_privilege(
      'authenticated', function_row.oid, 'EXECUTE'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS privilege
      WHERE privilege.privilege_type = 'EXECUTE'
        AND privilege.grantee <> function_row.proowner
    );

  IF v_function IS NULL AND v_trigger_count = 0 THEN
    RETURN;
  END IF;

  IF v_function IS NULL
     OR v_function_contract_count <> 1
     OR v_trigger_count <> 1
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_trigger AS trigger_row
       WHERE trigger_row.tgrelid =
             'arena.leaderboard_entries'::pg_catalog.regclass
         AND trigger_row.tgname = 'guard_bitget_bot_leaderboard_entry'
         AND NOT trigger_row.tgisinternal
         AND trigger_row.tgenabled = 'O'
         AND trigger_row.tgfoid = v_function
         AND trigger_row.tgtype = 23
         AND trigger_row.tgnargs = 0
         AND trigger_row.tgqual IS NULL
         AND (
           SELECT pg_catalog.array_agg(
             trigger_attribute.attnum
             ORDER BY trigger_attribute.attnum
           )
           FROM pg_catalog.unnest(
             trigger_row.tgattr::pg_catalog.int2[]
           ) AS trigger_attribute(attnum)
         ) = (
           SELECT pg_catalog.array_agg(
             attribute_row.attnum::pg_catalog.int2
             ORDER BY attribute_row.attnum
           )
           FROM pg_catalog.pg_attribute AS attribute_row
           WHERE attribute_row.attrelid =
                 'arena.leaderboard_entries'::pg_catalog.regclass
             AND attribute_row.attname = ANY (
               ARRAY[
                 'scraped_at',
                 'snapshot_id',
                 'trader_id',
                 'timeframe',
                 'headline_roi',
                 'headline_pnl',
                 'headline_win_rate',
                 'raw'
               ]::pg_catalog.text[]
             )
             AND NOT attribute_row.attisdropped
         )
     ) THEN
    RAISE EXCEPTION 'Bitget bot entry guard replay contract drifted';
  END IF;
END
$entry_guard_preflight$;

CREATE TEMP TABLE bitget_bot_entry_guard_before
ON COMMIT DROP
AS
SELECT pg_catalog.to_regprocedure(
  'arena.guard_bitget_bot_leaderboard_entry()'
) IS NOT NULL AS already_installed;

-- Ranking substrate is an internal implementation detail. Public B2C reads
-- must cross a reviewed SECURITY DEFINER projection so row-level policy drift,
-- raw cards, historical snapshots, or the owner-executed score view cannot
-- bypass product semantics. Keep service diagnostics available explicitly.
DROP POLICY IF EXISTS "Public read bots" ON arena.bots;
DROP POLICY IF EXISTS "Public read leaderboard_snapshots"
  ON arena.leaderboard_snapshots;
DROP POLICY IF EXISTS "Public read leaderboard_entries"
  ON arena.leaderboard_entries;
DROP POLICY IF EXISTS "Public read trader_stats" ON arena.trader_stats;

REVOKE ALL PRIVILEGES ON TABLE arena.bots
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE arena.leaderboard_snapshots
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE arena.leaderboard_entries
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE arena.trader_stats
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE arena.score_inputs
  FROM PUBLIC, anon, authenticated;

DO $entry_partition_acl_quarantine$
DECLARE
  v_partition record;
BEGIN
  FOR v_partition IN
    SELECT namespace_row.nspname, relation_row.relname
    FROM pg_catalog.pg_partition_tree(
      'arena.leaderboard_entries'::pg_catalog.regclass
    ) AS partition_row
    JOIN pg_catalog.pg_class AS relation_row
      ON relation_row.oid = partition_row.relid
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = relation_row.relnamespace
    WHERE partition_row.relid <>
          'arena.leaderboard_entries'::pg_catalog.regclass
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM PUBLIC, anon, authenticated',
      v_partition.nspname,
      v_partition.relname
    );
  END LOOP;
END
$entry_partition_acl_quarantine$;

GRANT SELECT ON TABLE arena.bots TO service_role;
GRANT SELECT ON TABLE arena.leaderboard_snapshots TO service_role;
GRANT SELECT ON TABLE arena.leaderboard_entries TO service_role;
GRANT SELECT ON TABLE arena.trader_stats TO service_role;
GRANT SELECT ON TABLE arena.score_inputs TO service_role;

-- The current ranker uses the fenced JSON/bundle functions. Retire the old
-- table-returning RPC so a delayed deployment cannot bypass their source
-- authority filter merely because it still holds the service key.
REVOKE ALL ON FUNCTION public.arena_score_inputs(text, integer, integer)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TEMP TABLE bitget_bot_canonical_entry_raw_before
ON COMMIT DROP
AS
SELECT entry.scraped_at, entry.snapshot_id, entry.trader_id
FROM arena.leaderboard_entries AS entry
JOIN arena.leaderboard_snapshots AS snapshot
  ON snapshot.id = entry.snapshot_id
JOIN arena.sources AS source_row
  ON source_row.id = snapshot.source_id
JOIN arena.traders AS trader
  ON trader.id = entry.trader_id
 AND trader.source_id = source_row.id
WHERE (
    source_row.slug = ANY (
      ARRAY[
        'bitget_bots_futures',
        'bitget_bots_spot'
      ]::pg_catalog.text[]
    )
    OR source_row.adapter_slug = 'bitget_bots'
  )
  AND trader.trader_kind = 'bot'
  AND trader.bot_strategy IN ('grid', 'martingale')
  AND entry.timeframe = 30
  AND snapshot.timeframe = entry.timeframe
  AND snapshot.scraped_at = entry.scraped_at
  AND pg_catalog.jsonb_typeof(trader.meta -> 'bot') = 'object'
  AND (trader.meta -> 'bot') ?& ARRAY[
    'exchange_bot_id',
    'product_id',
    'owner_account_id',
    'owner_name',
    'pair',
    'product_type',
    'strategy',
    'direction',
    'created_at_origin',
    'runtime_days',
    'profit_share_rate',
    'status'
  ]::pg_catalog.text[]
  AND (trader.meta -> 'bot') - ARRAY[
    'exchange_bot_id',
    'product_id',
    'owner_account_id',
    'owner_name',
    'pair',
    'product_type',
    'strategy',
    'direction',
    'created_at_origin',
    'runtime_days',
    'profit_share_rate',
    'status'
  ]::pg_catalog.text[] = '{}'::pg_catalog.jsonb
  AND (trader.meta -> 'bot') ->> 'exchange_bot_id' =
      trader.exchange_trader_id
  AND (trader.meta -> 'bot') ->> 'product_type' = source_row.product_type
  AND (trader.meta -> 'bot') ->> 'strategy' = trader.bot_strategy
  AND pg_catalog.jsonb_typeof(entry.raw) = 'object'
  AND entry.raw ?& ARRAY[
    'strategyId',
    'strategyType',
    'productId',
    'strAccountId',
    'status'
  ]::pg_catalog.text[]
  AND entry.raw - ARRAY[
    'strategyId',
    'strategyType',
    'productId',
    'strAccountId',
    'status'
  ]::pg_catalog.text[] = '{}'::pg_catalog.jsonb
  AND pg_catalog.jsonb_typeof(entry.raw -> 'strategyId') = 'string'
  AND entry.raw ->> 'strategyId' = trader.exchange_trader_id
  AND entry.raw ->> 'strategyId' ~ '^[0-9]+$'
  AND pg_catalog.jsonb_typeof(entry.raw -> 'strategyType') = 'number'
  AND entry.raw -> 'strategyType' = pg_catalog.to_jsonb(
    CASE
      WHEN source_row.product_type = 'spot'
       AND trader.bot_strategy = 'grid' THEN 1
      WHEN source_row.product_type = 'futures'
       AND trader.bot_strategy = 'grid' THEN 2
      WHEN source_row.product_type = 'spot'
       AND trader.bot_strategy = 'martingale' THEN 3
      WHEN source_row.product_type = 'futures'
       AND trader.bot_strategy = 'martingale' THEN 4
    END
  )
  AND pg_catalog.jsonb_typeof(entry.raw -> 'productId') IN ('string', 'null')
  AND pg_catalog.jsonb_typeof(entry.raw -> 'strAccountId') IN ('string', 'null')
  AND pg_catalog.jsonb_typeof(entry.raw -> 'status') IN ('string', 'null')
  AND entry.raw ->> 'productId' IS NOT DISTINCT FROM
      trader.meta -> 'bot' ->> 'product_id'
  AND entry.raw ->> 'strAccountId' IS NOT DISTINCT FROM
      trader.meta -> 'bot' ->> 'owner_account_id'
  AND entry.raw ->> 'status' IS NOT DISTINCT FROM
      trader.meta -> 'bot' ->> 'status';

ALTER TABLE bitget_bot_canonical_entry_raw_before
  ADD PRIMARY KEY (scraped_at, snapshot_id, trader_id);

-- The old board writer copied inception-cumulative profitRate/profitAmount
-- into 7D/30D/90D serving rows and copied the complete provider card to every
-- entry. The immutable RAW object remains the audit source; serving keeps no
-- mislabeled duplicate. Reset affected profiles to stale so Tier-C performs a
-- fresh, exact-window crawl before the cleaned metrics become warm again.
UPDATE arena.leaderboard_entries AS entry
SET headline_roi = NULL,
    headline_pnl = NULL,
    headline_win_rate = NULL,
    raw = CASE
      WHEN EXISTS (
        SELECT 1
        FROM bitget_bot_canonical_entry_raw_before AS canonical
        WHERE canonical.scraped_at = entry.scraped_at
          AND canonical.snapshot_id = entry.snapshot_id
          AND canonical.trader_id = entry.trader_id
      ) THEN entry.raw
      ELSE NULL
    END
FROM arena.leaderboard_snapshots AS snapshot,
     arena.sources AS source_row
WHERE snapshot.id = entry.snapshot_id
  AND source_row.id = snapshot.source_id
  AND NOT (
    SELECT state.already_installed
    FROM bitget_bot_entry_guard_before AS state
  )
  AND (
    source_row.slug = ANY (
      ARRAY[
        'bitget_bots_futures',
        'bitget_bots_spot'
      ]::pg_catalog.text[]
    )
    OR source_row.adapter_slug = 'bitget_bots'
  )
  AND (
    entry.headline_roi IS NOT NULL
    OR entry.headline_pnl IS NOT NULL
    OR entry.headline_win_rate IS NOT NULL
    OR (
      entry.raw IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM bitget_bot_canonical_entry_raw_before AS canonical
        WHERE canonical.scraped_at = entry.scraped_at
          AND canonical.snapshot_id = entry.snapshot_id
          AND canonical.trader_id = entry.trader_id
      )
    )
  );

UPDATE arena.trader_stats AS stats
SET roi = NULL,
    pnl = NULL,
    win_rate = NULL,
    mdd = CASE WHEN stats.timeframe = 30 THEN stats.mdd ELSE NULL END,
    as_of = '1970-01-01 00:00:00+00'::pg_catalog.timestamptz
FROM arena.traders AS trader,
     arena.sources AS source_row
WHERE trader.id = stats.trader_id
  AND source_row.id = trader.source_id
  AND NOT (
    SELECT state.already_installed
    FROM bitget_bot_entry_guard_before AS state
  )
  AND trader.trader_kind = 'bot'
  AND stats.timeframe IN (7, 30, 90)
  AND (
    source_row.slug = ANY (
      ARRAY[
        'bitget_bots_futures',
        'bitget_bots_spot'
      ]::pg_catalog.text[]
    )
    OR source_row.adapter_slug = 'bitget_bots'
  )
  AND (
    stats.roi IS NOT NULL
    OR stats.pnl IS NOT NULL
    OR stats.win_rate IS NOT NULL
    OR (stats.timeframe IN (7, 90) AND stats.mdd IS NOT NULL)
    OR stats.as_of <> '1970-01-01 00:00:00+00'::pg_catalog.timestamptz
  );

CREATE OR REPLACE FUNCTION arena.guard_bitget_bot_leaderboard_entry()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_source_id smallint;
  v_source_slug text;
  v_adapter_slug text;
  v_product_type text;
  v_snapshot_timeframe smallint;
  v_snapshot_scraped_at timestamptz;
  v_exchange_trader_id text;
  v_trader_kind text;
  v_bot_strategy text;
  v_bot_meta jsonb;
  v_expected_strategy_type integer;
BEGIN
  SELECT
    source_row.id,
    source_row.slug,
    source_row.adapter_slug,
    source_row.product_type,
    snapshot.timeframe,
    snapshot.scraped_at
  INTO
    v_source_id,
    v_source_slug,
    v_adapter_slug,
    v_product_type,
    v_snapshot_timeframe,
    v_snapshot_scraped_at
  FROM arena.leaderboard_snapshots AS snapshot
  JOIN arena.sources AS source_row
    ON source_row.id = snapshot.source_id
  WHERE snapshot.id = NEW.snapshot_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Bitget bot board entry snapshot identity is missing';
  END IF;

  IF NOT (
    v_source_slug = ANY (
      ARRAY[
        'bitget_bots_futures',
        'bitget_bots_spot'
      ]::pg_catalog.text[]
    )
    OR v_adapter_slug = 'bitget_bots'
  ) THEN
    RETURN NEW;
  END IF;

  IF NEW.timeframe <> 30
     OR v_snapshot_timeframe <> NEW.timeframe
     OR v_snapshot_scraped_at IS DISTINCT FROM NEW.scraped_at
     OR NEW.headline_roi IS NOT NULL
     OR NEW.headline_pnl IS NOT NULL
     OR NEW.headline_win_rate IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Bitget bot board entries require one exact 30D identity-only publication';
  END IF;

  SELECT
    trader.exchange_trader_id,
    trader.trader_kind,
    trader.bot_strategy,
    trader.meta -> 'bot'
  INTO
    v_exchange_trader_id,
    v_trader_kind,
    v_bot_strategy,
    v_bot_meta
  FROM arena.traders AS trader
  WHERE trader.id = NEW.trader_id
    AND trader.source_id = v_source_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Bitget bot board entry trader/source identity does not match';
  END IF;

  IF v_trader_kind <> 'bot'
     OR v_bot_strategy NOT IN ('grid', 'martingale')
     OR pg_catalog.jsonb_typeof(v_bot_meta) IS DISTINCT FROM 'object'
     OR NOT v_bot_meta ?& ARRAY[
       'exchange_bot_id',
       'product_id',
       'owner_account_id',
       'owner_name',
       'pair',
       'product_type',
       'strategy',
       'direction',
       'created_at_origin',
       'runtime_days',
       'profit_share_rate',
       'status'
     ]::pg_catalog.text[]
     OR v_bot_meta - ARRAY[
       'exchange_bot_id',
       'product_id',
       'owner_account_id',
       'owner_name',
       'pair',
       'product_type',
       'strategy',
       'direction',
       'created_at_origin',
       'runtime_days',
       'profit_share_rate',
       'status'
     ]::pg_catalog.text[] <> '{}'::pg_catalog.jsonb
     OR v_bot_meta ->> 'exchange_bot_id' IS DISTINCT FROM v_exchange_trader_id
     OR v_bot_meta ->> 'product_type' IS DISTINCT FROM v_product_type
     OR v_bot_meta ->> 'strategy' IS DISTINCT FROM v_bot_strategy THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Bitget bot board entry trader identity is outside the canonical contract';
  END IF;

  v_expected_strategy_type := CASE
    WHEN v_product_type = 'spot' AND v_bot_strategy = 'grid' THEN 1
    WHEN v_product_type = 'futures' AND v_bot_strategy = 'grid' THEN 2
    WHEN v_product_type = 'spot' AND v_bot_strategy = 'martingale' THEN 3
    WHEN v_product_type = 'futures' AND v_bot_strategy = 'martingale' THEN 4
    ELSE NULL
  END;

  IF pg_catalog.jsonb_typeof(NEW.raw) IS DISTINCT FROM 'object'
     OR NOT NEW.raw ?& ARRAY[
       'strategyId',
       'strategyType',
       'productId',
       'strAccountId',
       'status'
     ]::pg_catalog.text[]
     OR NEW.raw - ARRAY[
       'strategyId',
       'strategyType',
       'productId',
       'strAccountId',
       'status'
     ]::pg_catalog.text[] <> '{}'::pg_catalog.jsonb
     OR pg_catalog.jsonb_typeof(NEW.raw -> 'strategyId') IS DISTINCT FROM 'string'
     OR NEW.raw ->> 'strategyId' IS DISTINCT FROM v_exchange_trader_id
     OR NEW.raw ->> 'strategyId' !~ '^[0-9]+$'
     OR pg_catalog.jsonb_typeof(NEW.raw -> 'strategyType') IS DISTINCT FROM 'number'
     OR NEW.raw -> 'strategyType' IS DISTINCT FROM
          pg_catalog.to_jsonb(v_expected_strategy_type)
     OR pg_catalog.jsonb_typeof(NEW.raw -> 'productId') NOT IN ('string', 'null')
     OR pg_catalog.jsonb_typeof(NEW.raw -> 'strAccountId') NOT IN ('string', 'null')
     OR pg_catalog.jsonb_typeof(NEW.raw -> 'status') NOT IN ('string', 'null')
     OR NEW.raw ->> 'productId' IS DISTINCT FROM v_bot_meta ->> 'product_id'
     OR NEW.raw ->> 'strAccountId' IS DISTINCT FROM v_bot_meta ->> 'owner_account_id'
     OR NEW.raw ->> 'status' IS DISTINCT FROM v_bot_meta ->> 'status' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Bitget bot board entry raw data must be the exact identity-only projection';
  END IF;

  RETURN NEW;
END
$function$;

ALTER FUNCTION arena.guard_bitget_bot_leaderboard_entry() OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.guard_bitget_bot_leaderboard_entry()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS guard_bitget_bot_leaderboard_entry
  ON arena.leaderboard_entries;
CREATE TRIGGER guard_bitget_bot_leaderboard_entry
BEFORE INSERT OR UPDATE OF
  scraped_at,
  snapshot_id,
  trader_id,
  timeframe,
  headline_roi,
  headline_pnl,
  headline_win_rate,
  raw
ON arena.leaderboard_entries
FOR EACH ROW
EXECUTE FUNCTION arena.guard_bitget_bot_leaderboard_entry();

CREATE TEMP TABLE bitget_bot_rank_affected_seasons (
  season_id text PRIMARY KEY
) ON COMMIT DROP;

INSERT INTO bitget_bot_rank_affected_seasons (season_id)
SELECT DISTINCT rank_row.season_id
FROM public.leaderboard_ranks AS rank_row
WHERE rank_row.source = ANY (
  ARRAY[
    'bitget_bots_futures',
    'bitget_bots_spot'
  ]::pg_catalog.text[]
);

-- leaderboard_ranks is a derived materialization. Immutable RAW remains the
-- rollback evidence while the duplicate serving rows above are deliberately
-- scrubbed. Delete every historical season because old 7D/90D publications
-- are just as semantically invalid as the current 30D publication.
DELETE FROM public.leaderboard_ranks AS rank_row
WHERE rank_row.source = ANY (
  ARRAY[
    'bitget_bots_futures',
    'bitget_bots_spot'
  ]::pg_catalog.text[]
);

DELETE FROM public.leaderboard_source_freshness AS freshness
WHERE freshness.source = ANY (
  ARRAY[
    'bitget_bots_futures',
    'bitget_bots_spot'
  ]::pg_catalog.text[]
);

-- Administrative removal cannot support organic rank-change claims. Close
-- gaps deterministically only in seasons which actually contained bot ranks.
UPDATE public.leaderboard_ranks AS rank_row
SET rank_change = NULL
WHERE rank_row.season_id IN (
  SELECT affected.season_id
  FROM bitget_bot_rank_affected_seasons AS affected
)
  AND rank_row.rank_change IS NOT NULL;

WITH rank_authority AS MATERIALIZED (
  SELECT DISTINCT
    authority.season_id,
    authority.filter_source AS source
  FROM public.arena_freshness_expected_sources() AS authority
  JOIN bitget_bot_rank_affected_seasons AS affected
    ON affected.season_id = authority.season_id
),
classified AS MATERIALIZED (
  SELECT
    rank_row.id,
    rank_row.season_id,
    rank_row.arena_score,
    rank_authority.source IS NOT NULL
      AND arena.leaderboard_rank_row_is_public_eligible(
        rank_row,
        pg_catalog.transaction_timestamp()
      ) AS is_eligible
  FROM public.leaderboard_ranks AS rank_row
  JOIN bitget_bot_rank_affected_seasons AS affected
    ON affected.season_id = rank_row.season_id
  LEFT JOIN rank_authority
    ON rank_authority.season_id = rank_row.season_id
   AND rank_authority.source = rank_row.source
),
ordered AS MATERIALIZED (
  SELECT
    classified.id,
    classified.season_id,
    pg_catalog.row_number() OVER (
      PARTITION BY classified.season_id
      ORDER BY classified.arena_score DESC NULLS LAST, classified.id
    )::integer AS expected_rank
  FROM classified
  WHERE classified.is_eligible
),
desired AS MATERIALIZED (
  SELECT
    classified.id,
    classified.season_id,
    ordered.expected_rank
  FROM classified
  LEFT JOIN ordered
    ON ordered.id = classified.id
   AND ordered.season_id = classified.season_id
)
UPDATE public.leaderboard_ranks AS rank_row
SET rank = desired.expected_rank
FROM desired
WHERE rank_row.id = desired.id
  AND rank_row.season_id = desired.season_id
  AND rank_row.rank IS DISTINCT FROM desired.expected_rank;

-- A delayed writer may have read the old authority before this transaction.
-- Recreate the exact parent CHECK under the held table lock on every replay;
-- accepting a same-named but merely similar constraint would leave a bypass.
-- The parent constraint propagates to every season partition and makes stale
-- writes fail closed after our table lock is released.
ALTER TABLE public.leaderboard_ranks
  DROP CONSTRAINT IF EXISTS
    leaderboard_ranks_block_cumulative_bitget_bot_authority;

ALTER TABLE public.leaderboard_ranks
  ADD CONSTRAINT leaderboard_ranks_block_cumulative_bitget_bot_authority
  CHECK (
    source <> ALL (
      ARRAY[
        'bitget_bots_futures',
        'bitget_bots_spot'
      ]::pg_catalog.text[]
    )
  ) NOT VALID;

ALTER TABLE public.leaderboard_ranks
  VALIDATE CONSTRAINT leaderboard_ranks_block_cumulative_bitget_bot_authority;

SELECT public.refresh_leaderboard_count_cache();

DO $postflight$
DECLARE
  v_contract record;
  v_after pg_catalog.pg_proc%ROWTYPE;
  v_marker_count integer;
  v_expected_markers integer;
  v_function oid;
  v_guard_count integer;
  v_language text;
BEGIN
  FOR v_contract IN
    SELECT *
    FROM bitget_bot_rank_function_contract_before
    ORDER BY signature
  LOOP
    v_function := pg_catalog.to_regprocedure(v_contract.signature);
    SELECT *
    INTO STRICT v_after
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function;

    IF v_after.oid IS DISTINCT FROM v_contract.oid
       OR (
         pg_catalog.to_jsonb(v_after) - 'prosrc'
       ) IS DISTINCT FROM v_contract.catalog_without_source THEN
      RAISE EXCEPTION
        'rank-authority callable catalog contract changed: %',
        v_contract.signature;
    END IF;

    v_expected_markers := CASE v_contract.signature
      WHEN 'public.arena_score_inputs_json(text,integer,integer)' THEN 3
      ELSE 1
    END;
    v_marker_count := (
      pg_catalog.length(v_after.prosrc)
      - pg_catalog.length(
          pg_catalog.replace(
            v_after.prosrc,
            'bitget-bot-cumulative-rank-quarantine@1',
            ''
          )
        )
    ) / pg_catalog.length('bitget-bot-cumulative-rank-quarantine@1');

    IF v_marker_count <> v_expected_markers
       OR pg_catalog.encode(
            pg_catalog.sha256(
              pg_catalog.convert_to(v_after.prosrc, 'UTF8')
            ),
            'hex'
          ) IS DISTINCT FROM v_contract.expected_source_sha256
       OR v_after.proconfig IS DISTINCT FROM
         ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
       OR NOT pg_catalog.has_function_privilege(
         'service_role', v_after.oid, 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege(
         'anon', v_after.oid, 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege(
         'authenticated', v_after.oid, 'EXECUTE'
       ) THEN
      RAISE EXCEPTION
        'rank-authority rewrite or execution boundary postflight failed: %',
        v_contract.signature;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM public.leaderboard_ranks AS rank_row
    WHERE rank_row.source = ANY (
      ARRAY[
        'bitget_bots_futures',
        'bitget_bots_spot'
      ]::pg_catalog.text[]
    )
  ) THEN
    RAISE EXCEPTION 'cumulative Bitget bot ranks remain publicly materialized';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.leaderboard_source_freshness AS freshness
    WHERE freshness.source = ANY (
      ARRAY[
        'bitget_bots_futures',
        'bitget_bots_spot'
      ]::pg_catalog.text[]
    )
  ) THEN
    RAISE EXCEPTION 'cumulative Bitget bot rank freshness remains published';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.leaderboard_count_cache AS cache_row
    WHERE cache_row.source = ANY (
      ARRAY[
        'bitget_bots_futures',
        'bitget_bots_spot',
        'bitget_bots_futures_gt0',
        'bitget_bots_spot_gt0'
      ]::pg_catalog.text[]
    )
  ) THEN
    RAISE EXCEPTION 'cumulative Bitget bot leaderboard count cache remains published';
  END IF;

  IF EXISTS (
    WITH rank_authority AS MATERIALIZED (
      SELECT DISTINCT
        authority.season_id,
        authority.filter_source AS source
      FROM public.arena_freshness_expected_sources() AS authority
      JOIN bitget_bot_rank_affected_seasons AS affected
        ON affected.season_id = authority.season_id
    ),
    classified AS MATERIALIZED (
      SELECT
        rank_row.id,
        rank_row.season_id,
        rank_row.arena_score,
        rank_authority.source IS NOT NULL
          AND arena.leaderboard_rank_row_is_public_eligible(
            rank_row,
            pg_catalog.transaction_timestamp()
          ) AS is_eligible
      FROM public.leaderboard_ranks AS rank_row
      JOIN bitget_bot_rank_affected_seasons AS affected
        ON affected.season_id = rank_row.season_id
      LEFT JOIN rank_authority
        ON rank_authority.season_id = rank_row.season_id
       AND rank_authority.source = rank_row.source
    ),
    ordered AS MATERIALIZED (
      SELECT
        classified.id,
        classified.season_id,
        pg_catalog.row_number() OVER (
          PARTITION BY classified.season_id
          ORDER BY classified.arena_score DESC NULLS LAST, classified.id
        )::integer AS expected_rank
      FROM classified
      WHERE classified.is_eligible
    ),
    desired AS MATERIALIZED (
      SELECT
        classified.id,
        classified.season_id,
        ordered.expected_rank
      FROM classified
      LEFT JOIN ordered
        ON ordered.id = classified.id
       AND ordered.season_id = classified.season_id
    )
    SELECT 1
    FROM public.leaderboard_ranks AS rank_row
    JOIN desired
      ON desired.id = rank_row.id
     AND desired.season_id = rank_row.season_id
    WHERE rank_row.rank IS DISTINCT FROM desired.expected_rank
       OR rank_row.rank_change IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Bitget administrative rank removal left rank gaps or deltas';
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO STRICT v_guard_count
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid =
        'public.leaderboard_ranks'::pg_catalog.regclass
    AND constraint_row.conname =
        'leaderboard_ranks_block_cumulative_bitget_bot_authority'
    AND constraint_row.contype = 'c'
    AND constraint_row.convalidated
    AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
        ~ 'bitget_bots_futures'
    AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
        ~ 'bitget_bots_spot';

  IF v_guard_count <> 1 THEN
    RAISE EXCEPTION 'Bitget cumulative rank reinsertion guard postflight failed';
  END IF;

  -- No exposed relation may bypass the reviewed public RPCs. Include every
  -- current leaderboard-entry partition because PostgREST can address a child
  -- relation directly when the arena schema is exposed.
  IF EXISTS (
    WITH sensitive_relations AS (
      SELECT relation_oid
      FROM (
        VALUES
          ('arena.bots'::pg_catalog.regclass::oid),
          ('arena.leaderboard_snapshots'::pg_catalog.regclass::oid),
          ('arena.trader_stats'::pg_catalog.regclass::oid),
          ('arena.score_inputs'::pg_catalog.regclass::oid)
      ) AS direct(relation_oid)
      UNION
      SELECT partition_row.relid
      FROM pg_catalog.pg_partition_tree(
        'arena.leaderboard_entries'::pg_catalog.regclass
      ) AS partition_row
    )
    SELECT 1
    FROM sensitive_relations AS sensitive
    JOIN pg_catalog.pg_class AS relation_row
      ON relation_row.oid = sensitive.relation_oid
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation_row.relacl,
        pg_catalog.acldefault('r', relation_row.relowner)
      )
    ) AS privilege
    WHERE privilege.grantee <> ALL (
      ARRAY[
        relation_row.relowner,
        'service_role'::pg_catalog.regrole::oid
      ]::oid[]
    )
  ) THEN
    RAISE EXCEPTION 'ranking substrate retains a non-service relation privilege';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('arena.bots'::pg_catalog.regclass::oid),
        ('arena.leaderboard_snapshots'::pg_catalog.regclass::oid),
        ('arena.leaderboard_entries'::pg_catalog.regclass::oid),
        ('arena.trader_stats'::pg_catalog.regclass::oid),
        ('arena.score_inputs'::pg_catalog.regclass::oid)
    ) AS required(relation_oid)
    WHERE NOT pg_catalog.has_table_privilege(
      'service_role', required.relation_oid, 'SELECT'
    )
       OR pg_catalog.has_table_privilege(
         'anon', required.relation_oid, 'SELECT'
       )
       OR pg_catalog.has_table_privilege(
         'authenticated', required.relation_oid, 'SELECT'
       )
  ) THEN
    RAISE EXCEPTION 'ranking substrate RPC-only access boundary failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid = ANY (
      ARRAY[
        'arena.bots'::pg_catalog.regclass::oid,
        'arena.leaderboard_snapshots'::pg_catalog.regclass::oid,
        'arena.leaderboard_entries'::pg_catalog.regclass::oid,
        'arena.trader_stats'::pg_catalog.regclass::oid
      ]::oid[]
    )
      AND policy_row.polroles && ARRAY[
        0::oid,
        'anon'::pg_catalog.regrole::oid,
        'authenticated'::pg_catalog.regrole::oid
      ]::oid[]
  ) THEN
    RAISE EXCEPTION 'ranking substrate retains a public RLS policy';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('arena.bots'::pg_catalog.regclass::oid),
        ('arena.leaderboard_snapshots'::pg_catalog.regclass::oid),
        ('arena.leaderboard_entries'::pg_catalog.regclass::oid),
        ('arena.trader_stats'::pg_catalog.regclass::oid)
    ) AS required(relation_oid)
    JOIN pg_catalog.pg_class AS relation_row
      ON relation_row.oid = required.relation_oid
    WHERE NOT relation_row.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'ranking substrate RLS was disabled during quarantine';
  END IF;

  v_function := pg_catalog.to_regprocedure(
    'public.arena_score_inputs(text,integer,integer)'
  );
  IF pg_catalog.has_function_privilege(
       'service_role', v_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege('anon', v_function, 'EXECUTE')
     OR pg_catalog.has_function_privilege(
       'authenticated', v_function, 'EXECUTE'
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS privilege
       WHERE function_row.oid = v_function
         AND privilege.privilege_type = 'EXECUTE'
         AND privilege.grantee <> function_row.proowner
     ) THEN
    RAISE EXCEPTION 'legacy table score-input RPC remains executable';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM arena.leaderboard_entries AS entry
    JOIN arena.leaderboard_snapshots AS snapshot
      ON snapshot.id = entry.snapshot_id
    JOIN arena.sources AS source_row
      ON source_row.id = snapshot.source_id
    WHERE (
      source_row.slug = ANY (
        ARRAY[
          'bitget_bots_futures',
          'bitget_bots_spot'
        ]::pg_catalog.text[]
      )
      OR source_row.adapter_slug = 'bitget_bots'
    )
      AND (
        entry.headline_roi IS NOT NULL
        OR entry.headline_pnl IS NOT NULL
        OR entry.headline_win_rate IS NOT NULL
        OR (
          entry.raw IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM bitget_bot_canonical_entry_raw_before AS canonical
            WHERE canonical.scraped_at = entry.scraped_at
              AND canonical.snapshot_id = entry.snapshot_id
              AND canonical.trader_id = entry.trader_id
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'mislabeled Bitget bot entry metrics or raw cards remain';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM arena.trader_stats AS stats
    JOIN arena.traders AS trader
      ON trader.id = stats.trader_id
    JOIN arena.sources AS source_row
      ON source_row.id = trader.source_id
    WHERE trader.trader_kind = 'bot'
      AND stats.timeframe IN (7, 30, 90)
      AND (
        source_row.slug = ANY (
          ARRAY[
            'bitget_bots_futures',
            'bitget_bots_spot'
          ]::pg_catalog.text[]
        )
        OR source_row.adapter_slug = 'bitget_bots'
      )
      AND (
        (
          NOT (
            SELECT state.already_installed
            FROM bitget_bot_entry_guard_before AS state
          )
          AND (
            stats.roi IS NOT NULL
            OR stats.pnl IS NOT NULL
            OR stats.win_rate IS NOT NULL
            OR (stats.timeframe IN (7, 90) AND stats.mdd IS NOT NULL)
            OR stats.as_of <>
              '1970-01-01 00:00:00+00'::pg_catalog.timestamptz
          )
        )
        OR (
          (
            stats.roi IS NOT NULL
            OR stats.pnl IS NOT NULL
            OR stats.win_rate IS NOT NULL
            OR (stats.timeframe IN (7, 90) AND stats.mdd IS NOT NULL)
          )
          AND pg_catalog.jsonb_typeof(
            stats.extras -> '_arena_profile_publication_epoch_ms'
          ) IS DISTINCT FROM 'number'
        )
      )
  ) THEN
    RAISE EXCEPTION 'mislabeled Bitget bot profile-window metrics remain warm';
  END IF;

  v_function := pg_catalog.to_regprocedure(
    'arena.guard_bitget_bot_leaderboard_entry()'
  );
  SELECT language_row.lanname
  INTO STRICT v_language
  FROM pg_catalog.pg_proc AS function_row
  JOIN pg_catalog.pg_language AS language_row
    ON language_row.oid = function_row.prolang
  WHERE function_row.oid = v_function
    AND function_row.prokind = 'f'
    AND function_row.proowner = 'postgres'::pg_catalog.regrole
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.proparallel = 'u'
    AND function_row.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
    AND function_row.proconfig =
      ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
    AND pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(function_row.prosrc, 'UTF8')
      ),
      'hex'
    ) = 'b2260b83f3fd6cd2f636eff2bfc5b65cface86de23f7c1ed653d4d2197f3b4b0';

  IF v_language <> 'plpgsql'
     OR pg_catalog.has_function_privilege(
       'service_role', v_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege('anon', v_function, 'EXECUTE')
     OR pg_catalog.has_function_privilege(
       'authenticated', v_function, 'EXECUTE'
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS privilege
       WHERE function_row.oid = v_function
         AND privilege.privilege_type = 'EXECUTE'
         AND privilege.grantee <> function_row.proowner
     ) THEN
    RAISE EXCEPTION 'Bitget bot entry guard function contract failed';
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO STRICT v_guard_count
  FROM pg_catalog.pg_trigger AS trigger_row
  WHERE trigger_row.tgrelid =
        'arena.leaderboard_entries'::pg_catalog.regclass
    AND trigger_row.tgname = 'guard_bitget_bot_leaderboard_entry'
    AND NOT trigger_row.tgisinternal
    AND trigger_row.tgenabled = 'O'
    AND trigger_row.tgfoid = v_function
    AND trigger_row.tgtype = 23
    AND trigger_row.tgnargs = 0
    AND trigger_row.tgqual IS NULL
    AND (
      SELECT pg_catalog.array_agg(
        trigger_attribute.attnum
        ORDER BY trigger_attribute.attnum
      )
      FROM pg_catalog.unnest(
        trigger_row.tgattr::pg_catalog.int2[]
      ) AS trigger_attribute(attnum)
    ) = (
      SELECT pg_catalog.array_agg(
        attribute_row.attnum::pg_catalog.int2
        ORDER BY attribute_row.attnum
      )
      FROM pg_catalog.pg_attribute AS attribute_row
      WHERE attribute_row.attrelid =
            'arena.leaderboard_entries'::pg_catalog.regclass
        AND attribute_row.attname = ANY (
          ARRAY[
            'scraped_at',
            'snapshot_id',
            'trader_id',
            'timeframe',
            'headline_roi',
            'headline_pnl',
            'headline_win_rate',
            'raw'
          ]::pg_catalog.text[]
        )
        AND NOT attribute_row.attisdropped
    )
    AND pg_catalog.pg_get_triggerdef(trigger_row.oid, true)
        ~ '^CREATE TRIGGER guard_bitget_bot_leaderboard_entry BEFORE INSERT OR UPDATE OF ';

  IF v_guard_count <> 1 THEN
    RAISE EXCEPTION 'Bitget bot entry guard trigger contract failed';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM arena.sources AS source
    WHERE source.slug = ANY (
      ARRAY[
        'bitget_bots_futures',
        'bitget_bots_spot'
      ]::pg_catalog.text[]
    )
      AND source.status = 'active'
      AND source.serving_mode = 'serving'
  ) <> 2 THEN
    RAISE EXCEPTION 'rank-only quarantine changed Bitget bot serving visibility';
  END IF;
END
$postflight$;

COMMENT ON CONSTRAINT
  leaderboard_ranks_block_cumulative_bitget_bot_authority
  ON public.leaderboard_ranks IS
  'Blocks Bitget inception-cumulative bot metrics from public timeframe ranks until an explicit promotion migration.';

NOTIFY pgrst, 'reload schema';

COMMIT;
