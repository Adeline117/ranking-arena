#!/usr/bin/env bash

# PostgreSQL 17 proof for 20261118144144_rank_publication_trust_requires_run:
# public.rank_publication_trust_evidence grades a board trust_bound only when
# its own metric-trust run exists and it is not inside trust evidence
# retention (purge in progress, or a runs_only daily representative).
#
# Like Supabase (and the #512 fixture), the cluster superuser is
# supabase_admin and every fixture object and migration runs as a NOSUPERUSER
# postgres role. The pre-migration function is created from the exact
# 20261115141050 text, so the migration's body-digest guard is exercised
# against the real reviewed body.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATIONS="$ROOT_DIR/supabase/migrations"
MIGRATION="$MIGRATIONS/20261118144144_rank_publication_trust_requires_run.sql"
PREVIOUS="$MIGRATIONS/20261115141050_leaderboard_exhaustion_completeness_evidence.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  [[ -x "$PG_BIN/$executable" ]] || { echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2; exit 1; }
done
[[ "$("$PG_BIN/psql" --version)" == psql\ \(PostgreSQL\)\ 17.* ]] || { echo "requires PostgreSQL 17" >&2; exit 1; }

TMP_ROOT="$(mktemp -d /tmp/trust-requires-run-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((57000 + ($$ % 8000)))}"
mkdir -p "$SOCKET_DIR"
cleanup() {
  local code=$?
  [[ -s "$DATA_DIR/postmaster.pid" ]] && "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  if ((code != 0)) && [[ -f "$LOG_FILE" ]]; then tail -40 "$LOG_FILE" >&2 || true; fi
  rm -rf "$TMP_ROOT"
  exit "$code"
}
trap cleanup EXIT

