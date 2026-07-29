-- Migration: 20260729013000_bitget_bot_attempt_health_contract.sql
-- Created: 2026-07-29T01:30:00Z
-- Description: Expose one service-only, read-only health row for the latest
--   acquisition attempt of each canonical Bitget bot V4 source/window. Exact
--   V4 snapshot lineage distinguishes publication lag from a gated publish.

BEGIN;

SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL TIME ZONE 'UTC';

DO $preflight$
DECLARE
  v_exact_sources integer;
  v_latest_view_options text[];
BEGIN
  IF pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_capture_contracts') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_acquisition_attempts') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_acquisition_outcomes') IS NULL
     OR pg_catalog.to_regclass('arena.latest_leaderboard_acquisition_attempts') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_snapshots') IS NULL THEN
    RAISE EXCEPTION 'Bitget bot attempt-health foundations are missing';
  END IF;

  IF pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL THEN
    RAISE EXCEPTION 'Bitget bot attempt health requires Supabase runtime roles';
  END IF;

  IF pg_catalog.to_regprocedure(
       'public.arena_bitget_bot_acquisition_attempt_health()'
     ) IS NOT NULL THEN
    RAISE EXCEPTION 'Bitget bot attempt-health contract already exists';
  END IF;

  SELECT relation.reloptions
    INTO v_latest_view_options
    FROM pg_catalog.pg_class AS relation
   WHERE relation.oid =
         'arena.latest_leaderboard_acquisition_attempts'::pg_catalog.regclass
     AND relation.relkind = 'v';

  IF v_latest_view_options IS NULL
     OR NOT ('security_invoker=true' = ANY (v_latest_view_options))
     OR pg_catalog.strpos(
          pg_catalog.pg_get_viewdef(
            'arena.latest_leaderboard_acquisition_attempts'::pg_catalog.regclass,
            true
          ),
          'attempt_seq DESC'
        ) = 0 THEN
    RAISE EXCEPTION 'latest attempt view is missing its invoker/attempt-seq fence';
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
    JOIN arena.sources AS source_row
      ON source_row.slug = target.slug
     AND source_row.product_type = target.product_type
    JOIN arena.leaderboard_capture_contracts AS capture
      ON capture.source_id = source_row.id
     AND capture.capture_contract =
         'arena.ingest.leaderboard-acquisition-manifest@4'
     AND capture.adapter_slug = 'bitget_bots'
     AND capture.attempt_binding_contract =
         'arena.ingest.leaderboard-acquisition-attempt-binding@1'
     AND capture.requires_runner_git_sha
   WHERE source_row.adapter_slug = 'bitget_bots'
     AND source_row.trader_kind_scope = 'bot'
     AND source_row.status = 'active'
     AND source_row.serving_mode = 'serving'
     AND source_row.currency = 'USDT'
     AND source_row.timeframes_native = ARRAY[30]::integer[]
     AND source_row.timeframes_derived = ARRAY[]::integer[]
     AND source_row.page_size = 20
     AND source_row.pagination_kind = 'numeric'
     AND source_row.meta->'boards' = target.boards;

  IF v_exact_sources <> 2
     OR EXISTS (
       SELECT 1
         FROM arena.leaderboard_capture_contracts AS capture
         JOIN arena.sources AS source_row
           ON source_row.id = capture.source_id
        WHERE capture.capture_contract =
              'arena.ingest.leaderboard-acquisition-manifest@4'
          AND (
            capture.adapter_slug <> 'bitget_bots'
            OR source_row.slug <> ALL (
              ARRAY[
                'bitget_bots_futures',
                'bitget_bots_spot'
              ]::pg_catalog.text[]
            )
          )
     ) THEN
    RAISE EXCEPTION
      'Bitget bot attempt health requires exactly two canonical V4 source/windows';
  END IF;
END
$preflight$;

