-- Migration: 20260721175746_arena_score_inputs_publish_bundle.sql
-- Created: 2026-07-22T00:57:46Z
-- Description: Return score rows and registry-complete physical-board publish
-- evidence from one PostgreSQL statement snapshot. The existing score-input
-- RPC remains byte-for-byte untouched for compatibility.

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
     OR pg_catalog.to_regclass('arena.leaderboard_snapshots') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_entries') IS NULL THEN
    RAISE EXCEPTION 'score inputs, source registry, snapshots, and entries must exist';
  END IF;

  IF pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL THEN
    RAISE EXCEPTION 'PostgREST API roles must exist';
  END IF;
END
$preflight$;

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

  -- All relations below, including the legacy score-row function, are read by
  -- this single SQL statement and therefore share one PostgreSQL snapshot.
  RETURN (
  WITH requested_window AS MATERIALIZED (
    SELECT CASE p_window
      WHEN '7D' THEN 7::smallint
      WHEN '30D' THEN 30::smallint
      WHEN '90D' THEN 90::smallint
      ELSE NULL::smallint
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
        COALESCE(source_row.timeframes_native, ARRAY[]::integer[])
        || COALESCE(source_row.timeframes_derived, ARRAY[]::integer[])
      )
      -- Historical imports used the JSON string "null" as a retired alias.
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
  latest_passed_snapshot AS MATERIALIZED (
    SELECT DISTINCT ON (snapshot.source_id)
      snapshot.source_id,
      snapshot.id AS snapshot_id,
      snapshot.scraped_at,
      snapshot.actual_count
    FROM arena.leaderboard_snapshots AS snapshot
    JOIN registry_boards AS registry
      ON registry.source_id = snapshot.source_id
     AND registry.timeframe = snapshot.timeframe
    WHERE snapshot.count_check_passed
    ORDER BY
      snapshot.source_id,
      snapshot.scraped_at DESC,
      snapshot.id DESC
  ),
  passed_entry_counts AS MATERIALIZED (
    SELECT
      passed.snapshot_id,
      pg_catalog.count(entry.snapshot_id)::bigint AS entry_count
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
      CASE
        WHEN passed.snapshot_id IS NULL
             AND attempt.latest_attempt_id IS NULL THEN 'missing'
        WHEN passed.snapshot_id IS NULL THEN 'failed'
        WHEN passed.scraped_at
             > pg_catalog.statement_timestamp() + interval '5 minutes' THEN 'future'
        WHEN passed.scraped_at
             <= pg_catalog.statement_timestamp()
                - pg_catalog.make_interval(hours => p_max_age_hours) THEN 'stale'
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

REVOKE ALL
  ON FUNCTION public.arena_score_inputs_publish_bundle_json(text, int, int)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE
  ON FUNCTION public.arena_score_inputs_publish_bundle_json(text, int, int)
  TO service_role;

COMMENT ON FUNCTION public.arena_score_inputs_publish_bundle_json(text, int, int) IS
  'One-statement score-input bundle with registry-complete physical-board PASSED evidence for atomic publication.';

DO $postflight$
BEGIN
  IF NOT pg_catalog.has_function_privilege(
    'service_role',
    'public.arena_score_inputs_publish_bundle_json(text,integer,integer)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon',
    'public.arena_score_inputs_publish_bundle_json(text,integer,integer)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated',
    'public.arena_score_inputs_publish_bundle_json(text,integer,integer)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'score-input publish bundle ACL postflight failed';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
