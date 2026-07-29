#!/usr/bin/env bash

# PostgreSQL 17 proof for the inert Arena Score v5 zero-metric contract.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
V4_MIGRATION="$ROOT_DIR/supabase/migrations/20260722041000_pure_arena_score_v4_scorer.sql"
V5_MIGRATION="$ROOT_DIR/supabase/migrations/20260729070000_pure_arena_score_v5_zero_metric_scorer.sql"
GOLDEN_FIXTURE="$ROOT_DIR/supabase/migrations/__tests__/fixtures/arena-score-v5-zero-metrics-golden.json"
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

TMP_ROOT="$(mktemp -d /tmp/pure-arena-score-v5-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((59000 + ($$ % 5000)))}"
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

ALTER DEFAULT PRIVILEGES IN SCHEMA arena
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role, leaked_default_role;
SQL

psql_cmd -q -f "$V4_MIGRATION"
psql_cmd -q -f "$V5_MIGRATION"

psql_cmd -q -v golden_json="$(<"$GOLDEN_FIXTURE")" <<'SQL'
CREATE TEMP TABLE v5_golden_fixture (payload jsonb NOT NULL);
INSERT INTO v5_golden_fixture (payload) VALUES (:'golden_json'::jsonb);

DO $catalog_acl_and_immutability_proof$
DECLARE
  v_v4_oid oid :=
    'arena.compute_arena_scores_v4_json(text,jsonb)'::regprocedure::oid;
  v_v5_oid oid :=
    'arena.compute_arena_scores_v5_json(text,jsonb)'::regprocedure::oid;
  v_round_oid oid :=
    'arena.arena_score_v4_round2(double precision)'::regprocedure::oid;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_v5_oid
      AND (
        function_row.provolatile <> 'i'
        OR function_row.prosecdef
        OR function_row.proparallel <> 's'
        OR function_row.prolang <>
          (SELECT oid FROM pg_catalog.pg_language WHERE lanname = 'plpgsql')
        OR function_row.prorettype <> 'jsonb'::regtype
        OR function_row.prokind <> 'f'
        OR function_row.proretset
        OR function_row.proisstrict
        OR function_row.proleakproof
        OR function_row.proconfig IS DISTINCT FROM ARRAY[
          'search_path=pg_catalog, pg_temp',
          'extra_float_digits=3'
        ]::text[]
      )
  ) THEN
    RAISE EXCEPTION 'v5 scorer catalog contract drifted';
  END IF;

  IF (SELECT proowner FROM pg_catalog.pg_proc WHERE oid = v_v5_oid)
       IS DISTINCT FROM
     (SELECT proowner FROM pg_catalog.pg_proc WHERE oid = v_v4_oid) THEN
    RAISE EXCEPTION 'v5 scorer owner differs from frozen v4 scorer owner';
  END IF;

  IF pg_catalog.encode(
       pg_catalog.sha256(
         pg_catalog.convert_to(
           (SELECT prosrc FROM pg_catalog.pg_proc WHERE oid = v_v4_oid),
           'UTF8'
         )
       ),
       'hex'
     ) <> 'a3c245893d5a939020f70c70d09e41bf2e5b28e3ad640daf619c264c3bb530ba'
     OR pg_catalog.encode(
       pg_catalog.sha256(
         pg_catalog.convert_to(
           (SELECT prosrc FROM pg_catalog.pg_proc WHERE oid = v_round_oid),
           'UTF8'
         )
       ),
       'hex'
     ) <> '412f6e18ad5f311baae7420a3e0298cd2bfd7490533c282d8d46f7d2aa1c40d3'
     OR pg_catalog.encode(
       pg_catalog.sha256(
         pg_catalog.convert_to(
           (SELECT prosrc FROM pg_catalog.pg_proc WHERE oid = v_v5_oid),
           'UTF8'
         )
       ),
       'hex'
     ) <> '166acfea2dc336a160c465d456ac4c93d9ca977fe1a5bac33fc7c0f8a19494ae' THEN
    RAISE EXCEPTION 'v4 or v5 exact source digest drifted';
  END IF;

  IF pg_catalog.to_regprocedure(
       'arena.arena_score_v5_round2(double precision)'
     ) IS NOT NULL THEN
    RAISE EXCEPTION 'v5 unexpectedly duplicated unchanged round2 math';
  END IF;

  IF pg_catalog.has_function_privilege(
       'anon', v_v5_oid, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated', v_v5_oid, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'service_role', v_v5_oid, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'leaked_default_role', v_v5_oid, 'EXECUTE'
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
       WHERE function_row.oid = v_v5_oid
         AND privilege_row.privilege_type = 'EXECUTE'
         AND privilege_row.grantee <> function_row.proowner
     ) THEN
    RAISE EXCEPTION 'v5 scorer leaked EXECUTE privilege';
  END IF;
END
$catalog_acl_and_immutability_proof$;

DO $zero_metric_semantics_proof$
DECLARE
  v_fixture jsonb;
  v_inputs jsonb;
  v_v4 jsonb;
  v_v5 jsonb;
  v_zero jsonb;
  v_positive jsonb;
  v_unknown jsonb;
  v_plus_zero jsonb;
  v_minus_zero jsonb;
  v_null_zero jsonb;
