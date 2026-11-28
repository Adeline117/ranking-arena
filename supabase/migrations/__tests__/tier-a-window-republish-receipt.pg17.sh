#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for 20261127202748_tier_a_window_republish_receipt.sql:
# arena.record_tier_a_execution_window_republish_receipt records the window
# receipt for an attempt that an earlier queue attempt of the same job
# captured, exactly once, and refuses everything else.
#
# Fixtures as in tier-a-window-receipt-exhaustion-branch.pg17.sh: the claim
# fence (assert_tier_a_execution_write) is a no-op and the exhaustion bound
# reads a fixture table, because this proof is about the receipt predicate.
# The existing receipt RPC is installed from 20261118161307 and must be
# untouched by this migration (its digest is pinned by the worker).
#
# Every fixture object and migration runs as a NOSUPERUSER postgres role.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATIONS="$ROOT_DIR/supabase/migrations"
RECEIPT_MIGRATION="$MIGRATIONS/20261118161307_tier_a_window_receipt_exhaustion_branch.sql"
MIGRATION="$MIGRATIONS/20261127202748_tier_a_window_republish_receipt.sql"
RECEIPT_SHA256=8f23cbae0358f200dc7b2a0f4e00c7e218470ba1427968aa9fab0e390e8e1ef3
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

TMP_ROOT="$(mktemp -d /tmp/tier-a-republish-receipt-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
ERROR_FILE="$TMP_ROOT/expected-error.log"
PORT="${PGPORT_OVERRIDE:-$((49000 + ($$ % 7000)))}"
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
psql_admin() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -U supabase_admin -d postgres "$@"
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

receipt_body_sha256() {
  psql_cmd -Atqc "
    SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(prosrc, 'UTF8')), 'hex')
    FROM pg_catalog.pg_proc
    WHERE oid = 'arena.record_tier_a_execution_window_receipt(uuid,bigint,uuid,bigint)'::pg_catalog.regprocedure"
}

uuid() { printf '00000000-0000-4000-8000-%012d' "$1"; }

# republish <claim n> <generation> <attempt n> <snapshot id>, as service_role.
republish() {
  psql_cmd -Atq <<SQL
SET ROLE service_role;
SELECT arena.record_tier_a_execution_window_republish_receipt(
  '$(uuid "$1")', $2, '$(uuid "$3")', $4
)->>'attempt_seq';
SQL
}

expect_refused() {
  local label="$1" expected="$2"
  shift 2
  if republish "$@" >"$ERROR_FILE" 2>&1; then
    echo "FAIL: $label: a republish receipt was recorded" >&2
    exit 1
  fi
  if ! grep -q "$expected" "$ERROR_FILE"; then
    echo "FAIL: $label: refused for an unexpected reason" >&2
    cat "$ERROR_FILE" >&2
    exit 1
  fi
  echo "ok: refused: $label"
}

