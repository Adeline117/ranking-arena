#!/usr/bin/env bash

# Dependency-replays one hash-attested canonical-baseline candidate inside a
# harness-owned PostgreSQL 17 cluster. It has no URL, host, existing-cluster,
# remote, or production mode. Passing this check is not promotion evidence.

set -Eeuo pipefail

umask 077
export CDPATH=''

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
CANDIDATES_ROOT="$REPO_ROOT/supabase/baseline-candidates"
VALIDATOR="$REPO_ROOT/scripts/qa/validate-baseline-candidate.mjs"
OPT_IN_NAME='ARENA_DISPOSABLE_BASELINE_REPLAY'

usage() {
  cat <<'EOF'
Usage:
  ARENA_DISPOSABLE_BASELINE_REPLAY=1 \
  PG17_BIN=/absolute/path/to/postgresql@17/bin \
    bash scripts/maintenance/replay-baseline-candidate.pg17.sh \
      --candidate-dir supabase/baseline-candidates/<candidate>

The candidate must be a direct child of supabase/baseline-candidates and pass
the complete candidate validator. The harness derives and hash-verifies the
foundation, app schema, and complete forward set, then replays private staged
copies. PostgreSQL listens only on a short harness-owned Unix socket.

Every SQL file is applied by a separate psql --single-transaction invocation.
The SQL gate rejects psql meta-command escapes, explicit transaction control,
and non-atomic CONCURRENTLY operations before initdb. This is a dependency and
syntax replay only; it does not prove managed-Supabase or production equality.
EOF
}

fail() {
  echo "BASELINE REPLAY REFUSED: $*" >&2
  exit 1
}

if [[ "${1:-}" == '--help' ]]; then
  usage
  exit 0
fi

