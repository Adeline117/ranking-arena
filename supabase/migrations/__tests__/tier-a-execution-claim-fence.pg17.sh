#!/usr/bin/env bash

# PostgreSQL 17 behavioral proof for the expand-only Tier-A execution fence.
# It verifies legacy callable compatibility, current-xid authority derivation,
# monotonic takeover, claimed acquisition binding, deferred COMMIT fencing,
# closed ACLs, immutable receipts, and queue-scoped skip identity.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729015500_tier_a_execution_claim_fence.sql"
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

TMP_ROOT="$(mktemp -d /tmp/tier-a-execution-claim-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
ERROR_FILE="$TMP_ROOT/expected-error.log"
PORT="${PGPORT_OVERRIDE:-$((57000 + ($$ % 7000)))}"
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
    -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"
}

expect_failure() {
  local label="$1"
  local pattern="$2"
  local sql="$3"
  if psql_cmd -q -c "$sql" >"$ERROR_FILE" 2>&1; then
    echo "$label unexpectedly succeeded" >&2
    exit 1
  fi
  if ! rg -q "$pattern" "$ERROR_FILE"; then
    echo "$label failed for an unexpected reason" >&2
    sed -n '1,180p' "$ERROR_FILE" >&2
    exit 1
  fi
}

assert_sql_true() {
  local label="$1"
  local sql="$2"
  local result
  result="$(psql_cmd -Atq -c "$sql")"
  result="$(printf '%s\n' "$result" | rg -v '^$' | tail -1)"
  if [[ "$result" != "t" ]]; then
    echo "$label" >&2
    echo "query result: $result" >&2
    exit 1
  fi
}

"$PG_BIN/initdb" \
  -D "$DATA_DIR" \
  --auth-local=trust \
  --auth-host=trust \
  --encoding=UTF8 \
  --username=postgres \
  --no-locale >/dev/null
"$PG_BIN/pg_ctl" \
  -D "$DATA_DIR" \
  -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" \
  -w start >/dev/null

psql_cmd -q <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE ROLE fixture_rogue NOLOGIN;
CREATE SCHEMA arena;
GRANT USAGE ON SCHEMA arena TO anon, authenticated, service_role, fixture_rogue;

CREATE TABLE arena.sources (
  id smallint PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  status text NOT NULL,
  fetch_region text NOT NULL
);

CREATE TABLE arena.leaderboard_snapshots (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  timeframe smallint NOT NULL,
  scraped_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  count_check_passed boolean,
  is_derived boolean,
  raw_object_id bigint
);

CREATE TABLE arena.leaderboard_acquisition_attempts (
  attempt_seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  attempt_id uuid NOT NULL UNIQUE,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  source_slug text NOT NULL,
  timeframe smallint NOT NULL,
  observation_cycle_id text,
  queue_job_id text,
  queue_attempt integer NOT NULL,
  worker_region text,
  source_fetch_region text NOT NULL,
  recorded_started_at timestamptz NOT NULL
);

CREATE TABLE arena.leaderboard_acquisition_outcomes (
  attempt_seq bigint PRIMARY KEY
    REFERENCES arena.leaderboard_acquisition_attempts(attempt_seq),
  terminal_state text NOT NULL,
  source_run_id text,
  source_payload_raw_object_id bigint
);

CREATE TABLE arena.ingest_worker_instances (
  instance_id uuid PRIMARY KEY,
  node_id text NOT NULL,
  worker_region text NOT NULL,
  control_epoch bigint NOT NULL,
  release_id text NOT NULL,
  git_sha text NOT NULL
);

CREATE TABLE arena.ingest_worker_authorities (
  authority_scope text PRIMARY KEY,
  active_epoch bigint,
  active_instance_id uuid,
  active_node_id text,
  active_control_epoch bigint,
  lease_expires_at timestamptz
);

CREATE TABLE arena.ingest_worker_activations (
  authority_scope text NOT NULL,
  epoch bigint NOT NULL,
  instance_id uuid NOT NULL,
  node_id text NOT NULL,
  worker_region text NOT NULL,
  control_epoch bigint NOT NULL,
  release_id text NOT NULL,
  git_sha text NOT NULL,
  status text NOT NULL,
  ended_at timestamptz,
  PRIMARY KEY (authority_scope, epoch)
);

CREATE TABLE arena.ingest_worker_write_guards (
  top_xid8_text text NOT NULL,
  authority_scope text NOT NULL,
  epoch bigint NOT NULL,
  instance_id uuid NOT NULL,
  node_id text NOT NULL,
  worker_region text NOT NULL,
  control_epoch bigint NOT NULL,
  release_id text NOT NULL,
  git_sha text NOT NULL,
  asserted_at timestamptz NOT NULL,
  lease_expires_at_at_assertion timestamptz NOT NULL,
  PRIMARY KEY (top_xid8_text, authority_scope)
);

