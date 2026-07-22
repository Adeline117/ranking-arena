#!/usr/bin/env bash

# PostgreSQL 17 proof for the pure Arena Score v4 scorer. The fixture is shared
# with the TypeScript parity test, so neither implementation can silently
# redefine the golden outputs.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260722041000_pure_arena_score_v4_scorer.sql"
GOLDEN_FIXTURE="$ROOT_DIR/supabase/migrations/__tests__/fixtures/arena-score-v4-golden-vectors.json"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ "$("$PG_BIN/psql" --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/pure-arena-score-v4-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((58000 + ($$ % 7000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -200 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

"$PG_BIN/initdb" \
  -D "$DATA_DIR" \
  --auth-local=trust \
  --auth-host=trust \
  --encoding=UTF8 \
  --no-locale >/dev/null
"$PG_BIN/pg_ctl" \
  -D "$DATA_DIR" \
  -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" \
  -w start >/dev/null

psql_cmd -q <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE leaked_default_role NOLOGIN;
CREATE SCHEMA arena;
CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;

-- Prove the migration revokes grants inherited from hostile default ACLs.
ALTER DEFAULT PRIVILEGES IN SCHEMA arena
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role, leaked_default_role;
SQL

psql_cmd -q -f "$MIGRATION"

psql_cmd -q -v golden_json="$(<"$GOLDEN_FIXTURE")" <<'SQL'
CREATE TEMP TABLE golden_fixture (payload jsonb NOT NULL);
INSERT INTO golden_fixture (payload) VALUES (:'golden_json'::jsonb);

