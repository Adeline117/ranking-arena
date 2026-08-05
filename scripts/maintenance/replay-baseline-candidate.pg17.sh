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
TARGET_CATALOG_CAPTURE="$REPO_ROOT/scripts/qa/capture-baseline-replay-target-catalog.mjs"
WITNESS_COMPARATOR="$REPO_ROOT/scripts/qa/baseline-replay-witness-comparator.mjs"
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
and non-atomic CONCURRENTLY operations before initdb. The harness captures a
normalized target catalogue at the source boundary and after the forward set,
and atomically records the exact forward executions in a harness-owned ledger.
The source-boundary comparison deliberately excludes publication materialization
because source capture retains publication evidence but app-schema.sql does not
replay it. This remains dependency evidence only; it does not prove the final
catalogue is approved, managed-Supabase equivalence, or production equality.
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

TMP_PARENT_INPUT="${TMPDIR:-/tmp}"
if ! TMP_PARENT="$(
  env -u NODE_OPTIONS "$NODE_BIN" --input-type=module - "$TMP_PARENT_INPUT" <<'NODE'
import { lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'

const [requested] = process.argv.slice(2)
if (
  typeof requested !== 'string' ||
  !path.isAbsolute(requested) ||
  /[\u0000-\u001f\u007f]/u.test(requested) ||
  typeof process.geteuid !== 'function'
) {
  process.exit(1)
}
let physical
let metadata
try {
  physical = realpathSync(requested)
  metadata = lstatSync(physical)
} catch {
  process.exit(1)
}
if (metadata.isSymbolicLink() || !metadata.isDirectory()) process.exit(1)
const systemRoots = new Set()
for (const candidate of ['/tmp', '/private/tmp']) {
  try {
    systemRoots.add(realpathSync(candidate))
  } catch {}
}
const effectiveUserId = process.geteuid()
const ownerControlled = metadata.uid === effectiveUserId && (metadata.mode & 0o022) === 0
const exactSystemTemporaryRoot =
  systemRoots.has(physical) && metadata.uid === 0 && (metadata.mode & 0o1000) !== 0
if (!ownerControlled && !exactSystemTemporaryRoot) process.exit(1)
process.stdout.write(physical)
NODE
)"; then
  fail 'TMPDIR must be absolute, control-free, and either effective-user-owned without group/world write or the exact root-owned sticky system temporary directory'
fi
TMP_ROOT=''
TMP_ROOT_IDENTITY=''
SYSTEM_TMP_ROOT="$(cd /tmp && pwd -P)"
SOCKET_ROOT=''
SOCKET_ROOT_IDENTITY=''
DATA_DIR=''
SERVER_LOG=''
STAGE_DIR=''
STAGE_IDENTITY=''
STAGED_EXPECTATIONS_FILE=''
STAGED_EXPECTATIONS_SHA256=''
STAGED_STATE_FILE=''
STAGED_STATE_SHA256=''
PLAN_FILE=''
PREREQUISITES_FILE=''
OBSERVED_PREREQUISITES=''
BASE_PREREQUISITES=''
STAGED_FOUNDATION=''
STAGED_APP_SCHEMA=''
STAGED_SOURCE_CATALOG=''
STAGED_FORWARD_MANIFEST=''
SOURCE_ANCHOR_FILE=''
BASELINE_TARGET_CATALOG=''
FINAL_TARGET_CATALOG=''
OBSERVED_SOURCE_ANCHOR=''
OBSERVED_FORWARD_EXECUTIONS=''
WITNESS_SCHEMA=''
SERVER_START_ATTEMPTED=0
SERVER_STARTED=0

