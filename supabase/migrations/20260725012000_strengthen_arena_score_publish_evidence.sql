-- Strengthen the publication bundle without changing its callable identity.
-- The writer needs both the complete selected-snapshot cardinality and the
-- exact subset admitted by its requested rank limit. It must also fail closed
-- when the latest PASSED watermark is ambiguous or a later acquisition failed.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $preflight$
DECLARE
  v_bundle_function oid := pg_catalog.to_regprocedure(
    'public.arena_score_inputs_publish_bundle_json(text,integer,integer)'
  );
  v_legacy_function oid := pg_catalog.to_regprocedure(
    'public.arena_score_inputs_json(text,integer,integer)'
  );
BEGIN
  IF v_bundle_function IS NULL OR v_legacy_function IS NULL THEN
    RAISE EXCEPTION
      'score-input bundle and legacy JSON functions must exist before evidence strengthening';
  END IF;

  IF pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_snapshots') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_entries') IS NULL THEN
    RAISE EXCEPTION 'source registry, snapshots, and entries must exist';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid =
      'arena.leaderboard_entries'::pg_catalog.regclass
      AND attribute.attname = 'rank'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) THEN
    RAISE EXCEPTION 'arena.leaderboard_entries.rank must exist';
  END IF;

  IF pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL THEN
    RAISE EXCEPTION 'PostgREST API roles must exist';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_bundle_function
      AND function_row.prokind = 'f'
      AND function_row.prorettype = 'pg_catalog.jsonb'::pg_catalog.regtype
      AND NOT function_row.proretset
      AND function_row.pronargs = 3
      AND function_row.pronargdefaults = 2
      AND function_row.prosecdef
      AND function_row.provolatile = 's'
      AND function_row.proconfig =
        ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
  ) THEN
    RAISE EXCEPTION 'score-input publish bundle callable contract drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.oid = v_legacy_function
      AND function_row.prokind = 'f'
      AND language_row.lanname = 'sql'
      AND function_row.prorettype = 'pg_catalog.jsonb'::pg_catalog.regtype
      AND NOT function_row.proretset
      AND function_row.pronargs = 3
      AND function_row.pronargdefaults = 2
      AND function_row.proargnames IS NOT DISTINCT FROM ARRAY[
        'p_window',
        'p_per_platform_limit',
        'p_max_age_hours'
      ]::pg_catalog.text[]
      AND pg_catalog.pg_get_expr(function_row.proargdefaults, 0)
          = '1000, 48'
      AND function_row.prosecdef
      AND function_row.provolatile = ANY (
        ARRAY['v', 's']::"char"[]
      )
      AND function_row.proconfig =
        ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
      AND function_row.prosrc ~* '^\s*(SELECT|WITH)\M'
      AND function_row.prosrc !~* '\m(INSERT|UPDATE|DELETE|MERGE|CALL|COPY|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE|DO)\M'
  ) THEN
    RAISE EXCEPTION 'legacy score-input JSON read contract drifted';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
       'service_role', v_bundle_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'anon', v_bundle_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated', v_bundle_function, 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'score-input publish bundle execution boundary drifted';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
       'service_role', v_legacy_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'anon', v_legacy_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated', v_legacy_function, 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'legacy score-input JSON execution boundary drifted';
  END IF;
END
$preflight$;

-- CREATE OR REPLACE must preserve every callable catalog property. Capturing
-- these values also makes migration replay prove OID and ACL stability.
CREATE TEMP TABLE arena_score_publish_bundle_contract_before
ON COMMIT DROP
AS
SELECT
  function_row.oid,
  function_row.proowner,
  function_row.proacl,
  function_row.prolang,
  function_row.prokind,
  function_row.prorettype,
  function_row.proretset,
  function_row.pronargs,
  function_row.pronargdefaults,
  function_row.proargtypes::pg_catalog.text AS proargtypes,
  function_row.proargnames,
  function_row.proargmodes,
  function_row.proargdefaults::pg_catalog.text AS proargdefaults,
  function_row.prosecdef,
  function_row.proleakproof,
  function_row.proisstrict,
  function_row.proconfig,
  function_row.provolatile,
  function_row.proparallel
FROM pg_catalog.pg_proc AS function_row
WHERE function_row.oid =
  'public.arena_score_inputs_publish_bundle_json(text,integer,integer)'
    ::pg_catalog.regprocedure;

