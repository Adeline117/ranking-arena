-- Migration: 20261118113759_expected_sources_require_capture_contract.sql
-- Description: A season's expected source set (the freshness/publication
--   denominator) contains only sources with a valid attempt-bound capture
--   contract registration. Sources without one are listed as "unsupported"
--   instead of counting as stale.
--
-- Before: public.arena_freshness_expected_sources() returns every active +
-- serving source that declares the season. Tier-A refuses a source without an
-- exact arena.leaderboard_capture_contracts row before any upstream session
-- (worker/src/ingest/processors/tier-a-leaderboard.ts), so such a source can
-- never carry fresh attempt-bound evidence. It still counted in the
-- denominator, and the orchestrator's >50%-not-fresh rule refused every season.
--
-- After: the expected set additionally requires a valid registration, defined
-- exactly as lib/ingest/acquisition-attempts.ts validates the row it selects:
--   * capture_contract is a known attempt-bound contract
--     (arena.ingest.leaderboard-acquisition-manifest@3 or @4),
--   * adapter_slug equals the source's adapter_slug,
--   * attempt_binding_contract = arena.ingest.leaderboard-acquisition-attempt-binding@1,
--   * requires_runner_git_sha is true.
-- The predicate lives in one helper, arena.leaderboard_capture_contract_registered,
-- and is added to the single freshness authority (a static, digest-fenced
-- replacement of the reviewed post-isolation body), so every SQL consumer
-- (cleanup, rerank, seal, serving-authority trigger, read-time serving check
-- arena.public_ranked_leaderboard_serving_seasons, freshness report) and the
-- TypeScript orchestrator (which reads the same function) use the identical
-- set. Nothing else in SQL computes the denominator.
--
-- Unsupported sources never silently disappear:
--   * public.arena_publication_unsupported_sources() (service_role) lists the
--     (season, filter_source) pairs the contract predicate removes. It reads
--     the same freshness function with the predicate switched off through a
--     function-local setting, so it cannot drift from the expected set. The
--     setting can only ever widen the expected set (fail-closed).
--   * arena.leaderboard_publication_unsupported_sources records, inside each
--     publication transaction, the unsupported list of that cohort
--     (append-only, rolled back with a refused publication).
--   * public.public_leaderboard_unsupported_sources() (anon) returns that list
--     for each season's current serving head, for the "not yet supported"
--     label on the public page.
--
-- Not loosened: the orchestrator still refuses when more than half of the
-- (reduced) expected set lacks fresh evidence, still treats an unsupported
-- core source as not fresh for the every-core-source-down rule, and refuses
-- when the reduced set falls below RANK_PUBLICATION_MIN_EXPECTED_SOURCES, so
-- an emptied contract table can never pass as 0/0.
--
-- Changing the live expected set also changes the read-time serving check
-- (head.expected_sources must equal the live set), so a serving head sealed
-- under the old set stops serving until the next publication, exactly as when
-- a source is activated or deactivated.
--
-- POSTDEPLOY: the orchestrator release that records unsupported sources and
-- enforces the floor must serve first; the previous orchestrator would publish
-- the reduced set without either. Requires 20261113011058 (isolation rewrite of
-- the same function). Generated only; not applied to any environment.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
BEGIN
  IF pg_catalog.to_regprocedure('public.arena_freshness_expected_sources()') IS NULL
     OR pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_capture_contracts') IS NULL
     OR pg_catalog.to_regclass('arena.public_ranked_leaderboard_serving_heads') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL THEN
    RAISE EXCEPTION
      'capture-contract expected sources require the freshness authority, capture registry, serving heads and Supabase roles';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid =
          pg_catalog.to_regprocedure('public.arena_freshness_expected_sources()')
      AND pg_catalog.strpos(function_row.prosrc,
            'leaderboard-publication-source-isolation@1') > 0
  ) THEN
    RAISE EXCEPTION
      'capture-contract expected sources require the source isolation rewrite (20261113011058)';
  END IF;
END
$preflight$;

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('20261118_expected_sources_require_capture_contract', 0)
);

