-- Contain unbound copier rows before restoring them through a dedicated
-- snapshot-publication receipt. copier_records.ts is a follower event/source
-- timestamp on several adapters (notably Gate), so max(ts) is not a batch ID.
-- A Top-N row count or sum must never be presented as an upstream total.

BEGIN;

SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '2min';
SET LOCAL TIME ZONE 'UTC';
SET LOCAL search_path = pg_catalog, pg_temp;

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    '20260804-fail-closed-unbound-copier-aggregates',
    0
  )
);

DO $preflight$
DECLARE
  aggregate_function oid := pg_catalog.to_regprocedure(
    'public.arena_copier_aggregate(text,text)'
  );
  function_row pg_catalog.pg_proc%ROWTYPE;
  function_language text;
  function_sha256 text;
BEGIN
  IF pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.exchanges') IS NULL
     OR pg_catalog.to_regclass('arena.traders') IS NULL
     OR pg_catalog.to_regclass('arena.trader_stats') IS NULL
     OR pg_catalog.to_regclass('arena.copier_records') IS NULL
     OR aggregate_function IS NULL THEN
    RAISE EXCEPTION 'copier aggregate containment foundations are missing';
  END IF;

  IF pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION 'copier aggregate execution roles are missing';
  END IF;

  SELECT procedure.*
  INTO STRICT function_row
  FROM pg_catalog.pg_proc AS procedure
  WHERE procedure.oid = aggregate_function;

  SELECT language.lanname
  INTO STRICT function_language
  FROM pg_catalog.pg_language AS language
  WHERE language.oid = function_row.prolang;

  function_sha256 := pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(function_row.prosrc, 'UTF8')
    ),
    'hex'
  );

  IF function_row.prokind <> 'f'
     OR function_row.proowner <> 'postgres'::pg_catalog.regrole
     OR NOT function_row.prosecdef
     OR function_row.provolatile <> 's'
     OR function_row.proparallel <> 'u'
     OR function_row.proretset
     OR function_row.prorettype <> 'pg_catalog.jsonb'::pg_catalog.regtype
     OR function_row.proisstrict
     OR function_row.proleakproof
     OR function_language <> 'sql'
     OR function_row.proargnames IS DISTINCT FROM
          ARRAY['p_source','p_trader']::pg_catalog.text[]
     OR function_row.pronargdefaults <> 0
     OR function_row.proconfig IS DISTINCT FROM
          ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
     OR NOT (
       function_sha256 =
         '32879cff833594969c2cf3c09b7fdea921a624338b03b2c9c4f717f8bfbf7cf4'
       OR pg_catalog.strpos(
         function_row.prosrc,
         'arena.copier-aggregate-containment@1'
       ) > 0
     ) THEN
    RAISE EXCEPTION 'copier aggregate callable lineage drifted: %', function_sha256;
  END IF;

  IF pg_catalog.has_table_privilege(
       'anon', 'arena.copier_records', 'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'authenticated', 'arena.copier_records', 'SELECT'
     ) THEN
    RAISE EXCEPTION 'private copier row read boundary drifted';
  END IF;
END
$preflight$;

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
  -- arena.copier-aggregate-containment@1
  WITH resolved AS (
    SELECT
      trader.id,
      source_row.copier_table_depth,
      source_row.currency,
      source_row.meta->>'inception_tf' = 'true' AS inception_tf,
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
            pg_catalog.btrim(source_row.meta->>'legacy_platform'),
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
  ), trusted_profile_candidates AS (
    SELECT
      stats.timeframe,
      stats.copier_count,
      stats.copier_pnl,
      stats.as_of
    FROM arena.trader_stats AS stats
    CROSS JOIN resolved
    WHERE stats.trader_id = resolved.id
      AND (stats.copier_count IS NULL OR stats.copier_count >= 0)
      AND CASE
        WHEN pg_catalog.jsonb_typeof(
          stats.extras -> '_arena_profile_publication_epoch_ms'
        ) = 'number'
        THEN (
          stats.extras ->> '_arena_profile_publication_epoch_ms'
        )::pg_catalog.numeric
        ELSE NULL::pg_catalog.numeric
      END = EXTRACT(EPOCH FROM stats.as_of) * 1000
  ), latest_profile_at AS (
    SELECT pg_catalog.max(profile.as_of) AS as_of
    FROM trusted_profile_candidates AS profile
  ), latest_profile_rows AS (
    SELECT profile.copier_count
    FROM trusted_profile_candidates AS profile
    CROSS JOIN latest_profile_at
    WHERE profile.as_of = latest_profile_at.as_of
  ), trusted_current_count AS (
    SELECT CASE
      WHEN pg_catalog.count(profile.copier_count) = 0 THEN NULL::integer
      WHEN pg_catalog.min(profile.copier_count) =
           pg_catalog.max(profile.copier_count)
      THEN pg_catalog.min(profile.copier_count)
      ELSE NULL::integer
    END AS copier_count
    FROM latest_profile_rows AS profile
    CROSS JOIN resolved
    WHERE NOT resolved.is_bitget_bot
  ), trusted_lifetime_stats AS (
    SELECT
      profile.copier_count,
      profile.copier_pnl,
      profile.as_of
    FROM trusted_profile_candidates AS profile
    CROSS JOIN resolved
    WHERE profile.timeframe = 0
      AND (
        resolved.canonical_bitget_bot
        OR (
          NOT resolved.is_bitget_bot
          AND resolved.inception_tf
        )
      )
    ORDER BY profile.as_of DESC
    LIMIT 1
  )
  SELECT pg_catalog.jsonb_build_object(
    'copierCount', CASE
      WHEN resolved.is_bitget_bot
      THEN (
        SELECT lifetime.copier_count
        FROM trusted_lifetime_stats AS lifetime
      )
      ELSE (
        SELECT current_count.copier_count
        FROM trusted_current_count AS current_count
      )
    END,
    'copierCountMax', NULL,
    'totalCopierPnl', (
      SELECT lifetime.copier_pnl
      FROM trusted_lifetime_stats AS lifetime
    ),
    'currency', resolved.currency,
    'depth', resolved.copier_table_depth,
    'asOf', NULL::pg_catalog.timestamptz,
    'sourceAsOf', NULL::pg_catalog.timestamptz,
    'observedAt', NULL::pg_catalog.timestamptz,
    'publishedAt', NULL::pg_catalog.timestamptz,
    -- No histogram is safe until rows are bound to a capture receipt and pass
    -- the minimum cohort/bucket anonymity thresholds.
    'pnlDistribution', '[]'::pg_catalog.jsonb
  )
  FROM resolved
  WHERE resolved.copier_table_depth = 'none'
     OR (
       resolved.is_bitget_bot
       AND resolved.canonical_bitget_bot
       AND (
         (
           SELECT lifetime.copier_count
           FROM trusted_lifetime_stats AS lifetime
         ) IS NOT NULL
         OR (
           SELECT lifetime.copier_pnl
           FROM trusted_lifetime_stats AS lifetime
         ) IS NOT NULL
       )
     )
     OR (
       NOT resolved.is_bitget_bot
       AND (
         (
           SELECT current_count.copier_count
           FROM trusted_current_count AS current_count
         ) IS NOT NULL
         OR (
           SELECT lifetime.copier_pnl
           FROM trusted_lifetime_stats AS lifetime
         ) IS NOT NULL
       )
     );
