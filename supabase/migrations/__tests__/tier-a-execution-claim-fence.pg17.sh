#!/usr/bin/env bash

# PostgreSQL 17 behavioral proof for the expand-only Tier-A execution fence.
# It verifies legacy callable compatibility, current-xid authority derivation,
# monotonic takeover, claimed acquisition binding, deferred COMMIT fencing,
# closed ACLs, immutable receipts, and queue-scoped skip identity.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729015500_tier_a_execution_claim_fence.sql"
# The launch replacement, not the superseded 20260729061000: it is the one the
# launch plan applies and the one the worker startup gate pins (24 triggers).
ENFORCEMENT_MIGRATION="$ROOT_DIR/supabase/migrations/20261111192134_tier_a_execution_claim_enforcement_later_raw_guards.sql"
ONE_PHASE_MIGRATION="$ROOT_DIR/supabase/migrations/20260729071500_tier_a_one_phase_commit_guard.sql"
TSX_BIN="$ROOT_DIR/node_modules/.bin/tsx"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

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

replace_function_from_migration() {
  local file="$1"
  local function_name="$2"
  awk -v declaration="CREATE FUNCTION arena.${function_name}()" '
    index($0, declaration) == 1 {
      emit = 1
      sub(/^CREATE FUNCTION/, "CREATE OR REPLACE FUNCTION")
    }
    emit { print }
    emit && $0 == "$function$;" { exit }
  ' "$file" | psql_cmd -q
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

expect_file_failure() {
  local label="$1"
  local pattern="$2"
  local file="$3"
  if psql_cmd -q -f "$file" >"$ERROR_FILE" 2>&1; then
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

worker_enforcement_catalog_result() {
  {
    cd "$ROOT_DIR"
    printf '%s\n' \
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;' \
      "SET LOCAL statement_timeout = '10s';" \
      'SET LOCAL search_path = pg_catalog, pg_temp;'
    "$TSX_BIN" -e \
      "import { TIER_A_EXECUTION_ENFORCEMENT_CATALOG_SQL as sql } from './worker/src/ingest/attempt-bound-capture-readiness.ts'; process.stdout.write(sql + ';\\n')"
    printf '%s\n' 'ROLLBACK;'
  } | psql_cmd -Aq -F $'\t' -P footer=off
}

assert_worker_enforcement_catalog() {
  local label="$1"
  local expected_one_phase_exact="$2"
  local expected_substrate_exact="$3"
  local result
  result="$(worker_enforcement_catalog_result)"
  if ! printf '%s\n' "$result" |
    awk -F '\t' \
      -v expected_one_phase_exact="$expected_one_phase_exact" \
      -v expected_substrate_exact="$expected_substrate_exact" '
      NF > 0 {
        row_count += 1
        if (row_count == 1) {
          for (field_index = 1; field_index <= NF; field_index += 1) {
            if ($field_index == "one_phase_commit_exact") {
              one_phase_index = field_index
            }
            if ($field_index == "substrate_contract_exact") {
              substrate_index = field_index
            }
          }
        } else if (row_count == 2) {
          one_phase_value = $one_phase_index
          substrate_value = $substrate_index
        }
      }
      END {
        invalid = row_count != 2 || one_phase_index < 1
        invalid = invalid || substrate_index < 1
        invalid = invalid || one_phase_value != expected_one_phase_exact
        invalid = invalid || substrate_value != expected_substrate_exact
        if (invalid) {
          exit 1
        }
      }
    '; then
    echo "$label" >&2
    printf '%s\n' "$result" >&2
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

CREATE TABLE arena.raw_objects (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  job_type text NOT NULL,
  trader_id bigint,
  timeframe smallint,
  fetched_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  storage_path text,
  bytes integer,
  content_hash text,
  quarantined boolean NOT NULL DEFAULT false,
  source_run_id text,
  trust_artifact_role text,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE arena.metric_trust_artifacts (
  raw_object_id bigint
);

CREATE TABLE arena.metric_trust_runs (
  population_raw_object_id bigint,
  manifest_raw_object_id bigint
);

CREATE TABLE arena.upstream_field_inventory (
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  job_type text NOT NULL,
  field_path text NOT NULL,
  first_seen timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  last_seen timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (source_id, job_type, field_path)
);

-- Shared profile/maintenance series are deliberately outside the enforcement
-- migration. Minimal fixtures make accidental future trigger expansion fail.
CREATE TABLE arena.trader_series (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payload text NOT NULL
);

CREATE TABLE arena.trader_series_weekly (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payload text NOT NULL
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
  source_payload_raw_object_id bigint,
  manifest_raw_object_id bigint,
  diagnostic_raw_object_id bigint
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

CREATE FUNCTION arena.reject_direct_leaderboard_acquisition_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_path text := pg_catalog.current_setting(
    'arena.leaderboard_acquisition_mutation_path', true
  );
BEGIN
  IF TG_OP = 'INSERT'
     AND (
       (TG_TABLE_NAME = 'leaderboard_acquisition_attempts'
        AND v_path = 'start_leaderboard_acquisition_attempt')
       OR
       (TG_TABLE_NAME = 'leaderboard_acquisition_outcomes'
        AND v_path = 'finish_leaderboard_acquisition_attempt')
     ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'fixture acquisition ledger mutation rejected'
    USING ERRCODE = '42501';
END
$function$;

CREATE FUNCTION arena.protect_metric_trust_raw_object()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$function$;

CREATE FUNCTION arena.protect_leaderboard_acquisition_raw_evidence()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$function$;

-- Raw-object guards that later launch migrations install (20260803100000,
-- 20260804053000, 20260808010000) before the enforcement migration runs.
CREATE FUNCTION arena.protect_record_surface_publication_raw_object()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$function$;

CREATE FUNCTION arena.protect_copier_snapshot_raw_object()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$function$;

CREATE FUNCTION arena.protect_copier_snapshot_trust_raw_object()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$function$;

CREATE FUNCTION arena.serialize_leaderboard_terminal_publication()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RETURN NEW;
END
$function$;

ALTER FUNCTION arena.reject_direct_leaderboard_acquisition_mutation()
  OWNER TO postgres;
ALTER FUNCTION arena.protect_metric_trust_raw_object() OWNER TO postgres;
ALTER FUNCTION arena.protect_leaderboard_acquisition_raw_evidence()
  OWNER TO postgres;
ALTER FUNCTION arena.protect_record_surface_publication_raw_object()
  OWNER TO postgres;
ALTER FUNCTION arena.protect_copier_snapshot_raw_object() OWNER TO postgres;
ALTER FUNCTION arena.protect_copier_snapshot_trust_raw_object()
  OWNER TO postgres;
ALTER FUNCTION arena.serialize_leaderboard_terminal_publication()
  OWNER TO postgres;

CREATE TRIGGER leaderboard_acquisition_attempts_reject_direct_row_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON arena.leaderboard_acquisition_attempts
  FOR EACH ROW
  EXECUTE FUNCTION arena.reject_direct_leaderboard_acquisition_mutation();
CREATE TRIGGER leaderboard_acquisition_attempts_reject_truncate
  BEFORE TRUNCATE ON arena.leaderboard_acquisition_attempts
  FOR EACH STATEMENT
  EXECUTE FUNCTION arena.reject_direct_leaderboard_acquisition_mutation();
CREATE TRIGGER leaderboard_acquisition_outcomes_reject_direct_row_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON arena.leaderboard_acquisition_outcomes
  FOR EACH ROW
  EXECUTE FUNCTION arena.reject_direct_leaderboard_acquisition_mutation();
CREATE TRIGGER leaderboard_acquisition_outcomes_reject_truncate
  BEFORE TRUNCATE ON arena.leaderboard_acquisition_outcomes
  FOR EACH STATEMENT
  EXECUTE FUNCTION arena.reject_direct_leaderboard_acquisition_mutation();
CREATE TRIGGER leaderboard_acquisition_outcomes_serialize_terminal_publication
  BEFORE INSERT ON arena.leaderboard_acquisition_outcomes
  FOR EACH ROW
  EXECUTE FUNCTION arena.serialize_leaderboard_terminal_publication();
CREATE TRIGGER protect_metric_trust_raw_object_before_write
  BEFORE UPDATE OR DELETE ON arena.raw_objects
  FOR EACH ROW
  EXECUTE FUNCTION arena.protect_metric_trust_raw_object();
CREATE TRIGGER protect_leaderboard_acquisition_raw_evidence_before_write
  BEFORE UPDATE OR DELETE ON arena.raw_objects
  FOR EACH ROW
  EXECUTE FUNCTION arena.protect_leaderboard_acquisition_raw_evidence();
CREATE TRIGGER protect_record_surface_publication_raw_before_write
  BEFORE UPDATE OR DELETE ON arena.raw_objects
  FOR EACH ROW
  EXECUTE FUNCTION arena.protect_record_surface_publication_raw_object();
CREATE TRIGGER protect_copier_snapshot_raw_before_write
  BEFORE UPDATE OR DELETE ON arena.raw_objects
  FOR EACH ROW
  EXECUTE FUNCTION arena.protect_copier_snapshot_raw_object();
CREATE TRIGGER protect_copier_snapshot_trust_raw_before_write
  BEFORE UPDATE OR DELETE ON arena.raw_objects
  FOR EACH ROW
  EXECUTE FUNCTION arena.protect_copier_snapshot_trust_raw_object();

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

# Leave one historical unclaimed/open attempt before enforcement. NOT VALID
# must preserve it without allowing any later unclaimed finish.
assert_sql_true \
  'historical unclaimed attempt fixture was not created' \
  "SET ROLE service_role;
   SELECT (arena.start_leaderboard_acquisition_attempt(
     '30000000-0000-4000-8000-000000000003', 1, 90, 'historical-cycle',
     'historical-job', 0, 'legacy_unverified', NULL, 'local'
   )).execution_claim_id IS NULL;"

# Replace the lightweight behavioral fixtures with the exact production
# trigger bodies before the postdeploy catalog attestation.
replace_function_from_migration \
  "$ROOT_DIR/supabase/migrations/20260722030000_durable_leaderboard_acquisition_attempt_ledger.sql" \
  'reject_direct_leaderboard_acquisition_mutation'
replace_function_from_migration \
  "$ROOT_DIR/supabase/migrations/20260721120000_metric_trust_shadow_gate.sql" \
  'protect_metric_trust_raw_object'
replace_function_from_migration \
  "$ROOT_DIR/supabase/migrations/20260722030000_durable_leaderboard_acquisition_attempt_ledger.sql" \
  'protect_leaderboard_acquisition_raw_evidence'
replace_function_from_migration \
  "$ROOT_DIR/supabase/migrations/20260722042000_leaderboard_terminal_publication_fence.sql" \
  'serialize_leaderboard_terminal_publication'

psql_cmd -q <<'SQL'
UPDATE arena.leaderboard_snapshots
   SET is_derived = false
 WHERE is_derived IS NULL;
ALTER TABLE arena.leaderboard_snapshots
  ALTER COLUMN is_derived SET DEFAULT false,
  ALTER COLUMN is_derived SET NOT NULL;

CREATE TABLE public.fixture_enforcement_callables AS
SELECT
  function_row.oid,
  function_row.oid::pg_catalog.regprocedure::text AS identity,
  function_row.prosrc
FROM pg_catalog.pg_proc AS function_row
WHERE function_row.oid IN (
  'arena.start_leaderboard_acquisition_attempt(uuid,integer,integer,text,text,integer,text,text,text)'::pg_catalog.regprocedure,
  'arena.finish_leaderboard_acquisition_attempt(uuid,text,text,text,text,text,timestamp with time zone,timestamp with time zone,text,bigint,bigint,bigint,integer,text,integer,integer,text,integer,integer,integer,integer,boolean,boolean,text,text)'::pg_catalog.regprocedure,
  'arena.start_leaderboard_acquisition_attempt(uuid,integer,integer,text,text,integer,text,text,text,uuid,bigint)'::pg_catalog.regprocedure,
  'arena.finish_leaderboard_acquisition_attempt(uuid,text,text,text,text,text,timestamp with time zone,timestamp with time zone,text,bigint,bigint,bigint,integer,text,integer,integer,text,integer,integer,integer,integer,boolean,boolean,text,text,uuid,bigint)'::pg_catalog.regprocedure
);

GRANT ALL PRIVILEGES ON TABLE arena.leaderboard_snapshots,
  arena.raw_objects,
  arena.upstream_field_inventory,
  arena.leaderboard_acquisition_attempts,
  arena.leaderboard_acquisition_outcomes
  TO service_role, fixture_rogue;
GRANT INSERT (
  source_id, timeframe, count_check_passed, is_derived, raw_object_id
) ON TABLE arena.leaderboard_snapshots TO service_role, fixture_rogue;
GRANT UPDATE (is_derived, source_id)
  ON TABLE arena.leaderboard_snapshots TO service_role, fixture_rogue;
GRANT SELECT ON TABLE arena.tier_a_execution_claims TO fixture_rogue;
GRANT UPDATE (phase) ON TABLE arena.tier_a_execution_heads TO fixture_rogue;
GRANT TRIGGER, REFERENCES, MAINTAIN ON TABLE arena.sources TO fixture_rogue;
GRANT REFERENCES (id) ON TABLE arena.sources TO fixture_rogue;
GRANT EXECUTE ON FUNCTION arena.start_leaderboard_acquisition_attempt(
  uuid, integer, integer, text, text, integer, text, text, text
) TO fixture_rogue;
GRANT EXECUTE ON FUNCTION arena.claim_tier_a_execution(
  uuid, integer, text, text, text, integer, integer, text, uuid, text,
  text, integer
) TO fixture_rogue;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA arena
  GRANT EXECUTE ON FUNCTIONS TO fixture_rogue;

CREATE FUNCTION arena.fixture_launder_raw_before_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.job_type := 'tier_a';
  RETURN NEW;
END
$function$;
CREATE TRIGGER zz_fixture_launder_raw_before_insert
  BEFORE INSERT ON arena.raw_objects
  FOR EACH ROW
  EXECUTE FUNCTION arena.fixture_launder_raw_before_insert();
SQL

# The one-phase guard is an ordered predeploy migration.  Prove its real
# rollout position against the expand schema before postdeploy enforcement,
# including cleanup of the hostile ALTER DEFAULT PRIVILEGES fixture above.
psql_cmd -q -f "$ONE_PHASE_MIGRATION"

assert_sql_true \
  'one-phase guard migration did not install its exact PG17 default contract' \
  "SELECT pg_catalog.current_setting(
            'max_prepared_transactions'
          )::integer = 0
          AND function_row.oid IS NOT NULL
          AND function_row.prorettype = 'boolean'::pg_catalog.regtype
          AND function_row.pronargs = 0
          AND attribute_row.atttypid = 'boolean'::pg_catalog.regtype
          AND attribute_row.attnotnull
          AND attribute_row.attidentity = ''
          AND attribute_row.attgenerated = ''
          AND pg_catalog.pg_get_expr(
                default_row.adbin,
                default_row.adrelid,
                true
              ) = 'arena.require_tier_a_one_phase_commit()'
     FROM pg_catalog.pg_attribute AS attribute_row
     JOIN pg_catalog.pg_attrdef AS default_row
       ON default_row.adrelid = attribute_row.attrelid
      AND default_row.adnum = attribute_row.attnum
     LEFT JOIN pg_catalog.pg_proc AS function_row
       ON function_row.oid = pg_catalog.to_regprocedure(
            'arena.require_tier_a_one_phase_commit()'
          )
    WHERE attribute_row.attrelid =
          'arena.tier_a_execution_write_guards'::pg_catalog.regclass
      AND attribute_row.attname = 'one_phase_commit_required'
      AND attribute_row.attnum > 0
      AND NOT attribute_row.attisdropped;"

assert_worker_enforcement_catalog \
  'worker enforcement catalog SQL rejected the exact one-phase expand state' \
  't' \
  'f'

expect_file_failure \
  'hostile pre-existing trigger was accepted by enforcement' \
  'Tier-A execution trigger allowlist is not exact' \
  "$ENFORCEMENT_MIGRATION"

assert_sql_true \
  'failed trigger audit partially installed enforcement' \
  "SELECT pg_catalog.to_regprocedure(
            'arena.tier_a_execution_claim_enforcement_state()'
          ) IS NULL;"

psql_cmd -q <<'SQL'
DROP TRIGGER zz_fixture_launder_raw_before_insert ON arena.raw_objects;
DROP FUNCTION arena.fixture_launder_raw_before_insert();

ALTER TABLE arena.tier_a_execution_claims
  DROP CONSTRAINT tier_a_execution_claims_claim_id_key,
  ADD CONSTRAINT tier_a_execution_claims_claim_id_key
    UNIQUE (queue_job_id, source_id);
SQL

expect_file_failure \
  'weak same-name claim identity key was accepted by enforcement' \
  'Tier-A execution constraint allowlist is not exact' \
  "$ENFORCEMENT_MIGRATION"

assert_sql_true \
  'failed closed-set constraint audit partially installed enforcement' \
  "SELECT pg_catalog.to_regprocedure(
            'arena.tier_a_execution_claim_enforcement_state()'
          ) IS NULL;"

psql_cmd -q <<'SQL'
ALTER TABLE arena.tier_a_execution_claims
  DROP CONSTRAINT tier_a_execution_claims_claim_id_key,
  ADD CONSTRAINT tier_a_execution_claims_claim_id_key UNIQUE (claim_id);

ALTER TABLE arena.leaderboard_acquisition_attempts
  ADD CONSTRAINT leaderboard_acquisition_attempts_execution_required
  CHECK (
    (
      execution_claim_id IS NOT NULL
      OR execution_generation_seq IS NOT NULL
    ) OR true
  ) NOT VALID;
SQL

expect_file_failure \
  'weak same-name attempt constraint was accepted by enforcement' \
  'Tier-A attempt execution requirement is already drifted' \
  "$ENFORCEMENT_MIGRATION"

assert_sql_true \
  'failed constraint audit partially installed enforcement' \
  "SELECT pg_catalog.to_regprocedure(
            'arena.tier_a_execution_claim_enforcement_state()'
          ) IS NULL;"

psql_cmd -q -c \
  'ALTER TABLE arena.leaderboard_acquisition_attempts DROP CONSTRAINT leaderboard_acquisition_attempts_execution_required;'

psql_cmd -q -f "$ENFORCEMENT_MIGRATION"

assert_sql_true \
  'enforcement changed legacy or claimed callable identities' \
  "SELECT count(*) = 4
          AND bool_and(before.oid = after_function.oid)
          AND bool_and(before.prosrc = after_function.prosrc)
     FROM public.fixture_enforcement_callables AS before
     JOIN pg_catalog.pg_proc AS after_function
       ON after_function.oid::pg_catalog.regprocedure::text = before.identity;"

assert_sql_true \
  'historical unclaimed row was scanned, rewritten, or validated' \
  "SELECT attempt.execution_claim_id IS NULL
          AND attempt.execution_generation_seq IS NULL
          AND NOT constraint_row.convalidated
     FROM arena.leaderboard_acquisition_attempts AS attempt
     CROSS JOIN pg_catalog.pg_constraint AS constraint_row
    WHERE attempt.attempt_id =
          '30000000-0000-4000-8000-000000000003'::uuid
      AND constraint_row.conrelid =
          'arena.leaderboard_acquisition_attempts'::pg_catalog.regclass
      AND constraint_row.conname =
          'leaderboard_acquisition_attempts_execution_required'
      AND constraint_row.contype = 'c'
      AND NOT constraint_row.connoinherit
      AND constraint_row.conislocal
      AND constraint_row.coninhcount = 0
      AND constraint_row.conparentid = 0
      AND pg_catalog.pg_get_expr(
            constraint_row.conbin,
            constraint_row.conrelid,
            true
          ) =
          'execution_claim_id IS NOT NULL AND execution_generation_seq IS NOT NULL';"

assert_sql_true \
  'enforcement marker was not exact or service-only' \
  "SELECT arena.tier_a_execution_claim_enforcement_state() =
          pg_catalog.jsonb_build_object(
            'contract', 'arena.ingest.tier-a-execution-claim-enforcement@1',
            'state', 'enforced'
          )
          AND pg_catalog.has_function_privilege(
            'service_role',
            'arena.tier_a_execution_claim_enforcement_state()',
            'EXECUTE'
          )
          AND NOT pg_catalog.has_function_privilege(
            'fixture_rogue',
            'arena.tier_a_execution_claim_enforcement_state()',
            'EXECUTE'
          );"

# Execute the readiness query exported by the worker itself against this real
# PG17 catalog. The query is intentionally imported through the repository's
# runtime TypeScript loader so this proof cannot silently maintain a SQL copy.
assert_worker_enforcement_catalog \
  'worker enforcement catalog SQL did not return one exact PG17 substrate row' \
  't' \
  't'

expect_failure \
  'service role retained legacy begin execution' \
  'permission denied for function start_leaderboard_acquisition_attempt' \
  "SET ROLE service_role;
   SELECT arena.start_leaderboard_acquisition_attempt(
     '30000000-0000-4000-8000-000000000004', 1, 90, 'retired-cycle',
     'retired-job', 0, 'legacy_unverified', NULL, 'local'
   );"

expect_failure \
  'owner bypassed retired unclaimed begin trigger' \
  'unclaimed acquisition begin is retired' \
  "SELECT arena.start_leaderboard_acquisition_attempt(
     '30000000-0000-4000-8000-000000000005', 1, 90, 'retired-cycle',
     'retired-job', 0, 'legacy_unverified', NULL, 'local'
   );"

expect_failure \
  'owner finished a historical unclaimed attempt' \
  'unclaimed acquisition finish is retired' \
  "SELECT arena.finish_leaderboard_acquisition_attempt(
     '30000000-0000-4000-8000-000000000003',
     'processing_failed', 'unknown', 'unknown', 'unassessed', NULL,
     NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
     NULL, NULL, NULL, NULL, false, false, 'upstream_fetch', 'fixture'
   );"

