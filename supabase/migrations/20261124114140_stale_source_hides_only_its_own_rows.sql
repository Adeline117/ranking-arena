-- Migration: stale_source_hides_only_its_own_rows
-- Description: a serving source whose sealed watermark leaves the 48-hour
--   window hides only its own rows of that season, not the whole season.
--
-- Why: arena.public_ranked_leaderboard_serving_seasons() refused a season as
--   soon as ANY source witness of its serving head had source_as_of older than
--   48 hours. The publisher uses the same 48-hour bound to decide which
--   sources enter a cohort, and it runs every two hours, so a source that is
--   47 hours old at one seal crosses the line before the next one. In
--   production on 2026-11-24 the 7D head was sealed at 18:01Z with
--   bitget_spot at 47.3 hours; at 18:44Z the whole 7D leaderboard (4,080 rows
--   from 11 other sources, all 3 to 17 hours old) became invisible until the
--   next publication. bitget_spot had zero rows on that board.
--
-- What changes:
--   * Integrity conditions are unchanged and still hide the whole season:
--     expected-set drift, either rank mutation fence, receipt / proof
--     mismatch, cohort mismatch, witness count, rank_valid_until.
--   * A witness whose source_as_of is outside (observed - 48h, observed + 5min]
--     no longer refuses the season. That source is simply not served:
--     arena.public_ranked_leaderboard_served_sources() lists the (season,
--     source) pairs being served, and the public view, the sealed-source
--     reader, the public evidence view and arena_visible_sources() all read
--     that one function.
--   * The publisher's isolation bound applies at read time too, with the
--     publisher's own numbers: a season is not served when more than half of
--     its declared sources lack a current witness, or when every declared
--     core source does. Sources the serving cohort already isolated count as
--     declared and not current, exactly as the publisher counted them, so
--     seal-time and read-time exclusions cannot add up past the bound.
--     arena.rank_publication_core_sources() and
--     arena.rank_publication_max_isolated_ratio() hold the values of
--     RANK_PUBLICATION_CORE_SOURCES and RANK_PUBLICATION_MAX_ISOLATED_RATIO
--     (lib/rankings/publication/publish-season.ts); the PostgreSQL 17 proof
--     compares both pairs.
--
-- POSTDEPLOY, after 20261123021904 (whose view body it restates with the two
--   window-flag columns) and 20261121201553 (whose arena_visible_sources body
--   it replaces). No application or worker release depends on it.
-- Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
BEGIN
  IF pg_catalog.to_regprocedure(
       'arena.public_ranked_leaderboard_serving_seasons(timestamp with time zone)'
     ) IS NULL
     OR pg_catalog.to_regprocedure('arena.public_sealed_rank_sources()') IS NULL
     OR pg_catalog.to_regprocedure('public.arena_visible_sources(text)') IS NULL
     OR pg_catalog.to_regprocedure('public.arena_freshness_expected_sources()') IS NULL
     OR pg_catalog.to_regprocedure(
          'arena.public_ranked_leaderboard_row_is_eligible(public.leaderboard_ranks,timestamp with time zone)'
        ) IS NULL THEN
    RAISE EXCEPTION 'sealed public leaderboard readers are required';
  END IF;

  IF pg_catalog.to_regclass('public.public_ranked_leaderboard') IS NULL
     OR pg_catalog.to_regclass('public.public_ranked_leaderboard_source_evidence') IS NULL
     OR pg_catalog.to_regclass('arena.public_ranked_leaderboard_serving_heads') IS NULL
     OR pg_catalog.to_regclass('arena.public_ranked_leaderboard_serving_sources') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_publication_source_isolations') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_publication_unsupported_sources') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_rank_publication_source_evidence') IS NULL THEN
    RAISE EXCEPTION 'serving authority, isolation and evidence relations are required';
  END IF;

  -- The view is restated below; it must already be the 37-column
  -- 20261123021904 shape, or replacing it would drop or reorder columns.
  IF (
       SELECT pg_catalog.array_agg(attribute.attname::text ORDER BY attribute.attnum)
         FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = 'public.public_ranked_leaderboard'::pg_catalog.regclass
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
     )[36:37] IS DISTINCT FROM ARRAY['idle_window', 'mdd_contradiction']::pg_catalog.text[]
     OR (
       SELECT pg_catalog.count(*)
         FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = 'public.public_ranked_leaderboard'::pg_catalog.regclass
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
     ) <> 37 THEN
    RAISE EXCEPTION 'public.public_ranked_leaderboard is not the 20261123021904 view (37 columns ending in idle_window, mdd_contradiction)';
  END IF;