directory_identity() {
  local directory="$1"
  local parent="$2"
  local name_pattern="$3"

  env -u NODE_OPTIONS "$NODE_BIN" --input-type=module - \
    "$directory" "$parent" "$name_pattern" <<'NODE'
import { lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'

const [directory, parent, sourcePattern] = process.argv.slice(2)
if (typeof process.geteuid !== 'function') process.exit(1)
let metadata
let physical
try {
  metadata = lstatSync(directory)
  physical = realpathSync(directory)
} catch {
  process.exit(1)
}
if (
  metadata.isSymbolicLink() ||
  !metadata.isDirectory() ||
  physical !== directory ||
  realpathSync(path.dirname(physical)) !== realpathSync(parent) ||
  !(new RegExp(sourcePattern, 'u')).test(path.basename(physical)) ||
  metadata.uid !== process.geteuid() ||
  (metadata.mode & 0o777) !== 0o700
) {
  process.exit(1)
}
process.stdout.write(`${metadata.dev}:${metadata.ino}:${metadata.uid}:${metadata.mode}`)
NODE
}

directory_matches() {
  local actual
  actual="$(directory_identity "$1" "$2" "$3" 2>/dev/null)" || return 1
  [[ "$actual" == "$4" ]]
}

cleanup() {
  local status=$?
  local cleanup_status=0
  local preserve=0
  local server_detected=0

  # Once cleanup begins, signals must not interrupt the stop/status/delete
  # sequence and leave a live or partially removed cluster behind.
  trap - EXIT
  trap '' HUP INT TERM

  local roots_stable=1
  if [[ -n "$TMP_ROOT" ]] && ! directory_matches \
    "$TMP_ROOT" "$TMP_PARENT" '^arena-baseline-replay-pg17\.[A-Za-z0-9]+$' \
    "$TMP_ROOT_IDENTITY"; then
    echo "BASELINE REPLAY CLEANUP REFUSED: temporary root identity changed; preserving $TMP_ROOT" >&2
    roots_stable=0
    preserve=1
    cleanup_status=1
  fi
  if [[ -n "$SOCKET_ROOT" ]] && ! directory_matches \
    "$SOCKET_ROOT" "$SYSTEM_TMP_ROOT" '^arena-baseline-pg17-socket\.[A-Za-z0-9]+$' \
    "$SOCKET_ROOT_IDENTITY"; then
    echo "BASELINE REPLAY CLEANUP REFUSED: socket root identity changed; preserving $SOCKET_ROOT" >&2
    roots_stable=0
    preserve=1
    cleanup_status=1
  fi

  if [[ "$roots_stable" == '1' && "$status" != '0' && \
    -n "$SERVER_LOG" && -s "$SERVER_LOG" ]]; then
    echo 'BASELINE REPLAY: PostgreSQL failure log (last 40 lines):' >&2
    tail -n 40 "$SERVER_LOG" >&2 || true
  fi

  if [[ "$roots_stable" == '1' && "$SERVER_START_ATTEMPTED" == '1' && \
    -n "$DATA_DIR" && -d "$DATA_DIR" ]]; then
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
          if directory_matches \
            "$TMP_ROOT" "$TMP_PARENT" '^arena-baseline-replay-pg17\.[A-Za-z0-9]+$' \
            "$TMP_ROOT_IDENTITY"; then
            rm -rf -- "$TMP_ROOT" || cleanup_status=1
          else
            echo "BASELINE REPLAY CLEANUP REFUSED: temporary root changed before deletion: $TMP_ROOT" >&2
            cleanup_status=1
          fi
          ;;
        *)
          echo "BASELINE REPLAY CLEANUP REFUSED: unexpected temporary path: $TMP_ROOT" >&2
          cleanup_status=1
          ;;
      esac
    fi
    if [[ -n "$SOCKET_ROOT" ]]; then
      case "$SOCKET_ROOT" in
        "$SYSTEM_TMP_ROOT"/arena-baseline-pg17-socket.*)
          if directory_matches \
            "$SOCKET_ROOT" "$SYSTEM_TMP_ROOT" '^arena-baseline-pg17-socket\.[A-Za-z0-9]+$' \
            "$SOCKET_ROOT_IDENTITY"; then
            rm -rf -- "$SOCKET_ROOT" || cleanup_status=1
          else
            echo "BASELINE REPLAY CLEANUP REFUSED: socket root changed before deletion: $SOCKET_ROOT" >&2
            cleanup_status=1
          fi
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
TMP_ROOT="$(cd "$TMP_ROOT" && pwd -P)"
TMP_ROOT_IDENTITY="$(directory_identity \
  "$TMP_ROOT" "$TMP_PARENT" '^arena-baseline-replay-pg17\.[A-Za-z0-9]+$')" || \
  fail 'mktemp returned an unsafe replay root'
SOCKET_ROOT="$(mktemp -d "$SYSTEM_TMP_ROOT/arena-baseline-pg17-socket.XXXXXX")"
SOCKET_ROOT="$(cd "$SOCKET_ROOT" && pwd -P)"
SOCKET_ROOT_IDENTITY="$(directory_identity \
  "$SOCKET_ROOT" "$SYSTEM_TMP_ROOT" '^arena-baseline-pg17-socket\.[A-Za-z0-9]+$')" || \
  fail 'mktemp returned an unsafe socket root'
WITNESS_SCHEMA="arena_baseline_replay_witness_${TMP_ROOT##*.}"
[[ "$WITNESS_SCHEMA" =~ ^arena_baseline_replay_witness_[A-Za-z0-9]+$ ]] || \
  fail 'temporary root produced an unsafe witness namespace'