expect_failure \
  'constraint mode was forced before the Tier-A guard insert' \
  'Tier-A execution COMMIT fence cannot be forced early' \
  "SET ROLE service_role;
   BEGIN;
   SET LOCAL search_path = arena, pg_catalog;
   SET CONSTRAINTS tier_a_execution_fence_commit_assertion IMMEDIATE;
   SELECT arena.fixture_begin_region_guard(3);
   SELECT arena.assert_tier_a_execution_write(
     'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 2
   );
   COMMIT;"

expect_failure \
  'pending Tier-A guard was consumed with SET CONSTRAINTS ALL IMMEDIATE' \
  'Tier-A execution COMMIT fence cannot be forced early' \
  "SET ROLE service_role;
   BEGIN;
   SELECT arena.fixture_begin_region_guard(3);
   SELECT arena.assert_tier_a_execution_write(
     'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 2
   );
   SET CONSTRAINTS ALL IMMEDIATE;
   COMMIT;"

assert_sql_true \
  'forced constraint attempts left a durable execution guard' \
  'SELECT NOT EXISTS (SELECT 1 FROM arena.tier_a_execution_write_guards);'

# Reactivate source 1 with a fresh generation so one transaction can carry two
# independent source sentinels through both deferred verification rounds.
psql_cmd -Atq <<'SQL' >/dev/null
SET ROLE service_role;
BEGIN;
SELECT arena.fixture_begin_region_guard(1);
SELECT arena.claim_tier_a_execution(
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 1,
  'arena:ingest:local', 'tier-a-job-3', 'tiera:leaderboard', 2, 3,
  repeat('9', 64), 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeef',
  repeat('f', 64), 'local', 300
);
COMMIT;
SQL

