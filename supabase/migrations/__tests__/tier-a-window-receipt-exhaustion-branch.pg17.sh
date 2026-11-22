#!/usr/bin/env bash

# Executable PostgreSQL 17 proof that arena.record_tier_a_execution_window_receipt
# accepts an exhausted outcome whose exhaustion proof holds (20261118161307),
# exactly like publication and metric-trust authority (20261115141050), while
# every previous refusal still refuses.
#
# The receipt RPC is installed with its reviewed 20260729015500 body, extracted
# from that migration and pinned by digest. Its dependencies are minimal
# fixtures: the claim fence (assert_tier_a_execution_write) is a no-op and
# arena.leaderboard_outcome_exhaustion_bound reads a fixture table, because this
# proof is about the receipt predicate; the exhaustion proof itself has its own
# suite.
#
# Like Supabase, the cluster superuser is supabase_admin and every fixture
# object and migration runs as a NOSUPERUSER postgres role, so a statement only
# a superuser may run (e.g. a function-level SET of a custom parameter) fails
# here exactly as it does in production.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATIONS="$ROOT_DIR/supabase/migrations"
FENCE_MIGRATION="$MIGRATIONS/20260729015500_tier_a_execution_claim_fence.sql"
MIGRATION="20261118161307_tier_a_window_receipt_exhaustion_branch.sql"
READINESS="$ROOT_DIR/worker/src/ingest/attempt-bound-capture-readiness.ts"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
TSX_BIN="${TSX_BIN:-$ROOT_DIR/node_modules/.bin/tsx}"

OLD_SHA256=e5bb12bf86a5ac29154c8e6e38d1225d9cb356231d358b464e73bdf1463ba887
NEW_SHA256=8f23cbae0358f200dc7b2a0f4e00c7e218470ba1427968aa9fab0e390e8e1ef3

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ ! -x "$TSX_BIN" ]]; then
  echo "Repository tsx executable not found: $TSX_BIN" >&2
  exit 1
fi
if [[ "$("$PG_BIN/psql" --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/tier-a-receipt-exhaustion-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
ERROR_FILE="$TMP_ROOT/expected-error.log"
PORT="${PGPORT_OVERRIDE:-$((57000 + ($$ % 8000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -80 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"
}

psql_drift() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -U postgres -d drift "$@"
}

psql_admin() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -U supabase_admin -d postgres "$@"
}

body_sha256() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -U postgres \
    -d "${1:-postgres}" -Atqc "
    SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(prosrc, 'UTF8')), 'hex')
    FROM pg_catalog.pg_proc
    WHERE oid = 'arena.record_tier_a_execution_window_receipt(uuid,bigint,uuid,bigint)'::pg_catalog.regprocedure;
  "
}

expect_eq() {
  local label="$1" actual="$2" expected="$3"
  if [[ "$actual" != "$expected" ]]; then
    echo "$label drifted:" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    exit 1
  fi
}

# record_receipt <attempt-number>: the worker's call, as service_role.
record_receipt() {
  local n="$1"
  psql_cmd -Atq <<SQL
SET ROLE service_role;
SELECT arena.record_tier_a_execution_window_receipt(
  '00000000-0000-4000-8000-0000000000c1', 1,
  '00000000-0000-4000-8000-00000000000$n', 10$n
)->>'attempt_seq';
SQL
}

expect_receipt_refused() {
  local label="$1" n="$2"
  if record_receipt "$n" >"$ERROR_FILE" 2>&1; then
    echo "$label: receipt was recorded" >&2
    exit 1
  fi
  if ! grep -q 'Tier-A window receipt evidence is incomplete or mismatched' "$ERROR_FILE"; then
    echo "$label: refused for an unexpected reason" >&2
    cat "$ERROR_FILE" >&2
    exit 1
  fi
}

"$PG_BIN/initdb" -D "$DATA_DIR" -A trust -U supabase_admin --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" \
  -D "$DATA_DIR" \
  -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" \
  -w start >/dev/null

psql_admin -q <<'SQL'
CREATE ROLE postgres LOGIN NOSUPERUSER CREATEROLE NOBYPASSRLS;
CREATE ROLE anon NOLOGIN NOSUPERUSER;
CREATE ROLE authenticated NOLOGIN NOSUPERUSER;
CREATE ROLE service_role NOLOGIN NOSUPERUSER;
GRANT anon, authenticated, service_role TO postgres;
GRANT CREATE ON DATABASE postgres TO postgres;
ALTER SCHEMA public OWNER TO postgres;
SQL
if [[ "$(psql_cmd -Atqc "SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user")" != "f" ]]; then
  echo "migrations must run as a non-superuser postgres role" >&2
  exit 1