$function$;

ALTER FUNCTION public.arena_copier_aggregate(text, text)
  OWNER TO postgres;

REVOKE ALL ON FUNCTION public.arena_copier_aggregate(text, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.arena_copier_aggregate(text, text)
  TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.arena_copier_aggregate(text, text) IS
  'Aggregate-only copier reader. Unbound row-derived totals and distributions are quarantined; only exact profile publications may supply headline values.';

DO $postflight$
DECLARE
  aggregate_function oid := pg_catalog.to_regprocedure(
    'public.arena_copier_aggregate(text,text)'
  );
  function_row pg_catalog.pg_proc%ROWTYPE;
BEGIN
  SELECT procedure.*
  INTO STRICT function_row
  FROM pg_catalog.pg_proc AS procedure
  WHERE procedure.oid = aggregate_function;

  IF function_row.proowner <> 'postgres'::pg_catalog.regrole
     OR NOT function_row.prosecdef
     OR function_row.provolatile <> 's'
     OR function_row.proconfig IS DISTINCT FROM
          ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
     OR pg_catalog.strpos(
       function_row.prosrc,
       'arena.copier-aggregate-containment@1'
     ) = 0
     OR pg_catalog.strpos(function_row.prosrc, 'arena.copier_records') <> 0
     OR pg_catalog.strpos(function_row.prosrc, 'FROM batch') <> 0
     OR pg_catalog.strpos(
       function_row.prosrc,
       'trusted_profile_candidates AS'
     ) = 0
     OR pg_catalog.strpos(
       function_row.prosrc,
       'profile.timeframe = 0'
     ) = 0
     OR pg_catalog.strpos(
       function_row.prosrc,
       '''pnlDistribution'', ''[]''::pg_catalog.jsonb'
     ) = 0 THEN
    RAISE EXCEPTION 'copier aggregate containment postflight failed';
  END IF;

  IF EXISTS (
    (
      SELECT
        privilege.grantor,
        privilege.grantee,
        privilege.privilege_type,
        privilege.is_grantable
      FROM pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS privilege
      EXCEPT
      SELECT expected.*
      FROM (
        VALUES
          (
            function_row.proowner,
            function_row.proowner,
            'EXECUTE'::text,
            false
          ),
          (
            function_row.proowner,
            'anon'::pg_catalog.regrole::oid,
            'EXECUTE'::text,
            false
          ),
          (
            function_row.proowner,
            'authenticated'::pg_catalog.regrole::oid,
            'EXECUTE'::text,
            false
          ),
          (
            function_row.proowner,
            'service_role'::pg_catalog.regrole::oid,
            'EXECUTE'::text,
            false
          )
      ) AS expected(grantor, grantee, privilege_type, is_grantable)
    )
    UNION ALL
    (
      SELECT expected.*
      FROM (
        VALUES
          (
            function_row.proowner,
            function_row.proowner,
            'EXECUTE'::text,
            false
          ),
          (
            function_row.proowner,
            'anon'::pg_catalog.regrole::oid,
            'EXECUTE'::text,
            false
          ),
          (
            function_row.proowner,
            'authenticated'::pg_catalog.regrole::oid,
            'EXECUTE'::text,
            false
          ),
          (
            function_row.proowner,
            'service_role'::pg_catalog.regrole::oid,
            'EXECUTE'::text,
            false
          )
      ) AS expected(grantor, grantee, privilege_type, is_grantable)
      EXCEPT
      SELECT
        privilege.grantor,
        privilege.grantee,
        privilege.privilege_type,
        privilege.is_grantable
      FROM pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS privilege
    )
  ) THEN
    RAISE EXCEPTION 'copier aggregate exact ACL postflight failed';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