DATA_DIR="$TMP_ROOT/data"
SERVER_LOG="$TMP_ROOT/postgres.log"
STAGE_DIR="$TMP_ROOT/staged"
STAGED_EXPECTATIONS_FILE="$TMP_ROOT/staged-expected-sha256.json"
STAGED_STATE_FILE="$TMP_ROOT/staged-identities.json"
PLAN_FILE="$TMP_ROOT/forward-plan.tsv"
PREREQUISITES_FILE="$STAGE_DIR/platform-prerequisites.json"
OBSERVED_PREREQUISITES="$TMP_ROOT/observed-prerequisites.json"
BASE_PREREQUISITES="$TMP_ROOT/base-prerequisites.json"
STAGED_FOUNDATION="$STAGE_DIR/foundation.sql"
STAGED_APP_SCHEMA="$STAGE_DIR/app-schema.sql"
STAGED_SOURCE_CATALOG="$STAGE_DIR/source-catalog.json"
STAGED_FORWARD_MANIFEST="$STAGE_DIR/forward-migrations.json"
SOURCE_ANCHOR_FILE="$STAGE_DIR/source-anchor.tsv"
BASELINE_TARGET_CATALOG="$TMP_ROOT/baseline-target-catalog.json"
FINAL_TARGET_CATALOG="$TMP_ROOT/final-target-catalog.json"
OBSERVED_SOURCE_ANCHOR="$TMP_ROOT/observed-source-anchor.json"
OBSERVED_FORWARD_EXECUTIONS="$TMP_ROOT/observed-forward-executions.json"

mkdir -p "$STAGE_DIR" "$TMP_ROOT/home"
STAGE_IDENTITY="$(directory_identity \
  "$STAGE_DIR" "$TMP_ROOT" '^staged$')" || fail 'staging directory identity is unsafe'
directory_matches \
  "$TMP_ROOT" "$TMP_PARENT" '^arena-baseline-replay-pg17\.[A-Za-z0-9]+$' \
  "$TMP_ROOT_IDENTITY" || fail 'temporary root changed after allocation'
directory_matches \
  "$SOCKET_ROOT" "$SYSTEM_TMP_ROOT" '^arena-baseline-pg17-socket\.[A-Za-z0-9]+$' \
  "$SOCKET_ROOT_IDENTITY" || fail 'socket root changed after allocation'

# Validate the full candidate contract, then re-read and hash every executable
# byte while copying it into the private staging directory. Later source-tree
# changes cannot affect this replay.
if ! STAGED_EXPECTATIONS_SHA256="$(
  env -u NODE_OPTIONS "$NODE_BIN" --input-type=module - \
  "$VALIDATOR" \
  "$REPO_ROOT" \
  "$CANDIDATES_ROOT" \
  "$CANDIDATE_DIR" \
  "$STAGE_DIR" \
  "$PLAN_FILE" \
  "$STAGED_EXPECTATIONS_FILE" <<'NODE'
import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const [validatorPath, repoRoot, candidatesRoot, candidateDir, stageDir, planFile, expectationsFile] =
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
copyVerified(
  result.replayPlan.sourceCatalog.absolutePath,
  `${stageDir}/source-catalog.json`,
  result.replayPlan.sourceCatalog.sha256,
  'source catalogue'
)
copyVerified(
  result.replayPlan.forwardManifest.absolutePath,
  `${stageDir}/forward-migrations.json`,
  result.replayPlan.forwardManifest.sha256,
  'forward manifest'
)
writeFileSync(
  `${stageDir}/platform-prerequisites.json`,
  `${JSON.stringify(result.replayPlan.platformPrerequisites)}\n`,
  { flag: 'wx', mode: 0o600 }
)
writeFileSync(
  `${stageDir}/source-anchor.tsv`,
  `${result.replayPlan.sourceCatalog.baselineThrough}\t${result.replayPlan.sourceCatalog.catalogSha256}\t${result.replayPlan.sourceCatalog.ledgerSha256}\n`,
  { flag: 'wx', mode: 0o600 }
)