psql_cmd -q <<'SQL'
BEGIN;
SELECT arena.fixture_begin_region_guard(1);
SELECT arena.assert_tier_a_execution_write(
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 3
);
SELECT arena.assert_tier_a_execution_write(
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 2
);
INSERT INTO arena.leaderboard_snapshots (
  id, source_id, timeframe, count_check_passed, is_derived, raw_object_id
) VALUES
  (2101, 1, 30, true, false, NULL),
  (2103, 3, 30, true, false, NULL);
COMMIT;
SQL

assert_sql_true \
  'multiple source guards did not complete both deferred rounds exactly' \
  "SELECT (SELECT count(*)
             FROM arena.leaderboard_snapshots
            WHERE id IN (2101, 2103)) = 2
          AND NOT EXISTS (
            SELECT 1 FROM arena.tier_a_execution_write_guards
          );"

# Catch an attempted early force inside a savepoint. Rolling the failed force
# back must restore the original round-zero event; after returning the trigger
# to DEFERRED, the outer transaction must remain usable and finish both rounds.
savepoint_force_output=''
if ! savepoint_force_output="$(psql_cmd -Atq 2>&1 <<'SQL'
BEGIN;
SET LOCAL search_path = arena, pg_catalog;
SELECT arena.fixture_begin_region_guard(3);
SELECT arena.assert_tier_a_execution_write(
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 2
);
INSERT INTO arena.leaderboard_snapshots (
  id, source_id, timeframe, count_check_passed, is_derived, raw_object_id
) VALUES (2111, 3, 30, true, false, NULL);
SAVEPOINT before_early_force;
\set ON_ERROR_STOP off
SET CONSTRAINTS tier_a_execution_fence_commit_assertion IMMEDIATE;
\set ON_ERROR_STOP on
ROLLBACK TO SAVEPOINT before_early_force;
SET CONSTRAINTS tier_a_execution_fence_commit_assertion DEFERRED;
INSERT INTO arena.leaderboard_snapshots (
  id, source_id, timeframe, count_check_passed, is_derived, raw_object_id
) VALUES (2112, 3, 30, true, false, NULL);
COMMIT;
SQL
)"; then
  echo 'savepoint recovery after an early Tier-A fence force failed' >&2
  printf '%s\n' "$savepoint_force_output" >&2
  exit 1
