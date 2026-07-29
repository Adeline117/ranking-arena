-- Migration: 20260729011000_partitioned_bot_acquisition_manifest_v4.sql
-- Created: 2026-07-29T01:10:00Z
-- Description: Admit the attempt-bound partitioned numeric manifest V4 only
--   for the two canonical Bitget bot boards. V4 proves capture completeness;
--   it does not register metric trust or restore public rank authority.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL TIME ZONE 'UTC';

LOCK TABLE arena.sources IN SHARE MODE;

DO $preflight$
DECLARE
  v_capture_constraint text;
  v_attempt_constraint text;
  v_start_function oid;
  v_finish_function oid;
  v_start_sha256 text;
  v_finish_sha256 text;
  v_exact_sources integer;
BEGIN
  IF pg_catalog.to_regclass('arena.sources') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_capture_contracts') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_acquisition_attempts') IS NULL
     OR pg_catalog.to_regclass('arena.leaderboard_acquisition_outcomes') IS NULL
     OR pg_catalog.to_regclass('arena.raw_objects') IS NULL THEN
    RAISE EXCEPTION 'partitioned manifest V4 acquisition foundations are missing';
  END IF;

  IF pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL THEN
    RAISE EXCEPTION 'partitioned manifest V4 requires Supabase runtime roles';
  END IF;

  v_start_function := pg_catalog.to_regprocedure(
    'arena.start_leaderboard_acquisition_attempt(uuid,integer,integer,text,text,integer,text,text,text)'
  );
  v_finish_function := pg_catalog.to_regprocedure(
    'arena.finish_leaderboard_acquisition_attempt(uuid,text,text,text,text,text,timestamp with time zone,timestamp with time zone,text,bigint,bigint,bigint,integer,text,integer,integer,text,integer,integer,integer,integer,boolean,boolean,text,text)'
  );
  IF v_start_function IS NULL OR v_finish_function IS NULL THEN
    RAISE EXCEPTION 'partitioned manifest V4 acquisition RPCs are missing';
  END IF;

  SELECT pg_catalog.encode(
           pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc, 'UTF8')),
           'hex'
         )
  INTO STRICT v_start_sha256
  FROM pg_catalog.pg_proc AS function_row
  JOIN pg_catalog.pg_language AS language_row
    ON language_row.oid = function_row.prolang
  WHERE function_row.oid = v_start_function
    AND function_row.prokind = 'f'
    AND function_row.proowner = 'postgres'::pg_catalog.regrole
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND language_row.lanname = 'plpgsql'
    AND function_row.proconfig @> ARRAY[
      'search_path=pg_catalog, pg_temp',
      'lock_timeout=5s',
      'statement_timeout=30s'
    ]::pg_catalog.text[];

  SELECT pg_catalog.encode(
           pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc, 'UTF8')),
           'hex'
         )
  INTO STRICT v_finish_sha256
  FROM pg_catalog.pg_proc AS function_row
  JOIN pg_catalog.pg_language AS language_row
    ON language_row.oid = function_row.prolang
  WHERE function_row.oid = v_finish_function
    AND function_row.prokind = 'f'
    AND function_row.proowner = 'postgres'::pg_catalog.regrole
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND language_row.lanname = 'plpgsql'
    AND function_row.proconfig @> ARRAY[
      'search_path=pg_catalog, pg_temp',
      'lock_timeout=5s',
      'statement_timeout=30s'
    ]::pg_catalog.text[];

  IF v_start_sha256 IS DISTINCT FROM
       '91450023404a8adecb9949dc4179260415c667ac62f139e82936106ec2ab9a76'
     OR v_finish_sha256 IS DISTINCT FROM
       'ac654d08b64da69df71537b5f796fc3310e359d23815c14a5b651e29fa3e7bc4' THEN
    RAISE EXCEPTION
      'partitioned manifest V4 refuses drifted acquisition RPC bodies: start %, finish %',
      v_start_sha256,
      v_finish_sha256;
  END IF;

  SELECT pg_catalog.pg_get_constraintdef(constraint_row.oid)
  INTO v_capture_constraint
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid =
        'arena.leaderboard_capture_contracts'::pg_catalog.regclass
    AND constraint_row.conname =
        'leaderboard_capture_contracts_capture_contract_check'
    AND constraint_row.contype = 'c'
    AND constraint_row.convalidated;

  SELECT pg_catalog.pg_get_constraintdef(constraint_row.oid)
  INTO v_attempt_constraint
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid =
        'arena.leaderboard_acquisition_attempts'::pg_catalog.regclass
    AND constraint_row.conname =
        'leaderboard_acquisition_attempts_capture_contract_check'
    AND constraint_row.contype = 'c'
    AND constraint_row.convalidated;

  IF v_capture_constraint IS NULL
     OR v_capture_constraint NOT LIKE
        '%arena.ingest.leaderboard-acquisition-manifest@2%'
     OR v_capture_constraint NOT LIKE
        '%arena.ingest.leaderboard-acquisition-manifest@3%'
     OR v_capture_constraint LIKE
        '%arena.ingest.leaderboard-acquisition-manifest@4%'
     OR v_attempt_constraint IS NULL
     OR v_attempt_constraint NOT LIKE
        '%arena.ingest.leaderboard-acquisition-manifest@2%'
     OR v_attempt_constraint NOT LIKE
        '%arena.ingest.leaderboard-acquisition-manifest@3%'
     OR v_attempt_constraint NOT LIKE '%legacy_unverified%'
     OR v_attempt_constraint LIKE
        '%arena.ingest.leaderboard-acquisition-manifest@4%' THEN
    RAISE EXCEPTION 'partitioned manifest V4 capture constraints drifted';
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
       FROM arena.sources AS source_row
       WHERE source_row.status = 'active'
         AND source_row.adapter_slug = 'bitget_bots'
         AND source_row.slug <> ALL (
           ARRAY[
             'bitget_bots_futures',
             'bitget_bots_spot'
           ]::pg_catalog.text[]
         )
     ) THEN
    RAISE EXCEPTION
      'partitioned manifest V4 requires exactly two canonical active Bitget bot sources';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM arena.leaderboard_capture_contracts
    WHERE capture_contract =
          'arena.ingest.leaderboard-acquisition-manifest@4'
  ) THEN
    RAISE EXCEPTION 'partitioned manifest V4 registry must be empty before installation';
  END IF;