const lines = []
for (const migration of result.replayPlan.forwardMigrations) {
  const destination = `${stageDir}/${migration.version}_${basename(migration.path)}`
  copyVerified(migration.absolutePath, destination, migration.sha256, migration.path)
  lines.push(`${migration.version}\t${destination}\t${migration.path}\t${migration.sha256}`)
}
writeFileSync(planFile, lines.length === 0 ? '' : `${lines.join('\n')}\n`, {
  flag: 'wx',
  mode: 0o600,
})
const platformPrerequisitesContents = `${JSON.stringify(result.replayPlan.platformPrerequisites)}\n`
const sourceAnchorContents = `${result.replayPlan.sourceCatalog.baselineThrough}\t${result.replayPlan.sourceCatalog.catalogSha256}\t${result.replayPlan.sourceCatalog.ledgerSha256}\n`
const planContents = lines.length === 0 ? '' : `${lines.join('\n')}\n`
const expectedFiles = [
  { path: `${stageDir}/foundation.sql`, sha256: result.replayPlan.foundation.sha256 },
  { path: `${stageDir}/app-schema.sql`, sha256: result.replayPlan.appSchema.sha256 },
  { path: `${stageDir}/source-catalog.json`, sha256: result.replayPlan.sourceCatalog.sha256 },
  {
    path: `${stageDir}/forward-migrations.json`,
    sha256: result.replayPlan.forwardManifest.sha256,
  },
  { path: `${stageDir}/platform-prerequisites.json`, sha256: createHash('sha256').update(platformPrerequisitesContents).digest('hex') },
  { path: `${stageDir}/source-anchor.tsv`, sha256: createHash('sha256').update(sourceAnchorContents).digest('hex') },
  ...result.replayPlan.forwardMigrations.map((migration) => ({
    path: `${stageDir}/${migration.version}_${basename(migration.path)}`,
    sha256: migration.sha256,
  })),
  { path: planFile, sha256: createHash('sha256').update(planContents).digest('hex') },
].sort((left, right) => left.path.localeCompare(right.path))
const expectationsContents = `${JSON.stringify({
  contract: 'arena.baseline-replay-staged-expectations@1',
  files: expectedFiles,
})}\n`
writeFileSync(expectationsFile, expectationsContents, { flag: 'wx', mode: 0o600 })
chmodSync(expectationsFile, 0o600)
process.stdout.write(createHash('sha256').update(expectationsContents).digest('hex'))
NODE
)"; then
  fail 'could not bind staged files to the validated candidate digests'
fi

if ! STAGED_STATE_SHA256="$(
  env -u NODE_OPTIONS "$NODE_BIN" --input-type=module - \
    "$TMP_ROOT" "$TMP_ROOT_IDENTITY" \
    "$SOCKET_ROOT" "$SOCKET_ROOT_IDENTITY" \
    "$STAGE_DIR" "$STAGE_IDENTITY" \
    "$PLAN_FILE" \
    "$STAGED_EXPECTATIONS_FILE" "$STAGED_EXPECTATIONS_SHA256" \
    "$STAGED_STATE_FILE" <<'NODE'
import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

const [
  root,
  expectedRootIdentity,
  socket,
  expectedSocketIdentity,
  stage,
  expectedStageIdentity,
  planFile,
  expectationsFile,
  expectedExpectationsSha256,
  stateFile,
] = process.argv.slice(2)
if (typeof process.geteuid !== 'function' || constants.O_NOFOLLOW === undefined) process.exit(1)
const effectiveUserId = process.geteuid()
const sha256 = (contents) => createHash('sha256').update(contents).digest('hex')
const directoryIdentity = (metadata) =>
  `${metadata.dev}:${metadata.ino}:${metadata.uid}:${metadata.mode}`
const fileFields = ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs']
const sameFields = (left, right) => fileFields.every((field) => left[field] === right[field])

function assertDirectory(directory, expectedIdentity, expectedParent) {
  const metadata = lstatSync(directory)
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    realpathSync(directory) !== directory ||
    realpathSync(path.dirname(directory)) !== realpathSync(expectedParent) ||
    metadata.uid !== effectiveUserId ||
    (metadata.mode & 0o777) !== 0o700 ||
    directoryIdentity(metadata) !== expectedIdentity
  ) {
    throw new Error('directory identity changed')
  }
  return Object.fromEntries(
    ['dev', 'ino', 'uid', 'gid', 'mode'].map((field) => [field, metadata[field]])
  )
}

function captureFile(file) {
  const pathMetadata = lstatSync(file)
  if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile()) {
    throw new Error('staged entry is not a regular file')
  }
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(descriptor)
    if (
      !before.isFile() ||
      before.dev !== pathMetadata.dev ||
      before.ino !== pathMetadata.ino ||
      before.uid !== effectiveUserId ||
      (before.mode & 0o077) !== 0 ||
      before.nlink !== 1
    ) {
      throw new Error('staged entry identity is unsafe')
    }
    const contents = readFileSync(descriptor)
    const after = fstatSync(descriptor)
    const finalPathMetadata = lstatSync(file)
    if (!sameFields(before, after) || !sameFields(after, finalPathMetadata)) {
      throw new Error('staged entry changed while attesting')
    }
    return {
      contents,
      record: {
        ...Object.fromEntries(fileFields.map((field) => [field, before[field]])),
        path: file,
        sha256: sha256(contents),
      },
    }
  } finally {
    closeSync(descriptor)
  }
}

