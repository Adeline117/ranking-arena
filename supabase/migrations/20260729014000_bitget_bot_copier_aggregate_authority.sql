-- Migration: 20260729014000_bitget_bot_copier_aggregate_authority.sql
-- Created: 2026-07-29T01:40:00Z
-- Description: Make the public copier aggregate deterministic for Bitget bots.
--   Board metrics are inception-cumulative and must never be selected from an
--   arbitrary trader_stats timeframe. Only an exact, profile-published
--   inception row may provide total copier count/PnL. The independently
--   captured followRank batch may provide its Top-10 distribution, never a
--   fabricated total. Non-Bitget-bot behavior remains compatible.

BEGIN;

SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '2min';
SET LOCAL TIME ZONE 'UTC';
SET LOCAL search_path = pg_catalog, pg_temp;

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    '20260729_bitget_bot_copier_aggregate_authority',
    0
  )
);

LOCK TABLE arena.sources, arena.exchanges IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE arena.traders, arena.trader_stats, arena.copier_records IN SHARE MODE;

DO $preflight$
DECLARE
  v_function oid := pg_catalog.to_regprocedure(
    'public.arena_copier_aggregate(text,text)'
  );
  v_function_row pg_catalog.pg_proc%ROWTYPE;
  v_language text;
  v_source_sha256 text;
  v_exact_sources integer;
  v_constraint_count integer;
BEGIN
  IF pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.exchanges') IS NULL
     OR pg_catalog.to_regclass('arena.traders') IS NULL
     OR pg_catalog.to_regclass('arena.trader_stats') IS NULL
     OR pg_catalog.to_regclass('arena.copier_records') IS NULL THEN
    RAISE EXCEPTION
      'Bitget bot copier authority requires source, trader, profile, and copier foundations';
  END IF;

  IF v_function IS NULL THEN
    RAISE EXCEPTION 'public.arena_copier_aggregate(text,text) is missing';
  END IF;

  IF pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL THEN
    RAISE EXCEPTION 'Bitget bot copier authority requires Supabase runtime roles';
  END IF;

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
          ARRAY['p_source', 'p_trader']::pg_catalog.text[]
     OR v_function_row.pronargdefaults <> 0
     OR NOT (
       (
         v_source_sha256 =
           '32c18c9f396acb150581ec2432a5ba40aa107a492ec98cc14692b66b93ccea6a'
         AND v_function_row.proconfig =
           ARRAY['search_path=arena, public']::pg_catalog.text[]
       )
       OR (
         v_source_sha256 =
           '267bac4cf6a3c9f51e2a2b3f61aa29f22549bc39f69c20c59f438a3663ab68de'
         AND v_function_row.proconfig =
           ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
       )
     ) THEN
    RAISE EXCEPTION
      'copier aggregate callable contract drifted: %',
      v_source_sha256;
  END IF;

  IF NOT pg_catalog.has_function_privilege(
       'anon', v_function, 'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'authenticated', v_function, 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'copier aggregate browser execution contract drifted';
  END IF;

  IF pg_catalog.has_table_privilege(
       'anon', 'arena.trader_stats', 'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'authenticated', 'arena.trader_stats', 'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'anon', 'arena.copier_records', 'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'authenticated', 'arena.copier_records', 'SELECT'
     )
     OR NOT pg_catalog.has_table_privilege(
       'service_role', 'arena.trader_stats', 'SELECT'
     )
     OR NOT pg_catalog.has_table_privilege(
       'service_role', 'arena.copier_records', 'SELECT'
     ) THEN
    RAISE EXCEPTION 'copier metric substrate read authority drifted';
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
    AND source.copier_table_depth IN ('full', 'top10')
    AND source.meta->'boards' = target.boards
    AND COALESCE(
      NULLIF(pg_catalog.btrim(source.meta->>'legacy_platform'), ''),
      source.slug
    ) = source.slug;

  IF v_exact_sources <> 2 THEN
    RAISE EXCEPTION
      'Bitget bot copier authority requires two exact canonical sources, found %',
      v_exact_sources;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM arena.sources AS source
    JOIN arena.exchanges AS exchange
      ON exchange.id = source.exchange_id
    WHERE source.status = 'active'
      AND source.slug <> ALL (
        ARRAY[
          'bitget_bots_futures',
          'bitget_bots_spot'
        ]::pg_catalog.text[]
      )
      AND (
        source.adapter_slug = 'bitget_bots'
        OR (
          exchange.slug = 'bitget'
          AND (
            source.trader_kind_scope = 'bot'
            OR EXISTS (
              SELECT 1
              FROM arena.traders AS trader
              WHERE trader.source_id = source.id
                AND trader.trader_kind = 'bot'
            )
          )
        )
      )
  ) THEN
    RAISE EXCEPTION
      'unexpected active Bitget bot source requires explicit copier-authority review';
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO STRICT v_constraint_count
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid = 'arena.sources'::pg_catalog.regclass
    AND constraint_row.conname =
      'sources_bitget_bot_copier_depth_top10';

  IF v_constraint_count > 1 OR (
    v_constraint_count = 1
    AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = 'arena.sources'::pg_catalog.regclass
        AND constraint_row.conname =
          'sources_bitget_bot_copier_depth_top10'
        AND constraint_row.contype = 'c'
        AND constraint_row.convalidated
        AND NOT constraint_row.connoinherit
        AND pg_catalog.pg_get_constraintdef(
          constraint_row.oid,
          true
        ) ~ 'bitget_bots_futures'
        AND pg_catalog.pg_get_constraintdef(
          constraint_row.oid,
          true
        ) ~ 'bitget_bots_spot'
        AND pg_catalog.pg_get_constraintdef(
          constraint_row.oid,
          true
        ) ~ 'copier_table_depth = ''top10'''
    )
  ) THEN
    RAISE EXCEPTION 'Bitget bot copier-depth constraint drifted';
  END IF;
