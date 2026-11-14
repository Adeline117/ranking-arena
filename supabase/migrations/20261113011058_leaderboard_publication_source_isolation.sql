-- Per-season source isolation for public leaderboard publication.
--
-- Before: the season's expected source set (arena_freshness_expected_sources)
-- is every active+serving source, and seal/cleanup/serving all require EVERY
-- expected source to carry fresh (<48h) evidence. One geo-blocked or broken
-- source therefore stopped every season from publishing; 48h later the old
-- serving head expired and the whole public leaderboard went empty.
--
-- After: the publication orchestrator (lib/rankings/publication/publish-season.ts)
-- may, inside its single READ COMMITTED publication transaction, record a
-- (season, filter_source) isolation row for a source without fresh evidence.
-- arena_freshness_expected_sources() leaves isolated sources out, so cleanup,
-- rerank, seal, the serving-authority trigger and the read-time serving check
-- all agree on the reduced set atomically with the seal. Rows of an isolated
-- source keep their data but get rank NULL from the rerank and have no serving
-- witness, so they are never served. A failed publication rolls the isolation
-- change back together with everything else. The orchestrator clears every
-- isolation row of the season at the start of each publication and
-- re-isolates only sources that are still not fresh, so a recovered source
-- rejoins in the same transaction that seals it.
--
-- Safety bounds (more than half of the expected sources, or every core source,
-- not fresh => refuse the whole season) live in the orchestrator, which alerts.
--
-- Every isolation decision is also appended to an immutable event log.
--
-- Generated only; not applied to any environment. Must run after the
-- freshness-authority rewrites (20261111134416 in the 20260728124000 slot).

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
BEGIN
  IF pg_catalog.to_regprocedure('public.arena_freshness_expected_sources()') IS NULL
     OR pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL THEN
    RAISE EXCEPTION 'source isolation requires the freshness authority and Supabase roles';
  END IF;
END
$preflight$;

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('20261113_leaderboard_publication_source_isolation', 0)
);

CREATE TABLE IF NOT EXISTS arena.leaderboard_publication_source_isolations (
  season_id text NOT NULL CHECK (season_id IN ('7D', '30D', '90D')),
  filter_source text NOT NULL
    CHECK (filter_source ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
  reasons text[] NOT NULL
    CHECK (pg_catalog.cardinality(reasons) BETWEEN 1 AND 32),
  first_isolated_at timestamptz NOT NULL,
  isolated_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  score_cohort_id uuid NOT NULL,
  PRIMARY KEY (season_id, filter_source),
  CHECK (pg_catalog.isfinite(first_isolated_at) AND pg_catalog.isfinite(isolated_at)),
  CHECK (first_isolated_at <= isolated_at)
);

CREATE TABLE IF NOT EXISTS arena.leaderboard_publication_source_isolation_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  season_id text NOT NULL CHECK (season_id IN ('7D', '30D', '90D')),
  filter_source text NOT NULL,
  action text NOT NULL CHECK (action IN ('isolated', 'restored')),
  reasons text[] NOT NULL DEFAULT '{}'::text[],
  score_cohort_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp()
);

CREATE INDEX IF NOT EXISTS leaderboard_publication_source_isolation_events_lookup
  ON arena.leaderboard_publication_source_isolation_events (season_id, filter_source, recorded_at DESC);

CREATE OR REPLACE FUNCTION arena.reject_leaderboard_publication_isolation_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'leaderboard publication isolation events are append-only'
    USING ERRCODE = '42501';
END;
$function$;

DROP TRIGGER IF EXISTS leaderboard_publication_isolation_events_immutable
  ON arena.leaderboard_publication_source_isolation_events;
CREATE TRIGGER leaderboard_publication_isolation_events_immutable
  BEFORE UPDATE OR DELETE
  ON arena.leaderboard_publication_source_isolation_events
  FOR EACH ROW
  EXECUTE FUNCTION arena.reject_leaderboard_publication_isolation_event_mutation();

ALTER TABLE arena.leaderboard_publication_source_isolations OWNER TO postgres;
ALTER TABLE arena.leaderboard_publication_source_isolation_events OWNER TO postgres;
ALTER FUNCTION arena.reject_leaderboard_publication_isolation_event_mutation() OWNER TO postgres;
ALTER TABLE arena.leaderboard_publication_source_isolations ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.leaderboard_publication_source_isolation_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE arena.leaderboard_publication_source_isolations
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE arena.leaderboard_publication_source_isolation_events
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.reject_leaderboard_publication_isolation_event_mutation()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, DELETE ON TABLE arena.leaderboard_publication_source_isolations
  TO service_role;