fi
if ! printf '%s\n' "$savepoint_force_output" |
  rg -q 'Tier-A execution COMMIT fence cannot be forced early'; then
  echo 'savepoint did not catch the expected early Tier-A fence force' >&2
  printf '%s\n' "$savepoint_force_output" >&2
  exit 1
fi

assert_sql_true \
  'savepoint recovery lost, duplicated, or prematurely consumed guarded work' \
  "SELECT (SELECT count(*)
             FROM arena.leaderboard_snapshots
            WHERE id IN (2111, 2112)) = 2
          AND NOT EXISTS (
            SELECT 1 FROM arena.tier_a_execution_write_guards
          );"

for job_type in tier_a tier_a_manifest tier_a_failure; do
  expect_failure \
    "unguarded $job_type RAW insert passed" \
    'lacks a claimed Tier-A execution guard' \
    "INSERT INTO arena.raw_objects (source_id, job_type)
     VALUES (3, '$job_type');"
done

psql_cmd -q <<'SQL'
CREATE FUNCTION arena.fixture_launder_raw_before_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.job_type := 'tier_a';
  RETURN NEW;
END
$function$;
CREATE TRIGGER zz_fixture_launder_raw_before_insert
  BEFORE INSERT ON arena.raw_objects
  FOR EACH ROW
  EXECUTE FUNCTION arena.fixture_launder_raw_before_insert();
