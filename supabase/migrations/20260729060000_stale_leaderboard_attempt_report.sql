-- Read-only, service-only audit report for stale open leaderboard attempts.
--
-- The report is deliberately advisory and near-current, not a historical
-- reconstruction. It freezes one observed timestamp and one attempt-sequence
-- high-water mark, then walks the append-only ledger by attempt_seq. It never
-- changes acquisition or execution state and it omits every credential,
-- authority token, worker identity, release identity, and RAW evidence locator
-- from its response.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $preflight$
BEGIN
  IF pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regnamespace('arena') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_acquisition_attempts') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_acquisition_outcomes') IS NULL
     OR pg_catalog.to_regclass('arena.tier_a_execution_heads') IS NULL THEN
    RAISE EXCEPTION 'stale leaderboard attempt report prerequisites are missing';
  END IF;

  IF pg_catalog.to_regprocedure(
       'arena.report_stale_leaderboard_acquisition_attempts(jsonb)'
     ) IS NOT NULL THEN
    RAISE EXCEPTION 'stale leaderboard attempt report callable already exists';
  END IF;

  IF NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid =
              'arena.leaderboard_acquisition_attempts'::pg_catalog.regclass
          AND attribute.attname = 'execution_claim_id'
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
     )
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid =
              'arena.leaderboard_acquisition_attempts'::pg_catalog.regclass
          AND attribute.attname = 'execution_generation_seq'
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
     ) THEN
    RAISE EXCEPTION 'Tier-A execution attempt binding is missing';
  END IF;
END
$preflight$;