DO $catalog_and_acl_proof$
DECLARE
  v_oid oid := 'arena.compute_arena_scores_v4_json(text,jsonb)'::regprocedure::oid;
  v_round_oid oid := 'arena.arena_score_v4_round2(double precision)'::regprocedure::oid;
  v_digest_oid oid := 'extensions.digest(bytea,text)'::regprocedure::oid;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid IN (v_oid, v_round_oid)
      AND (
        function_row.provolatile <> 'i'
        OR function_row.prosecdef
        OR function_row.proparallel <> 's'
        OR function_row.proconfig IS NULL
        OR NOT ('search_path=pg_catalog, pg_temp' = ANY(function_row.proconfig))
      )
  ) THEN
    RAISE EXCEPTION 'scorer catalog contract is not immutable security-invoker parallel-safe';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS digest_row
    WHERE digest_row.oid = v_digest_oid
      AND (digest_row.provolatile <> 'i' OR digest_row.proparallel <> 's')
  ) THEN
    RAISE EXCEPTION 'extensions.digest is not immutable parallel-safe';
  END IF;

  IF pg_catalog.has_function_privilege(
       'anon', 'arena.compute_arena_scores_v4_json(text,jsonb)', 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated', 'arena.compute_arena_scores_v4_json(text,jsonb)', 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'service_role', 'arena.compute_arena_scores_v4_json(text,jsonb)', 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'leaked_default_role',
       'arena.compute_arena_scores_v4_json(text,jsonb)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'anon', 'arena.arena_score_v4_round2(double precision)', 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated', 'arena.arena_score_v4_round2(double precision)', 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'service_role', 'arena.arena_score_v4_round2(double precision)', 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'leaked_default_role', 'arena.arena_score_v4_round2(double precision)', 'EXECUTE'
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
       WHERE function_row.oid IN (v_oid, v_round_oid)
         AND privilege_row.grantee <> function_row.proowner
         AND privilege_row.privilege_type = 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'a non-owner role can execute the private scorer';
  END IF;
END
$catalog_and_acl_proof$;

DO $golden_vector_proof$
DECLARE
  v_case jsonb;
  v_result jsonb;
  v_reversed_inputs jsonb;
  v_reversed_result jsonb;
  v_recomputed_output_digest text;
  v_numeric_spelling_a jsonb;
  v_numeric_spelling_b jsonb;
  v_negative_zero_a jsonb;
  v_negative_zero_b jsonb;
  v_pg17_math_boundary jsonb;
  v_pg17_math_result jsonb;
BEGIN
  FOR v_case IN
    SELECT case_row.value
    FROM golden_fixture AS fixture
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
      fixture.payload->'cases'
    ) AS case_row(value)
  LOOP
    v_result := arena.compute_arena_scores_v4_json(
      v_case->>'period',
      v_case->'inputs'
    );

    IF v_result->'outputs' IS DISTINCT FROM v_case->'expected' THEN
      RAISE EXCEPTION 'golden vector % drifted: expected %, got %',
        v_case->>'name', v_case->'expected', v_result->'outputs';
    END IF;
    IF v_result->>'contract' IS DISTINCT FROM 'arena-score-v4-pg17@1'
       OR v_result->>'digestAlgorithm'
          IS DISTINCT FROM 'pg17-jsonb-utf8-sha256@1'
       OR v_result->>'period' IS DISTINCT FROM v_case->>'period'
       OR (v_result->>'inputCount')::integer
          IS DISTINCT FROM pg_catalog.jsonb_array_length(v_case->'inputs')
       OR v_result->>'inputDigest' !~ '^[0-9a-f]{64}$'
       OR v_result->>'outputDigest' !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'golden vector % returned an invalid envelope: %',
        v_case->>'name', v_result;
    END IF;

    v_recomputed_output_digest := pg_catalog.encode(
      extensions.digest(
        pg_catalog.convert_to(
          pg_catalog.jsonb_build_object(
            'contract', 'arena-score-v4-pg17-output@1',
            'period', v_result->>'period',
            'inputDigest', v_result->>'inputDigest',
            'outputs', v_result->'outputs'
          )::text,
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    );
    IF v_result->>'outputDigest' IS DISTINCT FROM v_recomputed_output_digest THEN
      RAISE EXCEPTION 'output digest basis drifted for %', v_case->>'name';
    END IF;

    SELECT COALESCE(
      pg_catalog.jsonb_agg(input_row.value ORDER BY input_row.ordinality DESC),
      '[]'::jsonb
    )
    INTO STRICT v_reversed_inputs
    FROM pg_catalog.jsonb_array_elements(v_case->'inputs')
      WITH ORDINALITY AS input_row(value, ordinality);

    v_reversed_result := arena.compute_arena_scores_v4_json(
      v_case->>'period',
      v_reversed_inputs
    );
    IF v_reversed_result IS DISTINCT FROM v_result THEN
      RAISE EXCEPTION 'order-invariant input digest changed for %', v_case->>'name';
    END IF;
  END LOOP;

  IF (
    SELECT pg_catalog.count(DISTINCT result->>'inputDigest')
    FROM golden_fixture AS fixture
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
      fixture.payload->'cases'
    ) AS case_row(value)
    CROSS JOIN LATERAL (
      SELECT arena.compute_arena_scores_v4_json(
        case_row.value->>'period', case_row.value->'inputs'
      ) AS result
    ) AS scored
    WHERE case_row.value->>'name' LIKE 'single_row_%'
  ) <> 3 THEN
    RAISE EXCEPTION 'period label is not bound into the input digest';
  END IF;

  IF (
    SELECT pg_catalog.count(DISTINCT result->>'outputDigest')
    FROM golden_fixture AS fixture
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
      fixture.payload->'cases'
    ) AS case_row(value)
    CROSS JOIN LATERAL (
      SELECT arena.compute_arena_scores_v4_json(
        case_row.value->>'period', case_row.value->'inputs'
      ) AS result
    ) AS scored
    WHERE case_row.value->>'name' LIKE 'single_row_%'
  ) <> 3 THEN
    RAISE EXCEPTION 'period label is not bound into the output digest';
  END IF;

  IF (
    SELECT pg_catalog.count(DISTINCT result->'outputs')
    FROM golden_fixture AS fixture
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
      fixture.payload->'cases'
    ) AS case_row(value)
    CROSS JOIN LATERAL (
      SELECT arena.compute_arena_scores_v4_json(
        case_row.value->>'period', case_row.value->'inputs'
      ) AS result
    ) AS scored
    WHERE case_row.value->>'name' LIKE 'single_row_%'
  ) <> 1 THEN
    RAISE EXCEPTION 'current period-independent Arena Score v4 math drifted';
  END IF;

  -- The fixture's 1e100 and -1e100 values must travel through float8 math as
  -- finite values; a production NUMERIC column precision must not truncate them.
  IF NOT (
    SELECT ((case_row.value->'inputs'->0->>'pnl')::double precision)
             < 'Infinity'::double precision
    FROM golden_fixture AS fixture
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
      fixture.payload->'cases'
    ) AS case_row(value)
    WHERE case_row.value->>'name' = 'extreme_positive_and_negative_pnl'
  ) THEN
    RAISE EXCEPTION '1e100 did not remain finite in PostgreSQL float8';
  END IF;

  v_numeric_spelling_a := '[{
    "source":"spell","source_trader_id":"same","roi":1,
    "pnl":1000,"max_drawdown":10,"win_rate":50,
    "sharpe_ratio":1,"profit_factor":2,"trades_count":10
  }]'::jsonb;
  v_numeric_spelling_b := '[{
    "source":"spell","source_trader_id":"same","roi":1.0,
    "pnl":1e3,"max_drawdown":1.0e1,"win_rate":5e1,
    "sharpe_ratio":1.00,"profit_factor":2e0,"trades_count":10.0
  }]'::jsonb;
  IF arena.compute_arena_scores_v4_json('30D', v_numeric_spelling_a)
     IS DISTINCT FROM arena.compute_arena_scores_v4_json('30D', v_numeric_spelling_b) THEN
    RAISE EXCEPTION 'numeric-spelling invariant canonical digest changed';
  END IF;

  v_negative_zero_a := '[{
    "source":"spell","source_trader_id":"zero","roi":0,
    "pnl":0,"max_drawdown":0,"win_rate":0,
    "sharpe_ratio":0,"profit_factor":0,"trades_count":0
  }]'::jsonb;
  v_negative_zero_b := '[{
    "source":"spell","source_trader_id":"zero","roi":-0.0,
    "pnl":-0e0,"max_drawdown":-0.00,"win_rate":-0.0,
    "sharpe_ratio":-0e0,"profit_factor":-0.0,"trades_count":-0.0
  }]'::jsonb;
  IF arena.compute_arena_scores_v4_json('30D', v_negative_zero_a)
     IS DISTINCT FROM arena.compute_arena_scores_v4_json('30D', v_negative_zero_b) THEN
    RAISE EXCEPTION 'negative-zero invariant canonical digest changed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM golden_fixture AS fixture
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
      fixture.payload->'roundingBoundary'
    ) AS boundary(value)
    WHERE arena.arena_score_v4_round2(
      (boundary.value->>'input')::double precision
    )
      IS DISTINCT FROM (boundary.value->>'expected')::double precision
  ) THEN
    RAISE EXCEPTION 'currency.js round2 boundary parity drifted';
  END IF;
  IF arena.arena_score_v4_round2(0) IS DISTINCT FROM 0::double precision
     OR arena.arena_score_v4_round2(100) IS DISTINCT FROM 100::double precision THEN
    RAISE EXCEPTION 'currency.js round2 scorer-domain endpoint parity drifted';
  END IF;

  SELECT fixture.payload->'pg17MathBoundary'
  INTO STRICT v_pg17_math_boundary
  FROM golden_fixture AS fixture;
  IF v_pg17_math_boundary->>'contract'
       IS DISTINCT FROM 'arena-score-v4-pg17-math-boundary@1'
     OR (v_pg17_math_boundary->>'expectedPg17FactorPnl')::double precision
       IS NOT DISTINCT FROM
       (v_pg17_math_boundary->>'expectedLegacyV8FactorPnl')::double precision THEN
    RAISE EXCEPTION 'PG17 math boundary fixture contract drifted';
  END IF;
  v_pg17_math_result := arena.compute_arena_scores_v4_json(
    v_pg17_math_boundary->>'period',
    pg_catalog.jsonb_build_array(v_pg17_math_boundary->'input')
  );
  IF (v_pg17_math_result#>>'{outputs,0,factors,pnl}')::double precision
       IS DISTINCT FROM
       (v_pg17_math_boundary->>'expectedPg17FactorPnl')::double precision THEN
    RAISE EXCEPTION 'PG17 authoritative ln math boundary factor drifted: expected %, got %',
      v_pg17_math_boundary->>'expectedPg17FactorPnl',
      v_pg17_math_result#>>'{outputs,0,factors,pnl}';
  END IF;
END
$golden_vector_proof$;

DO $dense_seeded_parity_proof$
DECLARE
  v_dense_inputs jsonb;
  v_result jsonb;
  v_cent_rows text;
  v_cent_digest text;
  v_expected_digest text;
  v_expected_count integer;
  v_period text;
BEGIN
  SELECT
    (fixture.payload->'denseCase'->>'count')::integer,
    fixture.payload->'denseCase'->>'period',
    fixture.payload->'denseCase'->>'expectedCentDigest'
  INTO STRICT v_expected_count, v_period, v_expected_digest
  FROM golden_fixture AS fixture;

  SELECT pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'source', 'dense-' || (series.value % 11)::text,
      'source_trader_id', 'row-' || pg_catalog.lpad(series.value::text, 4, '0'),
      'roi', ((series.value * 7919) % 20001 - 10000)::double precision
        + (series.value % 7)::double precision / 10::double precision,
      'pnl', CASE
        WHEN series.value % 13 = 0 THEN NULL::bigint
        WHEN series.value % 17 = 0 THEN -((series.value * 104729) % 100000000)::bigint
        ELSE (((series.value * 104729) % 100000000) + 1)::bigint
      END,
      'max_drawdown', CASE
        WHEN series.value % 11 = 0 THEN NULL::double precision
        WHEN series.value % 19 = 0 THEN 0::double precision
        ELSE ((series.value * 37) % 10001)::double precision / 100::double precision
      END,
      'win_rate', CASE
        WHEN series.value % 7 = 0 THEN NULL::double precision
        WHEN series.value % 23 = 0 THEN 0::double precision
        ELSE ((series.value * 53) % 10001)::double precision / 100::double precision
      END,
      'sharpe_ratio', CASE
        WHEN series.value % 5 = 0 THEN NULL::double precision
        ELSE (((series.value * 97) % 4001) - 2000)::double precision
          / 100::double precision
      END,
      'profit_factor', CASE
        WHEN series.value % 3 = 0 THEN NULL::double precision
        ELSE (((series.value * 61) % 5001) - 1000)::double precision
          / 100::double precision
      END,
      'trades_count', CASE
        WHEN series.value % 29 = 0 THEN NULL::integer
        WHEN series.value % 31 = 0 THEN 0
        ELSE (series.value * 43) % 5000
      END
    )
    ORDER BY series.value
  )
  INTO STRICT v_dense_inputs
  FROM pg_catalog.generate_series(1, v_expected_count) AS series(value);

  v_result := arena.compute_arena_scores_v4_json(v_period, v_dense_inputs);
  IF (v_result->>'inputCount')::integer <> v_expected_count
     OR pg_catalog.jsonb_array_length(v_result->'outputs') <> v_expected_count THEN
    RAISE EXCEPTION 'dense seeded cohort count drifted';
  END IF;

  SELECT pg_catalog.string_agg(
    pg_catalog.concat(
      output_row.value->>'source', E'\x1f',
      output_row.value->>'sourceTraderId', E'\x1f',
      (((output_row.value->>'totalScore')::numeric * 100)::bigint)::text, E'\x1f',
      (((output_row.value->>'quality')::numeric * 100)::bigint)::text, E'\x1f',
      (((output_row.value->>'confidence')::numeric * 100)::bigint)::text, E'\x1f',
      (((output_row.value#>>'{factors,roi}')::numeric * 100)::bigint)::text, E'\x1f',
      (((output_row.value#>>'{factors,pnl}')::numeric * 100)::bigint)::text, E'\x1f',
      COALESCE(
        (((output_row.value#>>'{factors,drawdown}')::numeric * 100)::bigint)::text,
        'null'
      ), E'\x1f',
      COALESCE(
        (((output_row.value#>>'{factors,sharpe}')::numeric * 100)::bigint)::text,
        'null'
      ), E'\x1f',
      COALESCE(
        (((output_row.value#>>'{factors,consistency}')::numeric * 100)::bigint)::text,
        'null'
      )
    ),
    E'\n'
    ORDER BY
      (output_row.value->>'source') COLLATE "C",
      (output_row.value->>'sourceTraderId') COLLATE "C"
  )
  INTO STRICT v_cent_rows
  FROM pg_catalog.jsonb_array_elements(v_result->'outputs') AS output_row(value);

  v_cent_digest := pg_catalog.encode(
    extensions.digest(pg_catalog.convert_to(v_cent_rows, 'UTF8'), 'sha256'),
    'hex'
  );
  IF v_cent_digest IS DISTINCT FROM v_expected_digest THEN
    RAISE EXCEPTION 'dense seeded TS/PostgreSQL cent digest drifted: expected %, got %',
      v_expected_digest, v_cent_digest;
  END IF;
END
$dense_seeded_parity_proof$;

DO $strict_rejection_proof$
DECLARE
  v_valid jsonb := jsonb_build_object(
    'source', 'alpha',
    'source_trader_id', 'one',
    'roi', 10,
    'pnl', 1000,
    'max_drawdown', 10,
    'win_rate', 50,
    'sharpe_ratio', 1,
    'profit_factor', 1.2,
    'trades_count', 10
  );
  v_inputs jsonb;
  v_expected_message text;
  v_round_input double precision;
BEGIN
  FOR v_inputs, v_expected_message IN
    SELECT invalid_case.inputs, invalid_case.expected_message
    FROM (VALUES
      (
        jsonb_build_array(v_valid, v_valid),
        'duplicate Arena Score v4 input key'::text
      ),
      (
        jsonb_build_array(v_valid || '{"extra":true}'::jsonb),
        'exactly the supported keys'
      ),
      (
        jsonb_build_array(v_valid || '{"roi":"10"}'::jsonb),
        'invalid scalar types'
      ),
      (
        jsonb_build_array(v_valid || '{"roi":"NaN"}'::jsonb),
        'invalid scalar types'
      ),
      (
        jsonb_build_array(v_valid || '{"pnl":"Infinity"}'::jsonb),
        'invalid scalar types'
      ),
      (
        jsonb_build_array(v_valid || '{"pnl":1e301}'::jsonb),
        'outside the finite scorer domain'
      ),
      (
        jsonb_build_array(v_valid || '{"trades_count":10.5}'::jsonb),
        'outside the finite scorer domain'
      )
    ) AS invalid_case(inputs, expected_message)
  LOOP
    BEGIN
      PERFORM arena.compute_arena_scores_v4_json('30D', v_inputs);
      RAISE EXCEPTION 'invalid scorer input unexpectedly succeeded: %', v_inputs;
    EXCEPTION
      WHEN invalid_parameter_value THEN
        IF SQLERRM NOT LIKE '%' || v_expected_message || '%' THEN
          RAISE EXCEPTION 'unexpected scorer rejection: expected %, got %',
            v_expected_message, SQLERRM;
        END IF;
    END;
  END LOOP;

  FOREACH v_round_input IN ARRAY ARRAY[
    -0.01::double precision,
    100.0001::double precision,
    30954907556599436::double precision,
    'NaN'::double precision,
    'Infinity'::double precision,
    '-Infinity'::double precision
  ]
  LOOP
    BEGIN
      PERFORM arena.arena_score_v4_round2(v_round_input);
      RAISE EXCEPTION 'out-of-domain round2 input unexpectedly succeeded: %', v_round_input;
    EXCEPTION WHEN invalid_parameter_value THEN
      IF SQLERRM NOT LIKE '%finite values between 0 and 100%' THEN RAISE; END IF;
    END;
  END LOOP;

  BEGIN
    PERFORM arena.compute_arena_scores_v4_json('1D', jsonb_build_array(v_valid));
    RAISE EXCEPTION 'invalid period unexpectedly succeeded';
  EXCEPTION WHEN invalid_parameter_value THEN
    IF SQLERRM NOT LIKE '%period must be 7D, 30D, or 90D%' THEN RAISE; END IF;
  END;

  SELECT pg_catalog.jsonb_agg(
    v_valid || pg_catalog.jsonb_build_object(
      'source_trader_id', series.value::text
    )
  )
  INTO STRICT v_inputs
  FROM pg_catalog.generate_series(1, 64001) AS series(value);
  BEGIN
    PERFORM arena.compute_arena_scores_v4_json('30D', v_inputs);
    RAISE EXCEPTION 'over-count scorer input unexpectedly succeeded';
  EXCEPTION WHEN program_limit_exceeded THEN
    IF SQLERRM NOT LIKE '%at most 64000 rows%' THEN RAISE; END IF;
  END;

  v_inputs := pg_catalog.jsonb_build_array(
    v_valid || pg_catalog.jsonb_build_object(
      'source', pg_catalog.repeat('x', 67108865)
    )
  );
  BEGIN
    PERFORM arena.compute_arena_scores_v4_json('30D', v_inputs);
    RAISE EXCEPTION 'over-byte scorer input unexpectedly succeeded';
  EXCEPTION WHEN program_limit_exceeded THEN
    IF SQLERRM NOT LIKE '%at most 67108864 bytes%' THEN RAISE; END IF;
  END;
END
$strict_rejection_proof$;
SQL

set +e
REAPPLY_OUTPUT="$(psql_cmd -q -f "$MIGRATION" 2>&1)"
REAPPLY_STATUS=$?
set -e
if [[ "$REAPPLY_STATUS" -eq 0 ]]; then
  echo "pure scorer migration unexpectedly replaced an existing signature" >&2
  exit 1
fi
if [[ "$REAPPLY_OUTPUT" != *"scorer signature already exists; audit before install"* ]]; then
  echo "pure scorer existing-signature preflight failed for the wrong reason" >&2
  echo "$REAPPLY_OUTPUT" >&2
  exit 1
fi

psql_cmd -q -c 'DROP FUNCTION arena.compute_arena_scores_v4_json(text, jsonb);'
set +e
HELPER_REAPPLY_OUTPUT="$(psql_cmd -q -f "$MIGRATION" 2>&1)"
HELPER_REAPPLY_STATUS=$?
set -e
if [[ "$HELPER_REAPPLY_STATUS" -eq 0 ]]; then
  echo "pure scorer migration unexpectedly replaced an existing round2 helper" >&2
  exit 1
fi
if [[ "$HELPER_REAPPLY_OUTPUT" != *"round2 helper signature already exists; audit before install"* ]]; then
  echo "pure scorer round2-helper preflight failed for the wrong reason" >&2
  echo "$HELPER_REAPPLY_OUTPUT" >&2
  exit 1
fi

echo "pure Arena Score v4 PostgreSQL 17 proof passed"