SQL

expect_failure \
  'post-cutover BEFORE trigger laundered a lower-tier RAW insert' \
  'lacks a claimed Tier-A execution guard' \
  "INSERT INTO arena.raw_objects (source_id, job_type)
   VALUES (3, 'tier_b');"

psql_cmd -q <<'SQL'
DROP TRIGGER zz_fixture_launder_raw_before_insert ON arena.raw_objects;
DROP FUNCTION arena.fixture_launder_raw_before_insert();
SQL

expect_failure \
  'unguarded non-derived snapshot insert passed' \
  'lacks a claimed Tier-A execution guard' \
  "INSERT INTO arena.leaderboard_snapshots (
     id, source_id, timeframe, count_check_passed, is_derived, raw_object_id
   ) VALUES (2001, 3, 30, true, false, NULL);"

expect_failure \
  'unguarded Tier-A field inventory insert passed' \
  'lacks a claimed Tier-A execution guard' \
  "INSERT INTO arena.upstream_field_inventory (
     source_id, job_type, field_path
   ) VALUES (3, 'tier_a', 'fixture.unguarded');"

expect_failure \
  'wrong-source execution guard authorized a snapshot' \
  'lacks a claimed Tier-A execution guard' \
  "BEGIN;
   SELECT arena.fixture_begin_region_guard(3);
   SELECT arena.assert_tier_a_execution_write(
     'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 2
   );
   INSERT INTO arena.leaderboard_snapshots (
     id, source_id, timeframe, count_check_passed, is_derived, raw_object_id
   ) VALUES (2002, 1, 30, true, false, NULL);
   COMMIT;"

expect_failure \
  'inactive source retained claimed publication authority' \
  'guarded Tier-A source authority cannot change before COMMIT' \
  "BEGIN;
   SELECT arena.fixture_begin_region_guard(3);
   SELECT arena.assert_tier_a_execution_write(
     'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 2
   );
   UPDATE arena.sources SET status = 'inactive' WHERE id = 3;
   INSERT INTO arena.leaderboard_snapshots (
     id, source_id, timeframe, count_check_passed, is_derived, raw_object_id
   ) VALUES (2003, 3, 30, true, false, NULL);
   COMMIT;"

expect_failure \
  'guarded publication committed before a same-transaction source shutdown' \
  'guarded Tier-A source authority cannot change before COMMIT' \
  "BEGIN;
   SELECT arena.fixture_begin_region_guard(3);
   SELECT arena.assert_tier_a_execution_write(
     'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 2
   );
   INSERT INTO arena.leaderboard_snapshots (
     id, source_id, timeframe, count_check_passed, is_derived, raw_object_id
   ) VALUES (2004, 3, 30, true, false, NULL);
   UPDATE arena.sources SET status = 'inactive' WHERE id = 3;
   COMMIT;"

# The postgres ingest owner still cannot write Tier-A rows without the exact
# guard, but a real asserted source-3 transaction can atomically write all
# guarded table families and pass the deferred COMMIT recheck.
psql_cmd -q <<'SQL'
BEGIN;
SELECT arena.fixture_begin_region_guard(3);
SELECT arena.assert_tier_a_execution_write(
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 2
);
INSERT INTO arena.leaderboard_snapshots (
  id, source_id, timeframe, count_check_passed, is_derived, raw_object_id
) VALUES (3001, 3, 30, true, false, NULL);
INSERT INTO arena.raw_objects (source_id, job_type)
VALUES
  (3, 'tier_a'),
  (3, 'tier_a_manifest'),
  (3, 'tier_a_failure');
INSERT INTO arena.upstream_field_inventory (
  source_id, job_type, field_path
) VALUES (3, 'tier_a', 'fixture.claimed');
COMMIT;
SQL

assert_sql_true \
  'claimed table writes did not commit exactly' \
  "SELECT
     (SELECT count(*) FROM arena.leaderboard_snapshots WHERE id = 3001) = 1
     AND (SELECT count(*) FROM arena.raw_objects WHERE source_id = 3) = 3
     AND (SELECT count(*) FROM arena.upstream_field_inventory
           WHERE source_id = 3 AND job_type = 'tier_a') = 1
     AND (SELECT count(*) FROM arena.tier_a_execution_write_guards) = 0;"

assert_sql_true \
  'claimed begin stopped working after legacy ACL retirement' \
  "SET ROLE service_role;
   BEGIN;
   SELECT arena.fixture_begin_region_guard(3);
   SELECT (
     arena.start_leaderboard_acquisition_attempt(
       '40000000-0000-4000-8000-000000000004', 3, 30,
       'replacement-cycle-2', 'replacement-job-2', 0,
       'fixture-contract', repeat('2', 40), 'local',
       'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 2
     )
   ).execution_claim_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'::uuid;
   COMMIT;"

assert_sql_true \
  'claimed finish stopped working after legacy ACL retirement' \
  "SET ROLE service_role;
   BEGIN;
   SELECT arena.fixture_begin_region_guard(3);
   SELECT (
     arena.finish_leaderboard_acquisition_attempt(
       '40000000-0000-4000-8000-000000000004',
       'processing_failed', 'unknown', 'unknown', 'unassessed', NULL,
       NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
       NULL, NULL, NULL, NULL, false, false, 'upstream_fetch', 'fixture',
       'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 2
     )
   ).terminal_state = 'processing_failed';
   COMMIT;"

# Pause before the final attempt guard so a second session can deactivate the
# source after the claimed assertion but before INSERT validation. The final
# bind must re-read and lock source authority, then fail the whole transaction.
psql_cmd -q <<'SQL'
CREATE FUNCTION arena.aa_fixture_pause_attempt_source_race()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.attempt_id = '50000000-0000-4000-8000-000000000001'::uuid THEN
    PERFORM pg_catalog.pg_sleep(1);
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER aa_fixture_pause_attempt_source_race
  BEFORE INSERT ON arena.leaderboard_acquisition_attempts
  FOR EACH ROW
  EXECUTE FUNCTION arena.aa_fixture_pause_attempt_source_race();
SQL

RACE_ERROR_FILE="$TMP_ROOT/attempt-source-race.log"
psql_cmd -q -c "
  SET ROLE service_role;
  BEGIN;
  SELECT arena.fixture_begin_region_guard(3);
  SELECT arena.start_leaderboard_acquisition_attempt(
    '50000000-0000-4000-8000-000000000001', 3, 30,
    'attempt-source-race', 'replacement-job-2', 0,
    'fixture-contract', repeat('2', 40), 'local',
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 2
  );
  COMMIT;" >"$RACE_ERROR_FILE" 2>&1 &
race_pid=$!
sleep 0.2
psql_cmd -q -c "UPDATE arena.sources SET status = 'inactive' WHERE id = 3;"
if wait "$race_pid"; then
  echo 'claimed attempt crossed a concurrent source shutdown' >&2
  exit 1