CREATE FUNCTION arena.report_stale_leaderboard_acquisition_attempts(
  p_request jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
PARALLEL RESTRICTED
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET statement_timeout = '15s'
AS $function$
DECLARE
  v_contract constant text :=
    'arena.ingest.stale-leaderboard-attempt-report-request@1';
  v_response_contract constant text :=
    'arena.ingest.stale-leaderboard-attempt-report-response@1';
  v_observed_at timestamptz;
  v_current_high_water bigint;
  v_high_water bigint;
  v_after bigint;
  v_page_size integer;
  v_stale_after_seconds integer;
  v_rows jsonb;
  v_has_more boolean;
  v_last_attempt_seq bigint;
BEGIN
  IF p_request IS NULL
     OR pg_catalog.jsonb_typeof(p_request) IS DISTINCT FROM 'object'
     OR NOT p_request ?& ARRAY[
       'contract',
       'observed_at',
       'high_water_attempt_seq',
       'after_attempt_seq',
       'page_size',
       'stale_after_seconds'
     ]
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.jsonb_object_keys(p_request) AS request_key(key_name)
        WHERE request_key.key_name <> ALL (ARRAY[
          'contract',
          'observed_at',
          'high_water_attempt_seq',
          'after_attempt_seq',
          'page_size',
          'stale_after_seconds'
        ]::text[])
     ) THEN
    RAISE EXCEPTION 'stale attempt report request envelope is malformed'
      USING ERRCODE = '22023';
  END IF;

  IF pg_catalog.jsonb_typeof(p_request->'contract') IS DISTINCT FROM 'string'
     OR p_request->>'contract' IS DISTINCT FROM v_contract
     OR pg_catalog.jsonb_typeof(p_request->'observed_at') IS DISTINCT FROM 'string'
     OR p_request->>'observed_at' !~
        '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
     OR pg_catalog.jsonb_typeof(p_request->'page_size') IS DISTINCT FROM 'number'
     OR p_request->>'page_size' !~ '^[1-9][0-9]{0,2}$|^1000$'
     OR pg_catalog.jsonb_typeof(p_request->'stale_after_seconds') IS DISTINCT FROM 'number'
     OR p_request->>'stale_after_seconds' !~ '^[1-9][0-9]{2,6}$' THEN
    RAISE EXCEPTION 'stale attempt report request values are malformed'
      USING ERRCODE = '22023';
  END IF;

  IF pg_catalog.jsonb_typeof(p_request->'high_water_attempt_seq') NOT IN (
       'string', 'null'
     )
     OR (
       pg_catalog.jsonb_typeof(p_request->'high_water_attempt_seq') = 'string'
       AND (
         p_request->>'high_water_attempt_seq' !~ '^(0|[1-9][0-9]{0,18})$'
         OR (
           pg_catalog.length(p_request->>'high_water_attempt_seq') = 19
           AND p_request->>'high_water_attempt_seq' > '9223372036854775807'
         )
       )
     )
     OR pg_catalog.jsonb_typeof(p_request->'after_attempt_seq') NOT IN (
       'string', 'null'
     )
     OR (
       pg_catalog.jsonb_typeof(p_request->'after_attempt_seq') = 'string'
       AND (
         p_request->>'after_attempt_seq' !~ '^[1-9][0-9]{0,18}$'
         OR (
           pg_catalog.length(p_request->>'after_attempt_seq') = 19
           AND p_request->>'after_attempt_seq' > '9223372036854775807'
         )
       )
     ) THEN
    RAISE EXCEPTION 'stale attempt report cursor values are malformed'
      USING ERRCODE = '22023';
  END IF;

  v_observed_at := (p_request->>'observed_at')::timestamptz;
  v_page_size := (p_request->>'page_size')::integer;
  v_stale_after_seconds :=
    (p_request->>'stale_after_seconds')::integer;

  IF NOT pg_catalog.isfinite(v_observed_at)
     OR v_observed_at IS DISTINCT FROM
        pg_catalog.date_trunc('milliseconds', v_observed_at)
     OR v_observed_at <
        pg_catalog.transaction_timestamp() - interval '5 minutes'
     OR v_observed_at >
        pg_catalog.transaction_timestamp() + interval '5 minutes'
     OR v_page_size NOT BETWEEN 1 AND 1000
     OR v_stale_after_seconds NOT BETWEEN 300 AND 2592000 THEN
    RAISE EXCEPTION 'stale attempt report request is outside its bounds'
      USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(pg_catalog.max(attempt.attempt_seq), 0)
    INTO STRICT v_current_high_water
    FROM arena.leaderboard_acquisition_attempts AS attempt;

  IF pg_catalog.jsonb_typeof(p_request->'high_water_attempt_seq') = 'null' THEN
    v_high_water := v_current_high_water;
  ELSE
    v_high_water := (p_request->>'high_water_attempt_seq')::bigint;
    IF v_high_water > v_current_high_water THEN
      RAISE EXCEPTION 'stale attempt report high-water is not observable'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  IF pg_catalog.jsonb_typeof(p_request->'after_attempt_seq') = 'null' THEN
    v_after := 0;
  ELSE
    v_after := (p_request->>'after_attempt_seq')::bigint;
  END IF;

  IF v_after > v_high_water THEN
    RAISE EXCEPTION 'stale attempt report cursor exceeds its high-water'
      USING ERRCODE = '22023';
  END IF;

  WITH candidates AS MATERIALIZED (
    SELECT
      attempt.attempt_seq,
      attempt.attempt_id,
      attempt.source_id,
      attempt.source_slug,
      attempt.timeframe,
      attempt.observation_cycle_id,
      attempt.queue_job_id,
      attempt.queue_attempt,
      attempt.capture_contract,
      attempt.recorded_started_at,
      attempt.execution_claim_id,
      attempt.execution_generation_seq,
      head.source_id AS head_source_id,
      head.generation_seq AS head_generation_seq,
      head.claim_id AS head_claim_id,
      head.phase AS head_phase,
      head.lease_expires_at AS head_lease_expires_at,
      EXISTS (
        SELECT 1
          FROM arena.leaderboard_acquisition_attempts AS newer
         WHERE newer.source_id = attempt.source_id
           AND newer.timeframe = attempt.timeframe
           AND newer.attempt_seq > attempt.attempt_seq
           AND newer.attempt_seq <= v_high_water
      ) AS is_superseded
    FROM arena.leaderboard_acquisition_attempts AS attempt
    LEFT JOIN arena.leaderboard_acquisition_outcomes AS outcome
      ON outcome.attempt_seq = attempt.attempt_seq
    LEFT JOIN arena.tier_a_execution_heads AS head
      ON head.source_id = attempt.source_id
    WHERE attempt.attempt_seq > v_after
      AND attempt.attempt_seq <= v_high_water
      AND outcome.attempt_seq IS NULL
      AND attempt.recorded_started_at <=
          v_observed_at -
          pg_catalog.make_interval(secs => v_stale_after_seconds)
    ORDER BY attempt.attempt_seq
    LIMIT v_page_size + 1
  ), numbered AS (
    SELECT
      candidate.*,
      pg_catalog.row_number() OVER (ORDER BY candidate.attempt_seq) AS ordinal
    FROM candidates AS candidate
  ), rendered AS (
    SELECT
      numbered.attempt_seq,
      numbered.ordinal,
      pg_catalog.jsonb_build_object(
        'attempt_seq', numbered.attempt_seq::text,
        'attempt_id', numbered.attempt_id::text,
        'source_id', numbered.source_id,
        'source_slug', numbered.source_slug,
        'timeframe', numbered.timeframe,
        'observation_cycle_id', numbered.observation_cycle_id,
        'queue_job_id', numbered.queue_job_id,
        'queue_attempt', numbered.queue_attempt,
        'capture_contract', numbered.capture_contract,
        'recorded_started_at', pg_catalog.to_char(
          numbered.recorded_started_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ),
        'ownership', CASE
          WHEN numbered.execution_claim_id IS NULL THEN 'legacy'
          ELSE 'claimed'
        END,
        'attempt_position', CASE
          WHEN numbered.is_superseded THEN 'superseded'
          ELSE 'current'
        END,
        'age_state', 'expired',
        'attempt_phase', 'open',
        'authority_state', CASE
          WHEN numbered.execution_claim_id IS NULL THEN 'legacy_unfenced'
          WHEN numbered.head_source_id IS NULL
            OR numbered.head_generation_seq IS DISTINCT FROM
               numbered.execution_generation_seq
            OR numbered.head_claim_id IS DISTINCT FROM
               numbered.execution_claim_id THEN 'fenced'
          WHEN numbered.head_phase IN ('completed', 'failed', 'revoked') THEN
            'closed'
          WHEN numbered.head_phase = 'active'
            AND numbered.head_lease_expires_at <= v_observed_at THEN 'expired'
          WHEN numbered.head_phase = 'active'
            AND numbered.head_lease_expires_at > v_observed_at THEN 'current'
          ELSE 'fenced'
        END,
        'execution_phase', CASE
          WHEN numbered.execution_claim_id IS NULL THEN 'legacy'
          ELSE COALESCE(numbered.head_phase, 'missing')
        END
      ) AS row_value
    FROM numbered
  )
  SELECT
    COALESCE(
      pg_catalog.jsonb_agg(
        rendered.row_value ORDER BY rendered.attempt_seq
      ) FILTER (WHERE rendered.ordinal <= v_page_size),
      '[]'::jsonb
    ),
    COALESCE(
      pg_catalog.bool_or(rendered.ordinal > v_page_size),
      false
    ),
    pg_catalog.max(rendered.attempt_seq)
      FILTER (WHERE rendered.ordinal <= v_page_size)
    INTO STRICT v_rows, v_has_more, v_last_attempt_seq
    FROM rendered;

  RETURN pg_catalog.jsonb_build_object(
    'contract', v_response_contract,
    'observed_at', pg_catalog.to_char(
      v_observed_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'high_water_attempt_seq', v_high_water::text,
    'after_attempt_seq', CASE
      WHEN v_after = 0 THEN NULL
      ELSE v_after::text
    END,
    'stale_after_seconds', v_stale_after_seconds,
    'page_size', v_page_size,
    'rows', v_rows,
    'page', pg_catalog.jsonb_build_object(
      'returned_count', pg_catalog.jsonb_array_length(v_rows),
      'has_more', v_has_more,
      'next_after_attempt_seq', CASE
        WHEN v_has_more THEN v_last_attempt_seq::text
        ELSE NULL
      END
    )
  );
END
$function$;

ALTER FUNCTION arena.report_stale_leaderboard_acquisition_attempts(jsonb)
  OWNER TO postgres;

COMMENT ON FUNCTION arena.report_stale_leaderboard_acquisition_attempts(jsonb) IS
  'Service-only, read-only keyset report for currently observable expired open acquisition attempts; observed_at must remain within five minutes of the transaction timestamp, and the response contains classifications, not authority or evidence secrets.';

-- CREATE FUNCTION inherits arbitrary ALTER DEFAULT PRIVILEGES grants. Close the
-- complete effective ACL rather than trying to enumerate known application
-- roles, then add back one non-owner caller without grant option.
DO $close_acl$
DECLARE
  v_report pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'arena.report_stale_leaderboard_acquisition_attempts(jsonb)'
  );
  v_owner oid;
  v_grantee oid;
  v_grantee_name name;