-- The production hot-path replacement historically omitted STABLE and is
-- therefore VOLATILE by default. Preserve its entire pg_proc row before the
-- one intentional volatility correction.
CREATE TEMP TABLE arena_score_inputs_json_catalog_before
ON COMMIT DROP
AS
SELECT function_row.*
FROM pg_catalog.pg_proc AS function_row
WHERE function_row.oid =
  'public.arena_score_inputs_json(text,integer,integer)'
    ::pg_catalog.regprocedure;

-- A VOLATILE SQL function takes a fresh snapshot for each query in its body.
-- Marking this read-only surface STABLE makes its nested execution share the
-- caller statement snapshot. This must precede the strengthened bundle body.
ALTER FUNCTION public.arena_score_inputs_json(text, int, int) STABLE;

CREATE OR REPLACE FUNCTION public.arena_score_inputs_publish_bundle_json(
  p_window text,
  p_per_platform_limit int DEFAULT 1000,
  p_max_age_hours int DEFAULT 48
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF p_window IS NULL OR p_window NOT IN ('7D', '30D', '90D') THEN
    RAISE EXCEPTION 'invalid score-input publish window: %', p_window
      USING ERRCODE = '22023';
  END IF;

  IF p_per_platform_limit IS NULL OR p_per_platform_limit <= 0 THEN
    RAISE EXCEPTION 'score-input publish limit must be positive: %',
      p_per_platform_limit
      USING ERRCODE = '22023';
  END IF;

  IF p_max_age_hours IS NULL OR p_max_age_hours <= 0 THEN
    RAISE EXCEPTION 'score-input publish max age must be positive: %',
      p_max_age_hours
      USING ERRCODE = '22023';
  END IF;

  -- Every arena relation and the legacy score-row RPC are read by this one SQL
  -- statement, so scoreRows and physicalBoards share one statement snapshot.
  RETURN (
  WITH requested_window AS MATERIALIZED (
    SELECT CASE p_window
      WHEN '7D' THEN 7::pg_catalog.int2
      WHEN '30D' THEN 30::pg_catalog.int2
      WHEN '90D' THEN 90::pg_catalog.int2
      ELSE NULL::pg_catalog.int2
    END AS timeframe
  ),
  registry_boards AS MATERIALIZED (
    SELECT
      source_row.id AS source_id,
      source_row.slug AS registry_slug,
      COALESCE(
        NULLIF(pg_catalog.btrim(source_row.meta->>'legacy_platform'), ''),
        source_row.slug
      ) AS filter_source,
      requested.timeframe
    FROM arena.sources AS source_row
    CROSS JOIN requested_window AS requested
    WHERE requested.timeframe IS NOT NULL
      AND source_row.status = 'active'
      AND source_row.serving_mode = 'serving'
      AND requested.timeframe = ANY (
        COALESCE(source_row.timeframes_native, ARRAY[]::pg_catalog.int4[])
        || COALESCE(source_row.timeframes_derived, ARRAY[]::pg_catalog.int4[])
      )
      AND pg_catalog.btrim(
        COALESCE(source_row.meta->>'legacy_platform', '')
      ) <> 'null'
  ),
  latest_snapshot_attempt AS MATERIALIZED (
    SELECT DISTINCT ON (snapshot.source_id)
      snapshot.source_id,
      snapshot.id AS latest_attempt_id,
      snapshot.scraped_at AS latest_attempt_scraped_at,
      snapshot.count_check_passed AS latest_attempt_passed
    FROM arena.leaderboard_snapshots AS snapshot
    JOIN registry_boards AS registry
      ON registry.source_id = snapshot.source_id
     AND registry.timeframe = snapshot.timeframe
    ORDER BY
      snapshot.source_id,
      snapshot.scraped_at DESC,
      snapshot.id DESC
  ),
  passed_snapshots AS MATERIALIZED (
    SELECT
      snapshot.source_id,
      snapshot.id AS snapshot_id,
      snapshot.scraped_at,
      snapshot.actual_count,
      pg_catalog.count(*) OVER (
        PARTITION BY snapshot.source_id, snapshot.scraped_at
      )::bigint AS latest_passed_tie_count,
      pg_catalog.row_number() OVER (
        PARTITION BY snapshot.source_id
        ORDER BY snapshot.scraped_at DESC, snapshot.id DESC
      ) AS selected_order
    FROM arena.leaderboard_snapshots AS snapshot
    JOIN registry_boards AS registry
      ON registry.source_id = snapshot.source_id
     AND registry.timeframe = snapshot.timeframe
    WHERE snapshot.count_check_passed
  ),
  latest_passed_snapshot AS MATERIALIZED (
    SELECT
      passed.source_id,
      passed.snapshot_id,
      passed.scraped_at,
      passed.actual_count,
      passed.latest_passed_tie_count
    FROM passed_snapshots AS passed
    WHERE passed.selected_order = 1
  ),
  passed_entry_counts AS MATERIALIZED (
    SELECT
      passed.snapshot_id,
      pg_catalog.count(entry.snapshot_id)::bigint AS entry_count,
      pg_catalog.count(entry.snapshot_id) FILTER (
        WHERE entry.rank <= p_per_platform_limit
      )::bigint AS rank_limited_entry_count
    FROM latest_passed_snapshot AS passed
    LEFT JOIN arena.leaderboard_entries AS entry
      ON entry.snapshot_id = passed.snapshot_id
     AND entry.scraped_at = passed.scraped_at
    GROUP BY passed.snapshot_id
  ),
  physical_board_evidence AS MATERIALIZED (
    SELECT
      registry.registry_slug,
      registry.filter_source,
      registry.timeframe,
      passed.snapshot_id,
      passed.scraped_at,
      passed.actual_count,
      CASE
        WHEN passed.snapshot_id IS NULL THEN NULL::bigint
        ELSE COALESCE(entry_count.entry_count, 0::bigint)
      END AS entry_count,
      p_per_platform_limit AS rank_limit,
      CASE
        WHEN passed.snapshot_id IS NULL THEN NULL::bigint
        ELSE COALESCE(entry_count.rank_limited_entry_count, 0::bigint)
      END AS rank_limited_entry_count,
      COALESCE(passed.latest_passed_tie_count, 0::bigint)
        AS latest_passed_tie_count,
      CASE
        WHEN passed.snapshot_id IS NULL
             AND attempt.latest_attempt_id IS NULL THEN 'missing'
        WHEN passed.snapshot_id IS NULL THEN 'failed'
        WHEN passed.latest_passed_tie_count > 1 THEN 'ambiguous_latest'
        WHEN attempt.latest_attempt_passed IS FALSE
             AND attempt.latest_attempt_scraped_at >= passed.scraped_at
          THEN 'latest_attempt_failed'
        WHEN passed.scraped_at
             > pg_catalog.statement_timestamp() + interval '5 minutes'
          THEN 'future'
        WHEN passed.scraped_at
             <= pg_catalog.statement_timestamp()
                - pg_catalog.make_interval(hours => p_max_age_hours)
          THEN 'stale'
        WHEN passed.actual_count::bigint
             IS DISTINCT FROM COALESCE(entry_count.entry_count, 0::bigint)
          THEN 'entry_count_mismatch'
        ELSE 'passed'
      END AS evidence_status,
      attempt.latest_attempt_id,
      attempt.latest_attempt_scraped_at,
      attempt.latest_attempt_passed
    FROM registry_boards AS registry
    LEFT JOIN latest_passed_snapshot AS passed
      ON passed.source_id = registry.source_id
    LEFT JOIN passed_entry_counts AS entry_count
      ON entry_count.snapshot_id = passed.snapshot_id
    LEFT JOIN latest_snapshot_attempt AS attempt
      ON attempt.source_id = registry.source_id
  ),
  physical_boards_json AS MATERIALIZED (
    SELECT COALESCE(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'registry_slug', evidence.registry_slug,
          'filter_source', evidence.filter_source,
          'window', evidence.timeframe::text || 'D',
          'snapshot_id', evidence.snapshot_id,
          'scraped_at', evidence.scraped_at,
          'actual_count', evidence.actual_count,
          'entry_count', evidence.entry_count,
          'rank_limit', evidence.rank_limit,
          'rank_limited_entry_count', evidence.rank_limited_entry_count,
          'latest_passed_tie_count', evidence.latest_passed_tie_count,
          'evidence_status', evidence.evidence_status,
          'latest_attempt_id', evidence.latest_attempt_id,
          'latest_attempt_scraped_at', evidence.latest_attempt_scraped_at,
          'latest_attempt_passed', evidence.latest_attempt_passed
        )
        ORDER BY evidence.registry_slug
      ),
      '[]'::pg_catalog.jsonb
    ) AS payload
    FROM physical_board_evidence AS evidence
  )
  SELECT pg_catalog.jsonb_build_object(
    'scoreRows', public.arena_score_inputs_json(
      p_window,
      p_per_platform_limit,
      p_max_age_hours
    ),
    'physicalBoards', physical_boards.payload
  )
  FROM physical_boards_json AS physical_boards
  );