fi
if ! rg -q 'lacks a claimed Tier-A execution guard' "$RACE_ERROR_FILE"; then
  echo 'claimed attempt source race failed for an unexpected reason' >&2
  sed -n '1,180p' "$RACE_ERROR_FILE" >&2
  exit 1
fi

psql_cmd -q <<'SQL'
UPDATE arena.sources SET status = 'active' WHERE id = 3;
DROP TRIGGER aa_fixture_pause_attempt_source_race
  ON arena.leaderboard_acquisition_attempts;
DROP FUNCTION arena.aa_fixture_pause_attempt_source_race();
SQL

assert_sql_true \
  'failed source-race attempt left a durable row or guard' \
  "SELECT NOT EXISTS (
            SELECT 1 FROM arena.leaderboard_acquisition_attempts
             WHERE attempt_id =
                   '50000000-0000-4000-8000-000000000001'::uuid
          )
          AND NOT EXISTS (SELECT 1 FROM arena.tier_a_execution_write_guards);"

# Create a valid open claimed attempt, then repeat the same interleaving before
# outcome validation. The terminal row must not commit on an inactive source.
assert_sql_true \
  'outcome source-race parent attempt was not created' \
  "SET ROLE service_role;
   BEGIN;
   SELECT arena.fixture_begin_region_guard(3);
   SELECT (
     arena.start_leaderboard_acquisition_attempt(
       '50000000-0000-4000-8000-000000000002', 3, 30,
       'outcome-source-race', 'replacement-job-2', 0,
       'fixture-contract', repeat('2', 40), 'local',
       'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 2
     )
   ).execution_claim_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'::uuid;
   COMMIT;"

psql_cmd -q <<'SQL'
CREATE FUNCTION arena.aa_fixture_pause_outcome_source_race()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.attempt_seq = (
    SELECT attempt.attempt_seq
      FROM arena.leaderboard_acquisition_attempts AS attempt
     WHERE attempt.attempt_id =
           '50000000-0000-4000-8000-000000000002'::uuid
  ) THEN
    PERFORM pg_catalog.pg_sleep(1);
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER aa_fixture_pause_outcome_source_race
  BEFORE INSERT ON arena.leaderboard_acquisition_outcomes
  FOR EACH ROW
  EXECUTE FUNCTION arena.aa_fixture_pause_outcome_source_race();
SQL

RACE_ERROR_FILE="$TMP_ROOT/outcome-source-race.log"
psql_cmd -q -c "
  SET ROLE service_role;
  BEGIN;
  SELECT arena.fixture_begin_region_guard(3);
  SELECT arena.finish_leaderboard_acquisition_attempt(
    '50000000-0000-4000-8000-000000000002',
    'processing_failed', 'unknown', 'unknown', 'unassessed', NULL,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    NULL, NULL, NULL, NULL, false, false, 'upstream_fetch', 'fixture',
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 2
  );
  COMMIT;" >"$RACE_ERROR_FILE" 2>&1 &
race_pid=$!
sleep 0.2
psql_cmd -q -c "UPDATE arena.sources SET status = 'inactive' WHERE id = 3;"
if wait "$race_pid"; then
  echo 'claimed outcome crossed a concurrent source shutdown' >&2
  exit 1
fi
if ! rg -q 'lacks a claimed Tier-A execution guard' "$RACE_ERROR_FILE"; then
  echo 'claimed outcome source race failed for an unexpected reason' >&2
  sed -n '1,180p' "$RACE_ERROR_FILE" >&2
  exit 1
fi

psql_cmd -q <<'SQL'
UPDATE arena.sources SET status = 'active' WHERE id = 3;
DROP TRIGGER aa_fixture_pause_outcome_source_race
  ON arena.leaderboard_acquisition_outcomes;
DROP FUNCTION arena.aa_fixture_pause_outcome_source_race();
SQL

assert_sql_true \
  'failed source-race outcome left a durable row or guard' \
  "SELECT NOT EXISTS (
            SELECT 1
              FROM arena.leaderboard_acquisition_outcomes AS outcome
              JOIN arena.leaderboard_acquisition_attempts AS attempt
                ON attempt.attempt_seq = outcome.attempt_seq
             WHERE attempt.attempt_id =
                   '50000000-0000-4000-8000-000000000002'::uuid
          )
          AND NOT EXISTS (SELECT 1 FROM arena.tier_a_execution_write_guards);"

# Derived publication, other ingest tiers, profile series, and RAW GC retain
# their established owner paths.
psql_cmd -q <<'SQL'
INSERT INTO arena.leaderboard_snapshots (
  id, source_id, timeframe, count_check_passed, is_derived, raw_object_id
) VALUES (3002, 1, 30, true, true, NULL);
INSERT INTO arena.raw_objects (source_id, job_type)
VALUES
  (1, 'tier_b'),
  (1, 'tier_b_series'),
  (1, 'tier_c'),
  (1, 'tier_d');
INSERT INTO arena.upstream_field_inventory (source_id, job_type, field_path)
VALUES (1, 'tier_b', 'fixture.profile');
INSERT INTO arena.trader_series (payload) VALUES ('daily');
INSERT INTO arena.trader_series_weekly (payload) VALUES ('weekly');
SQL

expect_failure \
  'derived-to-direct snapshot laundering passed' \
  'lacks a claimed Tier-A execution guard' \
  "UPDATE arena.leaderboard_snapshots
      SET is_derived = false
    WHERE id = 3002;"

expect_failure \
  'direct-to-derived snapshot laundering passed' \
  'lacks a claimed Tier-A execution guard' \
  "UPDATE arena.leaderboard_snapshots
      SET is_derived = true
    WHERE id = 3001;"

expect_failure \
  'non-Tier-A RAW laundering into Tier-A passed' \
  'lacks a claimed Tier-A execution guard' \
  "UPDATE arena.raw_objects
      SET job_type = 'tier_a'
    WHERE source_id = 1 AND job_type = 'tier_b';"

expect_failure \
  'Tier-A RAW laundering out of the guard passed' \
  'lacks a claimed Tier-A execution guard' \
  "UPDATE arena.raw_objects
      SET job_type = 'tier_b'
    WHERE source_id = 3 AND job_type = 'tier_a';"

expect_failure \
  'Tier-B inventory laundering into Tier-A passed' \
  'lacks a claimed Tier-A execution guard' \
  "UPDATE arena.upstream_field_inventory
      SET job_type = 'tier_a'
    WHERE source_id = 1 AND job_type = 'tier_b';"

psql_cmd -q -c "DELETE FROM arena.raw_objects WHERE source_id = 3 AND job_type = 'tier_a';"