const rootIdentity = assertDirectory(root, expectedRootIdentity, path.dirname(root))
const socketIdentity = assertDirectory(socket, expectedSocketIdentity, path.dirname(socket))
const stageIdentity = assertDirectory(stage, expectedStageIdentity, root)
const expectations = captureFile(expectationsFile)
if (sha256(expectations.contents) !== expectedExpectationsSha256) {
  throw new Error('staged expectations digest changed')
}
const expectedDocument = JSON.parse(expectations.contents.toString('utf8'))
if (
  expectedDocument?.contract !== 'arena.baseline-replay-staged-expectations@1' ||
  !Array.isArray(expectedDocument.files)
) {
  throw new Error('staged expectations contract changed')
}
const expectedDigests = new Map()
for (const entry of expectedDocument.files) {
  if (
    typeof entry?.path !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(entry?.sha256) ||
    expectedDigests.has(entry.path)
  ) {
    throw new Error('staged expectations entry is invalid')
  }
  expectedDigests.set(entry.path, entry.sha256)
}
const plan = captureFile(planFile)
const planText = plan.contents.toString('utf8')
if (/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(planText)) {
  throw new Error('forward plan contains control characters')
}
const forwardFiles = []
for (const line of planText.length === 0 ? [] : planText.trimEnd().split('\n')) {
  const fields = line.split('\t')
  if (fields.length !== 4) throw new Error('forward plan shape is invalid')
  const [version, migrationFile, migrationPath, migrationSha256] = fields
  if (
    !/^\d{14}$/u.test(version) ||
    !/^[a-f0-9]{64}$/u.test(migrationSha256) ||
    !migrationFile.startsWith(`${stage}${path.sep}`) ||
    path.dirname(migrationFile) !== stage ||
    !/^\d{14}_[0-9]{14}_[a-z0-9][a-z0-9_]*\.sql$/u.test(path.basename(migrationFile)) ||
    !/^supabase\/migrations\/\d{14}_[a-z0-9][a-z0-9_]*\.sql$/u.test(migrationPath)
  ) {
    throw new Error('forward plan entry is invalid')
  }
  forwardFiles.push({ migrationFile, migrationSha256 })
}
const expectedStageNames = [
  'app-schema.sql',
  'foundation.sql',
  'forward-migrations.json',
  'platform-prerequisites.json',
  'source-anchor.tsv',
  'source-catalog.json',
  ...forwardFiles.map(({ migrationFile }) => path.basename(migrationFile)),
].sort()
if (JSON.stringify(readdirSync(stage).sort()) !== JSON.stringify(expectedStageNames)) {
  throw new Error('staging directory contains unexpected entries')
}
const stagedFiles = expectedStageNames.map((name) => captureFile(path.join(stage, name)).record)
const candidateFiles = [...stagedFiles, plan.record]
if (candidateFiles.length !== expectedDigests.size) {
  throw new Error('staged expectations file set changed')
}
for (const record of candidateFiles) {
  if (expectedDigests.get(record.path) !== record.sha256) {
    throw new Error('staged file does not match its validated digest')
  }
}
const state = {
  contract: 'arena.baseline-replay-staged-state@1',
  files: [...candidateFiles, expectations.record].sort((left, right) =>
    left.path.localeCompare(right.path)
  ),
  root: { identity: rootIdentity, path: root },
  socket: { identity: socketIdentity, path: socket },
  stage: { identity: stageIdentity, path: stage },
}
const serialized = Buffer.from(`${JSON.stringify(state)}\n`, 'utf8')
const descriptor = openSync(
  stateFile,
  constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
  0o600
)
try {
  fchmodSync(descriptor, 0o600)
  writeFileSync(descriptor, serialized)
  fsyncSync(descriptor)
  const readback = Buffer.alloc(serialized.length)
  let offset = 0
  while (offset < readback.length) {
    const count = readSync(descriptor, readback, offset, readback.length - offset, offset)
    if (count === 0) throw new Error('staged state readback was truncated')
    offset += count
  }
  const metadata = fstatSync(descriptor)
  if (
    !metadata.isFile() ||
    metadata.uid !== effectiveUserId ||
    (metadata.mode & 0o777) !== 0o600 ||
    metadata.nlink !== 1 ||
    !readback.equals(serialized)
  ) {
    throw new Error('staged state publication failed')
  }
} finally {
  closeSync(descriptor)
}
process.stdout.write(sha256(serialized))
NODE
)"; then
  fail 'could not pin the staged replay state'
fi