fi

psql_cmd -q <<'SQL'
CREATE SCHEMA arena;
GRANT USAGE ON SCHEMA arena TO service_role, anon, authenticated;

CREATE TABLE arena.tier_a_execution_claims (
  claim_id uuid NOT NULL,
  generation_seq bigint NOT NULL,
  source_id smallint NOT NULL,
  queue_name text NOT NULL,
  queue_job_id text NOT NULL,
  queue_attempt integer NOT NULL,
  PRIMARY KEY (source_id, generation_seq, claim_id)
);

CREATE TABLE arena.leaderboard_acquisition_attempts (
  attempt_seq bigint PRIMARY KEY,
  attempt_id uuid NOT NULL UNIQUE,
  source_id smallint NOT NULL,
  timeframe smallint NOT NULL,
  execution_claim_id uuid,
  execution_generation_seq bigint,
  queue_job_id text,
  queue_attempt integer,
  observation_cycle_id text
);

CREATE TABLE arena.leaderboard_acquisition_outcomes (
  attempt_seq bigint PRIMARY KEY
    REFERENCES arena.leaderboard_acquisition_attempts(attempt_seq),
  terminal_state text NOT NULL,
  population_state text NOT NULL,
  population_report_state text NOT NULL,
  reported_population integer,
  reason_code text,
  source_run_id text,
  source_payload_raw_object_id bigint
);

CREATE TABLE arena.leaderboard_snapshots (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL,
  timeframe smallint NOT NULL,
  count_check_passed boolean,
  is_derived boolean,
  raw_object_id bigint
);

CREATE TABLE arena.tier_a_execution_window_receipts (
  contract text NOT NULL,
  source_id smallint NOT NULL,
  queue_name text NOT NULL,
  queue_job_id text NOT NULL,
  observation_cycle_id text NOT NULL,
  timeframe smallint NOT NULL,
  generation_seq bigint NOT NULL,
  claim_id uuid NOT NULL,
  attempt_seq bigint NOT NULL
    REFERENCES arena.leaderboard_acquisition_attempts(attempt_seq),
  attempt_id uuid NOT NULL,
  snapshot_id bigint NOT NULL REFERENCES arena.leaderboard_snapshots(id),
  raw_object_id bigint NOT NULL,
  source_run_id text NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (source_id, queue_name, queue_job_id, observation_cycle_id, timeframe),
  FOREIGN KEY (source_id, generation_seq, claim_id)
    REFERENCES arena.tier_a_execution_claims(source_id, generation_seq, claim_id)
);

-- Fixture: the claim fence passes; it is not what this proof is about.
CREATE FUNCTION arena.assert_tier_a_execution_write(uuid, bigint)
RETURNS jsonb
LANGUAGE sql
SET search_path = pg_catalog, pg_temp
AS $function$ SELECT '{}'::jsonb $function$;

-- Fixture: an exhaustion proof is recorded and holding exactly for the
-- attempts listed here.
CREATE TABLE arena.fixture_exhaustion_bound (attempt_seq bigint PRIMARY KEY);
CREATE FUNCTION arena.leaderboard_outcome_exhaustion_bound(p_attempt_seq bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM arena.fixture_exhaustion_bound AS bound
     WHERE bound.attempt_seq = p_attempt_seq
  )
$function$;