GRANT SELECT, INSERT ON TABLE arena.leaderboard_publication_source_isolation_events
  TO service_role;

COMMENT ON TABLE arena.leaderboard_publication_source_isolations IS
  'Sources left out of a season''s expected set by the publication that sealed it (not fresh / not count-check passed). Written only inside the publication transaction.';
COMMENT ON TABLE arena.leaderboard_publication_source_isolation_events IS
  'Append-only log of publication source isolation/restoration decisions.';

-- Monitoring view of the current isolations. Isolated sources leave the
-- expected set, so the freshness report must list them from here instead of
-- letting them disappear. Service-role only.
CREATE OR REPLACE FUNCTION public.arena_publication_source_isolations()
RETURNS TABLE (
  season_id text,
  filter_source text,
  reasons text[],
  first_isolated_at timestamptz,
  isolated_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT isolation.season_id, isolation.filter_source, isolation.reasons,
         isolation.first_isolated_at, isolation.isolated_at
  FROM arena.leaderboard_publication_source_isolations AS isolation
  ORDER BY isolation.filter_source, isolation.season_id;
$function$;

ALTER FUNCTION public.arena_publication_source_isolations() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.arena_publication_source_isolations()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.arena_publication_source_isolations() TO service_role;

-- Exclude isolated (season, filter_source) pairs from the freshness authority.
-- The anchor is the shared serving predicate, present exactly once both in the
-- original 20260718134000 body and after the Bitget-bot quarantine rewrite.
DO $rewrite_expected_sources$
DECLARE
  v_function oid := pg_catalog.to_regprocedure('public.arena_freshness_expected_sources()');
  v_source text;
  v_needle constant text := E'source_row.serving_mode = ''serving''\n';
  v_marker constant text := 'leaderboard-publication-source-isolation@1';
  v_needle_count integer;
  v_definition text;
BEGIN
  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_function;

  IF pg_catalog.strpos(v_source, v_marker) > 0 THEN
    RETURN; -- already rewritten (idempotent replay)
  END IF;

  v_needle_count := (
    pg_catalog.length(v_source)
    - pg_catalog.length(pg_catalog.replace(v_source, v_needle, ''))
  ) / pg_catalog.length(v_needle);
  IF v_needle_count <> 1
     OR pg_catalog.strpos(v_source, 'timeframe.day_count') = 0 THEN
    RAISE EXCEPTION
      'arena_freshness_expected_sources body drifted (serving anchor count %)',
      v_needle_count;
  END IF;

  v_definition := pg_catalog.replace(
    pg_catalog.pg_get_functiondef(v_function),
    v_needle,
    v_needle || $predicate$    -- leaderboard-publication-source-isolation@1
    AND NOT EXISTS (
      SELECT 1
      FROM arena.leaderboard_publication_source_isolations AS isolation
      WHERE isolation.season_id = (timeframe.day_count::text || 'D')
        AND isolation.filter_source = COALESCE(
          NULLIF(pg_catalog.btrim(source_row.meta->>'legacy_platform'), ''),
          source_row.slug
        )
    )
$predicate$
  );
  EXECUTE v_definition;
END
$rewrite_expected_sources$;

DO $postflight$
DECLARE
  v_function oid := pg_catalog.to_regprocedure('public.arena_freshness_expected_sources()');
  v_function_row pg_catalog.pg_proc%ROWTYPE;
BEGIN
  SELECT function_row.*
  INTO STRICT v_function_row
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_function;

  IF (
       pg_catalog.length(v_function_row.prosrc)
       - pg_catalog.length(pg_catalog.replace(
           v_function_row.prosrc, 'leaderboard-publication-source-isolation@1', ''))
     ) / pg_catalog.length('leaderboard-publication-source-isolation@1') <> 1
     OR NOT v_function_row.prosecdef
     OR v_function_row.proowner <> 'postgres'::pg_catalog.regrole
     OR pg_catalog.has_function_privilege('anon', v_function, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_function, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('service_role', v_function, 'EXECUTE')
     OR pg_catalog.has_function_privilege(
       'anon', 'public.arena_publication_source_isolations()', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege(
       'service_role', 'public.arena_publication_source_isolations()', 'EXECUTE')
     OR pg_catalog.has_table_privilege(
       'anon', 'arena.leaderboard_publication_source_isolations', 'SELECT')
     OR pg_catalog.has_table_privilege(
       'authenticated', 'arena.leaderboard_publication_source_isolation_events', 'SELECT') THEN
    RAISE EXCEPTION 'source isolation postflight failed';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