INSERT INTO arena.sources (id, slug, status, fetch_region)
VALUES
  (1, 'binance_futures', 'active', 'local'),
  (2, 'future_japan_source', 'active', 'vps_jp'),
  (3, 'replacement_source', 'active', 'local');

INSERT INTO arena.ingest_worker_instances (
  instance_id, node_id, worker_region, control_epoch, release_id, git_sha
) VALUES (
  '11111111-1111-4111-8111-111111111111',
  'fixture-local-1',
  'local',
  10,
  pg_catalog.repeat('1', 64),
  pg_catalog.repeat('1', 40)
);

INSERT INTO arena.ingest_worker_authorities (
  authority_scope, active_epoch, active_instance_id, active_node_id,
  active_control_epoch, lease_expires_at
) VALUES (
  'region:local',
  1,
  '11111111-1111-4111-8111-111111111111',
  'fixture-local-1',
  10,
  pg_catalog.clock_timestamp() + interval '1 hour'
);

INSERT INTO arena.ingest_worker_activations (
  authority_scope, epoch, instance_id, node_id, worker_region,
  control_epoch, release_id, git_sha, status, ended_at
) VALUES (
  'region:local',
  1,
  '11111111-1111-4111-8111-111111111111',
  'fixture-local-1',
  'local',
  10,
  pg_catalog.repeat('1', 64),
  pg_catalog.repeat('1', 40),
  'active',
  NULL
);