END
$preflight$;

ALTER TABLE arena.leaderboard_capture_contracts
  DROP CONSTRAINT leaderboard_capture_contracts_capture_contract_check,
  ADD CONSTRAINT leaderboard_capture_contracts_capture_contract_check
  CHECK (
    capture_contract IN (
      'arena.ingest.leaderboard-acquisition-manifest@2',
      'arena.ingest.leaderboard-acquisition-manifest@3',
      'arena.ingest.leaderboard-acquisition-manifest@4'
    )
  );

ALTER TABLE arena.leaderboard_acquisition_attempts
  DROP CONSTRAINT leaderboard_acquisition_attempts_capture_contract_check,
  ADD CONSTRAINT leaderboard_acquisition_attempts_capture_contract_check
  CHECK (
    capture_contract IN (
      'arena.ingest.leaderboard-acquisition-manifest@2',
      'arena.ingest.leaderboard-acquisition-manifest@3',
      'arena.ingest.leaderboard-acquisition-manifest@4',
      'legacy_unverified'
    )
  );

DO $register_v4$
DECLARE
  v_inserted integer;
BEGIN
  INSERT INTO arena.leaderboard_capture_contracts (
    source_id,
    capture_contract,
    adapter_slug,
    attempt_binding_contract,
    requires_runner_git_sha
  )
  SELECT
    source_row.id,
    'arena.ingest.leaderboard-acquisition-manifest@4',
    source_row.adapter_slug,
    'arena.ingest.leaderboard-acquisition-attempt-binding@1',
    true
  FROM arena.sources AS source_row
  WHERE source_row.slug = ANY (
      ARRAY[
        'bitget_bots_futures',
        'bitget_bots_spot'
      ]::pg_catalog.text[]
    )
    AND source_row.adapter_slug = 'bitget_bots'
  ORDER BY source_row.slug;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted <> 2 THEN
    RAISE EXCEPTION 'expected two partitioned manifest V4 registrations';
  END IF;
END
$register_v4$;