CANDIDATE_INPUT=''
while (($# > 0)); do
  case "$1" in
    --candidate-dir)
      [[ -z "$CANDIDATE_INPUT" ]] || fail '--candidate-dir was provided more than once'
      (($# >= 2)) || fail '--candidate-dir requires a path'
      CANDIDATE_INPUT="$2"
      shift 2
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

[[ "${!OPT_IN_NAME:-}" == '1' ]] || \
  fail "$OPT_IN_NAME=1 is required for this disposable replay"

# Reject ambient libpq and common database connection variables even though
# every psql call supplies a private socket. This makes future omissions fail
# closed rather than falling back to a developer or production profile.
while IFS='=' read -r environment_name _; do
  case "$environment_name" in
    PG17_BIN | ${OPT_IN_NAME} | NODE_BIN)
      ;;
    PG* | *DATABASE_URL* | DIRECT_URL | POSTGRES_URL | POSTGRES_URL_* | SUPABASE_DB_URL)
      fail "external database environment is not allowed: $environment_name"
      ;;
  esac
done < <(env)

[[ -n "$CANDIDATE_INPUT" ]] || fail '--candidate-dir is required'

if [[ "$CANDIDATE_INPUT" == /* ]]; then
  CANDIDATE_REQUESTED="$CANDIDATE_INPUT"
else
  CANDIDATE_REQUESTED="$REPO_ROOT/$CANDIDATE_INPUT"
fi
[[ ! -L "$CANDIDATE_REQUESTED" ]] || fail "candidate directory must not be a symlink: $CANDIDATE_INPUT"
[[ -d "$CANDIDATE_REQUESTED" ]] || fail "candidate directory does not exist: $CANDIDATE_INPUT"
CANDIDATE_DIR="$(cd "$CANDIDATE_REQUESTED" && pwd -P)"
[[ "$(dirname "$CANDIDATE_DIR")" == "$CANDIDATES_ROOT" ]] || \
  fail 'candidate directory must be a direct child of supabase/baseline-candidates'

PG17_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
[[ "$PG17_BIN" == /* ]] || fail 'PG17_BIN must be an absolute directory'
[[ -d "$PG17_BIN" ]] || fail "PG17_BIN is not a directory: $PG17_BIN"

INITDB="$PG17_BIN/initdb"
PG_CTL="$PG17_BIN/pg_ctl"
POSTGRES="$PG17_BIN/postgres"
PSQL="$PG17_BIN/psql"

postgres_version() {
  local executable="$1"
  local output
  local major
  local minor

  [[ -x "$executable" ]] || fail "PostgreSQL executable is missing: $executable"
  output="$("$executable" --version 2>&1)" || \
    fail "could not read PostgreSQL version from $executable"
  if [[ "$output" =~ PostgreSQL[^0-9]*([0-9]+)\.([0-9]+)([^0-9]|$) ]]; then
    major="${BASH_REMATCH[1]}"
    minor="${BASH_REMATCH[2]}"
  else
    fail "unrecognized PostgreSQL version output from $executable: $output"
  fi
  [[ "$major" == '17' ]] || \
    fail "PostgreSQL 17 is required; $executable reported major $major"
  printf '%s.%s\n' "$major" "$minor"
}

INITDB_VERSION="$(postgres_version "$INITDB")"
PG_CTL_VERSION="$(postgres_version "$PG_CTL")"
POSTGRES_VERSION="$(postgres_version "$POSTGRES")"
PSQL_VERSION="$(postgres_version "$PSQL")"
[[ "$INITDB_VERSION" == "$PG_CTL_VERSION" && \
  "$PG_CTL_VERSION" == "$POSTGRES_VERSION" && \
  "$POSTGRES_VERSION" == "$PSQL_VERSION" ]] || \
  fail "PostgreSQL tools must have one exact version: initdb=$INITDB_VERSION pg_ctl=$PG_CTL_VERSION postgres=$POSTGRES_VERSION psql=$PSQL_VERSION"
PSQL_MINOR="${PSQL_VERSION#17.}"
((10#$PSQL_MINOR >= 6)) || \
  fail "psql 17.6 or newer is required for restricted-mode dump guards; found $PSQL_VERSION"

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || fail 'node is required to validate and stage the candidate'

TMP_PARENT="${TMPDIR:-/tmp}"
[[ -d "$TMP_PARENT" ]] || fail "temporary parent is not a directory: $TMP_PARENT"
TMP_PARENT="$(cd "$TMP_PARENT" && pwd -P)"
TMP_ROOT=''
SOCKET_ROOT=''
DATA_DIR=''
SERVER_LOG=''
STAGE_DIR=''
PLAN_FILE=''
PREREQUISITES_FILE=''
OBSERVED_PREREQUISITES=''
BASE_PREREQUISITES=''
STAGED_FOUNDATION=''
STAGED_APP_SCHEMA=''
SERVER_START_ATTEMPTED=0
SERVER_STARTED=0

cleanup() {
  local status=$?
  local cleanup_status=0
  local preserve=0
  local server_detected=0

  # Once cleanup begins, signals must not interrupt the stop/status/delete
  # sequence and leave a live or partially removed cluster behind.
  trap - EXIT
  trap '' HUP INT TERM

  if [[ "$status" != '0' && -n "$SERVER_LOG" && -s "$SERVER_LOG" ]]; then
    echo 'BASELINE REPLAY: PostgreSQL failure log (last 40 lines):' >&2
    tail -n 40 "$SERVER_LOG" >&2 || true
  fi

  if [[ "$SERVER_START_ATTEMPTED" == '1' && -n "$DATA_DIR" && -d "$DATA_DIR" ]]; then
    if [[ "$SERVER_STARTED" == '1' || -s "$DATA_DIR/postmaster.pid" ]]; then
      server_detected=1
    elif "$PG_CTL" -D "$DATA_DIR" status >/dev/null 2>&1; then
      server_detected=1
    fi
    if [[ "$server_detected" == '1' ]]; then
      if ! "$PG_CTL" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1; then
        echo "BASELINE REPLAY CLEANUP REFUSED: PostgreSQL stop failed; preserving $TMP_ROOT and $SOCKET_ROOT" >&2
        preserve=1
        cleanup_status=1
      elif "$PG_CTL" -D "$DATA_DIR" status >/dev/null 2>&1 || [[ -s "$DATA_DIR/postmaster.pid" ]]; then
        echo "BASELINE REPLAY CLEANUP REFUSED: PostgreSQL still appears live after stop; preserving $TMP_ROOT and $SOCKET_ROOT" >&2
        preserve=1
        cleanup_status=1
      fi
    fi
  fi

  if [[ "$preserve" == '0' ]]; then
    if [[ -n "$TMP_ROOT" ]]; then
      case "$TMP_ROOT" in
        "$TMP_PARENT"/arena-baseline-replay-pg17.*)
          rm -rf -- "$TMP_ROOT" || cleanup_status=1
          ;;
        *)
          echo "BASELINE REPLAY CLEANUP REFUSED: unexpected temporary path: $TMP_ROOT" >&2
          cleanup_status=1
          ;;
      esac
    fi
    if [[ -n "$SOCKET_ROOT" ]]; then
      case "$SOCKET_ROOT" in
        /tmp/arena-baseline-pg17-socket.*)
          rm -rf -- "$SOCKET_ROOT" || cleanup_status=1
          ;;
        *)
          echo "BASELINE REPLAY CLEANUP REFUSED: unexpected socket path: $SOCKET_ROOT" >&2
          cleanup_status=1
          ;;
      esac
    fi
  fi

  if [[ "$cleanup_status" != '0' && "$status" == '0' ]]; then
    status=1
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Arm cleanup before either allocation so a signal or a failed second mktemp
# cannot leak the first harness-owned root.
TMP_ROOT="$(mktemp -d "$TMP_PARENT/arena-baseline-replay-pg17.XXXXXX")"
SOCKET_ROOT="$(mktemp -d /tmp/arena-baseline-pg17-socket.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SERVER_LOG="$TMP_ROOT/postgres.log"
STAGE_DIR="$TMP_ROOT/staged"
PLAN_FILE="$TMP_ROOT/forward-plan.tsv"
PREREQUISITES_FILE="$STAGE_DIR/platform-prerequisites.json"
OBSERVED_PREREQUISITES="$TMP_ROOT/observed-prerequisites.json"
BASE_PREREQUISITES="$TMP_ROOT/base-prerequisites.json"
STAGED_FOUNDATION="$STAGE_DIR/foundation.sql"
STAGED_APP_SCHEMA="$STAGE_DIR/app-schema.sql"

mkdir -p "$STAGE_DIR" "$TMP_ROOT/home"

# Validate the full candidate contract, then re-read and hash every executable
# byte while copying it into the private staging directory. Later source-tree
# changes cannot affect this replay.
env -u NODE_OPTIONS "$NODE_BIN" --input-type=module - \
  "$VALIDATOR" \
  "$REPO_ROOT" \
  "$CANDIDATES_ROOT" \
  "$CANDIDATE_DIR" \
  "$STAGE_DIR" \
  "$PLAN_FILE" <<'NODE'
import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const [validatorPath, repoRoot, candidatesRoot, candidateDir, stageDir, planFile] =
  process.argv.slice(2)
const { validateBaselineCandidate } = await import(pathToFileURL(validatorPath).href)
const result = validateBaselineCandidate({
  candidateDir,
  candidatesRoot,
  includeReplayPlan: true,
  repoRoot,
})

function copyVerified(source, destination, expectedSha256, label) {
  const contents = readFileSync(source)
  const actual = createHash('sha256').update(contents).digest('hex')
  if (actual !== expectedSha256) {
    throw new Error(`${label} changed after candidate validation`)
  }
  writeFileSync(destination, contents, { flag: 'wx', mode: 0o600 })
  chmodSync(destination, 0o600)
}

copyVerified(
  result.replayPlan.foundation.absolutePath,
  `${stageDir}/foundation.sql`,
  result.replayPlan.foundation.sha256,
  'foundation SQL'
)
copyVerified(
  result.replayPlan.appSchema.absolutePath,
  `${stageDir}/app-schema.sql`,
  result.replayPlan.appSchema.sha256,
  'app schema'
)
writeFileSync(
  `${stageDir}/platform-prerequisites.json`,
  `${JSON.stringify(result.replayPlan.platformPrerequisites)}\n`,
  { flag: 'wx', mode: 0o600 }
)

const lines = []
for (const migration of result.replayPlan.forwardMigrations) {
  const destination = `${stageDir}/${migration.version}_${basename(migration.path)}`
  copyVerified(migration.absolutePath, destination, migration.sha256, migration.path)
  lines.push(`${migration.version}\t${destination}`)
}
writeFileSync(planFile, lines.length === 0 ? '' : `${lines.join('\n')}\n`, {
  flag: 'wx',
  mode: 0o600,
})
NODE

# Prevent psql from reading host credentials even if a future invocation loses
# -w. The files do not exist, and HOME/XDG_CONFIG_HOME are private to this run.
export HOME="$TMP_ROOT/home"
export XDG_CONFIG_HOME="$TMP_ROOT/home"
export PGPASSFILE="$TMP_ROOT/home/.pgpass"
export PGSERVICEFILE="$TMP_ROOT/home/.pg_service.conf"
export PSQL_PAGER=''

"$INITDB" -D "$DATA_DIR" -U postgres --auth=trust --no-locale \
  --encoding=UTF8 >/dev/null
SERVER_START_ATTEMPTED=1
if ! "$PG_CTL" -D "$DATA_DIR" -l "$SERVER_LOG" \
  -p "$POSTGRES" \
  -o "-F -k '$SOCKET_ROOT' -p 5432 -c listen_addresses=''" \
  -w start >/dev/null; then
  fail 'PostgreSQL failed to start'
fi
SERVER_STARTED=1

apply_sql_file() {
  local phase="$1"
  local sql_file="$2"

  echo "BASELINE REPLAY: $phase $(basename "$sql_file")"
  "$PSQL" \
    -h "$SOCKET_ROOT" \
    -p 5432 \
    -U postgres \
    -d postgres \
    -X \
    -w \
    -P pager=off \
    -v ON_ERROR_STOP=1 \
    --single-transaction \
    -f "$sql_file"
}

capture_platform_catalog() {
  local destination="$1"

  "$PSQL" \
    -h "$SOCKET_ROOT" \
    -p 5432 \
    -U postgres \
    -d postgres \
    -X \
    -w \
    -P pager=off \
    -v ON_ERROR_STOP=1 \
    -At \
    -c "SELECT json_build_object(
    'extensions', COALESCE((SELECT json_agg(extname ORDER BY extname) FROM pg_extension), '[]'::json),
    'functions', COALESCE((SELECT json_agg(format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) ORDER BY n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace), '[]'::json),
    'relations', COALESCE((SELECT json_agg(format('%I.%I', n.nspname, c.relname) ORDER BY n.nspname, c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')), '[]'::json),
    'roles', COALESCE((SELECT json_agg(rolname ORDER BY rolname) FROM pg_roles), '[]'::json),
    'schemas', COALESCE((SELECT json_agg(nspname ORDER BY nspname) FROM pg_namespace), '[]'::json),
    'types', COALESCE((SELECT json_agg(format('%I.%I', n.nspname, t.typname) ORDER BY n.nspname, t.typname) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace LEFT JOIN pg_class c ON c.oid = t.typrelid WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND t.typelem = 0 AND (t.typrelid = 0 OR c.relkind = 'c')), '[]'::json),
    'appOwnedSchemas', (SELECT count(*) FROM pg_namespace WHERE nspname = 'arena'),
    'appOwnedRelations', (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('public', 'arena')),
    'appOwnedRoutines', (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('public', 'arena')),
    'appOwnedTypes', (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname IN ('public', 'arena') AND t.typtype NOT IN ('p'))
  );" >"$destination"
}

# Compare the exact catalog delta, not a subset of the post-foundation state.
# This forces each fixture to declare every object it adds and detects removals.
capture_platform_catalog "$BASE_PREREQUISITES"
apply_sql_file 'foundation' "$STAGED_FOUNDATION"
capture_platform_catalog "$OBSERVED_PREREQUISITES"

env -u NODE_OPTIONS "$NODE_BIN" --input-type=module - \
  "$PREREQUISITES_FILE" \
  "$BASE_PREREQUISITES" \
  "$OBSERVED_PREREQUISITES" <<'NODE'
import { readFileSync } from 'node:fs'

const [expectedPath, basePath, observedPath] = process.argv.slice(2)
const expected = JSON.parse(readFileSync(expectedPath, 'utf8'))
const base = JSON.parse(readFileSync(basePath, 'utf8'))
const observed = JSON.parse(readFileSync(observedPath, 'utf8'))

for (const key of ['extensions', 'functions', 'relations', 'roles', 'schemas', 'types']) {
  const before = new Set(base[key])
  const after = new Set(observed[key])
  const removed = base[key].filter((item) => !after.has(item))
  if (removed.length > 0) {
    throw new Error(`foundation removed ${key}: ${removed.join(', ')}`)
  }
  const added = observed[key].filter((item) => !before.has(item))
  if (JSON.stringify(added) !== JSON.stringify(expected[key])) {
    throw new Error(
      `foundation ${key} delta does not match its declaration: expected ${JSON.stringify(expected[key])}, observed ${JSON.stringify(added)}`
    )
  }
}
for (const key of ['appOwnedSchemas', 'appOwnedRelations', 'appOwnedRoutines', 'appOwnedTypes']) {
  if (observed[key] !== 0) {
    throw new Error(`foundation pre-created ${observed[key]} ${key}`)
  }
}
NODE

apply_sql_file 'app-schema' "$STAGED_APP_SCHEMA"

while IFS=$'\t' read -r version migration_file; do
  [[ -n "$version" && -n "$migration_file" ]] || \
    fail 'validated forward execution plan contains an empty field'
  apply_sql_file "forward:$version" "$migration_file"
done <"$PLAN_FILE"

echo 'BASELINE REPLAY: disposable PostgreSQL 17 dependency replay passed (not promotion evidence)'