assert_sql_true \
  'shared or cleanup paths were blocked by Tier-A enforcement' \
  "SELECT
     (SELECT count(*) FROM arena.leaderboard_snapshots WHERE id = 3002) = 1
     AND (SELECT count(*) FROM arena.raw_objects
           WHERE source_id = 1 AND job_type IN (
             'tier_b', 'tier_b_series', 'tier_c', 'tier_d'
           )) = 4
     AND (SELECT count(*) FROM arena.raw_objects
           WHERE source_id = 3 AND job_type = 'tier_a') = 0
     AND (SELECT count(*) FROM arena.upstream_field_inventory
           WHERE source_id = 1 AND job_type = 'tier_b') = 1
     AND (SELECT count(*) FROM arena.trader_series) = 1
     AND (SELECT count(*) FROM arena.trader_series_weekly) = 1;"

expect_failure \
  'service role retained direct table writes' \
  'permission denied for table raw_objects' \
  "SET ROLE service_role;
   INSERT INTO arena.raw_objects (source_id, job_type) VALUES (1, 'tier_b');"

assert_sql_true \
  'hostile non-owner ACLs survived enforcement' \
  "SELECT NOT pg_catalog.has_function_privilege(
            'fixture_rogue',
            'arena.start_leaderboard_acquisition_attempt(uuid,integer,integer,text,text,integer,text,text,text)',
            'EXECUTE'
          )
          AND NOT pg_catalog.has_function_privilege(
            'fixture_rogue',
            'arena.claim_tier_a_execution(uuid,integer,text,text,text,integer,integer,text,uuid,text,text,integer)',
            'EXECUTE'
          )
          AND NOT pg_catalog.has_table_privilege(
            'fixture_rogue', 'arena.raw_objects', 'INSERT,UPDATE,DELETE'
          )
          AND NOT pg_catalog.has_table_privilege(
            'fixture_rogue', 'arena.raw_objects', 'MAINTAIN'
          )
          AND NOT pg_catalog.has_column_privilege(
            'service_role', 'arena.leaderboard_snapshots',
            'is_derived', 'INSERT'
          )
          AND NOT pg_catalog.has_column_privilege(
            'fixture_rogue', 'arena.leaderboard_snapshots',
            'is_derived', 'UPDATE'
          )
          AND NOT pg_catalog.has_table_privilege(
            'fixture_rogue', 'arena.tier_a_execution_claims', 'SELECT'
          )
          AND NOT pg_catalog.has_column_privilege(
            'fixture_rogue', 'arena.tier_a_execution_heads',
            'phase', 'UPDATE'
          )
          AND NOT pg_catalog.has_table_privilege(
            'fixture_rogue', 'arena.sources', 'TRIGGER,REFERENCES,MAINTAIN'
          )
          AND NOT pg_catalog.has_column_privilege(
            'fixture_rogue', 'arena.sources', 'id', 'REFERENCES'
          );"

psql_cmd -q -c 'ALTER TABLE arena.sources OWNER TO fixture_rogue;'

expect_file_failure \
  'drifted source owner was accepted by enforcement replay' \
  'Tier-A source control-plane ACL is not closed' \
  "$ENFORCEMENT_MIGRATION"

psql_cmd -q -c 'ALTER TABLE arena.sources OWNER TO postgres;'

psql_cmd -q -c \
  'ALTER TABLE arena.leaderboard_snapshots ALTER COLUMN is_derived DROP NOT NULL;'

expect_file_failure \
  'nullable trigger dependency was accepted by enforcement replay' \
  'Tier-A enforcement dependent column contract drifted' \
  "$ENFORCEMENT_MIGRATION"

psql_cmd -q -c \
  'ALTER TABLE arena.leaderboard_snapshots ALTER COLUMN is_derived SET NOT NULL;'

psql_cmd -q <<'SQL'
DROP TRIGGER tier_a_execution_fence_commit_assertion
  ON arena.tier_a_execution_write_guards;
CREATE TRIGGER tier_a_execution_fence_commit_assertion
  AFTER INSERT ON arena.tier_a_execution_write_guards
  FOR EACH ROW
  EXECUTE FUNCTION arena.assert_tier_a_execution_fence_at_commit();
SQL

psql_cmd -q -f "$ENFORCEMENT_MIGRATION"

assert_sql_true \
  'enforcement replay did not repair the exact two-round constraint trigger' \
  "SELECT trigger_row.tgconstraint <> 0
          AND trigger_row.tgtype = 21
          AND trigger_row.tgdeferrable
          AND trigger_row.tginitdeferred
     FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid =
          'arena.tier_a_execution_write_guards'::pg_catalog.regclass
      AND trigger_row.tgname =
          'tier_a_execution_fence_commit_assertion';"

psql_cmd -q <<'SQL'
ALTER FUNCTION arena.start_leaderboard_acquisition_attempt(
  uuid, integer, integer, text, text, integer, text, text, text
) OWNER TO fixture_rogue;
REVOKE ALL PRIVILEGES ON FUNCTION arena.start_leaderboard_acquisition_attempt(
  uuid, integer, integer, text, text, integer, text, text, text
) FROM PUBLIC, fixture_rogue;
SQL

expect_file_failure \
  'empty ACL concealed a drifted trigger function owner' \
  'Tier-A enforcement function ACL is not a closed set' \
  "$ENFORCEMENT_MIGRATION"

psql_cmd -q -c \
  'ALTER FUNCTION arena.start_leaderboard_acquisition_attempt(uuid, integer, integer, text, text, integer, text, text, text) OWNER TO postgres;'

psql_cmd -q <<'SQL'
CREATE OR REPLACE FUNCTION arena.reject_direct_leaderboard_acquisition_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RETURN COALESCE(NEW, OLD);
END
$function$;
SQL

expect_file_failure \
  'weak same-OID ledger trigger body was accepted by enforcement replay' \
  'Tier-A execution substrate function contract drifted' \
  "$ENFORCEMENT_MIGRATION"

replace_function_from_migration \
  "$ROOT_DIR/supabase/migrations/20260722030000_durable_leaderboard_acquisition_attempt_ledger.sql" \
  'reject_direct_leaderboard_acquisition_mutation'

psql_cmd -q <<'SQL'
CREATE TABLE public.fixture_enforcement_marker AS
SELECT function_row.oid, function_row.prosrc
FROM pg_catalog.pg_proc AS function_row
WHERE function_row.oid =
      'arena.tier_a_execution_claim_enforcement_state()'::pg_catalog.regprocedure;

GRANT EXECUTE ON FUNCTION arena.start_leaderboard_acquisition_attempt(
  uuid, integer, integer, text, text, integer, text, text, text
) TO fixture_rogue;
GRANT EXECUTE ON FUNCTION arena.claim_tier_a_execution(
  uuid, integer, text, text, text, integer, integer, text, uuid, text,
  text, integer
) TO fixture_rogue;
GRANT EXECUTE ON FUNCTION arena.tier_a_execution_claim_enforcement_state()
  TO fixture_rogue;
GRANT UPDATE ON TABLE arena.raw_objects TO fixture_rogue;
SQL

psql_cmd -q -f "$ENFORCEMENT_MIGRATION"