-- The current V3 functions are immutable-reviewed bodies. Replace only the
-- exact quoted @3 literal in their allowlists, after the hashes above prove
-- no operator or later migration changed any other statement.
DO $upgrade_rpc_allowlists$
DECLARE
  v_start_definition text;
  v_finish_definition text;
  v_v3_literal text := pg_catalog.quote_literal(
    'arena.ingest.leaderboard-acquisition-manifest@3'
  );
  v_v4_literal text := pg_catalog.quote_literal(
    'arena.ingest.leaderboard-acquisition-manifest@4'
  );
  v_start_occurrences integer;
  v_finish_occurrences integer;
BEGIN
  v_start_definition := pg_catalog.pg_get_functiondef(
    'arena.start_leaderboard_acquisition_attempt(uuid,integer,integer,text,text,integer,text,text,text)'
      ::pg_catalog.regprocedure
  );
  v_finish_definition := pg_catalog.pg_get_functiondef(
    'arena.finish_leaderboard_acquisition_attempt(uuid,text,text,text,text,text,timestamp with time zone,timestamp with time zone,text,bigint,bigint,bigint,integer,text,integer,integer,text,integer,integer,integer,integer,boolean,boolean,text,text)'
      ::pg_catalog.regprocedure
  );

  v_start_occurrences := (
    pg_catalog.length(v_start_definition)
    - pg_catalog.length(pg_catalog.replace(v_start_definition, v_v3_literal, ''))
  ) / pg_catalog.length(v_v3_literal);
  v_finish_occurrences := (
    pg_catalog.length(v_finish_definition)
    - pg_catalog.length(pg_catalog.replace(v_finish_definition, v_v3_literal, ''))
  ) / pg_catalog.length(v_v3_literal);
  IF v_start_occurrences <> 1 OR v_finish_occurrences <> 3 THEN
    RAISE EXCEPTION
      'partitioned manifest V4 RPC allowlist occurrence drift: start %, finish %',
      v_start_occurrences,
      v_finish_occurrences;
  END IF;

  EXECUTE pg_catalog.replace(
    v_start_definition,
    v_v3_literal,
    v_v3_literal || ', ' || v_v4_literal
  );
  EXECUTE pg_catalog.replace(
    v_finish_definition,
    v_v3_literal,
    v_v3_literal || ', ' || v_v4_literal
  );
END
$upgrade_rpc_allowlists$;

ALTER FUNCTION arena.start_leaderboard_acquisition_attempt(
  uuid, integer, integer, text, text, integer, text, text, text
) OWNER TO postgres;
ALTER FUNCTION arena.finish_leaderboard_acquisition_attempt(
  uuid, text, text, text, text, text, timestamptz, timestamptz, text,
  bigint, bigint, bigint, integer, text, integer, integer, text,
  integer, integer, integer, integer, boolean, boolean, text, text
) OWNER TO postgres;