CREATE FUNCTION arena.fixture_begin_region_guard(p_source_id integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_source arena.sources%ROWTYPE;
  v_authority arena.ingest_worker_authorities%ROWTYPE;
  v_instance arena.ingest_worker_instances%ROWTYPE;
  v_now timestamptz := pg_catalog.date_trunc(
    'milliseconds', pg_catalog.clock_timestamp()
  );
BEGIN
  SELECT * INTO STRICT v_source FROM arena.sources WHERE id = p_source_id;
  SELECT * INTO STRICT v_authority
    FROM arena.ingest_worker_authorities
   WHERE authority_scope = 'region:' || v_source.fetch_region;
  SELECT * INTO STRICT v_instance
    FROM arena.ingest_worker_instances
   WHERE instance_id = v_authority.active_instance_id;

  INSERT INTO arena.ingest_worker_write_guards (
    top_xid8_text, authority_scope, epoch, instance_id, node_id,
    worker_region, control_epoch, release_id, git_sha, asserted_at,
    lease_expires_at_at_assertion
  ) VALUES (
    pg_catalog.pg_current_xact_id()::text,
    v_authority.authority_scope,
    v_authority.active_epoch,
    v_instance.instance_id,
    v_instance.node_id,
    v_instance.worker_region,
    v_instance.control_epoch,
    v_instance.release_id,
    v_instance.git_sha,
    v_now,
    v_authority.lease_expires_at
  ) ON CONFLICT DO NOTHING;
END
$function$;

CREATE FUNCTION arena.fixture_expire_execution_head(p_source_id integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  EXECUTE
    'UPDATE arena.tier_a_execution_heads
        SET last_heartbeat_at = pg_catalog.clock_timestamp() - interval ''2 seconds'',
            lease_expires_at = pg_catalog.clock_timestamp() - interval ''1 second'',
            updated_at = pg_catalog.clock_timestamp()
      WHERE source_id = $1'
    USING p_source_id;
END
$function$;

CREATE FUNCTION arena.start_leaderboard_acquisition_attempt(
  p_attempt_id uuid,
  p_source_id integer,
  p_timeframe integer,
  p_observation_cycle_id text,
  p_queue_job_id text,
  p_queue_attempt integer,
  p_capture_contract text,
  p_runner_git_sha text,
  p_worker_region text
)
RETURNS arena.leaderboard_acquisition_attempts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_existing arena.leaderboard_acquisition_attempts%ROWTYPE;
  v_result arena.leaderboard_acquisition_attempts%ROWTYPE;
  v_source arena.sources%ROWTYPE;
  v_prior text := pg_catalog.current_setting(
    'arena.leaderboard_acquisition_mutation_path', true
  );
BEGIN
  SELECT * INTO v_existing
    FROM arena.leaderboard_acquisition_attempts
   WHERE attempt_id = p_attempt_id;
  IF FOUND THEN
    RETURN v_existing;
  END IF;

  SELECT * INTO STRICT v_source FROM arena.sources WHERE id = p_source_id;
  PERFORM pg_catalog.set_config(
    'arena.leaderboard_acquisition_mutation_path',
    'start_leaderboard_acquisition_attempt',
    true
  );
  INSERT INTO arena.leaderboard_acquisition_attempts (
    attempt_id, source_id, source_slug, timeframe, observation_cycle_id,
    queue_job_id, queue_attempt, worker_region, source_fetch_region,
    recorded_started_at
  ) VALUES (
    p_attempt_id, p_source_id, v_source.slug, p_timeframe,
    p_observation_cycle_id, p_queue_job_id, p_queue_attempt, p_worker_region,
    v_source.fetch_region,
    pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp())
  ) RETURNING * INTO STRICT v_result;
  PERFORM pg_catalog.set_config(
    'arena.leaderboard_acquisition_mutation_path', COALESCE(v_prior, ''), true
  );
  RETURN v_result;
END
$function$;

CREATE FUNCTION arena.finish_leaderboard_acquisition_attempt(
  p_attempt_id uuid,
  p_terminal_state text,
  p_acquisition_state text,
  p_population_state text,
  p_capture_evidence_state text,
  p_termination_reason text,
  p_capture_started_at timestamptz,
  p_capture_completed_at timestamptz,
  p_source_run_id text,
  p_source_payload_raw_object_id bigint,
  p_manifest_raw_object_id bigint,
  p_diagnostic_raw_object_id bigint,
  p_reported_population integer,
  p_population_report_state text,
  p_source_page_count integer,
  p_reported_page_count integer,
  p_page_count_report_state text,
  p_observed_population integer,
  p_accepted_population integer,
  p_rejected_row_count integer,
  p_deduplicated_row_count integer,
  p_caller_limited boolean,
  p_safety_limited boolean,
  p_failure_stage text,
  p_reason_code text
)
RETURNS arena.leaderboard_acquisition_outcomes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_attempt arena.leaderboard_acquisition_attempts%ROWTYPE;
  v_existing arena.leaderboard_acquisition_outcomes%ROWTYPE;
  v_result arena.leaderboard_acquisition_outcomes%ROWTYPE;
  v_prior text := pg_catalog.current_setting(
    'arena.leaderboard_acquisition_mutation_path', true
  );
BEGIN
  SELECT * INTO STRICT v_attempt
    FROM arena.leaderboard_acquisition_attempts
   WHERE attempt_id = p_attempt_id;
  SELECT * INTO v_existing
    FROM arena.leaderboard_acquisition_outcomes
   WHERE attempt_seq = v_attempt.attempt_seq;
  IF FOUND THEN
    RETURN v_existing;
  END IF;

  PERFORM pg_catalog.set_config(
    'arena.leaderboard_acquisition_mutation_path',
    'finish_leaderboard_acquisition_attempt',
    true
  );
  INSERT INTO arena.leaderboard_acquisition_outcomes (
    attempt_seq, terminal_state, source_run_id,
    source_payload_raw_object_id
  ) VALUES (
    v_attempt.attempt_seq, p_terminal_state, p_source_run_id,
    p_source_payload_raw_object_id
  ) RETURNING * INTO STRICT v_result;
  PERFORM pg_catalog.set_config(
    'arena.leaderboard_acquisition_mutation_path', COALESCE(v_prior, ''), true
  );
  RETURN v_result;
END
$function$;

ALTER FUNCTION arena.fixture_begin_region_guard(integer) OWNER TO postgres;
ALTER FUNCTION arena.fixture_expire_execution_head(integer) OWNER TO postgres;
ALTER FUNCTION arena.start_leaderboard_acquisition_attempt(
  uuid, integer, integer, text, text, integer, text, text, text
) OWNER TO postgres;
ALTER FUNCTION arena.finish_leaderboard_acquisition_attempt(
  uuid, text, text, text, text, text, timestamptz, timestamptz, text,
  bigint, bigint, bigint, integer, text, integer, integer, text,
  integer, integer, integer, integer, boolean, boolean, text, text
) OWNER TO postgres;

REVOKE ALL ON FUNCTION arena.fixture_begin_region_guard(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION arena.fixture_expire_execution_head(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION arena.start_leaderboard_acquisition_attempt(
  uuid, integer, integer, text, text, integer, text, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION arena.finish_leaderboard_acquisition_attempt(
  uuid, text, text, text, text, text, timestamptz, timestamptz, text,
  bigint, bigint, bigint, integer, text, integer, integer, text,
  integer, integer, integer, integer, boolean, boolean, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION arena.fixture_begin_region_guard(integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION arena.fixture_expire_execution_head(integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION arena.start_leaderboard_acquisition_attempt(
  uuid, integer, integer, text, text, integer, text, text, text
) TO service_role;
GRANT EXECUTE ON FUNCTION arena.finish_leaderboard_acquisition_attempt(
  uuid, text, text, text, text, text, timestamptz, timestamptz, text,
  bigint, bigint, bigint, integer, text, integer, integer, text,
  integer, integer, integer, integer, boolean, boolean, text, text
) TO service_role;

CREATE TABLE public.fixture_old_callables AS
SELECT
  start_function.oid AS start_oid,
  start_function.prosrc AS start_source,
  start_function.proacl AS start_acl,
  finish_function.oid AS finish_oid,
  finish_function.prosrc AS finish_source,
  finish_function.proacl AS finish_acl
FROM pg_catalog.pg_proc AS start_function
CROSS JOIN pg_catalog.pg_proc AS finish_function
WHERE start_function.oid =
      'arena.start_leaderboard_acquisition_attempt(uuid,integer,integer,text,text,integer,text,text,text)'::pg_catalog.regprocedure
  AND finish_function.oid =
      'arena.finish_leaderboard_acquisition_attempt(uuid,text,text,text,text,text,timestamp with time zone,timestamp with time zone,text,bigint,bigint,bigint,integer,text,integer,integer,text,integer,integer,integer,integer,boolean,boolean,text,text)'::pg_catalog.regprocedure;
SQL

psql_cmd -q -f "$MIGRATION"

assert_sql_true \
  'legacy start callable changed across install or replay' \
  "SELECT before.start_oid = start_function.oid
          AND before.start_source = start_function.prosrc
          AND before.start_acl IS NOT DISTINCT FROM start_function.proacl
     FROM public.fixture_old_callables AS before
     JOIN pg_catalog.pg_proc AS start_function
       ON start_function.oid = before.start_oid;"

assert_sql_true \
  'legacy finish callable changed across install or replay' \
  "SELECT before.finish_oid = finish_function.oid
          AND before.finish_source = finish_function.prosrc
          AND before.finish_acl IS NOT DISTINCT FROM finish_function.proacl
     FROM public.fixture_old_callables AS before
     JOIN pg_catalog.pg_proc AS finish_function
       ON finish_function.oid = before.finish_oid;"

assert_sql_true \
  'legacy fresh start stopped working' \
  "SET ROLE service_role;
   SELECT (arena.start_leaderboard_acquisition_attempt(
     '00000000-0000-4000-8000-000000000001', 1, 30, 'legacy-cycle',
     'legacy-job', 0, 'legacy_unverified', NULL, 'local'
   )).execution_claim_id IS NULL;"

assert_sql_true \
  'legacy fresh finish stopped working' \
  "SET ROLE service_role;
   SELECT (arena.finish_leaderboard_acquisition_attempt(
     '00000000-0000-4000-8000-000000000001',
     'processing_failed', 'unknown', 'unknown', 'unassessed', NULL,
     NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
     NULL, NULL, NULL, NULL, false, false, 'upstream_fetch', 'fixture'
   )).terminal_state = 'processing_failed';"

expect_failure \
  'service role claimed without a region guard' \
  'lacks live Tier-A worker authority' \
  "SET ROLE service_role;
   SELECT arena.claim_tier_a_execution(
     'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1,
     'arena:ingest:local', 'tier-a-job-1', 'tiera:leaderboard', 0, 1,
     repeat('a', 64), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab',
     repeat('b', 64), 'local', 60
   );"

claim_one="$(psql_cmd -Atq <<'SQL'
SET ROLE service_role;
BEGIN;
SELECT arena.fixture_begin_region_guard(1);
SELECT arena.claim_tier_a_execution(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1,
  'arena:ingest:local', 'tier-a-job-1', 'tiera:leaderboard', 0, 1,
  repeat('a', 64), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab',
  repeat('b', 64), 'local', 60
)::text;
COMMIT;
SQL
)"
claim_one="$(printf '%s\n' "$claim_one" | rg '^\{' | tail -1)"

claim_one_replay="$(psql_cmd -Atq <<'SQL'
SET ROLE service_role;
BEGIN;
SELECT arena.fixture_begin_region_guard(1);
SELECT arena.claim_tier_a_execution(
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1,
  'arena:ingest:local', 'tier-a-job-1', 'tiera:leaderboard', 0, 1,
  repeat('a', 64), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab',
  repeat('b', 64), 'local', 60
)::text;
COMMIT;
SQL
)"
claim_one_replay="$(printf '%s\n' "$claim_one_replay" | rg '^\{' | tail -1)"
if [[ -z "$claim_one" || "$claim_one" != "$claim_one_replay" ]]; then
  echo 'claim response-loss replay was not frozen' >&2
  exit 1
fi

# Keep a fresh claim on a second source so a later region-authority replacement
# can prove immediate monotonic takeover without waiting for its DB lease.
psql_cmd -Atq <<'SQL' >/dev/null
SET ROLE service_role;
BEGIN;
SELECT arena.fixture_begin_region_guard(3);
SELECT arena.claim_tier_a_execution(
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 3,
  'arena:ingest:local', 'replacement-job-1', 'tiera:leaderboard', 0, 1,
  repeat('5', 64), 'cccccccc-cccc-4ccc-8ccc-cccccccccccd',
  repeat('6', 64), 'local', 60
);
COMMIT;
SQL

expect_failure \
  'competing active source claim was accepted' \
  'another Tier-A execution owns the active source lease' \
  "SET ROLE service_role;
   BEGIN;
   SELECT arena.fixture_begin_region_guard(1);
   SELECT arena.claim_tier_a_execution(
     'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 1,
     'arena:ingest:local', 'tier-a-job-2', 'tiera:leaderboard', 0, 1,
     repeat('c', 64), 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc',
     repeat('d', 64), 'local', 60
   );
   COMMIT;"

assert_sql_true \
  'claimed start did not bind the attempt' \
  "SET ROLE service_role;
   BEGIN;
   SELECT arena.fixture_begin_region_guard(1);
   SELECT (
     arena.start_leaderboard_acquisition_attempt(
       '10000000-0000-4000-8000-000000000001', 1, 7, 'cycle-1',
       'tier-a-job-1', 0, 'fixture-contract', repeat('1', 40), 'local',
       'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1
     )
   ).execution_claim_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid;
   COMMIT;"

expect_failure \
  'legacy finish terminated an execution-bound attempt' \
  'claimed acquisition attempt requires claimed finish RPC' \
  "SET ROLE service_role;
   SELECT arena.finish_leaderboard_acquisition_attempt(
     '10000000-0000-4000-8000-000000000001',
     'processing_failed', 'unknown', 'unknown', 'unassessed', NULL,
     NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
     NULL, NULL, NULL, NULL, false, false, 'upstream_fetch', 'fixture'
   );"

psql_cmd -q -c "
  UPDATE arena.tier_a_execution_heads
     SET last_heartbeat_at = pg_catalog.clock_timestamp() - interval '2 seconds',
         lease_expires_at = pg_catalog.clock_timestamp() - interval '1 second',
         updated_at = pg_catalog.clock_timestamp()
   WHERE source_id = 1;
"

psql_cmd -Atq <<'SQL' >/dev/null
SET ROLE service_role;
BEGIN;
SELECT arena.fixture_begin_region_guard(1);
SELECT arena.claim_tier_a_execution(
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 1,
  'arena:ingest:local', 'tier-a-job-2', 'tiera:leaderboard', 1, 2,
  repeat('c', 64), 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc',
  repeat('d', 64), 'local', 60
);
COMMIT;
SQL

assert_sql_true \
  'expired generation did not permit takeover' \
  "SELECT generation_seq = 2
          AND claim_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid
          AND phase = 'active'
     FROM arena.tier_a_execution_heads
    WHERE source_id = 1;"

expect_failure \
  'stale generation heartbeat revived a claim' \
  'Tier-A execution heartbeat was fenced' \
  "SET ROLE service_role;
   BEGIN;
   SELECT arena.fixture_begin_region_guard(1);
   SELECT arena.heartbeat_tier_a_execution(
     'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1
   );
   COMMIT;"

expect_failure \
  'stale generation finalized after takeover' \
  'Tier-A execution write was fenced' \
  "SET ROLE service_role;
   BEGIN;
   SELECT arena.fixture_begin_region_guard(1);
   SELECT arena.finish_leaderboard_acquisition_attempt(
     '10000000-0000-4000-8000-000000000001',
     'processing_failed', 'unknown', 'unknown', 'unassessed', NULL,
     NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
     NULL, NULL, NULL, NULL, false, false, 'upstream_fetch', 'fixture',
     'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1
   );
   COMMIT;"

assert_sql_true \
  'claimed generation-2 start did not bind the attempt' \
  "SET ROLE service_role;
   BEGIN;
   SELECT arena.fixture_begin_region_guard(1);
   SELECT (
     arena.start_leaderboard_acquisition_attempt(
       '20000000-0000-4000-8000-000000000002', 1, 7, 'cycle-2',
       'tier-a-job-2', 1, 'fixture-contract', repeat('1', 40), 'local',
       'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 2
     )
   ).execution_generation_seq = 2;
   COMMIT;"

assert_sql_true \
  'claimed finish did not persist complete evidence' \
  "SET ROLE service_role;
   BEGIN;
   SELECT arena.fixture_begin_region_guard(1);
   SELECT (
     arena.finish_leaderboard_acquisition_attempt(
       '20000000-0000-4000-8000-000000000002',
       'complete', 'complete', 'verified', 'verified', NULL,
       NULL, pg_catalog.clock_timestamp(), repeat('e', 64), 501,
       502, NULL, 10, 'consistent', 1, 1, 'consistent', 10, 10, 0, 0,
       false, false, NULL, NULL,
       'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 2
     )
   ).terminal_state = 'complete';
   COMMIT;"

psql_cmd -q <<'SQL'
INSERT INTO arena.leaderboard_snapshots (
  id, source_id, timeframe, count_check_passed, is_derived, raw_object_id
) VALUES
  (1001, 1, 7, true, false, 501),
  (1002, 1, 7, false, false, 501),
  (1003, 1, 7, true, NULL, 501);
SQL

expect_failure \
  'receipt accepted incomplete publication evidence' \
  'receipt evidence is incomplete or mismatched' \
  "SET ROLE service_role;
   BEGIN;
   SELECT arena.fixture_begin_region_guard(1);
   SELECT arena.record_tier_a_execution_window_receipt(
     'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 2,
     '20000000-0000-4000-8000-000000000002', 1002
   );
   COMMIT;"

expect_failure \
  'receipt accepted a nullable derived verdict' \
  'receipt evidence is incomplete or mismatched' \
  "SET ROLE service_role;
   BEGIN;
   SELECT arena.fixture_begin_region_guard(1);
   SELECT arena.record_tier_a_execution_window_receipt(
     'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 2,
     '20000000-0000-4000-8000-000000000002', 1003
   );
   COMMIT;"

receipt_one="$(psql_cmd -Atq <<'SQL'
SET ROLE service_role;
BEGIN;
SELECT arena.fixture_begin_region_guard(1);
SELECT arena.record_tier_a_execution_window_receipt(
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 2,
  '20000000-0000-4000-8000-000000000002', 1001
)::text;
COMMIT;
SQL
)"
receipt_one="$(printf '%s\n' "$receipt_one" | rg '^\{' | tail -1)"
if [[ -z "$receipt_one" ]]; then
  echo 'valid receipt was not recorded' >&2
  exit 1
fi

assert_sql_true \
  'receipt getter did not return exact queue-scoped evidence' \
  "SET ROLE service_role;
   SELECT arena.get_tier_a_execution_window_receipt(
     1, 'arena:ingest:local', 'tier-a-job-2', 'cycle-2', 7
   )->>'snapshot_id' = '1001';"

assert_sql_true \
  'receipt getter ignored queue name' \
  "SET ROLE service_role;
   SELECT arena.get_tier_a_execution_window_receipt(
     1, 'arena:ingest:vps_sg', 'tier-a-job-2', 'cycle-2', 7
   ) IS NULL;"

assert_sql_true \
  'receipt getter ignored observation cycle' \
  "SET ROLE service_role;
   SELECT arena.get_tier_a_execution_window_receipt(
     1, 'arena:ingest:local', 'tier-a-job-2', 'future-cycle', 7
   ) IS NULL;"

# Controlled owner fixture: the same stable Bull job id can be reused by a
# later scheduler kick.  The observation cycle is therefore part of durable
# identity, not optional metadata.  Copying otherwise identical evidence
# proves the five-column key admits both cycles independently.
psql_cmd -q <<'SQL'
INSERT INTO arena.tier_a_execution_window_receipts (
  contract, source_id, queue_name, queue_job_id, observation_cycle_id,
  timeframe, generation_seq, claim_id, attempt_seq, attempt_id, snapshot_id,
  raw_object_id, source_run_id, recorded_at
)
SELECT
  receipt.contract,
  receipt.source_id,
  receipt.queue_name,
  receipt.queue_job_id,
  'future-cycle',
  receipt.timeframe,
  receipt.generation_seq,
  receipt.claim_id,
  receipt.attempt_seq,
  receipt.attempt_id,
  receipt.snapshot_id,
  receipt.raw_object_id,
  receipt.source_run_id,
  receipt.recorded_at + interval '1 millisecond'
FROM arena.tier_a_execution_window_receipts AS receipt
WHERE receipt.source_id = 1
  AND receipt.queue_name = 'arena:ingest:local'
  AND receipt.queue_job_id = 'tier-a-job-2'
  AND receipt.observation_cycle_id = 'cycle-2'
  AND receipt.timeframe = 7;
SQL

assert_sql_true \
  'different observation cycles could not retain independent receipts' \
  "SELECT count(*) = 2
     FROM arena.tier_a_execution_window_receipts
    WHERE source_id = 1
      AND queue_name = 'arena:ingest:local'
      AND queue_job_id = 'tier-a-job-2'
      AND timeframe = 7;"

assert_sql_true \
  'future observation cycle did not resolve its independent receipt' \
  "SET ROLE service_role;
   SELECT arena.get_tier_a_execution_window_receipt(
     1, 'arena:ingest:local', 'tier-a-job-2', 'future-cycle', 7
   )->>'observation_cycle_id' = 'future-cycle';"

expect_failure \
  'receipt table was mutable' \
  'Tier-A execution ledgers are immutable' \
  "UPDATE arena.tier_a_execution_window_receipts
      SET raw_object_id = 999
    WHERE source_id = 1;"

expect_failure \
  'service role could read private execution claims' \
  'permission denied' \
  "SET ROLE service_role; SELECT * FROM arena.tier_a_execution_claims;"

psql_cmd -q <<'SQL'
SET ROLE service_role;
BEGIN;
SELECT arena.fixture_begin_region_guard(1);
SELECT arena.assert_tier_a_execution_write(
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 2
);
COMMIT;
SQL

assert_sql_true \
  'execution write guard survived COMMIT' \
  "SELECT count(*) = 0 FROM arena.tier_a_execution_write_guards;"

expect_failure \
  'deferred execution fence accepted expiry before COMMIT' \
  'Tier-A execution was fenced before COMMIT' \
  "SET ROLE service_role;
   BEGIN;
   SELECT arena.fixture_begin_region_guard(1);
   SELECT arena.assert_tier_a_execution_write(
     'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 2
   );
   SELECT arena.fixture_expire_execution_head(1);
   COMMIT;"

assert_sql_true \
  'failed COMMIT fence changed the active generation' \
  "SELECT generation_seq = 2
          AND phase = 'active'
          AND lease_expires_at > pg_catalog.clock_timestamp()
     FROM arena.tier_a_execution_heads
    WHERE source_id = 1;"

assert_sql_true \
  'takeover synthesized an abandoned terminal outcome' \
  "SELECT NOT EXISTS (
     SELECT 1
       FROM arena.leaderboard_acquisition_outcomes AS outcome
       JOIN arena.leaderboard_acquisition_attempts AS attempt
         ON attempt.attempt_seq = outcome.attempt_seq
      WHERE attempt.attempt_id =
            '10000000-0000-4000-8000-000000000001'::uuid
   );"

assert_sql_true \
  'close did not seal the current generation' \
  "SET ROLE service_role;
   BEGIN;
   SELECT arena.fixture_begin_region_guard(1);
   SELECT arena.close_tier_a_execution(
     'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 2, 'completed'
   )->>'phase' = 'completed';
   COMMIT;"

psql_cmd -q <<'SQL'
INSERT INTO arena.ingest_worker_instances (
  instance_id, node_id, worker_region, control_epoch, release_id, git_sha
) VALUES (
  '22222222-2222-4222-8222-222222222222',
  'fixture-local-2',
  'local',
  11,
  pg_catalog.repeat('2', 64),
  pg_catalog.repeat('2', 40)
);

INSERT INTO arena.ingest_worker_activations (
  authority_scope, epoch, instance_id, node_id, worker_region,
  control_epoch, release_id, git_sha, status, ended_at
) VALUES (
  'region:local',
  2,
  '22222222-2222-4222-8222-222222222222',
  'fixture-local-2',
  'local',
  11,
  pg_catalog.repeat('2', 64),
  pg_catalog.repeat('2', 40),
  'active',
  NULL
);

UPDATE arena.ingest_worker_activations
   SET status = 'released', ended_at = pg_catalog.clock_timestamp()
 WHERE authority_scope = 'region:local' AND epoch = 1;

UPDATE arena.ingest_worker_authorities
   SET active_epoch = 2,
       active_instance_id = '22222222-2222-4222-8222-222222222222',
       active_node_id = 'fixture-local-2',
       active_control_epoch = 11,
       lease_expires_at = pg_catalog.clock_timestamp() + interval '1 hour'
 WHERE authority_scope = 'region:local';
SQL

psql_cmd -Atq <<'SQL' >/dev/null
SET ROLE service_role;
BEGIN;
SELECT arena.fixture_begin_region_guard(3);
SELECT arena.claim_tier_a_execution(
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 3,
  'arena:ingest:local', 'replacement-job-2', 'tiera:leaderboard', 0, 1,
  repeat('7', 64), 'dddddddd-dddd-4ddd-8ddd-ddddddddddde',
  repeat('8', 64), 'local', 60
);
COMMIT;
SQL

assert_sql_true \
  'region authority replacement did not permit monotonic takeover' \
  "SELECT generation_seq = 2
          AND claim_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'::uuid
          AND lease_expires_at > pg_catalog.clock_timestamp()
     FROM arena.tier_a_execution_heads
    WHERE source_id = 3;"

# Capture all new callable identities, replay the migration, and verify that
# CREATE OR REPLACE did not replace OIDs or mutate durable rows.
psql_cmd -q <<'SQL'
CREATE TABLE public.fixture_new_callables AS
SELECT function_row.oid, function_row.oid::pg_catalog.regprocedure::text AS identity
  FROM pg_catalog.pg_proc AS function_row
 WHERE function_row.oid IN (
   'arena.claim_tier_a_execution(uuid,integer,text,text,text,integer,integer,text,uuid,text,text,integer)'::pg_catalog.regprocedure,
   'arena.heartbeat_tier_a_execution(uuid,bigint)'::pg_catalog.regprocedure,
   'arena.assert_tier_a_execution_write(uuid,bigint)'::pg_catalog.regprocedure,
   'arena.close_tier_a_execution(uuid,bigint,text)'::pg_catalog.regprocedure,
   'arena.record_tier_a_execution_window_receipt(uuid,bigint,uuid,bigint)'::pg_catalog.regprocedure,
   'arena.get_tier_a_execution_window_receipt(integer,text,text,text,integer)'::pg_catalog.regprocedure
 );

GRANT EXECUTE ON FUNCTION arena.claim_tier_a_execution(
  uuid, integer, text, text, text, integer, integer, text, uuid, text,
  text, integer
) TO fixture_rogue;
GRANT EXECUTE ON FUNCTION arena.require_current_tier_a_worker_guard(integer)
  TO fixture_rogue;
SQL

psql_cmd -q -f "$MIGRATION"

assert_sql_true \
  'legacy start callable changed across install or replay' \
  "SELECT before.start_oid = start_function.oid
          AND before.start_source = start_function.prosrc
          AND before.start_acl IS NOT DISTINCT FROM start_function.proacl
     FROM public.fixture_old_callables AS before
     JOIN pg_catalog.pg_proc AS start_function
       ON start_function.oid = before.start_oid;"

assert_sql_true \
  'legacy finish callable changed across install or replay' \
  "SELECT before.finish_oid = finish_function.oid
          AND before.finish_source = finish_function.prosrc
          AND before.finish_acl IS NOT DISTINCT FROM finish_function.proacl
     FROM public.fixture_old_callables AS before
     JOIN pg_catalog.pg_proc AS finish_function
       ON finish_function.oid = before.finish_oid;"

assert_sql_true \
  'new callable identity changed across migration replay' \
  "SELECT count(*) = 6
          AND bool_and(before.oid = after_function.oid)
     FROM public.fixture_new_callables AS before
     JOIN pg_catalog.pg_proc AS after_function
       ON after_function.oid::pg_catalog.regprocedure::text = before.identity;"

assert_sql_true \
  'migration replay retained a rogue execution-function grant' \
  "SELECT NOT pg_catalog.has_function_privilege(
            'fixture_rogue',
            'arena.claim_tier_a_execution(uuid,integer,text,text,text,integer,integer,text,uuid,text,text,integer)',
            'EXECUTE'
          )
          AND NOT pg_catalog.has_function_privilege(
            'fixture_rogue',
            'arena.require_current_tier_a_worker_guard(integer)',
            'EXECUTE'
          );"

assert_sql_true \
  'migration replay changed durable claim or receipt rows' \
  "SELECT
     (SELECT count(*) FROM arena.tier_a_execution_claims) = 4
     AND (SELECT count(*) FROM arena.tier_a_execution_window_receipts) = 2
     AND (SELECT phase FROM arena.tier_a_execution_heads WHERE source_id = 1) =
         'completed';"

echo 'Tier-A execution claim fence PG17 proof passed'