END;
$function$;

-- Reassert the existing service-only PostgREST boundary without granting a
-- new principal or changing the function object's identity.
REVOKE ALL
  ON FUNCTION public.arena_score_inputs_publish_bundle_json(text, int, int)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE
  ON FUNCTION public.arena_score_inputs_publish_bundle_json(text, int, int)
  TO service_role;

COMMENT ON FUNCTION public.arena_score_inputs_publish_bundle_json(text, int, int) IS
  'One-statement score-input bundle with rank-bounded, unambiguous physical-board publication evidence.';

DO $postflight$
DECLARE
  v_before arena_score_publish_bundle_contract_before%ROWTYPE;
  v_after pg_catalog.pg_proc%ROWTYPE;
  v_legacy_before arena_score_inputs_json_catalog_before%ROWTYPE;
  v_legacy_after pg_catalog.pg_proc%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_before
  FROM arena_score_publish_bundle_contract_before;

  SELECT * INTO STRICT v_after
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
    'public.arena_score_inputs_publish_bundle_json(text,integer,integer)'
      ::pg_catalog.regprocedure;

  IF v_after.oid IS DISTINCT FROM v_before.oid
     OR v_after.proowner IS DISTINCT FROM v_before.proowner
     OR v_after.proacl IS DISTINCT FROM v_before.proacl
     OR v_after.prolang IS DISTINCT FROM v_before.prolang
     OR v_after.prokind IS DISTINCT FROM v_before.prokind
     OR v_after.prorettype IS DISTINCT FROM v_before.prorettype
     OR v_after.proretset IS DISTINCT FROM v_before.proretset
     OR v_after.pronargs IS DISTINCT FROM v_before.pronargs
     OR v_after.pronargdefaults IS DISTINCT FROM v_before.pronargdefaults
     OR v_after.proargtypes::pg_catalog.text
          IS DISTINCT FROM v_before.proargtypes
     OR v_after.proargnames IS DISTINCT FROM v_before.proargnames
     OR v_after.proargmodes IS DISTINCT FROM v_before.proargmodes
     OR v_after.proargdefaults::pg_catalog.text
          IS DISTINCT FROM v_before.proargdefaults
     OR v_after.prosecdef IS DISTINCT FROM v_before.prosecdef
     OR v_after.proleakproof IS DISTINCT FROM v_before.proleakproof
     OR v_after.proisstrict IS DISTINCT FROM v_before.proisstrict
     OR v_after.proconfig IS DISTINCT FROM v_before.proconfig
     OR v_after.provolatile IS DISTINCT FROM v_before.provolatile
     OR v_after.proparallel IS DISTINCT FROM v_before.proparallel THEN
    RAISE EXCEPTION
      'score-input publish bundle callable catalog contract changed';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
       'service_role', v_after.oid, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'anon', v_after.oid, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated', v_after.oid, 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'score-input publish bundle ACL postflight failed';
  END IF;

  SELECT * INTO STRICT v_legacy_before
  FROM arena_score_inputs_json_catalog_before;

  SELECT * INTO STRICT v_legacy_after
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
    'public.arena_score_inputs_json(text,integer,integer)'
      ::pg_catalog.regprocedure;

  IF v_legacy_after.provolatile <> 's'
     OR (
       pg_catalog.to_jsonb(v_legacy_after) - 'provolatile'
     ) IS DISTINCT FROM (
       pg_catalog.to_jsonb(v_legacy_before) - 'provolatile'
     ) THEN
    RAISE EXCEPTION
      'legacy score-input JSON catalog changed beyond STABLE correction';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
       'service_role', v_legacy_after.oid, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'anon', v_legacy_after.oid, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated', v_legacy_after.oid, 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'legacy score-input JSON ACL postflight failed';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