verify_replay_state() {
  local selected_path="${1:-}"
  local selected_descriptor="${2:-}"

  if ! env -u NODE_OPTIONS "$NODE_BIN" --input-type=module - \
    "$TMP_ROOT" "$SOCKET_ROOT" "$STAGE_DIR" \
    "$STAGED_STATE_FILE" "$STAGED_STATE_SHA256" \
    "$selected_path" "$selected_descriptor" <<'NODE'
import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
} from 'node:fs'
import path from 'node:path'

const [root, socket, stage, stateFile, expectedStateSha256, selectedPath, selectedDescriptor] =
  process.argv.slice(2)
if (typeof process.geteuid !== 'function' || constants.O_NOFOLLOW === undefined) process.exit(1)
const effectiveUserId = process.geteuid()
const sha256 = (contents) => createHash('sha256').update(contents).digest('hex')
const directoryFields = ['dev', 'ino', 'uid', 'gid', 'mode']
const fileFields = ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs']
const sameFields = (left, right, fields) => fields.every((field) => left[field] === right[field])

function readDescriptor(descriptor, size) {
  const contents = Buffer.alloc(size)
  let offset = 0
  while (offset < size) {
    const count = readSync(descriptor, contents, offset, size - offset, offset)
    if (count === 0) throw new Error('pinned descriptor was truncated')
    offset += count
  }
  return contents
}

function readPinned(file) {
  const pathMetadata = lstatSync(file)
  if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile()) throw new Error('unsafe file')
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(descriptor)
    const contents = readFileSync(descriptor)
    const after = fstatSync(descriptor)
    const finalPathMetadata = lstatSync(file)
    if (!sameFields(before, after, fileFields) || !sameFields(after, finalPathMetadata, fileFields)) {
      throw new Error('file changed while reading')
    }
    return { contents, metadata: before }
  } finally {
    closeSync(descriptor)
  }
}

const stateRead = readPinned(stateFile)
if (
  stateRead.metadata.uid !== effectiveUserId ||
  (stateRead.metadata.mode & 0o777) !== 0o600 ||
  stateRead.metadata.nlink !== 1 ||
  sha256(stateRead.contents) !== expectedStateSha256
) {
  throw new Error('staged state identity changed')
}
const state = JSON.parse(stateRead.contents.toString('utf8'))
if (
  state?.contract !== 'arena.baseline-replay-staged-state@1' ||
  state.root?.path !== root ||
  state.socket?.path !== socket ||
  state.stage?.path !== stage ||
  !Array.isArray(state.files)
) {
  throw new Error('staged state contract changed')
}
for (const [directory, expected, expectedParent] of [
  [root, state.root.identity, path.dirname(root)],
  [socket, state.socket.identity, path.dirname(socket)],
  [stage, state.stage.identity, root],
]) {
  const metadata = lstatSync(directory)
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    realpathSync(directory) !== directory ||
    realpathSync(path.dirname(directory)) !== realpathSync(expectedParent) ||
    metadata.uid !== effectiveUserId ||
    (metadata.mode & 0o777) !== 0o700 ||
    !sameFields(metadata, expected, directoryFields)
  ) {
    throw new Error('replay directory identity changed')
  }
}
const expectedStageEntries = state.files
  .filter(({ path: file }) => path.dirname(file) === stage)
  .map(({ path: file }) => path.basename(file))
  .sort()
if (JSON.stringify(readdirSync(stage).sort()) !== JSON.stringify(expectedStageEntries)) {
  throw new Error('staging directory entries changed')
}
for (const expected of state.files) {
  const actual = readPinned(expected.path)
  if (
    actual.metadata.uid !== effectiveUserId ||
    (actual.metadata.mode & 0o077) !== 0 ||
    actual.metadata.nlink !== 1 ||
    !sameFields(actual.metadata, expected, fileFields) ||
    sha256(actual.contents) !== expected.sha256
  ) {
    throw new Error('staged replay file changed')
  }
}
if (selectedPath !== '' || selectedDescriptor !== '') {
  if (!/^\d+$/u.test(selectedDescriptor)) throw new Error('selected descriptor is invalid')
  const expected = state.files.find(({ path: file }) => file === selectedPath)
  if (expected === undefined) throw new Error('selected file is not attested')
  const descriptor = Number(selectedDescriptor)
  const metadata = fstatSync(descriptor)
  if (
    !metadata.isFile() ||
    !sameFields(metadata, expected, fileFields) ||
    sha256(readDescriptor(descriptor, metadata.size)) !== expected.sha256
  ) {
    throw new Error('selected descriptor does not match the attested file')
  }
}
NODE
  then
    echo 'BASELINE REPLAY REFUSED: staged replay state changed or became unsafe' >&2
    return 1
  fi
}

verify_replay_state