CREATE FUNCTION arena.tier_a_execution_receipt_json(
  p_receipt arena.tier_a_execution_window_receipts
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT pg_catalog.jsonb_build_object(
    'attempt_seq', p_receipt.attempt_seq,
    'snapshot_id', p_receipt.snapshot_id
  )
$function$;

REVOKE ALL ON FUNCTION arena.assert_tier_a_execution_write(uuid, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION arena.leaderboard_outcome_exhaustion_bound(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION arena.tier_a_execution_receipt_json(arena.tier_a_execution_window_receipts) FROM PUBLIC;

INSERT INTO arena.tier_a_execution_claims VALUES
  ('00000000-0000-4000-8000-0000000000c1', 1, 1, 'arena:ingest:local', 'job-1', 1);

-- Attempt n: attempt_seq n, attempt_id ...00n, snapshot 10n, payload RAW 100n,
-- observation cycle cycle-n.
INSERT INTO arena.leaderboard_acquisition_attempts
SELECT n, ('00000000-0000-4000-8000-00000000000' || n)::uuid, 1, 30,
       '00000000-0000-4000-8000-0000000000c1', 1, 'job-1', 1, 'cycle-' || n
  FROM pg_catalog.generate_series(1, 7) AS n;

INSERT INTO arena.leaderboard_snapshots
SELECT 100 + n, 1, 30, true, false, 1000 + n
  FROM pg_catalog.generate_series(1, 7) AS n;

INSERT INTO arena.leaderboard_acquisition_outcomes VALUES
  -- 1: complete (reported total equal to accepted rows).
  (1, 'complete', 'verified', 'consistent', 500, NULL, 'run-1', 1001),
  -- 2: exhausted, proof recorded and holding.
  (2, 'unknown', 'unknown', 'unknown', NULL, 'population_unknown', 'run-2', 1002),
  -- 3: exhausted shape, no holding proof.
  (3, 'unknown', 'unknown', 'unknown', NULL, 'population_unknown', 'run-3', 1003),
  -- 4: complete, but the snapshot carries another payload RAW (below).
  (4, 'complete', 'verified', 'consistent', 500, NULL, 'run-4', 1004),
  -- 5: proof listed, but the outcome is not the exhausted shape.
  (5, 'unknown', 'unknown', 'unknown', NULL, 'population_mismatch', 'run-5', 1005),
  -- 6: proof listed, but a reported total exists.
  (6, 'unknown', 'unknown', 'unknown', 500, 'population_unknown', 'run-6', 1006),
  -- 7: complete, recorded only after the migration.
  (7, 'complete', 'verified', 'consistent', 500, NULL, 'run-7', 1007);
UPDATE arena.leaderboard_snapshots SET raw_object_id = 9999 WHERE id = 104;
INSERT INTO arena.fixture_exhaustion_bound VALUES (2), (5), (6);
SQL

# The reviewed 20260729015500 receipt body, its owner and its ACL.
awk '
  index($0, "CREATE OR REPLACE FUNCTION arena.record_tier_a_execution_window_receipt(") == 1 { emit = 1 }
  emit { print }
  emit && $0 == "$function$;" { exit }
' "$FENCE_MIGRATION" | psql_cmd -q
psql_cmd -q <<'SQL'
REVOKE ALL ON FUNCTION arena.record_tier_a_execution_window_receipt(uuid, bigint, uuid, bigint)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION arena.record_tier_a_execution_window_receipt(uuid, bigint, uuid, bigint)
  TO service_role;
SQL
expect_eq "reviewed 20260729015500 body digest" "$(body_sha256)" "$OLD_SHA256"

# The worker readiness gate accepts both bodies, so either deploy order works.
for digest in "$OLD_SHA256" "$NEW_SHA256"; do
  if ! grep -q "'$digest'" "$READINESS"; then
    echo "worker readiness does not accept receipt digest $digest" >&2
    exit 1
  fi
done

# Before: a complete outcome is receipted; the exhausted one is refused (the
# production failure).
expect_eq "complete receipt (old body)" "$(record_receipt 1)" "1"
expect_receipt_refused "exhausted outcome under the old body" 2

# Negative: any other body refuses the whole migration and changes nothing.
psql_admin -qc "CREATE DATABASE drift TEMPLATE postgres OWNER postgres;"
psql_drift -q <<'SQL'
DO $drift$
BEGIN
  EXECUTE pg_catalog.replace(
    pg_catalog.pg_get_functiondef(
      'arena.record_tier_a_execution_window_receipt(uuid,bigint,uuid,bigint)'::pg_catalog.regprocedure),
    'OR v_outcome.source_run_id IS NULL',
    'OR v_outcome.source_run_id IS NULL OR false');
END
$drift$;
SQL
DRIFTED_SHA256="$(body_sha256 drift)"
if [[ "$DRIFTED_SHA256" == "$OLD_SHA256" ]]; then
  echo "drift fixture did not change the body" >&2
  exit 1
fi
if DRIFT="$(psql_drift -q -f "$MIGRATIONS/$MIGRATION" 2>&1)"; then
  echo "a drifted receipt body was not refused" >&2
  exit 1
fi
if [[ "$DRIFT" != *"body drifted from the reviewed 20260729015500 body"* ]]; then
  echo "drift refusal had the wrong reason: $DRIFT" >&2
  exit 1
fi
expect_eq "drifted body after refusal" "$(body_sha256 drift)" "$DRIFTED_SHA256"

# Apply as the NOSUPERUSER owner, then replay (own digest accepted).
PGOPTIONS='-c client_min_messages=warning' psql_cmd -q -f "$MIGRATIONS/$MIGRATION" >/dev/null
expect_eq "new body digest" "$(body_sha256)" "$NEW_SHA256"
PGOPTIONS='-c client_min_messages=warning' psql_cmd -q -f "$MIGRATIONS/$MIGRATION" >/dev/null
expect_eq "replayed body digest" "$(body_sha256)" "$NEW_SHA256"

# The new body is the old body with exactly the terminal predicate replaced.
OLD_BODY="$TMP_ROOT/old.sql"
NEW_BODY="$TMP_ROOT/new.sql"
awk '
  index($0, "CREATE OR REPLACE FUNCTION arena.record_tier_a_execution_window_receipt(") == 1 { emit = 1 }
  emit { print }
  emit && $0 == "$function$;" { exit }
' "$FENCE_MIGRATION" >"$OLD_BODY"
awk '
  index($0, "CREATE OR REPLACE FUNCTION arena.record_tier_a_execution_window_receipt(") == 1 { emit = 1 }
  emit { print }
  emit && $0 == "$function$;" { exit }
' "$MIGRATIONS/$MIGRATION" >"$NEW_BODY"
REMOVED="$(diff "$OLD_BODY" "$NEW_BODY" | grep '^<' || true)"
expect_eq "removed body lines" "$REMOVED" \
  "<      OR v_outcome.terminal_state IS DISTINCT FROM 'complete'"

# After: complete outcomes still receipt (replay returns the frozen receipt,
# a new one records); the exhausted outcome with a holding proof records.
expect_eq "complete receipt replay" "$(record_receipt 1)" "1"
expect_eq "complete receipt (new body)" "$(record_receipt 7)" "7"
expect_eq "exhausted receipt" "$(record_receipt 2)" "2"
expect_eq "exhausted receipt replay" "$(record_receipt 2)" "2"

# Still refused: an exhausted outcome without a holding proof, mismatched
# snapshot evidence, and a proof-listed outcome that is not the exhausted shape.
expect_receipt_refused "exhausted outcome without a holding proof" 3
expect_receipt_refused "mismatched snapshot payload" 4
expect_receipt_refused "non-exhausted reason code" 5
expect_receipt_refused "reported total present" 6

# A holding proof does not waive the snapshot checks.
psql_cmd -qc "UPDATE arena.leaderboard_snapshots SET count_check_passed = false WHERE id = 103;"
psql_cmd -qc "INSERT INTO arena.fixture_exhaustion_bound VALUES (3);"
expect_receipt_refused "exhausted outcome with a failed count check" 3

# The bound is read live: once the proof no longer holds, even a replay of
# the recorded receipt is refused.
psql_cmd -qc "DELETE FROM arena.fixture_exhaustion_bound WHERE attempt_seq = 2;"
expect_receipt_refused "exhausted receipt replay without a holding proof" 2

# The worker's own RPC proof query runs against the replaced function and
# reports the new digest (the other pinned RPCs are absent from this fixture).
WORKER_PROOF="$(
  {
    cd "$ROOT_DIR"
    printf '%s\n' \
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;' \
      'SET LOCAL search_path = pg_catalog, pg_temp;'
    "$TSX_BIN" -e \
      "import { PARTITIONED_V4_RPC_PROOF_SQL as sql } from './worker/src/ingest/attempt-bound-capture-readiness.ts'; process.stdout.write(sql + ';\\n')"
    printf '%s\n' 'ROLLBACK;'
  } | psql_cmd -Aq -F $'\t' -P footer=off |
    awk -F '\t' '
      NF > 1 && !header { for (i = 1; i <= NF; i += 1) if ($i == "execution_record_receipt_rpc_sha256") column = i; header = 1; next }
      NF > 1 && header { print $column }
    '
)"
expect_eq "worker RPC proof receipt digest" "$WORKER_PROOF" "$NEW_SHA256"

expect_eq "receipts recorded" \
  "$(psql_cmd -Atqc "SELECT pg_catalog.string_agg(attempt_seq::text, ',' ORDER BY attempt_seq) FROM arena.tier_a_execution_window_receipts")" \
  "1,2,7"

# Owner, SECURITY DEFINER, exact configuration (no custom parameter) and ACL.
CONTRACT="$(
  psql_cmd -Atqc "
    SELECT pg_catalog.pg_get_userbyid(proowner) || '|' || prosecdef || '|' ||
           pg_catalog.array_to_string(proconfig, ';') || '|' ||
           has_function_privilege('service_role', oid, 'EXECUTE') || '|' ||
           has_function_privilege('anon', oid, 'EXECUTE') || '|' ||
           has_function_privilege('authenticated', oid, 'EXECUTE')
    FROM pg_catalog.pg_proc
    WHERE oid = 'arena.record_tier_a_execution_window_receipt(uuid,bigint,uuid,bigint)'::pg_catalog.regprocedure;
  "
)"
expect_eq "function contract" "$CONTRACT" \
  "postgres|true|search_path=pg_catalog, pg_temp;TimeZone=UTC;lock_timeout=10s;statement_timeout=30s|true|false|false"

echo "Tier-A window receipt exhaustion branch PostgreSQL 17 proof passed"