assert_sql_true \
  'enforcement replay changed marker identity or retained hostile grants' \
  "SELECT marker_before.oid = marker_after.oid
          AND marker_before.prosrc = marker_after.prosrc
          AND NOT pg_catalog.has_function_privilege(
            'fixture_rogue',
            'arena.start_leaderboard_acquisition_attempt(uuid,integer,integer,text,text,integer,text,text,text)',
            'EXECUTE'
          )
          AND NOT pg_catalog.has_function_privilege(
            'fixture_rogue',
            'arena.claim_tier_a_execution(uuid,integer,text,text,text,integer,integer,text,uuid,text,text,integer)',
            'EXECUTE'
          )
          AND NOT pg_catalog.has_function_privilege(
            'fixture_rogue',
            'arena.tier_a_execution_claim_enforcement_state()',
            'EXECUTE'
          )
          AND NOT pg_catalog.has_table_privilege(
            'fixture_rogue', 'arena.raw_objects', 'UPDATE'
          )
     FROM public.fixture_enforcement_marker AS marker_before
     JOIN pg_catalog.pg_proc AS marker_after
       ON marker_after.oid =
          'arena.tier_a_execution_claim_enforcement_state()'::pg_catalog.regprocedure;"

assert_sql_true \
  'enforcement replays removed or weakened the one-phase guard contract' \
  "SELECT attribute_row.atttypid = 'boolean'::pg_catalog.regtype
          AND attribute_row.attnotnull
          AND pg_catalog.pg_get_expr(
                default_row.adbin,
                default_row.adrelid,
                true
              ) = 'arena.require_tier_a_one_phase_commit()'
          AND pg_catalog.to_regprocedure(
                'arena.require_tier_a_one_phase_commit()'
              ) IS NOT NULL
     FROM pg_catalog.pg_attribute AS attribute_row
     JOIN pg_catalog.pg_attrdef AS default_row
       ON default_row.adrelid = attribute_row.attrelid
      AND default_row.adnum = attribute_row.attnum
    WHERE attribute_row.attrelid =
          'arena.tier_a_execution_write_guards'::pg_catalog.regclass
      AND attribute_row.attname = 'one_phase_commit_required'
      AND attribute_row.attnum > 0
      AND NOT attribute_row.attisdropped;"

# Refresh the long-lived source-1 execution immediately before the postmaster
# restart. This keeps the negative guard assertion focused on the one-phase
# default instead of allowing fixture lease expiry to mask the failure.
assert_sql_true \
  'one-phase negative probe did not retain a live claimed execution' \
  "SET ROLE service_role;
   BEGIN;
   SELECT arena.fixture_begin_region_guard(1);
   SELECT arena.heartbeat_tier_a_execution(
     'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 3
   )->>'phase' = 'active';
   COMMIT;"

"$PG_BIN/pg_ctl" -D "$DATA_DIR" -m fast -w stop >/dev/null
"$PG_BIN/pg_ctl" \
  -D "$DATA_DIR" \
  -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses= -c max_prepared_transactions=10" \
  -w start >/dev/null

assert_sql_true \
  'PG17 negative phase did not restart with prepared transactions enabled' \
  "SELECT pg_catalog.current_setting(
            'max_prepared_transactions'
          )::integer = 10
          AND setting::integer = 10
          AND context = 'postmaster'
     FROM pg_catalog.pg_settings
    WHERE name = 'max_prepared_transactions';"

assert_worker_enforcement_catalog \
  'worker enforcement catalog SQL stayed ready with prepared transactions enabled' \
  'f' \
  'f'

# Catch the helper directly so the runtime proof locks the promised SQLSTATE,
# independent of psql's human-readable error formatting.
assert_sql_true \
  'one-phase helper did not reject nonzero max_prepared_transactions as 55000' \
  "DO \$proof\$
   BEGIN
     BEGIN
       PERFORM arena.require_tier_a_one_phase_commit();
       RAISE EXCEPTION 'one-phase helper unexpectedly returned';
     EXCEPTION
       WHEN SQLSTATE '55000' THEN NULL;
     END;
   END
   \$proof\$;
   SELECT true;"

worker_guard_count_before="$(
  psql_cmd -Atq -c 'SELECT count(*) FROM arena.ingest_worker_write_guards;'
)"
if [[ ! "$worker_guard_count_before" =~ ^[0-9]+$ ]]; then
  echo 'could not capture the pre-probe worker-guard fixture baseline' >&2
  printf '%s\n' "$worker_guard_count_before" >&2
  exit 1
fi

expect_failure \
  'Tier-A guard insert survived prepared-transaction enablement' \
  'Tier-A execution requires max_prepared_transactions = 0' \
  "BEGIN;
   SELECT arena.fixture_begin_region_guard(1);
   INSERT INTO arena.raw_objects (
     source_id, job_type, storage_path
   ) VALUES (
     1, 'tier_b', 'fixture://one-phase-guard-rollback-probe'
   );
   SELECT arena.assert_tier_a_execution_write(
     'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 3
   );
   COMMIT;"

assert_sql_true \
  'failed one-phase guard left a prepared xact, guard, or business row' \
  "SELECT NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_prepared_xacts
          )
          AND NOT EXISTS (
            SELECT 1 FROM arena.tier_a_execution_write_guards
          )
          AND (
            SELECT count(*) FROM arena.ingest_worker_write_guards
          ) = $worker_guard_count_before::bigint
          AND NOT EXISTS (
            SELECT 1
              FROM arena.raw_objects
             WHERE storage_path =
                   'fixture://one-phase-guard-rollback-probe'
          );"

expect_file_failure \
  'one-phase migration replayed with prepared transactions enabled' \
  'Tier-A execution requires max_prepared_transactions = 0' \
  "$ONE_PHASE_MIGRATION"

assert_sql_true \
  'failed one-phase migration replay left partial or prepared state' \
  "SELECT pg_catalog.to_regprocedure(
            'arena.require_tier_a_one_phase_commit()'
          ) IS NOT NULL
          AND EXISTS (
            SELECT 1
              FROM pg_catalog.pg_attribute AS attribute_row
             WHERE attribute_row.attrelid =
                   'arena.tier_a_execution_write_guards'::pg_catalog.regclass
               AND attribute_row.attname = 'one_phase_commit_required'
               AND attribute_row.atttypid = 'boolean'::pg_catalog.regtype
               AND attribute_row.attnotnull
               AND attribute_row.attnum > 0
               AND NOT attribute_row.attisdropped
          )
          AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_prepared_xacts
          )
          AND NOT EXISTS (
            SELECT 1 FROM arena.tier_a_execution_write_guards
          )
          AND NOT EXISTS (
            SELECT 1
              FROM arena.raw_objects
             WHERE storage_path =
                   'fixture://one-phase-guard-rollback-probe'
          );"

echo 'Tier-A execution claim fence and postdeploy enforcement PG17 proof passed'