-- The single definition of "valid capture contract registration". Mirrors
-- lib/ingest/acquisition-attempts.ts (findRegisteredAttemptBound...): a
-- contract row the worker would accept for this source and its adapter.
CREATE OR REPLACE FUNCTION arena.leaderboard_capture_contract_registered(
  p_source_id integer,
  p_adapter_slug text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  -- leaderboard-capture-contract-registration@1
  SELECT EXISTS (
    SELECT 1
    FROM arena.leaderboard_capture_contracts AS capture
    WHERE capture.source_id = p_source_id
      AND capture.adapter_slug = p_adapter_slug
      AND capture.capture_contract IN (
        'arena.ingest.leaderboard-acquisition-manifest@3',
        'arena.ingest.leaderboard-acquisition-manifest@4'
      )
      AND capture.attempt_binding_contract =
          'arena.ingest.leaderboard-acquisition-attempt-binding@1'
      AND capture.requires_runner_git_sha IS TRUE
  );
$function$;

ALTER FUNCTION arena.leaderboard_capture_contract_registered(integer, text)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION arena.leaderboard_capture_contract_registered(integer, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION arena.leaderboard_capture_contract_registered(integer, text)
  TO service_role;

-- Replace the freshness authority with the reviewed post-isolation body plus
-- the registration predicate. The current body must be exactly the one
-- 20261113011058 leaves after the Bitget-bot quarantine (prosrc sha256
-- 9427c4e0...; the quarantine's own c69d25e9... reproduces exactly in the
-- pg17 proof), or this migration's own body on replay; anything else refuses.
-- The function-local setting arena.freshness_include_unsupported lets the
-- unsupported reader below see the same rows without the predicate.
DO $expected_sources_digest$
DECLARE
  v_sha256 text;
BEGIN
  SELECT pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc, 'UTF8')), 'hex')
  INTO STRICT v_sha256
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
        pg_catalog.to_regprocedure('public.arena_freshness_expected_sources()');

  IF v_sha256 NOT IN (
    -- after 20261113011058
    '9427c4e01af650268ec07534a61101d9f177b38f07ceec621ae4e4b0a8cbc56b',
    -- this migration (replay)
    '2d7d679a100ed09b60c40a53e57d7bd2907d624a6738c7c49ce81496b0e9ebd2'
  ) THEN
    RAISE EXCEPTION
      'arena_freshness_expected_sources body drifted from the reviewed post-isolation body: %',
      v_sha256;
  END IF;
END
$expected_sources_digest$;