REVOKE ALL ON FUNCTION arena.start_leaderboard_acquisition_attempt(
  uuid, integer, integer, text, text, integer, text, text, text
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION arena.finish_leaderboard_acquisition_attempt(
  uuid, text, text, text, text, text, timestamptz, timestamptz, text,
  bigint, bigint, bigint, integer, text, integer, integer, text,
  integer, integer, integer, integer, boolean, boolean, text, text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION arena.start_leaderboard_acquisition_attempt(
  uuid, integer, integer, text, text, integer, text, text, text
) TO service_role;
GRANT EXECUTE ON FUNCTION arena.finish_leaderboard_acquisition_attempt(
  uuid, text, text, text, text, text, timestamptz, timestamptz, text,
  bigint, bigint, bigint, integer, text, integer, integer, text,
  integer, integer, integer, integer, boolean, boolean, text, text
) TO service_role;

DO $postflight$
DECLARE
  v_start_sha256 text;
  v_finish_sha256 text;
BEGIN
  SELECT pg_catalog.encode(
           pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc, 'UTF8')),
           'hex'
         )
  INTO STRICT v_start_sha256
  FROM pg_catalog.pg_proc AS function_row
  JOIN pg_catalog.pg_language AS language_row
    ON language_row.oid = function_row.prolang
  WHERE function_row.oid =
        'arena.start_leaderboard_acquisition_attempt(uuid,integer,integer,text,text,integer,text,text,text)'
          ::pg_catalog.regprocedure
    AND function_row.prokind = 'f'
    AND function_row.proowner = 'postgres'::pg_catalog.regrole
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND language_row.lanname = 'plpgsql'
    AND function_row.proconfig @> ARRAY[
      'search_path=pg_catalog, pg_temp',
      'lock_timeout=5s',
      'statement_timeout=30s'
    ]::pg_catalog.text[];

  SELECT pg_catalog.encode(
           pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc, 'UTF8')),
           'hex'
         )
  INTO STRICT v_finish_sha256
  FROM pg_catalog.pg_proc AS function_row
  JOIN pg_catalog.pg_language AS language_row
    ON language_row.oid = function_row.prolang
  WHERE function_row.oid =
        'arena.finish_leaderboard_acquisition_attempt(uuid,text,text,text,text,text,timestamp with time zone,timestamp with time zone,text,bigint,bigint,bigint,integer,text,integer,integer,text,integer,integer,integer,integer,boolean,boolean,text,text)'
          ::pg_catalog.regprocedure
    AND function_row.prokind = 'f'
    AND function_row.proowner = 'postgres'::pg_catalog.regrole
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND language_row.lanname = 'plpgsql'
    AND function_row.proconfig @> ARRAY[
      'search_path=pg_catalog, pg_temp',
      'lock_timeout=5s',
      'statement_timeout=30s'
    ]::pg_catalog.text[];

  IF v_start_sha256 IS DISTINCT FROM
       '3fe0c7fb170dfd43022f07736012f84cd5083a8e79e038e037efae2b6462cdcd'
     OR v_finish_sha256 IS DISTINCT FROM
       '3b40b3f8c79a7187edfe42e9f419e79a4d445625d6e6a9c13926470897eb35cb' THEN
    RAISE EXCEPTION
      'partitioned manifest V4 acquisition RPC rewrite hash failed: start %, finish %',
      v_start_sha256,
      v_finish_sha256;
  END IF;

  IF (
       SELECT pg_catalog.count(*)
       FROM arena.leaderboard_capture_contracts AS capture
       JOIN arena.sources AS source_row
         ON source_row.id = capture.source_id
       WHERE capture.capture_contract =
             'arena.ingest.leaderboard-acquisition-manifest@4'
         AND capture.adapter_slug = 'bitget_bots'
         AND capture.attempt_binding_contract =
             'arena.ingest.leaderboard-acquisition-attempt-binding@1'
         AND capture.requires_runner_git_sha
         AND source_row.slug = ANY (
           ARRAY[
             'bitget_bots_futures',
             'bitget_bots_spot'
           ]::pg_catalog.text[]
         )
     ) <> 2
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
    RAISE EXCEPTION 'partitioned manifest V4 registry postflight failed';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
       'service_role',
       'arena.start_leaderboard_acquisition_attempt(uuid,integer,integer,text,text,integer,text,text,text)',
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role',
       'arena.finish_leaderboard_acquisition_attempt(uuid,text,text,text,text,text,timestamp with time zone,timestamp with time zone,text,bigint,bigint,bigint,integer,text,integer,integer,text,integer,integer,integer,integer,boolean,boolean,text,text)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'anon',
       'arena.start_leaderboard_acquisition_attempt(uuid,integer,integer,text,text,integer,text,text,text)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'anon',
       'arena.finish_leaderboard_acquisition_attempt(uuid,text,text,text,text,text,timestamp with time zone,timestamp with time zone,text,bigint,bigint,bigint,integer,text,integer,integer,text,integer,integer,integer,integer,boolean,boolean,text,text)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated',
       'arena.start_leaderboard_acquisition_attempt(uuid,integer,integer,text,text,integer,text,text,text)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated',
       'arena.finish_leaderboard_acquisition_attempt(uuid,text,text,text,text,text,timestamp with time zone,timestamp with time zone,text,bigint,bigint,bigint,integer,text,integer,integer,text,integer,integer,integer,integer,boolean,boolean,text,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'partitioned manifest V4 acquisition RPC ACL postflight failed';
  END IF;
END
$postflight$;

COMMENT ON TABLE arena.leaderboard_capture_contracts IS
  'Append-only reviewed capture contracts. Manifest V4 is population evidence for exact partitioned sources and never grants metric trust.';

COMMIT;