export PGOPTIONS='-c client_min_messages=warning'
psql_cmd() { "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"; }
psql_admin() { "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -U supabase_admin -d postgres "$@"; }
assert_equal() { [[ "$2" == "$3" ]] || { echo "$1: expected '$2', got '$3'" >&2; exit 1; }; echo "ok - $1"; }
graded() {
  psql_cmd -Atqc "
    SELECT string_agg(snapshot_id || ':' || trust_bound, ',' ORDER BY snapshot_id)
    FROM public.rank_publication_trust_evidence(ARRAY[1, 2, 3, 4, 5]::bigint[])"
}

"$PG_BIN/initdb" -D "$DATA_DIR" -A trust -U supabase_admin --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" -w start >/dev/null

psql_admin -q <<'SQL'
CREATE ROLE postgres LOGIN NOSUPERUSER CREATEROLE NOBYPASSRLS;
CREATE ROLE anon NOLOGIN NOSUPERUSER;
CREATE ROLE authenticated NOLOGIN NOSUPERUSER;
CREATE ROLE service_role NOLOGIN NOSUPERUSER;
GRANT anon, authenticated, service_role TO postgres;
GRANT CREATE ON DATABASE postgres TO postgres;
ALTER SCHEMA public OWNER TO postgres;
SQL
assert_equal "migrations run as a non-superuser postgres role" "f" \
  "$(psql_cmd -Atqc "SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user")"

psql_cmd -q <<'SQL'
CREATE SCHEMA arena;
CREATE TABLE arena.leaderboard_snapshots (
  id bigint PRIMARY KEY, source_id smallint NOT NULL, timeframe smallint NOT NULL,
  count_check_passed boolean NOT NULL, raw_object_id bigint
);
CREATE TABLE arena.leaderboard_acquisition_attempts (
  attempt_seq bigint PRIMARY KEY, source_id smallint NOT NULL, timeframe smallint NOT NULL,
  capture_contract text NOT NULL
);
CREATE TABLE arena.leaderboard_acquisition_outcomes (
  attempt_seq bigint PRIMARY KEY REFERENCES arena.leaderboard_acquisition_attempts(attempt_seq),
  terminal_state text NOT NULL, source_run_id text, manifest_raw_object_id bigint,
  source_payload_raw_object_id bigint
);
CREATE FUNCTION arena.leaderboard_outcome_exhaustion_bound(p_attempt_seq bigint)
RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE TABLE arena.metric_trust_runs (
  source_run_id text PRIMARY KEY, snapshot_id bigint NOT NULL UNIQUE
);
CREATE TABLE arena.trust_evidence_retention_purges (
  snapshot_id bigint NOT NULL, disposition text NOT NULL, state text NOT NULL,
  PRIMARY KEY (snapshot_id, disposition)
);

-- Five passed boards of one source/timeframe, each with a complete
-- attempt-bound outcome for its RAW (100 + id):
--   1 daily representative kept by retention without its runs (runs_only, complete)
--   2 latest board, run present                   -> trusted
--   3 run present but its purge is in progress     -> not trusted
--   4 outcome only, no run ever written            -> not trusted
--   5 run present but for a different source run   -> not trusted
INSERT INTO arena.leaderboard_snapshots
SELECT id, 1, 90, true, 100 + id FROM generate_series(1, 5) AS id;
INSERT INTO arena.leaderboard_acquisition_attempts
SELECT id, 1, 90, 'arena.ingest.leaderboard-acquisition-manifest@4' FROM generate_series(1, 5) AS id;
INSERT INTO arena.leaderboard_acquisition_outcomes
SELECT id, 'complete', 'run-' || id, 200 + id, 100 + id FROM generate_series(1, 5) AS id;
INSERT INTO arena.metric_trust_runs VALUES ('run-2', 2), ('run-3', 3), ('run-other', 5);
INSERT INTO arena.trust_evidence_retention_purges VALUES
  (1, 'runs_only', 'complete'),
  (3, 'snapshot', 'in_progress');
SQL

# The reviewed pre-migration function, verbatim from 20261115141050.
{
  echo "SET search_path = pg_catalog, pg_temp;"
  sed -n '/^CREATE OR REPLACE FUNCTION public.rank_publication_trust_evidence(p_snapshot_ids bigint\[\])/,/^\$function\$;/p' "$PREVIOUS"
  echo "ALTER FUNCTION public.rank_publication_trust_evidence(bigint[]) OWNER TO postgres;"
  echo "REVOKE ALL ON FUNCTION public.rank_publication_trust_evidence(bigint[]) FROM PUBLIC, anon, authenticated, service_role;"
  echo "GRANT EXECUTE ON FUNCTION public.rank_publication_trust_evidence(bigint[]) TO service_role;"
} | psql_cmd -q

assert_equal "before: every board with a complete outcome grades trusted (the hole)" \
  "1:true,2:true,3:true,4:true,5:true" "$(graded)"

psql_cmd -q -f "$MIGRATION" >/dev/null
psql_cmd -q -f "$MIGRATION" >/dev/null # replay
echo "ok - migration applies as a non-superuser and replays"

assert_equal "after: only the latest board with its own run is trusted" \
  "1:false,2:true,3:false,4:false,5:false" "$(graded)"
assert_equal "the representative kept without runs is untrusted (negative)" "f" "$(psql_cmd -Atqc "
  SELECT trust_bound FROM public.rank_publication_trust_evidence(ARRAY[1]::bigint[])")"
assert_equal "the normal latest board is still trusted (positive)" "t|run-2|102|202" "$(psql_cmd -Atqc "
  SELECT concat_ws('|', trust_bound, source_run_id, raw_object_id, manifest_raw_object_id)
  FROM public.rank_publication_trust_evidence(ARRAY[2]::bigint[])")"
assert_equal "only search_path is set on the function (no custom SET)" "{\"search_path=pg_catalog, pg_temp\"}" \
  "$(psql_cmd -Atqc "SELECT proconfig FROM pg_proc WHERE oid = 'public.rank_publication_trust_evidence(bigint[])'::regprocedure")"
assert_equal "service_role keeps EXECUTE; anon has none" "t|f" "$(psql_cmd -Atqc "
  SELECT concat_ws('|',
    has_function_privilege('service_role', 'public.rank_publication_trust_evidence(bigint[])', 'EXECUTE'),
    has_function_privilege('anon', 'public.rank_publication_trust_evidence(bigint[])', 'EXECUTE'))")"

# Digest guard: a drifted body is refused and left untouched.
psql_cmd -q <<'SQL'
CREATE OR REPLACE FUNCTION public.rank_publication_trust_evidence(p_snapshot_ids bigint[])
RETURNS TABLE (snapshot_id bigint, trust_bound boolean, raw_object_id bigint, source_run_id text, manifest_raw_object_id bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $function$ SELECT NULL::bigint, true, NULL::bigint, NULL::text, NULL::bigint WHERE false $function$;
SQL
if psql_cmd -q -f "$MIGRATION" >/dev/null 2>&1; then
  echo "the migration accepted a drifted function body" >&2
  exit 1
fi
assert_equal "a drifted body is refused and not replaced" "0" "$(psql_cmd -Atqc "
  SELECT count(*) FROM public.rank_publication_trust_evidence(ARRAY[2]::bigint[])")"

echo "rank publication trust requires run PostgreSQL 17 proof passed"