CREATE FUNCTION public.arena_bitget_bot_acquisition_attempt_health()
RETURNS TABLE (
  source_id smallint,
  source_slug text,
  timeframe smallint,
  attempt_seq bigint,
  attempt_id uuid,
  health_state text,
  terminal_state text,
  recorded_started_at timestamptz,
  recorded_completed_at timestamptz,
  source_run_id text,
  acquisition_contract text,
  source_payload_raw_object_id bigint,
  manifest_raw_object_id bigint,
  publication_snapshot_id bigint,
  publication_scraped_at timestamptz,
  publication_count_check_passed boolean
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
  WITH target_sources(source_slug) AS MATERIALIZED (
    VALUES
      ('bitget_bots_futures'::text),
      ('bitget_bots_spot'::text)
  ),
  canonical_sources AS MATERIALIZED (
    SELECT
      source_row.id AS source_id,
      source_row.slug AS source_slug
    FROM target_sources AS target
    JOIN arena.sources AS source_row
      ON source_row.slug = target.source_slug
    JOIN arena.leaderboard_capture_contracts AS capture
      ON capture.source_id = source_row.id
     AND capture.capture_contract =
         'arena.ingest.leaderboard-acquisition-manifest@4'
     AND capture.adapter_slug = 'bitget_bots'
     AND capture.attempt_binding_contract =
         'arena.ingest.leaderboard-acquisition-attempt-binding@1'
     AND capture.requires_runner_git_sha
  )
  SELECT
    source_row.source_id,
    source_row.source_slug,
    30::smallint AS timeframe,
    attempt.attempt_seq,
    attempt.attempt_id,
    CASE
      WHEN attempt.attempt_seq IS NULL THEN 'not_started'
      WHEN attempt.source_slug IS DISTINCT FROM source_row.source_slug
        OR attempt.capture_contract IS DISTINCT FROM
           'arena.ingest.leaderboard-acquisition-manifest@4'
        THEN 'unknown'
      WHEN attempt.terminal_state = 'in_progress'
       AND attempt.recorded_started_at
           > pg_catalog.statement_timestamp() - interval '2 hours'
        THEN 'open_fresh'
      WHEN attempt.terminal_state = 'in_progress'
        THEN 'open_stale_suspect'
      WHEN attempt.terminal_state = 'partial' THEN 'partial'
      WHEN attempt.terminal_state = 'unknown' THEN 'unknown'
      WHEN attempt.terminal_state = 'processing_failed' THEN 'processing_failed'
      WHEN attempt.terminal_state = 'abandoned' THEN 'abandoned'
      WHEN publication.snapshot_id IS NOT NULL
       AND NOT publication.count_check_passed
        THEN 'published_gated'
      WHEN publication.snapshot_id IS NOT NULL
       AND publication.count_check_passed
        THEN 'published'
      WHEN attempt.recorded_completed_at
           > pg_catalog.statement_timestamp() - interval '10 minutes'
        THEN 'complete_in_publication_grace'
      ELSE 'complete_unpublished'
    END AS health_state,
    attempt.terminal_state,
    attempt.recorded_started_at,
    attempt.recorded_completed_at,
    attempt.source_run_id,
    attempt.capture_contract AS acquisition_contract,
    attempt.source_payload_raw_object_id,
    attempt.manifest_raw_object_id,
    publication.snapshot_id AS publication_snapshot_id,
    publication.scraped_at AS publication_scraped_at,
    publication.count_check_passed AS publication_count_check_passed
  FROM canonical_sources AS source_row
  LEFT JOIN arena.latest_leaderboard_acquisition_attempts AS attempt
    ON attempt.source_id = source_row.source_id
   AND attempt.timeframe = 30
  LEFT JOIN LATERAL (
    SELECT
      snapshot.id AS snapshot_id,
      snapshot.scraped_at,
      snapshot.count_check_passed
    FROM arena.leaderboard_snapshots AS snapshot
    WHERE attempt.terminal_state = 'complete'
      AND attempt.source_slug = source_row.source_slug
      AND attempt.capture_contract =
          'arena.ingest.leaderboard-acquisition-manifest@4'
      AND snapshot.source_id = attempt.source_id
      AND snapshot.timeframe = attempt.timeframe
      AND NOT snapshot.is_derived
      AND snapshot.raw_object_id = attempt.source_payload_raw_object_id
      AND pg_catalog.jsonb_typeof(snapshot.meta) = 'object'
      AND pg_catalog.jsonb_typeof(snapshot.meta->'source_run_id') = 'string'
      AND snapshot.meta->>'source_run_id' = attempt.source_run_id
      AND pg_catalog.jsonb_typeof(snapshot.meta->'acquisition_contract') = 'string'
      AND snapshot.meta->>'acquisition_contract' = attempt.capture_contract
      AND pg_catalog.jsonb_typeof(
            snapshot.meta->'source_payload_raw_object_id'
          ) = 'number'
      AND snapshot.meta->>'source_payload_raw_object_id' =
          attempt.source_payload_raw_object_id::text
      AND pg_catalog.jsonb_typeof(snapshot.meta->'manifest_raw_object_id') = 'number'
      AND snapshot.meta->>'manifest_raw_object_id' =
          attempt.manifest_raw_object_id::text
    ORDER BY
      snapshot.count_check_passed DESC,
      snapshot.scraped_at DESC,
      snapshot.id DESC
    LIMIT 1
  ) AS publication ON true
  ORDER BY source_row.source_slug;
$function$;

ALTER FUNCTION public.arena_bitget_bot_acquisition_attempt_health()
  OWNER TO postgres;

REVOKE ALL
  ON FUNCTION public.arena_bitget_bot_acquisition_attempt_health()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE
  ON FUNCTION public.arena_bitget_bot_acquisition_attempt_health()
  TO service_role;

COMMENT ON FUNCTION public.arena_bitget_bot_acquisition_attempt_health() IS
  'Service-only read contract returning exactly two canonical Bitget bot V4 source/windows, including not_started before a first physical attempt. Open freshness is 2h; complete publication grace is 10m; publication requires exact V4 snapshot lineage.';

DO $postflight$
DECLARE
  v_function oid := pg_catalog.to_regprocedure(
    'public.arena_bitget_bot_acquisition_attempt_health()'
  );
BEGIN
  IF v_function IS NULL THEN
    RAISE EXCEPTION 'Bitget bot attempt-health function is missing';
  END IF;

  IF NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_proc AS function_row
         JOIN pg_catalog.pg_language AS language_row
           ON language_row.oid = function_row.prolang
        WHERE function_row.oid = v_function
          AND function_row.proowner = 'postgres'::pg_catalog.regrole
          AND function_row.prokind = 'f'
          AND function_row.provolatile = 's'
          AND NOT function_row.prosecdef
          AND function_row.proretset
          AND language_row.lanname = 'sql'
          AND function_row.proconfig = ARRAY[
                'search_path=pg_catalog, pg_temp'
              ]::pg_catalog.text[]
          AND function_row.prosrc ~ '^\n?  WITH target_sources'
          AND function_row.prosrc !~* '\m(INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\M'
     ) THEN
    RAISE EXCEPTION 'Bitget bot attempt-health function shape is unsafe';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.arena_bitget_bot_acquisition_attempt_health()',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'anon',
       'public.arena_bitget_bot_acquisition_attempt_health()',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated',
       'public.arena_bitget_bot_acquisition_attempt_health()',
       'EXECUTE'
     )
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_proc AS function_row
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           COALESCE(
             function_row.proacl,
             pg_catalog.acldefault('f', function_row.proowner)
           )
         ) AS privilege_row
        WHERE function_row.oid = v_function
          AND privilege_row.privilege_type = 'EXECUTE'
          AND (
            privilege_row.grantee NOT IN (
              function_row.proowner,
              'service_role'::pg_catalog.regrole
            )
            OR (
              privilege_row.grantee = 'service_role'::pg_catalog.regrole
              AND privilege_row.is_grantable
            )
          )
     ) THEN
    RAISE EXCEPTION 'Bitget bot attempt-health ACL is unsafe';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