# Prevent psql from reading host credentials even if a future invocation loses
# -w. The files do not exist, and HOME/XDG_CONFIG_HOME are private to this run.
export HOME="$TMP_ROOT/home"
export XDG_CONFIG_HOME="$TMP_ROOT/home"
export PGPASSFILE="$TMP_ROOT/home/.pgpass"
export PGSERVICEFILE="$TMP_ROOT/home/.pg_service.conf"
export PSQL_PAGER=''

run_with_replay_state() {
  local command_status=0
  local verification_status=0

  verify_replay_state || return 1
  "$@" || command_status=$?
  verify_replay_state || verification_status=$?
  if [[ "$verification_status" != '0' ]]; then return "$verification_status"; fi
  return "$command_status"
}

execute_staged_sql() {
  local phase="$1"
  local sql_file="$2"
  local command_status=0
  local verification_status=0
  shift 2

  exec 9<"$sql_file" || fail "could not pin staged SQL for $phase"
  if ! verify_replay_state "$sql_file" 9; then
    exec 9<&-
    return 1
  fi
  echo "BASELINE REPLAY: $phase $(basename "$sql_file")"
  ARENA_BASELINE_STAGED_SQL="$sql_file" "$PSQL" \
    -h "$SOCKET_ROOT" \
    -p 5432 \
    -U postgres \
    -d postgres \
    -X \
    -w \
    -P pager=off \
    -v ON_ERROR_STOP=1 \
    --single-transaction \
    -f /dev/fd/9 \
    "$@" || command_status=$?
  verify_replay_state "$sql_file" 9 || verification_status=$?
  exec 9<&-
  if [[ "$verification_status" != '0' ]]; then return "$verification_status"; fi
  return "$command_status"
}

run_with_replay_state "$INITDB" -D "$DATA_DIR" -U postgres --auth=trust --no-locale \
  --encoding=UTF8 >/dev/null
SERVER_START_ATTEMPTED=1
if ! run_with_replay_state "$PG_CTL" -D "$DATA_DIR" -l "$SERVER_LOG" \
  -p "$POSTGRES" \
  -o "-F -k '$SOCKET_ROOT' -p 5432 -c listen_addresses=''" \
  -w start >/dev/null; then
  fail 'PostgreSQL failed to start'
fi
SERVER_STARTED=1

apply_sql_file() {
  local phase="$1"
  local sql_file="$2"

  execute_staged_sql "$phase" "$sql_file"
}