CREATE OR REPLACE FUNCTION public.arena_freshness_expected_sources()
RETURNS TABLE (
  registry_slug text,
  filter_source text,
  exchange_name text,
  season_id text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT
    source_row.slug AS registry_slug,
    COALESCE(
      NULLIF(pg_catalog.btrim(source_row.meta->>'legacy_platform'), ''),
      source_row.slug
    ) AS filter_source,
    exchange_row.name AS exchange_name,
    (timeframe.day_count::text || 'D') AS season_id
  FROM arena.sources AS source_row
  JOIN arena.exchanges AS exchange_row
    ON exchange_row.id = source_row.exchange_id
  CROSS JOIN LATERAL (
    SELECT DISTINCT declared.day_count
    FROM unnest(
      source_row.timeframes_native || source_row.timeframes_derived
    ) AS declared(day_count)
    WHERE declared.day_count IN (7, 30, 90)
  ) AS timeframe
  WHERE source_row.status = 'active'
    AND source_row.serving_mode = 'serving'
    -- leaderboard-capture-contract-registration@1
    AND (
      arena.leaderboard_capture_contract_registered(
        source_row.id::integer,
        source_row.adapter_slug
      )
      OR pg_catalog.current_setting('arena.freshness_include_unsupported', true)
         IS NOT DISTINCT FROM 'on'
    )
    -- leaderboard-publication-source-isolation@1
    AND NOT EXISTS (
      SELECT 1
      FROM arena.leaderboard_publication_source_isolations AS isolation
      WHERE isolation.season_id = (timeframe.day_count::text || 'D')
        AND isolation.filter_source = COALESCE(
          NULLIF(pg_catalog.btrim(source_row.meta->>'legacy_platform'), ''),
          source_row.slug
        )
    )
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
    -- Historical registry imports used the JSON string "null" as a sentinel.
    -- Score inputs and source-watermark publication exclude it too.
    AND pg_catalog.btrim(
      COALESCE(source_row.meta->>'legacy_platform', '')
    ) <> 'null'
  ORDER BY
    exchange_row.name,
    source_row.slug,
    timeframe.day_count;
$function$;

ALTER FUNCTION public.arena_freshness_expected_sources() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.arena_freshness_expected_sources()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.arena_freshness_expected_sources() TO service_role;

-- (season, filter_source) pairs the registration predicate removes from the
-- expected set: declared by an active+serving source, but no registry row of
-- that filter_source and season holds a valid registration.
CREATE OR REPLACE FUNCTION public.arena_publication_unsupported_sources()
RETURNS TABLE (
  registry_slug text,
  filter_source text,
  exchange_name text,
  season_id text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET arena.freshness_include_unsupported = 'on'
AS $function$
  -- leaderboard-capture-contract-registration@1
  WITH declared AS MATERIALIZED (
    SELECT
      declared.registry_slug,
      declared.filter_source,
      declared.exchange_name,
      declared.season_id,
      arena.leaderboard_capture_contract_registered(
        source_row.id::integer,
        source_row.adapter_slug
      ) AS registered
    FROM public.arena_freshness_expected_sources() AS declared
    JOIN arena.sources AS source_row
      ON source_row.slug = declared.registry_slug
  )
  SELECT
    declared.registry_slug,
    declared.filter_source,
    declared.exchange_name,
    declared.season_id
  FROM declared
  WHERE NOT declared.registered
    AND NOT EXISTS (
      SELECT 1
      FROM declared AS sibling
      WHERE sibling.registered
        AND sibling.season_id = declared.season_id
        AND sibling.filter_source = declared.filter_source
    )
  ORDER BY declared.filter_source, declared.season_id, declared.registry_slug;
$function$;

ALTER FUNCTION public.arena_publication_unsupported_sources() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.arena_publication_unsupported_sources()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.arena_publication_unsupported_sources() TO service_role;

COMMENT ON FUNCTION public.arena_publication_unsupported_sources() IS
  'Active+serving declared season sources left out of arena_freshness_expected_sources() because no valid attempt-bound capture contract is registered (not yet supported, not stale).';

-- Per-publication evidence: the unsupported list each sealed cohort excluded.
CREATE TABLE IF NOT EXISTS arena.leaderboard_publication_unsupported_sources (
  season_id text NOT NULL CHECK (season_id IN ('7D', '30D', '90D')),
  score_cohort_id uuid NOT NULL,
  filter_sources text[] NOT NULL
    CHECK (
      pg_catalog.cardinality(filter_sources) <= 256
      AND pg_catalog.array_position(filter_sources, NULL) IS NULL
    ),
  recorded_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp()
    CHECK (pg_catalog.isfinite(recorded_at)),
  PRIMARY KEY (season_id, score_cohort_id)
);

CREATE OR REPLACE FUNCTION arena.reject_leaderboard_publication_unsupported_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'leaderboard publication unsupported-source records are append-only'
    USING ERRCODE = '42501';
END;
$function$;

CREATE OR REPLACE TRIGGER leaderboard_publication_unsupported_immutable
  BEFORE UPDATE OR DELETE
  ON arena.leaderboard_publication_unsupported_sources
  FOR EACH ROW
  EXECUTE FUNCTION arena.reject_leaderboard_publication_unsupported_mutation();

ALTER TABLE arena.leaderboard_publication_unsupported_sources OWNER TO postgres;
ALTER FUNCTION arena.reject_leaderboard_publication_unsupported_mutation() OWNER TO postgres;
ALTER TABLE arena.leaderboard_publication_unsupported_sources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE arena.leaderboard_publication_unsupported_sources
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.reject_leaderboard_publication_unsupported_mutation()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE arena.leaderboard_publication_unsupported_sources
  TO service_role;

COMMENT ON TABLE arena.leaderboard_publication_unsupported_sources IS
  'Per sealed cohort: declared sources excluded from the expected set for lack of a valid capture contract registration. Written only inside the publication transaction; append-only.';

-- Public: the unsupported list of each season's current serving head.
CREATE OR REPLACE FUNCTION public.public_leaderboard_unsupported_sources()
RETURNS TABLE (
  season_id text,
  filter_source text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT recorded.season_id, unsupported.filter_source
  FROM ONLY arena.public_ranked_leaderboard_serving_heads AS head
  JOIN ONLY arena.leaderboard_publication_unsupported_sources AS recorded
    ON recorded.season_id = head.season_id
   AND recorded.score_cohort_id = head.score_cohort_id
  CROSS JOIN LATERAL pg_catalog.unnest(recorded.filter_sources)
    AS unsupported(filter_source)
  ORDER BY recorded.season_id, unsupported.filter_source;
$function$;

ALTER FUNCTION public.public_leaderboard_unsupported_sources() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.public_leaderboard_unsupported_sources()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.public_leaderboard_unsupported_sources()
  TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.public_leaderboard_unsupported_sources() IS
  'Sources the current serving publication of each season lists as not yet supported (no capture contract registered). Labels only; carries no ranking data.';

DO $postflight$
DECLARE
  v_function oid := pg_catalog.to_regprocedure('public.arena_freshness_expected_sources()');
  v_function_row pg_catalog.pg_proc%ROWTYPE;
BEGIN
  SELECT function_row.*
  INTO STRICT v_function_row
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_function;

  IF pg_catalog.encode(
       pg_catalog.sha256(pg_catalog.convert_to(v_function_row.prosrc, 'UTF8')), 'hex')
       <> '2d7d679a100ed09b60c40a53e57d7bd2907d624a6738c7c49ce81496b0e9ebd2'
     OR v_function_row.proconfig
        IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
     OR NOT v_function_row.prosecdef
     OR v_function_row.proowner <> 'postgres'::pg_catalog.regrole
     OR pg_catalog.has_function_privilege('anon', v_function, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_function, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('service_role', v_function, 'EXECUTE')
     OR pg_catalog.has_function_privilege(
       'anon', 'arena.leaderboard_capture_contract_registered(integer,text)', 'EXECUTE')
     OR pg_catalog.has_function_privilege(
       'anon', 'public.arena_publication_unsupported_sources()', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege(
       'service_role', 'public.arena_publication_unsupported_sources()', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege(
       'anon', 'public.public_leaderboard_unsupported_sources()', 'EXECUTE')
     OR pg_catalog.has_table_privilege(
       'anon', 'arena.leaderboard_publication_unsupported_sources', 'SELECT')
     OR pg_catalog.has_table_privilege(
       'service_role', 'arena.leaderboard_publication_unsupported_sources', 'UPDATE') THEN
    RAISE EXCEPTION 'capture-contract expected sources postflight failed';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