BEGIN
  SELECT function_row.proowner
    INTO STRICT v_owner
    FROM pg_catalog.pg_proc AS function_row
   WHERE function_row.oid = v_report;

  FOR v_grantee IN
    SELECT DISTINCT acl_row.grantee
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS acl_row
     WHERE function_row.oid = v_report
       AND acl_row.grantee <> v_owner
  LOOP
    IF v_grantee = 0 THEN
      EXECUTE
        'REVOKE ALL PRIVILEGES ON FUNCTION '
        'arena.report_stale_leaderboard_acquisition_attempts(jsonb) '
        'FROM PUBLIC';
    ELSE
      SELECT role_row.rolname
        INTO STRICT v_grantee_name
        FROM pg_catalog.pg_roles AS role_row
       WHERE role_row.oid = v_grantee;
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION '
        'arena.report_stale_leaderboard_acquisition_attempts(jsonb) FROM %I',
        v_grantee_name
      );
    END IF;
  END LOOP;
END
$close_acl$;

GRANT EXECUTE ON FUNCTION
  arena.report_stale_leaderboard_acquisition_attempts(jsonb)
  TO service_role;

DO $postflight$
DECLARE
  v_report pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'arena.report_stale_leaderboard_acquisition_attempts(jsonb)'
  );
  v_service_role oid := pg_catalog.to_regrole('service_role');