END
$preflight$;

ALTER TABLE arena.sources
  DROP CONSTRAINT IF EXISTS sources_bitget_bot_copier_depth_top10;

ALTER TABLE arena.sources
  ADD CONSTRAINT sources_bitget_bot_copier_depth_top10
  CHECK (
    slug <> ALL (
      ARRAY[
        'bitget_bots_futures',
        'bitget_bots_spot'
      ]::pg_catalog.text[]
    )
    OR copier_table_depth = 'top10'
  ) NOT VALID;

-- followRank is a non-paginated, page-disclosed Top-10 surface. Both reviewed
-- live captures and the durable repository fixture contain exactly ten rows
-- and expose no continuation/total field. Do not advertise it as a full table.
UPDATE arena.sources
SET copier_table_depth = 'top10'
WHERE slug = ANY (
  ARRAY[
    'bitget_bots_futures',
    'bitget_bots_spot'
  ]::pg_catalog.text[]
)
  AND copier_table_depth = 'full';

ALTER TABLE arena.sources
  VALIDATE CONSTRAINT sources_bitget_bot_copier_depth_top10;

CREATE OR REPLACE FUNCTION public.arena_copier_aggregate(
  p_source text,
  p_trader text
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  WITH resolved AS (
    SELECT
      trader.id,
      source_row.copier_table_depth,
      source_row.currency,
      (
        source_row.slug = ANY (
          ARRAY[
            'bitget_bots_futures',
            'bitget_bots_spot'
          ]::pg_catalog.text[]
        )
        OR source_row.adapter_slug = 'bitget_bots'
        OR (
          exchange_row.slug = 'bitget'
          AND (
            trader.trader_kind = 'bot'
            OR source_row.trader_kind_scope = 'bot'
          )
        )
      ) AS is_bitget_bot,
      (
        trader.trader_kind = 'bot'
        AND exchange_row.slug = 'bitget'
        AND source_row.adapter_slug = 'bitget_bots'
        AND source_row.trader_kind_scope = 'bot'
        AND source_row.status = 'active'
        AND source_row.serving_mode = 'serving'
        AND source_row.currency = 'USDT'
        AND source_row.timeframes_native = ARRAY[30]::integer[]
        AND source_row.timeframes_derived = ARRAY[]::integer[]
        AND source_row.page_size = 20
        AND source_row.pagination_kind = 'numeric'
        AND source_row.copier_table_depth = 'top10'
        AND (
          (
            source_row.slug = 'bitget_bots_futures'
            AND source_row.product_type = 'futures'
            AND source_row.meta->'boards' =
              '["futures_grid", "futures_martingale"]'::pg_catalog.jsonb
          )
          OR (
            source_row.slug = 'bitget_bots_spot'
            AND source_row.product_type = 'spot'
            AND source_row.meta->'boards' =
              '["spot_grid", "spot_martingale"]'::pg_catalog.jsonb
          )
        )
        AND COALESCE(
          NULLIF(
            pg_catalog.btrim(
              source_row.meta->>'legacy_platform'
            ),
            ''
          ),
          source_row.slug
        ) = source_row.slug
      ) AS canonical_bitget_bot
    FROM arena.traders AS trader
    JOIN arena.sources AS source_row
      ON source_row.id = trader.source_id
    JOIN arena.exchanges AS exchange_row
      ON exchange_row.id = source_row.exchange_id
    WHERE source_row.slug = p_source
      AND trader.exchange_trader_id = p_trader
      AND source_row.status = 'active'
      AND source_row.serving_mode = 'serving'
  ), latest_candidate AS (
    SELECT pg_catalog.max(copier.ts) AS ts
    FROM arena.copier_records AS copier
    CROSS JOIN resolved
    WHERE copier.trader_id = resolved.id
      AND (
        NOT resolved.is_bitget_bot
        OR resolved.canonical_bitget_bot
      )
  ), batch_candidate AS (
    SELECT copier.copier_pnl
    FROM arena.copier_records AS copier
    CROSS JOIN resolved
    CROSS JOIN latest_candidate
    WHERE copier.trader_id = resolved.id
      AND copier.ts = latest_candidate.ts
      AND (
        NOT resolved.is_bitget_bot
        OR resolved.canonical_bitget_bot
      )
  ), batch_contract AS (
    SELECT pg_catalog.count(*) AS row_count
    FROM batch_candidate
  ), latest AS (
    SELECT latest_candidate.ts
    FROM latest_candidate
    CROSS JOIN resolved
    CROSS JOIN batch_contract
    WHERE latest_candidate.ts IS NOT NULL
      AND (
        NOT resolved.is_bitget_bot
        OR (
          resolved.canonical_bitget_bot
          AND batch_contract.row_count BETWEEN 1 AND 10
        )
      )
  ), batch AS (
    SELECT batch_candidate.copier_pnl
    FROM batch_candidate
    CROSS JOIN resolved
    CROSS JOIN batch_contract
    WHERE NOT resolved.is_bitget_bot
       OR (
         resolved.canonical_bitget_bot
         AND batch_contract.row_count BETWEEN 1 AND 10
       )
  ), legacy_stats AS (
    SELECT stats.copier_count, stats.copier_pnl, stats.as_of
    FROM arena.trader_stats AS stats
    CROSS JOIN resolved
    WHERE stats.trader_id = resolved.id
      AND NOT resolved.is_bitget_bot
    ORDER BY stats.as_of DESC
    LIMIT 1
  ), trusted_bot_stats AS (
    SELECT stats.copier_count, stats.copier_pnl, stats.as_of
    FROM arena.trader_stats AS stats
    CROSS JOIN resolved
    WHERE stats.trader_id = resolved.id
      AND resolved.is_bitget_bot
      AND resolved.canonical_bitget_bot
      AND stats.timeframe = 0
      AND pg_catalog.jsonb_typeof(
        stats.extras -> '_arena_profile_publication_epoch_ms'
      ) = 'number'
      AND (
        stats.extras ->> '_arena_profile_publication_epoch_ms'
      )::pg_catalog.numeric =
        EXTRACT(EPOCH FROM stats.as_of) * 1000
  )
  SELECT pg_catalog.jsonb_build_object(
    'copierCount', CASE
      WHEN resolved.is_bitget_bot
      THEN (SELECT stats.copier_count FROM trusted_bot_stats AS stats)
      ELSE COALESCE(
        (SELECT stats.copier_count FROM legacy_stats AS stats),
        NULLIF((SELECT pg_catalog.count(*) FROM batch), 0)
      )
    END,
    'copierCountMax', NULL,
    'totalCopierPnl', CASE
      WHEN resolved.is_bitget_bot
      THEN (SELECT stats.copier_pnl FROM trusted_bot_stats AS stats)
      ELSE COALESCE(
        (SELECT stats.copier_pnl FROM legacy_stats AS stats),
        (SELECT pg_catalog.sum(batch.copier_pnl) FROM batch)
      )
    END,
    'currency', resolved.currency,
    'depth', resolved.copier_table_depth,
    'asOf', CASE
      WHEN resolved.is_bitget_bot THEN GREATEST(
        (SELECT latest.ts FROM latest),
        (SELECT stats.as_of FROM trusted_bot_stats AS stats)
      )
      ELSE COALESCE(
        (SELECT latest.ts FROM latest),
        pg_catalog.now()
      )
    END,
    'pnlDistribution', COALESCE((
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'bucket', distribution.bucket,
            'count', distribution.count
          )
          ORDER BY distribution.ord
        )
        FROM (
          SELECT bucketed.bucket, bucketed.ord,
                 pg_catalog.count(*) AS count
          FROM (
            SELECT
              CASE
                WHEN batch.copier_pnl < -1000 THEN '<-1000'
                WHEN batch.copier_pnl < 0 THEN '-1000~0'
                WHEN batch.copier_pnl < 1000 THEN '0~1000'
                WHEN batch.copier_pnl < 10000 THEN '1000~10000'
                ELSE '>10000'
              END AS bucket,
              CASE
                WHEN batch.copier_pnl < -1000 THEN 0
                WHEN batch.copier_pnl < 0 THEN 1
                WHEN batch.copier_pnl < 1000 THEN 2
                WHEN batch.copier_pnl < 10000 THEN 3
                ELSE 4
              END AS ord
            FROM batch
            WHERE batch.copier_pnl IS NOT NULL
          ) AS bucketed
          GROUP BY bucketed.bucket, bucketed.ord
        ) AS distribution
      ), '[]'::pg_catalog.jsonb)
  )
  FROM resolved
  WHERE NOT resolved.is_bitget_bot
     OR (
       resolved.canonical_bitget_bot
       AND (
         (SELECT latest.ts FROM latest) IS NOT NULL
         OR (SELECT stats.as_of FROM trusted_bot_stats AS stats) IS NOT NULL
       )
     );