capture_platform_catalog() {
  local destination="$1"

  run_with_replay_state "$PSQL" \
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

run_with_replay_state env -u NODE_OPTIONS "$NODE_BIN" --input-type=module - \
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

exec 8<"$SOURCE_ANCHOR_FILE" || fail 'could not pin the validated source anchor'
verify_replay_state "$SOURCE_ANCHOR_FILE" 8
IFS=$'\t' read -r SOURCE_BASELINE_THROUGH SOURCE_CATALOG_SHA256 SOURCE_LEDGER_SHA256 <&8
verify_replay_state "$SOURCE_ANCHOR_FILE" 8
exec 8<&-
[[ "$SOURCE_BASELINE_THROUGH" =~ ^[0-9]{14}$ ]] || \
  fail 'validated source anchor contains an invalid baseline version'
[[ "$SOURCE_CATALOG_SHA256" =~ ^[a-f0-9]{64}$ && \
  "$SOURCE_LEDGER_SHA256" =~ ^[a-f0-9]{64}$ ]] || \
  fail 'validated source anchor contains an invalid digest'

# This schema is owned by the disposable harness and is intentionally outside
# the captured application schemas. It binds the source witness digests to this
# exact local target and records each forward migration in the same transaction
# as its SQL file. It is neither Supabase's managed ledger nor promotion proof.
run_with_replay_state "$PSQL" \
  -h "$SOCKET_ROOT" \
  -p 5432 \
  -U postgres \
  -d postgres \
  -X \
  -w \
  -P pager=off \
  -v ON_ERROR_STOP=1 \
  --single-transaction \
  -c "CREATE SCHEMA $WITNESS_SCHEMA;
CREATE TABLE $WITNESS_SCHEMA.source_anchor (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  baseline_through text NOT NULL,
  catalog_sha256 text NOT NULL,
  ledger_sha256 text NOT NULL
);
CREATE TABLE $WITNESS_SCHEMA.forward_executions (
  ordinal bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version text NOT NULL UNIQUE,
  path text NOT NULL UNIQUE,
  sha256 text NOT NULL
);
INSERT INTO $WITNESS_SCHEMA.source_anchor
  (baseline_through, catalog_sha256, ledger_sha256)
VALUES
  ('$SOURCE_BASELINE_THROUGH', '$SOURCE_CATALOG_SHA256', '$SOURCE_LEDGER_SHA256');"

run_with_replay_state env -u NODE_OPTIONS "$NODE_BIN" "$TARGET_CATALOG_CAPTURE" \
  --psql "$PSQL" \
  --socket "$SOCKET_ROOT" \
  --output "$BASELINE_TARGET_CATALOG"

exec 8<"$PLAN_FILE" || fail 'could not pin the validated forward execution plan'
verify_replay_state "$PLAN_FILE" 8
while IFS=$'\t' read -r version migration_file migration_path migration_sha256 <&8; do
  [[ -n "$version" && -n "$migration_file" && -n "$migration_path" && \
    -n "$migration_sha256" ]] || \
    fail 'validated forward execution plan contains an empty field'
  execute_staged_sql "forward:$version" "$migration_file" \
    -c "INSERT INTO $WITNESS_SCHEMA.forward_executions
      (version, path, sha256)
      VALUES ('$version', '$migration_path', '$migration_sha256');"
done
verify_replay_state "$PLAN_FILE" 8
exec 8<&-

run_with_replay_state env -u NODE_OPTIONS "$NODE_BIN" "$TARGET_CATALOG_CAPTURE" \
  --psql "$PSQL" \
  --socket "$SOCKET_ROOT" \
  --output "$FINAL_TARGET_CATALOG"

run_with_replay_state "$PSQL" \
  -h "$SOCKET_ROOT" \
  -p 5432 \
  -U postgres \
  -d postgres \
  -X \
  -w \
  -P pager=off \
  -v ON_ERROR_STOP=1 \
  -At \
  -c "/* arena_baseline_source_anchor_witness */
SELECT pg_catalog.json_build_object(
  'baselineThrough', baseline_through,
  'catalogSha256', catalog_sha256,
  'ledgerSha256', ledger_sha256
)
FROM $WITNESS_SCHEMA.source_anchor;" \
  >"$OBSERVED_SOURCE_ANCHOR"

run_with_replay_state "$PSQL" \
  -h "$SOCKET_ROOT" \
  -p 5432 \
  -U postgres \
  -d postgres \
  -X \
  -w \
  -P pager=off \
  -v ON_ERROR_STOP=1 \
  -At \
  -c "/* arena_baseline_forward_execution_witness */
SELECT COALESCE(
  pg_catalog.json_agg(
    pg_catalog.json_build_object(
      'path', path,
      'sha256', sha256,
      'version', version
    ) ORDER BY ordinal
  ),
  '[]'::json
)
FROM $WITNESS_SCHEMA.forward_executions;" \
  >"$OBSERVED_FORWARD_EXECUTIONS"

run_with_replay_state env -u NODE_OPTIONS "$NODE_BIN" --input-type=module - \
  "$WITNESS_COMPARATOR" \
  "$STAGED_SOURCE_CATALOG" \
  "$STAGED_FORWARD_MANIFEST" \
  "$BASELINE_TARGET_CATALOG" \
  "$FINAL_TARGET_CATALOG" \
  "$OBSERVED_SOURCE_ANCHOR" \
  "$OBSERVED_FORWARD_EXECUTIONS" <<'NODE'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const [
  comparatorPath,
  sourceCatalogPath,
  forwardManifestPath,
  baselineCatalogPath,
  finalCatalogPath,
  sourceAnchorPath,
  forwardExecutionsPath,
] = process.argv.slice(2)
const {
  BASELINE_REPLAY_TARGET_WITNESS_CONTRACT,
  BASELINE_REPLAY_WITNESS_STATUS,
  compareBaselineReplayWitness,
} = await import(pathToFileURL(comparatorPath).href)
const parse = (file) => JSON.parse(readFileSync(file, 'utf8'))
const sourceCatalog = parse(sourceCatalogPath)
const forwardManifest = parse(forwardManifestPath)
const targetWitness = {
  baselineCatalog: parse(baselineCatalogPath),
  contract: BASELINE_REPLAY_TARGET_WITNESS_CONTRACT,
  finalCatalog: parse(finalCatalogPath),
  forwardExecutions: parse(forwardExecutionsPath),
  postgresMajor: 17,
  source: parse(sourceAnchorPath),
  status: BASELINE_REPLAY_WITNESS_STATUS,
}
const result = compareBaselineReplayWitness({
  forwardManifest,
  sourceCatalog,
  targetWitness,
})
process.stdout.write(`BASELINE REPLAY WITNESS: ${JSON.stringify(result)}\n`)
NODE

echo 'BASELINE REPLAY: disposable PostgreSQL 17 dependency witness passed (not promotion evidence)'