BEGIN
  IF v_report IS NULL
     OR NOT pg_catalog.has_function_privilege(
       'service_role', v_report, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege('anon', v_report, 'EXECUTE')
     OR pg_catalog.has_function_privilege(
       'authenticated', v_report, 'EXECUTE'
     )
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_proc AS function_row
        WHERE function_row.oid = v_report
          AND function_row.prosecdef
          AND function_row.provolatile = 's'
          AND function_row.proparallel = 'r'
          AND pg_catalog.array_length(function_row.proconfig, 1) = 2
          AND function_row.proconfig @> ARRAY[
            'search_path=pg_catalog, pg_temp',
            'statement_timeout=15s'
          ]::text[]
          AND NOT EXISTS (
            SELECT 1
              FROM pg_catalog.aclexplode(
                COALESCE(
                  function_row.proacl,
                  pg_catalog.acldefault('f', function_row.proowner)
                )
              ) AS acl_row
             WHERE acl_row.privilege_type <> 'EXECUTE'
                OR acl_row.grantee NOT IN (
                  function_row.proowner,
                  v_service_role
                )
                OR acl_row.is_grantable
          )
          AND (
            SELECT pg_catalog.count(*)
              FROM pg_catalog.aclexplode(
                COALESCE(
                  function_row.proacl,
                  pg_catalog.acldefault('f', function_row.proowner)
                )
              ) AS acl_row
          ) = 2
          AND EXISTS (
            SELECT 1
              FROM pg_catalog.aclexplode(
                COALESCE(
                  function_row.proacl,
                  pg_catalog.acldefault('f', function_row.proowner)
                )
              ) AS acl_row
             WHERE acl_row.grantee = function_row.proowner
               AND acl_row.privilege_type = 'EXECUTE'
          )
          AND EXISTS (
            SELECT 1
              FROM pg_catalog.aclexplode(
                COALESCE(
                  function_row.proacl,
                  pg_catalog.acldefault('f', function_row.proowner)
                )
              ) AS acl_row
             WHERE acl_row.grantee = v_service_role
               AND acl_row.privilege_type = 'EXECUTE'
          )
     ) THEN
    RAISE EXCEPTION 'stale leaderboard attempt report authority drifted';
  END IF;
END
$postflight$;

COMMIT;