BEGIN
  SELECT fixture_row.payload
  INTO STRICT v_fixture
  FROM v5_golden_fixture AS fixture_row;
  IF v_fixture->>'contract'
       IS DISTINCT FROM 'arena-score-v5-zero-metrics-golden@1'
     OR v_fixture->>'period' IS DISTINCT FROM '30D' THEN
    RAISE EXCEPTION 'v5 golden fixture contract drifted';
  END IF;
  v_inputs := v_fixture->'inputs';

  v_v4 := arena.compute_arena_scores_v4_json('30D', v_inputs);
  v_v5 := arena.compute_arena_scores_v5_json('30D', v_inputs);

  IF v_v5 IS DISTINCT FROM v_fixture->'expectedEnvelope' THEN
    RAISE EXCEPTION 'v5 full PostgreSQL golden envelope drifted: %', v_v5;
  END IF;

  SELECT output_row.value INTO STRICT v_zero
  FROM pg_catalog.jsonb_array_elements(v_v5->'outputs') AS output_row(value)
  WHERE output_row.value->>'sourceTraderId' = 'zero';
  SELECT output_row.value INTO STRICT v_positive
  FROM pg_catalog.jsonb_array_elements(v_v5->'outputs') AS output_row(value)
  WHERE output_row.value->>'sourceTraderId' = 'positive';
  SELECT output_row.value INTO STRICT v_unknown
  FROM pg_catalog.jsonb_array_elements(v_v5->'outputs') AS output_row(value)
  WHERE output_row.value->>'sourceTraderId' = 'unknown';

  IF (v_zero->'factors'->>'drawdown')::numeric <> 1
     OR (v_positive->'factors'->>'drawdown')::numeric <> 0
     OR v_unknown->'factors'->'drawdown' <> 'null'::jsonb
     OR (v_zero->'factors'->>'consistency')::numeric <> 0
     OR (v_positive->'factors'->>'consistency')::numeric <> 1
     OR v_unknown->'factors'->'consistency' <> 'null'::jsonb
     OR (v_zero->>'confidence')::numeric
          <> (v_positive->>'confidence')::numeric
     OR (v_zero->>'confidence')::numeric
          <= (v_unknown->>'confidence')::numeric THEN
    RAISE EXCEPTION 'trusted zero metrics were not ranked as known values: %', v_v5;
  END IF;

  SELECT output_row.value INTO STRICT v_zero
  FROM pg_catalog.jsonb_array_elements(v_v4->'outputs') AS output_row(value)
  WHERE output_row.value->>'sourceTraderId' = 'zero';
  IF v_zero->'factors'->'drawdown' <> 'null'::jsonb
     OR v_zero->'factors'->'consistency' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'v5 installation changed historical v4 zero semantics';
  END IF;

  v_plus_zero := arena.compute_arena_scores_v5_json(
    '30D',
    pg_catalog.jsonb_build_array(v_inputs->0)
  );
  v_minus_zero := arena.compute_arena_scores_v5_json(
    '30D',
    pg_catalog.jsonb_build_array(
      (v_inputs->0) || '{"max_drawdown":-0,"win_rate":-0}'::jsonb
    )
  );
  v_null_zero := arena.compute_arena_scores_v5_json(
    '30D',
    pg_catalog.jsonb_build_array(
      (v_inputs->0) || '{"max_drawdown":null,"win_rate":null}'::jsonb
    )
  );
  IF v_plus_zero->>'inputDigest' IS DISTINCT FROM v_minus_zero->>'inputDigest'
     OR v_plus_zero->>'outputDigest' IS DISTINCT FROM v_minus_zero->>'outputDigest'
     OR v_plus_zero->>'inputDigest' IS NOT DISTINCT FROM v_null_zero->>'inputDigest'
     OR v_plus_zero->>'outputDigest' IS NOT DISTINCT FROM v_null_zero->>'outputDigest' THEN
    RAISE EXCEPTION '+0/-0 canonicalization or zero/null distinction drifted';
  END IF;

  -- 100% MDD is a representable source fact. The later v2 trust projection,
  -- not this pure scorer, owns its public-rank policy exclusion.
  PERFORM arena.compute_arena_scores_v5_json(
    '30D',
    pg_catalog.jsonb_build_array(
      (v_inputs->0) || '{"max_drawdown":100}'::jsonb
    )
  );
END
$zero_metric_semantics_proof$;
SQL

V5_OID_BEFORE="$(psql_cmd -At -c \
  "SELECT 'arena.compute_arena_scores_v5_json(text,jsonb)'::regprocedure::oid")"
psql_cmd -q -f "$V5_MIGRATION"
V5_OID_AFTER="$(psql_cmd -At -c \
  "SELECT 'arena.compute_arena_scores_v5_json(text,jsonb)'::regprocedure::oid")"
if [[ "$V5_OID_BEFORE" != "$V5_OID_AFTER" ]]; then
  echo "v5 replay changed the scorer OID" >&2
  exit 1
fi

psql_cmd -q -c \
  'ALTER FUNCTION arena.compute_arena_scores_v5_json(text,jsonb) STRICT;'
set +e
DRIFT_OUTPUT="$(psql_cmd -q -f "$V5_MIGRATION" 2>&1)"
DRIFT_STATUS=$?
set -e
if [[ "$DRIFT_STATUS" -eq 0 ]]; then
  echo "v5 migration accepted a drifted existing scorer" >&2
  exit 1
fi
if [[ "$DRIFT_OUTPUT" != *"existing Arena Score v5 scorer contract drifted"* ]]; then
  echo "v5 drift preflight failed for the wrong reason" >&2
  echo "$DRIFT_OUTPUT" >&2
  exit 1
fi

echo "pure Arena Score v5 zero-metric PostgreSQL 17 proof passed"