$function$;

ALTER FUNCTION public.arena_copier_aggregate(text, text)
  OWNER TO postgres;

REVOKE ALL ON FUNCTION public.arena_copier_aggregate(text, text)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.arena_copier_aggregate(text, text)
  TO anon, authenticated, service_role;

DO $postflight$
DECLARE
  v_function oid := pg_catalog.to_regprocedure(
    'public.arena_copier_aggregate(text,text)'
  );
  v_function_row pg_catalog.pg_proc%ROWTYPE;
  v_language text;
  v_source_sha256 text;
BEGIN
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
          ARRAY['p_source', 'p_trader']::pg_catalog.text[]
     OR v_function_row.pronargdefaults <> 0
     OR v_function_row.proconfig IS DISTINCT FROM
          ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
     OR v_source_sha256 <>
          '267bac4cf6a3c9f51e2a2b3f61aa29f22549bc39f69c20c59f438a3663ab68de'
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
         AND (
           privilege.is_grantable
           OR privilege.grantee = 0::oid
           OR privilege.grantee <> ALL (
             ARRAY[
               v_function_row.proowner,
               'anon'::pg_catalog.regrole::oid,
               'authenticated'::pg_catalog.regrole::oid,
               'service_role'::pg_catalog.regrole::oid
             ]::oid[]
           )
         )
     )
     OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.aclexplode(
         COALESCE(
           v_function_row.proacl,
           pg_catalog.acldefault('f', v_function_row.proowner)
         )
       ) AS privilege
       WHERE privilege.privilege_type = 'EXECUTE'
     ) <> 4 THEN
    RAISE EXCEPTION
      'Bitget bot copier aggregate postflight failed: %',
      v_source_sha256;
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
      AND source.copier_table_depth = 'top10'
  ) <> 2
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_constraint AS constraint_row
       WHERE constraint_row.conrelid =
             'arena.sources'::pg_catalog.regclass
         AND constraint_row.conname =
             'sources_bitget_bot_copier_depth_top10'
         AND constraint_row.contype = 'c'
         AND constraint_row.convalidated
         AND NOT constraint_row.connoinherit
     ) THEN
    RAISE EXCEPTION 'Bitget bot Top-10 source contract failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM arena.sources AS source
    WHERE source.slug = ANY (
      ARRAY[
        'bitget_bots_futures',
        'bitget_bots_spot'
      ]::pg_catalog.text[]
    )
      AND (
        source.status <> 'active'
        OR source.serving_mode <> 'serving'
      )
  ) THEN
    RAISE EXCEPTION 'copier authority changed Bitget bot serving visibility';
  END IF;
END
$postflight$;

COMMENT ON FUNCTION public.arena_copier_aggregate(text, text) IS
  'Aggregate-only copier reader. Bitget bot totals require an exact profile-published inception row; followRank contributes only a Top-10 distribution.';

COMMENT ON CONSTRAINT sources_bitget_bot_copier_depth_top10
  ON arena.sources IS
  'Canonical Bitget bot followRank is a reviewed non-paginated Top-10 surface.';

NOTIFY pgrst, 'reload schema';

COMMIT;