counts() {
  psql_cmd -Atqc "SELECT (SELECT count(*) FROM arena.tier_a_execution_window_receipts) || '/' ||
                         (SELECT count(*) FROM arena.tier_a_execution_window_republishes)"
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

-- Claims of source s (s = 1..12): claim 10s+1 (generation 1, queue attempt 0),
-- 10s+2 (generation 2, attempt 1), 10s+3 (generation 3, attempt 2) of job-s,
-- and 10s+9 (generation 4) of another job.
INSERT INTO arena.tier_a_execution_claims
SELECT ('00000000-0000-4000-8000-' || pg_catalog.lpad((10 * s + c)::text, 12, '0'))::uuid,
       g, s, 'arena:ingest:local', CASE WHEN c = 9 THEN 'other-job-' || s ELSE 'job-' || s END, qa
  FROM pg_catalog.generate_series(1, 12) AS s,
       (VALUES (1, 1, 0), (2, 2, 1), (3, 3, 2), (9, 4, 0)) AS v(c, g, qa);

-- Attempt 100s+1 of source s, window 7, captured by claim 10s+1 (queue
-- attempt 0), cycle cycle-s; snapshot 1000s+1 carries payload RAW 5000s+1.
INSERT INTO arena.leaderboard_acquisition_attempts
SELECT 100 * s + 1, ('00000000-0000-4000-8000-' || pg_catalog.lpad((100 * s + 1)::text, 12, '0'))::uuid,
       s, 7, ('00000000-0000-4000-8000-' || pg_catalog.lpad((10 * s + 1)::text, 12, '0'))::uuid,
       1, 'job-' || s, 0, 'cycle-' || s
  FROM pg_catalog.generate_series(1, 12) AS s;
INSERT INTO arena.leaderboard_acquisition_outcomes
SELECT 100 * s + 1, 'complete', 'verified', 'consistent', 500, NULL, 'run-' || s, 5000 * s + 1
  FROM pg_catalog.generate_series(1, 12) AS s;
INSERT INTO arena.leaderboard_snapshots
SELECT 1000 * s + 1, s, 7, true, false, 5000 * s + 1
  FROM pg_catalog.generate_series(1, 12) AS s;

-- Source 2: exhausted outcome with a holding proof.
UPDATE arena.leaderboard_acquisition_outcomes
   SET terminal_state = 'unknown', population_state = 'unknown',
       population_report_state = 'unknown', reported_population = NULL,
       reason_code = 'population_unknown'
 WHERE attempt_seq IN (201, 301);
INSERT INTO arena.fixture_exhaustion_bound VALUES (201);
-- Source 3: exhausted outcome without a holding proof (no fixture row).
-- Source 4: a later attempt (402) of the same window started after 401.
INSERT INTO arena.leaderboard_acquisition_attempts VALUES
  (402, '00000000-0000-4000-8000-000000000402', 4, 7,
   '00000000-0000-4000-8000-000000000042', 2, 'job-4', 1, 'cycle-4');
-- Source 5: the snapshot carries another payload RAW.
UPDATE arena.leaderboard_snapshots SET raw_object_id = 9 WHERE id = 5001;
-- Source 6: the snapshot did not pass the count check.
UPDATE arena.leaderboard_snapshots SET count_check_passed = false WHERE id = 6001;
-- Source 7: the snapshot is another window's.
UPDATE arena.leaderboard_snapshots SET timeframe = 30 WHERE id = 7001;
-- Source 8: captured by the same claim that would republish it (10*8+2).
UPDATE arena.leaderboard_acquisition_attempts
   SET execution_claim_id = '00000000-0000-4000-8000-000000000082',
       execution_generation_seq = 2, queue_attempt = 1
 WHERE attempt_seq = 801;
-- Source 9: captured by a claim of another job (10*9+9).
UPDATE arena.leaderboard_acquisition_attempts
   SET execution_claim_id = '00000000-0000-4000-8000-000000000099',
       execution_generation_seq = 4, queue_job_id = 'other-job-9'
 WHERE attempt_seq = 901;
-- Source 10: no outcome.
DELETE FROM arena.leaderboard_acquisition_outcomes WHERE attempt_seq = 1001;
-- Source 11: the attempt's queue attempt does not match its claim.
UPDATE arena.leaderboard_acquisition_attempts SET queue_attempt = 1 WHERE attempt_seq = 1101;
SQL

# The existing receipt RPC as 20261118161307 leaves it, owner and ACL.
awk '
  index($0, "CREATE OR REPLACE FUNCTION arena.record_tier_a_execution_window_receipt(") == 1 { emit = 1 }
  emit { print }
  emit && $0 == "$function$;" { exit }
' "$RECEIPT_MIGRATION" | psql_cmd -q
psql_cmd -q <<'SQL'
REVOKE ALL ON FUNCTION arena.record_tier_a_execution_window_receipt(uuid, bigint, uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION arena.record_tier_a_execution_window_receipt(uuid, bigint, uuid, bigint) TO service_role;
SQL
expect_eq "existing receipt RPC digest before" "$(receipt_body_sha256)" "$RECEIPT_SHA256"

# Source 12: the window already holds a normal receipt from the capturing claim.
psql_cmd -Atq >/dev/null <<'SQL'
SET ROLE service_role;
SELECT arena.record_tier_a_execution_window_receipt(
  '00000000-0000-4000-8000-000000000121', 1, '00000000-0000-4000-8000-000000001201', 12001);
SQL

# Negative control: the existing receipt RPC refuses the retry's claim for an
# attempt an earlier queue attempt captured (the 2026-11-27 failure mode).
if psql_cmd -Atq >"$ERROR_FILE" 2>&1 <<'SQL'
SET ROLE service_role;
SELECT arena.record_tier_a_execution_window_receipt(
  '00000000-0000-4000-8000-000000000012', 2, '00000000-0000-4000-8000-000000000101', 1001);
SQL
then
  echo "FAIL: the existing receipt RPC accepted another claim's attempt" >&2
  exit 1
fi
grep -q "Tier-A window receipt evidence is incomplete or mismatched" "$ERROR_FILE" || { cat "$ERROR_FILE" >&2; exit 1; }
echo "ok: before: the existing receipt RPC refuses a retry's receipt for an earlier capture"

# ── Apply, replay ──
psql_cmd -q -f "$MIGRATION"
psql_cmd -q -f "$MIGRATION"
echo "ok: migration applies as the NOSUPERUSER owner and replays"
expect_eq "existing receipt RPC untouched (worker-pinned digest)" "$(receipt_body_sha256)" "$RECEIPT_SHA256"

# ── Accepted ──
expect_eq "baseline counts" "$(counts)" "1/0"
expect_eq "a complete capture of queue attempt 0 is receipted by queue attempt 1" "$(republish 12 2 101 1001)" "101"
expect_eq "receipt and republish row recorded" "$(counts)" "2/1"
expect_eq "republish row names both claims" "$(psql_cmd -Atqc "
  SELECT captured_by_claim_id || '|' || captured_by_generation_seq || '|' || published_by_claim_id || '|' || published_by_generation_seq
    FROM arena.tier_a_execution_window_republishes WHERE attempt_seq = 101")" \
  "$(uuid 11)|1|$(uuid 12)|2"
expect_eq "the receipt row is the normal receipt shape for the publishing claim" "$(psql_cmd -Atqc "
  SELECT contract || '|' || claim_id || '|' || generation_seq || '|' || attempt_seq || '|' || snapshot_id || '|' || raw_object_id || '|' || source_run_id
    FROM arena.tier_a_execution_window_receipts WHERE attempt_seq = 101")" \
  "arena.ingest.tier-a-execution-window-receipt@1|$(uuid 12)|2|101|1001|5001|run-1"
expect_eq "an identical repeated call returns the recorded receipt" "$(republish 12 2 101 1001)" "101"
expect_eq "and records nothing more" "$(counts)" "2/1"
expect_refused "a second republish of the same attempt by a later claim" \
  "conflicts with a recorded receipt" 13 3 101 1001
expect_eq "the second republish records nothing" "$(counts)" "2/1"
expect_eq "an exhausted capture with a holding proof is receipted" "$(republish 22 2 201 2001)" "201"

# ── Refused ──
expect_refused "an exhausted capture without a holding proof" "incomplete or mismatched" 32 2 301 3001
expect_refused "a capture that is no longer the window's latest attempt" "incomplete or mismatched" 42 2 401 4001
expect_refused "a snapshot carrying another payload RAW" "incomplete or mismatched" 52 2 501 5001
expect_refused "a snapshot that did not pass the count check" "incomplete or mismatched" 62 2 601 6001
expect_refused "a snapshot of another window" "incomplete or mismatched" 72 2 701 7001
expect_refused "a capture of the calling claim itself" "incomplete or mismatched" 82 2 801 8001
expect_refused "a capture of another queue job" "incomplete or mismatched" 92 2 901 9001
expect_refused "an attempt without an outcome" "does not exist" 102 2 1001 10001
expect_refused "an attempt whose queue attempt is not its claim's" "incomplete or mismatched" 112 2 1101 11001
expect_refused "a window that already holds a normal receipt" "conflicts with a recorded receipt" 122 2 1201 12001
expect_refused "an earlier claim publishing a later claim's capture" "incomplete or mismatched" 81 1 801 8001
expect_refused "an invalid identity" "invalid Tier-A republish receipt identity" 12 0 101 1001
expect_eq "refusals record nothing" "$(counts)" "3/2"

# ── Append-only and ACL ──
for statement in \
  "UPDATE arena.tier_a_execution_window_republishes SET recorded_at = now()" \
  "DELETE FROM arena.tier_a_execution_window_republishes" \
  "TRUNCATE arena.tier_a_execution_window_republishes"; do
  if psql_cmd -qc "$statement" >"$ERROR_FILE" 2>&1; then
    echo "FAIL: the owner could run: $statement" >&2
    exit 1
  fi
  grep -q "append-only" "$ERROR_FILE" || { cat "$ERROR_FILE" >&2; exit 1; }
done
echo "ok: republish rows are append-only, even for the owner"
for role in anon authenticated; do
  if psql_cmd -qc "SET ROLE $role; SELECT arena.record_tier_a_execution_window_republish_receipt('$(uuid 12)', 2, '$(uuid 101)', 1001)" >"$ERROR_FILE" 2>&1; then
    echo "FAIL: $role may call the republish receipt RPC" >&2
    exit 1
  fi
  grep -q "permission denied" "$ERROR_FILE" || { cat "$ERROR_FILE" >&2; exit 1; }
done
if psql_cmd -qc "SET ROLE service_role; INSERT INTO arena.tier_a_execution_window_republishes VALUES (999, 1, 'q', 'j', 'c', 7, '$(uuid 11)', 1, '$(uuid 12)', 2, now())" >"$ERROR_FILE" 2>&1; then
  echo "FAIL: service_role may insert republish rows directly" >&2
  exit 1
fi
grep -q "permission denied" "$ERROR_FILE" || { cat "$ERROR_FILE" >&2; exit 1; }
echo "ok: only service_role may call it, and nobody but the function writes republish rows"

echo "Tier-A window republish receipt PostgreSQL 17 proof passed"