END
$preflight$;

-- The publisher's isolation bound (publish-season.ts). Owner-only: read by
-- the definer function below.
CREATE FUNCTION arena.rank_publication_core_sources()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT ARRAY[
    'binance_futures',
    'bybit',
    'okx_futures',
    'bitget_futures',
    'hyperliquid'
  ]::pg_catalog.text[];
$function$;

CREATE FUNCTION arena.rank_publication_max_isolated_ratio()
RETURNS numeric
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT 0.5::pg_catalog.numeric;
$function$;

-- The one definition of "this sealed source watermark is current".
CREATE FUNCTION arena.public_ranked_leaderboard_witness_is_current(
  p_source_as_of timestamptz,
  p_observed_at timestamptz
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT COALESCE(
    pg_catalog.isfinite(p_source_as_of)
    AND pg_catalog.isfinite(p_observed_at)
    AND p_source_as_of > p_observed_at - interval '48 hours'
    AND p_source_as_of <= p_observed_at + interval '5 minutes',
    false
  );
$function$;

ALTER FUNCTION arena.rank_publication_core_sources() OWNER TO postgres;
ALTER FUNCTION arena.rank_publication_max_isolated_ratio() OWNER TO postgres;
ALTER FUNCTION arena.public_ranked_leaderboard_witness_is_current(timestamptz, timestamptz)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.rank_publication_core_sources()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.rank_publication_max_isolated_ratio()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.public_ranked_leaderboard_witness_is_current(timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;

-- Same signature, owner, security and grants. The body is the 20260816184500
-- body with two changes: the per-witness source_as_of window no longer
-- refuses the season, and the isolation bound is checked instead.
CREATE OR REPLACE FUNCTION arena.public_ranked_leaderboard_serving_seasons(
  p_observed_at timestamptz
)
RETURNS TABLE (
  season_id text
)
LANGUAGE plpgsql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
BEGIN
  IF NOT pg_catalog.isfinite(p_observed_at) THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH expected_source_rows AS MATERIALIZED (
    SELECT
      expected.season_id,
      expected.filter_source AS source
    FROM public.arena_freshness_expected_sources() AS expected
    WHERE expected.season_id IN ('7D', '30D', '90D')
  ),
  invalid_expected_sources AS MATERIALIZED (
    SELECT DISTINCT expected.season_id
    FROM expected_source_rows AS expected
    WHERE expected.source IS NULL
       OR pg_catalog.char_length(expected.source) > 128
       OR expected.source COLLATE "C" !~ '^[a-z0-9]+(_[a-z0-9]+)*$'
       OR expected.source IS DISTINCT FROM
            pg_catalog.lower(pg_catalog.btrim(expected.source))
  ),
  expected_sources AS MATERIALIZED (
    SELECT DISTINCT
      expected.season_id,
      expected.source COLLATE "C" AS source
    FROM expected_source_rows AS expected
  ),
  expected_sets AS MATERIALIZED (
    SELECT
      expected.season_id,
      pg_catalog.array_agg(
        expected.source
        ORDER BY expected.source COLLATE "C"
      ) AS sources
    FROM expected_sources AS expected
    GROUP BY expected.season_id
    HAVING pg_catalog.count(*) BETWEEN 1 AND 256
  )
  SELECT head.season_id
  FROM ONLY arena.public_ranked_leaderboard_serving_heads AS head
  JOIN expected_sets AS expected
    ON expected.season_id = head.season_id
   AND expected.sources = head.expected_sources
  JOIN ONLY arena.leaderboard_rank_season_mutation_fences AS season_fence
    ON season_fence.season_id = head.season_id
   AND season_fence.mutation_seq = head.rank_mutation_epoch
  JOIN ONLY arena.leaderboard_rank_publications AS publication
    ON publication.id = head.score_cohort_id
   AND publication.season_id = head.season_id
   AND publication.published_at IS NOT DISTINCT FROM head.sealed_at
  WHERE NOT EXISTS (
          SELECT 1
          FROM invalid_expected_sources AS invalid
          WHERE invalid.season_id = head.season_id
        )
    AND head.rank_valid_until >= p_observed_at
    AND publication.source_count = pg_catalog.cardinality(head.expected_sources)
    AND publication.source_count =
        pg_catalog.jsonb_array_length(publication.proofs)
    AND (SELECT pg_catalog.count(*)
         FROM ONLY arena.public_ranked_leaderboard_serving_sources AS serving
         WHERE serving.season_id = head.season_id)
        = pg_catalog.cardinality(head.expected_sources)
    AND NOT EXISTS (
      SELECT 1
      FROM ONLY arena.public_ranked_leaderboard_serving_sources AS serving
      LEFT JOIN public.leaderboard_source_freshness AS freshness
        ON freshness.season_id = serving.season_id
       AND freshness.source = serving.source
      LEFT JOIN ONLY arena.leaderboard_rank_mutation_fences AS source_fence
        ON source_fence.season_id = serving.season_id
       AND source_fence.source = serving.source
      WHERE serving.season_id = head.season_id
        AND (
          serving.score_cohort_id IS DISTINCT FROM head.score_cohort_id
          OR NOT (serving.source = ANY (head.expected_sources))
          OR freshness.source IS NULL
          OR freshness.source_as_of IS DISTINCT FROM serving.source_as_of
          OR freshness.recorded_at IS DISTINCT FROM serving.recorded_at
          OR freshness.score_cohort_id IS DISTINCT FROM serving.score_cohort_id
          OR freshness.rank_mutation_seq IS DISTINCT FROM serving.rank_mutation_seq
          OR freshness.published_rank_count
               IS DISTINCT FROM serving.published_rank_count
          OR freshness.published_identity_sha256
               IS DISTINCT FROM serving.published_identity_sha256
          OR source_fence.mutation_seq IS DISTINCT FROM serving.rank_mutation_seq
          OR NOT pg_catalog.isfinite(serving.source_as_of)
          OR NOT pg_catalog.isfinite(serving.recorded_at)
          OR serving.recorded_at > p_observed_at + interval '5 minutes'
          OR publication.published_at IS DISTINCT FROM serving.recorded_at
          OR NOT EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(publication.proofs)
              AS audit(proof)
            WHERE audit.proof = pg_catalog.jsonb_build_object(
              'source', serving.source,
              'source_as_of', pg_catalog.to_char(
                serving.source_as_of AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
              ),
              'recorded_at', pg_catalog.to_char(
                serving.recorded_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
              ),
              'score_cohort_id', serving.score_cohort_id,
              'rank_mutation_seq', serving.rank_mutation_seq,
              'published_rank_count', serving.published_rank_count,
              'published_identity_sha256', serving.published_identity_sha256
            )
          )
        )
    )
    -- The publisher's isolation bound, at read time. "Declared" is the
    -- serving head's expected set plus the sources this season currently
    -- isolates; an isolated source never has a current witness.
    AND (
      SELECT
        (witnesses.not_current + isolated.source_count)
          <= (pg_catalog.cardinality(head.expected_sources) + isolated.source_count)
             * arena.rank_publication_max_isolated_ratio()
        AND (witnesses.current_core > 0 OR NOT core.declared)
      FROM (
        SELECT
          pg_catalog.count(*) FILTER (
            WHERE NOT arena.public_ranked_leaderboard_witness_is_current(
              serving.source_as_of,
              p_observed_at
            )
          ) AS not_current,
          pg_catalog.count(*) FILTER (
            WHERE arena.public_ranked_leaderboard_witness_is_current(
                    serving.source_as_of,
                    p_observed_at
                  )
              AND serving.source = ANY (arena.rank_publication_core_sources())
          ) AS current_core
        FROM ONLY arena.public_ranked_leaderboard_serving_sources AS serving
        WHERE serving.season_id = head.season_id
      ) AS witnesses
      CROSS JOIN (
        SELECT pg_catalog.count(*) AS source_count
        FROM ONLY arena.leaderboard_publication_source_isolations AS isolation
        WHERE isolation.season_id = head.season_id
      ) AS isolated
      CROSS JOIN (
        SELECT (
          head.expected_sources && arena.rank_publication_core_sources()
          OR EXISTS (
            SELECT 1
            FROM ONLY arena.leaderboard_publication_source_isolations AS isolation
            WHERE isolation.season_id = head.season_id
              AND isolation.filter_source = ANY (arena.rank_publication_core_sources())
          )
          OR EXISTS (
            SELECT 1
            FROM ONLY arena.leaderboard_publication_unsupported_sources AS unsupported
            WHERE unsupported.season_id = head.season_id
              AND unsupported.score_cohort_id = head.score_cohort_id
              AND unsupported.filter_sources && arena.rank_publication_core_sources()
          )
        ) AS declared
      ) AS core
    )
  ORDER BY head.season_id COLLATE "C";
END;
$function$;

-- The (season, source) pairs the public leaderboard serves right now: the
-- served seasons' witnesses of the serving cohort that are still current.
CREATE FUNCTION arena.public_ranked_leaderboard_served_sources(
  p_observed_at timestamptz
)
RETURNS TABLE (
  season_id text,
  source text,
  source_as_of timestamptz
)
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
  SELECT witness.season_id, witness.source, witness.source_as_of
  FROM arena.public_ranked_leaderboard_serving_seasons(p_observed_at) AS serving
  JOIN ONLY arena.public_ranked_leaderboard_serving_heads AS head
    ON head.season_id = serving.season_id
  JOIN ONLY arena.public_ranked_leaderboard_serving_sources AS witness
    ON witness.season_id = head.season_id
   AND witness.score_cohort_id = head.score_cohort_id
  WHERE arena.public_ranked_leaderboard_witness_is_current(
    witness.source_as_of,
    p_observed_at
  );
$function$;

ALTER FUNCTION arena.public_ranked_leaderboard_served_sources(timestamptz)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.public_ranked_leaderboard_served_sources(timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
-- The public view calls it as the querying role, like the season gate.
GRANT EXECUTE ON FUNCTION arena.public_ranked_leaderboard_served_sources(timestamptz)
  TO anon, authenticated, service_role;

-- The 20261123021904 view (37 columns, same options and owner); the rank rows
-- now join the served sources instead of the served seasons.
CREATE OR REPLACE VIEW public.public_ranked_leaderboard
WITH (security_barrier = true, security_invoker = false)
AS
WITH observed AS MATERIALIZED (
  SELECT pg_catalog.statement_timestamp() AS observed_at
),
served_sources AS MATERIALIZED (
  SELECT served.season_id, served.source
  FROM observed
  CROSS JOIN LATERAL arena.public_ranked_leaderboard_served_sources(
    observed.observed_at
  ) AS served
)
SELECT
  rank_row.id,
  rank_row.season_id,
  rank_row.source,
  rank_row.source_type,
  rank_row.source_trader_id,
  rank_row.rank,
  rank_row.arena_score,
  rank_row.arena_score_v3,
  rank_row.arena_score_v4,
  rank_row.roi,
  rank_row.pnl,
  rank_row.win_rate,
  rank_row.max_drawdown,
  rank_row.followers,
  rank_row.copiers,
  rank_row.trades_count,
  rank_row.handle,
  rank_row.avatar_url,
  rank_row.computed_at,
  rank_row.profitability_score,
  rank_row.risk_control_score,
  rank_row.execution_score,
  rank_row.score_completeness,
  rank_row.trading_style,
  rank_row.avg_holding_hours,
  rank_row.style_confidence,
  rank_row.sharpe_ratio,
  rank_row.sortino_ratio,
  rank_row.profit_factor,
  rank_row.calmar_ratio,
  rank_row.trader_type,
  rank_row.is_outlier,
  rank_row.metrics_estimated,
  rank_row.rank_change,
  rank_row.is_new,
  COALESCE(
    (rank_row.score_factors -> 'idle_window') = 'true'::pg_catalog.jsonb,
    false
  ) AS idle_window,
  COALESCE(
    (rank_row.score_factors -> 'mdd_contradiction') = 'true'::pg_catalog.jsonb,
    false
  ) AS mdd_contradiction
FROM public.leaderboard_ranks AS rank_row
JOIN served_sources AS served
  ON served.season_id = rank_row.season_id
 AND served.source = rank_row.source
JOIN ONLY arena.public_ranked_leaderboard_serving_heads AS head
  ON head.season_id = rank_row.season_id
 AND head.score_cohort_id = rank_row.rank_publication_id
JOIN ONLY arena.public_ranked_leaderboard_serving_sources AS source_witness
  ON source_witness.season_id = rank_row.season_id
 AND source_witness.source = rank_row.source
 AND source_witness.score_cohort_id = rank_row.rank_publication_id
CROSS JOIN observed
WHERE rank_row.rank IS NOT NULL
  AND arena.public_ranked_leaderboard_row_is_eligible(
    rank_row,
    observed.observed_at
  );

ALTER VIEW public.public_ranked_leaderboard OWNER TO postgres;

-- Same signature, owner and grants.
CREATE OR REPLACE FUNCTION arena.public_sealed_rank_sources()
RETURNS TABLE (season_id text, filter_source text, source_as_of timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT served.season_id, served.source, served.source_as_of
  FROM arena.public_ranked_leaderboard_served_sources(
    pg_catalog.statement_timestamp()
  ) AS served;
$function$;

-- Same columns, options, owner and grants.
CREATE OR REPLACE VIEW public.public_ranked_leaderboard_source_evidence
WITH (security_barrier = true, security_invoker = false)
AS
SELECT served.season_id,
       served.source,
       evidence.evidence_grade,
       served.source_as_of
FROM arena.public_ranked_leaderboard_served_sources(pg_catalog.statement_timestamp()) AS served
JOIN ONLY arena.public_ranked_leaderboard_serving_heads AS head
  ON head.season_id = served.season_id
LEFT JOIN arena.leaderboard_rank_publication_source_evidence AS evidence
  ON evidence.score_cohort_id = head.score_cohort_id
 AND evidence.source = served.source;

ALTER VIEW public.public_ranked_leaderboard_source_evidence OWNER TO postgres;

-- Same signature, owner, security and grants (20261121201553); a source is
-- visible when it is served and its sealed proof records published ranks.
CREATE OR REPLACE FUNCTION public.arena_visible_sources(p_season_id text DEFAULT '90D')
RETURNS TABLE (
  registry_slug text,
  filter_source text,
  exchange_slug text,
  exchange_name text,
  product_type text,
  trader_count integer,
  cache_updated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, arena, pg_temp
AS $$
  WITH served AS (
    SELECT
      freshness.source,
      freshness.published_rank_count AS trader_count,
      freshness.recorded_at
    FROM arena.public_ranked_leaderboard_served_sources(
           pg_catalog.statement_timestamp()
         ) AS serving
    JOIN arena.public_ranked_leaderboard_serving_heads AS head
      ON head.season_id = serving.season_id
    JOIN public.leaderboard_source_freshness AS freshness
      ON freshness.season_id = head.season_id
     AND freshness.source = serving.source
     AND freshness.score_cohort_id = head.score_cohort_id
    WHERE serving.season_id = p_season_id
      AND freshness.published_rank_count > 0
  )
  SELECT
    source_row.slug AS registry_slug,
    COALESCE(NULLIF(source_row.meta->>'legacy_platform', ''), source_row.slug) AS filter_source,
    exchange_row.slug AS exchange_slug,
    exchange_row.name AS exchange_name,
    source_row.product_type,
    served.trader_count,
    served.recorded_at AS cache_updated_at
  FROM arena.sources AS source_row
  JOIN arena.exchanges AS exchange_row ON exchange_row.id = source_row.exchange_id
  JOIN served
    ON served.source =
       COALESCE(NULLIF(source_row.meta->>'legacy_platform', ''), source_row.slug)
  WHERE p_season_id IN ('7D', '30D', '90D')
    AND source_row.status = 'active'
    AND source_row.serving_mode = 'serving'
    AND served.trader_count > 0
  ORDER BY exchange_row.name, source_row.product_type, source_row.slug;
$$;

COMMENT ON FUNCTION arena.public_ranked_leaderboard_serving_seasons(timestamptz) IS
  'Browser-callable season-only capability. It validates the bounded sealed witness set, current registry, immutable receipts, both rank mutation fences and the publisher isolation bound without running the full proof. A source outside the 48-hour window is left out by arena.public_ranked_leaderboard_served_sources, not by this gate.';
COMMENT ON FUNCTION arena.public_ranked_leaderboard_served_sources(timestamptz) IS
  'Browser-callable (season, source) pairs served right now: the served seasons'' sealed witnesses whose source watermark is within 48 hours.';
COMMENT ON VIEW public.public_ranked_leaderboard IS
  'Only current, globally sealed, source-fresh, full/non-estimated public leaderboard rows. Expected-source, cohort or rank-mutation drift hides the entire affected season; a source whose sealed watermark is older than 48 hours hides only its own rows, unless the publisher isolation bound is exceeded.';

DO $postflight$
DECLARE
  v_view_options text[];
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('arena.public_ranked_leaderboard_serving_seasons(timestamp with time zone)'
           ::pg_catalog.regprocedure),
        ('arena.public_ranked_leaderboard_served_sources(timestamp with time zone)'
           ::pg_catalog.regprocedure)
    ) AS capability(function_oid)
    JOIN pg_catalog.pg_proc AS procedure_row
      ON procedure_row.oid = capability.function_oid
    WHERE procedure_row.proowner <> 'postgres'::pg_catalog.regrole
       OR NOT procedure_row.prosecdef
       OR procedure_row.provolatile <> 's'
       OR NOT procedure_row.proisstrict
       OR NOT pg_catalog.has_function_privilege('anon', procedure_row.oid, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('authenticated', procedure_row.oid, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('service_role', procedure_row.oid, 'EXECUTE')
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.aclexplode(
           COALESCE(
             procedure_row.proacl,
             pg_catalog.acldefault('f', procedure_row.proowner)
           )
         ) AS privilege_row
         WHERE privilege_row.privilege_type = 'EXECUTE'
           AND privilege_row.grantee <> procedure_row.proowner
           AND privilege_row.grantee NOT IN (
             'anon'::pg_catalog.regrole,
             'authenticated'::pg_catalog.regrole,
             'service_role'::pg_catalog.regrole
           )
       )
  ) THEN
    RAISE EXCEPTION 'public serving capabilities have an unsafe security or EXECUTE boundary';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('arena.rank_publication_core_sources()'::pg_catalog.regprocedure),
        ('arena.rank_publication_max_isolated_ratio()'::pg_catalog.regprocedure),
        ('arena.public_ranked_leaderboard_witness_is_current(timestamp with time zone,timestamp with time zone)'
           ::pg_catalog.regprocedure)
    ) AS helper(function_oid)
    JOIN pg_catalog.pg_proc AS procedure_row
      ON procedure_row.oid = helper.function_oid
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        procedure_row.proacl,
        pg_catalog.acldefault('f', procedure_row.proowner)
      )
    ) AS privilege_row
    WHERE privilege_row.grantee <> procedure_row.proowner
  ) THEN
    RAISE EXCEPTION 'isolation-bound helpers must stay owner-only';
  END IF;

  SELECT relation.reloptions
  INTO v_view_options
  FROM pg_catalog.pg_class AS relation
  WHERE relation.oid = 'public.public_ranked_leaderboard'::pg_catalog.regclass;

  IF v_view_options IS NULL
     OR NOT (v_view_options @> ARRAY[
       'security_barrier=true',
       'security_invoker=false'
     ]::pg_catalog.text[])
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_attribute AS attribute
       WHERE attribute.attrelid =
             'public.public_ranked_leaderboard'::pg_catalog.regclass
         AND attribute.attname IN ('rank_publication_id', 'score_factors')
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
     ) THEN
    RAISE EXCEPTION 'public ranked leaderboard security barrier or projection regressed';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
