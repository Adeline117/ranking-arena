#!/usr/bin/env bash
# Transactional deployment for the Mac Mini ingest worker.
#
# This script never deploys from the caller's dirty worktree. It materializes an
# exact current-main commit, gives that release its own Node 22 dependencies and
# Playwright browser, proves the production database gate while the old worker
# remains online, then changes PM2 cwd. Any post-stop failure restores the exact
# previous cwd and requires fresh rollback evidence.
#
# Usage:
#   ARENA_NODE_BIN=/absolute/path/to/node22 \
#     bash worker/deploy-ingest-local.sh --target-sha=<40hex> --dry-run
#   ARENA_NODE_BIN=/absolute/path/to/node22 \
#     bash worker/deploy-ingest-local.sh --target-sha=<40hex>
#   ARENA_NODE_BIN=/absolute/path/to/node22 \
#     bash worker/deploy-ingest-local.sh --target-sha=<40hex> --recover-from-stopped

set -Eeuo pipefail
umask 077

SCRIPT_SOURCE_DIR="$(cd "$(dirname "$0")" && pwd -P)"
REPO_DIR="$(cd "$SCRIPT_SOURCE_DIR/.." && pwd -P)"
SCRIPT_PATH="$REPO_DIR/worker/deploy-ingest-local.sh"
INVOKED_SCRIPT="$SCRIPT_SOURCE_DIR/$(basename "$0")"
[ "$INVOKED_SCRIPT" = "$SCRIPT_PATH" ] || {
  echo '✗ local deploy must run from its canonical repository path' >&2
  exit 1
}
[ -f "$SCRIPT_PATH" ] && [ ! -L "$SCRIPT_PATH" ] || {
  echo '✗ local deploy orchestrator must be a real file' >&2
  exit 1
}
cd "$REPO_DIR"

PM2_APP='arena-ingest-worker'
# Allow the previous PM2 owner to exit (30s), its ownership lease to expire
# (180s), and one renewal/jitter interval (30s), with an additional 60s margin.
AUTHORITY_HANDOFF_TIMEOUT_SECONDS=300
TARGET_SHA=''
DRY_RUN=0
RECOVER_FROM_STOPPED=0

for arg in "$@"; do
  case "$arg" in
    --target-sha=*) TARGET_SHA="${arg#*=}" ;;
    --dry-run) DRY_RUN=1 ;;
    --recover-from-stopped) RECOVER_FROM_STOPPED=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if [ "$DRY_RUN" = 1 ] && [ "$RECOVER_FROM_STOPPED" = 1 ]; then
  echo '✗ --dry-run and --recover-from-stopped are mutually exclusive' >&2
  exit 2
fi

if [[ ! "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo '✗ --target-sha must be exactly 40 lowercase hexadecimal characters' >&2
  exit 2
fi

fail() {
  echo "✗ $*" >&2
  exit 1
}

require_absolute_path() {
  local value="$1" label="$2"
  case "$value" in
    /*) ;;
    *) fail "$label must be an absolute path" ;;
  esac
}

canonical_directory() {
  local value="$1" label="$2"
  require_absolute_path "$value" "$label"
  [ -d "$value" ] || fail "$label is not a directory: $value"
  [ ! -L "$value" ] || fail "$label must not be a symlink: $value"
  (cd "$value" && pwd -P)
}

canonical_executable() {
  local value="$1" label="$2" parent
  require_absolute_path "$value" "$label"
  [ -f "$value" ] || fail "$label is not a file: $value"
  [ -x "$value" ] || fail "$label is not executable: $value"
  [ ! -L "$value" ] || fail "$label must name the real executable, not a symlink"
  parent="$(cd "$(dirname "$value")" && pwd -P)"
  printf '%s/%s\n' "$parent" "$(basename "$value")"
}

GIT_INPUT="${ARENA_GIT_BIN:-/usr/bin/git}"
GIT_BIN="$(canonical_executable "$GIT_INPUT" 'ARENA_GIT_BIN')"
[ "$(basename "$GIT_BIN")" = git ] || fail 'ARENA_GIT_BIN must name an executable called git'
GIT_SAFE_PATH="$(dirname "$GIT_BIN"):/usr/bin:/bin"

git_command() {
  env -i \
    HOME="$HOME" PATH="$GIT_SAFE_PATH" LC_ALL=C \
    SSH_AUTH_SOCK="${SSH_AUTH_SOCK:-}" \
    GIT_ATTR_NOSYSTEM=1 GIT_CONFIG_NOSYSTEM=1 \
    GIT_CONFIG_GLOBAL=/dev/null GIT_NO_REPLACE_OBJECTS=1 GIT_OPTIONAL_LOCKS=0 \
    "$GIT_BIN" -C "$REPO_DIR" "$@"
}

portable_mode() {
  if stat -f '%Lp' "$1" >/dev/null 2>&1; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}

require_exact_main() {
  local main_sha
  git_command fetch --force --no-tags origin refs/heads/main:refs/remotes/origin/main --quiet
  main_sha="$(git_command rev-parse --verify origin/main^{commit})"
  [ "$SHA" = "$main_sha" ] || {
    echo "✗ target $SHA is not exact origin/main $main_sha" >&2
    return 1
  }
}

[ "$(git_command rev-parse --show-toplevel)" = "$REPO_DIR" ] || \
  fail 'local deploy repository path is not the exact Git worktree root'
[ "$(git_command remote get-url origin)" = 'git@github.com:Adeline117/ranking-arena.git' ] || \
  fail 'origin does not identify the authorized ranking-arena repository'
GIT_COMMON_INPUT="$(git_command rev-parse --git-common-dir)" || fail 'unable to resolve Git metadata'
case "$GIT_COMMON_INPUT" in
  /*) ;;
  *) GIT_COMMON_INPUT="$REPO_DIR/$GIT_COMMON_INPUT" ;;
esac
GIT_COMMON_DIR="$(canonical_directory "$GIT_COMMON_INPUT" 'Git common directory')"
GIT_OBJECT_DIR="$(canonical_directory "$GIT_COMMON_DIR/objects" 'Git object directory')"
if [ -e "$GIT_OBJECT_DIR/info/alternates" ] || [ -L "$GIT_OBJECT_DIR/info/alternates" ]; then
  fail 'Git alternate object stores are unsupported for exact local releases'
fi

NODE_INPUT="${ARENA_NODE_BIN:-}"
[ -n "$NODE_INPUT" ] || fail 'ARENA_NODE_BIN must explicitly name a Node 22 arm64 executable'
NODE_BIN="$(canonical_executable "$NODE_INPUT" 'ARENA_NODE_BIN')"
NODE_RUNTIME="$("$NODE_BIN" -p "process.versions.node.split('.')[0] + ' ' + process.arch + ' ' + process.platform")" || \
  fail 'unable to inspect ARENA_NODE_BIN'
[ "$NODE_RUNTIME" = '22 arm64 darwin' ] || \
  fail "local deploy requires Node 22 arm64 darwin, got ${NODE_RUNTIME:-unknown}"

NODE_PREFIX="$(cd "$(dirname "$NODE_BIN")/.." && pwd -P)"
NPM_CLI_INPUT="${ARENA_NPM_CLI:-$NODE_PREFIX/lib/node_modules/npm/bin/npm-cli.js}"
require_absolute_path "$NPM_CLI_INPUT" 'ARENA_NPM_CLI'
[ -f "$NPM_CLI_INPUT" ] || fail "Node 22 npm CLI is unavailable: $NPM_CLI_INPUT"
NPM_CLI="$(cd "$(dirname "$NPM_CLI_INPUT")" && pwd -P)/$(basename "$NPM_CLI_INPUT")"

PM2_BIN="${ARENA_PM2_BIN:-/opt/homebrew/bin/pm2}"
require_absolute_path "$PM2_BIN" 'ARENA_PM2_BIN'
[ -x "$PM2_BIN" ] || fail "PM2 executable is unavailable: $PM2_BIN"

RELEASE_ROOT="$(canonical_directory "${ARENA_LOCAL_RELEASE_ROOT:-$HOME/ranking-arena-releases}" 'release root')"
SHARED_DIR="$(canonical_directory "${ARENA_LOCAL_SHARED_DIR:-$HOME/ranking-arena}" 'shared runtime root')"
LOCK_INPUT="${ARENA_LOCAL_LOCK_DIR:-$RELEASE_ROOT/.arena-ingest-deploy-lock}"
require_absolute_path "$LOCK_INPUT" 'local deploy lock'
LOCK_PARENT="$(canonical_directory "$(dirname "$LOCK_INPUT")" 'local deploy lock parent')"
LOCK_DIR="$LOCK_PARENT/$(basename "$LOCK_INPUT")"
case "$LOCK_DIR" in
  "$RELEASE_ROOT"/.arena-ingest-deploy-lock*) ;;
  *) fail 'local deploy lock must stay under the release root' ;;
esac

SHARED_STATE_DIR="$SHARED_DIR/.arena-ingest"
SHARED_WORKER_DIR="$SHARED_DIR/worker"
SHARED_LOG_DIR="$SHARED_DIR/worker/logs"
SHARED_ENV_FILE="$SHARED_DIR/worker/.env"
[ -d "$SHARED_STATE_DIR" ] && [ ! -L "$SHARED_STATE_DIR" ] || \
  fail 'shared .arena-ingest must be a real directory'
[ "$(canonical_directory "$SHARED_STATE_DIR" 'shared .arena-ingest')" = "$SHARED_STATE_DIR" ] || \
  fail 'shared .arena-ingest must already be canonical'

# This host-owned marker is intentionally outside every immutable release. An
# incident operator can arm it without changing Git or PM2; mutating deploys
# then fail closed even when an otherwise valid current-main release is used.
# Removal is an explicit owner operation after the incident release gate is
# satisfied. Dry-runs remain available for read-only comparison.
INCIDENT_HOLD_FILE="$SHARED_STATE_DIR/ingest-deploy.hold"
RECOVERY_GO_FILE="$SHARED_STATE_DIR/recover-from-stopped.go"
assert_no_incident_hold() {
  if [ -e "$INCIDENT_HOLD_FILE" ] || [ -L "$INCIDENT_HOLD_FILE" ]; then
    fail "local ingest deploy is blocked by incident hold: $INCIDENT_HOLD_FILE"
  fi
}
if [ "$DRY_RUN" = 0 ] && [ "$RECOVER_FROM_STOPPED" = 0 ]; then
  assert_no_incident_hold
fi

[ -d "$SHARED_WORKER_DIR" ] && [ ! -L "$SHARED_WORKER_DIR" ] || \
  fail 'shared worker must be a real directory'
[ "$(canonical_directory "$SHARED_WORKER_DIR" 'shared worker')" = "$SHARED_WORKER_DIR" ] || \
  fail 'shared worker directory must already be canonical'
[ -d "$SHARED_LOG_DIR" ] && [ ! -L "$SHARED_LOG_DIR" ] || \
  fail 'shared worker/logs must be a real directory'
[ "$(canonical_directory "$SHARED_LOG_DIR" 'shared worker/logs')" = "$SHARED_LOG_DIR" ] || \
  fail 'shared worker/logs must already be canonical'
[ -f "$SHARED_ENV_FILE" ] && [ ! -L "$SHARED_ENV_FILE" ] || \
  fail 'shared worker/.env must be a real file'
[ "$(portable_mode "$SHARED_ENV_FILE")" = 600 ] || \
  fail 'shared worker/.env must have mode 0600'

hash_shared_env() {
  [ -f "$SHARED_ENV_FILE" ] && [ ! -L "$SHARED_ENV_FILE" ] || return 1
  [ "$(portable_mode "$SHARED_ENV_FILE")" = 600 ] || return 1
  "$NODE_BIN" -e '
    const fs = require("node:fs")
    const crypto = require("node:crypto")
    const path = process.argv[1]
    const metadata = fs.lstatSync(path)
    if (!metadata.isFile() || metadata.isSymbolicLink()) process.exit(47)
    process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex"))
  ' "$SHARED_ENV_FILE"
}

SHARED_ENV_SHA256="$(hash_shared_env)" || fail 'unable to bind the shared worker environment'
[[ "$SHARED_ENV_SHA256" =~ ^[0-9a-f]{64}$ ]] || fail 'shared worker environment digest is malformed'

SHA="$(git_command rev-parse --verify --quiet --end-of-options "${TARGET_SHA}^{commit}")" || \
  fail 'target SHA does not resolve to a commit'
[ "$SHA" = "$TARGET_SHA" ] || fail 'target must resolve to the exact supplied full SHA'
require_exact_main

SCRIPT_TREE_ENTRY="$(git_command ls-tree "$SHA" -- worker/deploy-ingest-local.sh)" || \
  fail 'unable to inspect the committed local deploy orchestrator'
read -r TARGET_SCRIPT_MODE TARGET_SCRIPT_TYPE TARGET_SCRIPT_BLOB TARGET_SCRIPT_PATH \
  <<<"$SCRIPT_TREE_ENTRY"
[ "$TARGET_SCRIPT_MODE" = 100755 ] && [ "$TARGET_SCRIPT_TYPE" = blob ] && \
  [ "$TARGET_SCRIPT_PATH" = worker/deploy-ingest-local.sh ] || \
  fail 'target local deploy orchestrator must be one executable Git blob'
CURRENT_SCRIPT_BLOB="$(git_command hash-object --no-filters "$SCRIPT_PATH")" || \
  fail 'unable to hash the running local deploy orchestrator'
[ "$CURRENT_SCRIPT_BLOB" = "$TARGET_SCRIPT_BLOB" ] || \
  fail 'running local deploy orchestrator does not exactly match target main'

RELEASE_TREE_PATHS="$(git_command ls-tree -r --name-only "$SHA")" || \
  fail 'unable to inspect target release paths'
if grep -Eq '(^|/)\.gitattributes$' <<<"$RELEASE_TREE_PATHS"; then
  fail 'worker release contains .gitattributes; exact archive bytes are not proven'
fi
RELEASE_INPUT_TREE="$(git_command ls-tree -r "$SHA" -- \
  .npmrc lib worker package.json package-lock.json tsconfig.json \
  scripts/ci/worker-release-id.mjs)" || fail 'unable to inspect worker release input modes'
if awk '$1 != "100644" && $1 != "100755" { unsupported = 1 } END { exit !unsupported }' \
  <<<"$RELEASE_INPUT_TREE"; then
  fail 'worker release inputs must contain only regular committed files'
fi

archive_worker_release() {
  local destination isolated_git
  destination="$1"
  isolated_git="$destination/.arena-isolated-git"
  mkdir "$isolated_git" || return 1
  env -i HOME="$HOME" PATH="$GIT_SAFE_PATH" LC_ALL=C \
    GIT_ATTR_NOSYSTEM=1 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    "$GIT_BIN" init --bare --quiet "$isolated_git" || return 1
  if ! env -i \
    HOME="$HOME" PATH="$GIT_SAFE_PATH" LC_ALL=C \
    GIT_DIR="$isolated_git" GIT_OBJECT_DIRECTORY="$GIT_OBJECT_DIR" \
    GIT_ATTR_NOSYSTEM=1 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null \
    GIT_NO_REPLACE_OBJECTS=1 GIT_OPTIONAL_LOCKS=0 \
    "$GIT_BIN" archive "$SHA" -- \
      .npmrc lib worker package.json package-lock.json tsconfig.json \
      scripts/ci/worker-release-id.mjs \
      | /usr/bin/tar -xf - -C "$destination"; then
    rm -rf "$isolated_git"
    return 1
  fi
  rm -rf "$isolated_git"
}

compute_worker_release_id() {
  local helper="$1"
  env -i \
    HOME="$HOME" PATH="$GIT_SAFE_PATH" LC_ALL=C \
    GIT_ATTR_NOSYSTEM=1 GIT_CONFIG_NOSYSTEM=1 \
    GIT_CONFIG_GLOBAL=/dev/null GIT_NO_REPLACE_OBJECTS=1 GIT_OPTIONAL_LOCKS=0 \
    "$NODE_BIN" "$helper" "$SHA"
}

DEPLOY_USER="${USER:-$(id -un)}"
DEPLOY_LOGNAME="${LOGNAME:-$DEPLOY_USER}"
PM2_HOME_VALUE="$(canonical_directory "${ARENA_PM2_HOME:-$HOME/.pm2}" 'PM2 home')"
PM2_PATH="$(dirname "$NODE_BIN"):$(dirname "$PM2_BIN"):/opt/homebrew/bin:/usr/bin:/bin"

pm2_command() {
  env -i \
    HOME="$HOME" USER="$DEPLOY_USER" LOGNAME="$DEPLOY_LOGNAME" \
    PM2_HOME="$PM2_HOME_VALUE" PATH="$PM2_PATH" \
    "$PM2_BIN" "$@"
}

pm2_snapshot() {
  pm2_command jlist | "$NODE_BIN" -e '
    const appName = process.argv[1]
    let raw = ""
    process.stdin.on("data", (chunk) => { raw += chunk })
    process.stdin.on("end", () => {
      const apps = JSON.parse(raw).filter((app) => app.name === appName)
      if (apps.length !== 1) process.exit(41)
      const app = apps[0]
      const values = [
        app.pid,
        app.pm2_env?.status,
        app.pm2_env?.pm_cwd,
        app.pm2_env?.exec_interpreter,
        app.pm2_env?.pm_exec_path,
        app.pm2_env?.restart_time,
        JSON.stringify(app.pm2_env?.args ?? []),
        JSON.stringify(app.pm2_env?.node_args ?? []),
        app.pm2_env?.exec_mode,
        app.pm2_env?.instances,
      ]
      if (values.some((value) => String(value ?? "").match(/[\n\r\x1f]/))) process.exit(42)
      process.stdout.write(values.map((value) => String(value ?? "")).join("\x1f") + "\n")
    })
  ' "$PM2_APP"
}

pm2_referenced_cwds() {
  pm2_command jlist | "$NODE_BIN" -e '
    let raw = ""
    process.stdin.on("data", (chunk) => { raw += chunk })
    process.stdin.on("end", () => {
      const values = [...new Set(JSON.parse(raw).map((app) => app.pm2_env?.pm_cwd).filter(Boolean))]
      if (values.some((value) => typeof value !== "string" || value.match(/[\n\r]/))) process.exit(43)
      process.stdout.write(values.join("\n") + (values.length ? "\n" : ""))
    })
  '
}

BASELINE_SNAPSHOT="$(pm2_snapshot)" || fail "PM2 must contain exactly one $PM2_APP process"
IFS=$'\x1f' read -r OLD_PID OLD_STATUS OLD_CWD OLD_INTERPRETER OLD_EXEC_PATH OLD_RESTARTS \
  OLD_ARGS_JSON OLD_NODE_ARGS_JSON OLD_EXEC_MODE OLD_INSTANCES <<<"$BASELINE_SNAPSHOT"
if [ "$RECOVER_FROM_STOPPED" = 1 ]; then
  [ "$OLD_STATUS" = stopped ] && [ "$OLD_PID" = 0 ] || \
    fail "--recover-from-stopped requires exactly one stopped $PM2_APP baseline"
elif [ "$DRY_RUN" = 1 ] && [ "$OLD_STATUS" = stopped ] && [ "$OLD_PID" = 0 ]; then
  : # A stopped incident baseline is valid for a read-only release preview.
else
  [ "$OLD_STATUS" = online ] || fail "$PM2_APP must be online before deployment"
  [[ "$OLD_PID" =~ ^[1-9][0-9]*$ ]] || fail 'existing PM2 pid is malformed'
fi
require_absolute_path "$OLD_CWD" 'existing PM2 cwd'
require_absolute_path "$OLD_INTERPRETER" 'existing PM2 interpreter'
require_absolute_path "$OLD_EXEC_PATH" 'existing PM2 executable'
[ -d "$OLD_CWD" ] && [ ! -L "$OLD_CWD" ] || fail 'existing PM2 cwd is unsafe'
[ "$(canonical_directory "$OLD_CWD" 'existing PM2 cwd')" = "$OLD_CWD" ] || \
  fail 'existing PM2 cwd must already be canonical'
[ -x "$OLD_INTERPRETER" ] || fail 'existing PM2 interpreter is unavailable for rollback'
[[ "$OLD_RESTARTS" =~ ^[0-9]+$ ]] || fail 'existing PM2 restart count is malformed'
[ -n "$OLD_ARGS_JSON" ] || fail 'existing PM2 argument list is unavailable'
[ -n "$OLD_NODE_ARGS_JSON" ] || fail 'existing PM2 Node argument list is unavailable'
[ -n "$OLD_EXEC_MODE" ] || fail 'existing PM2 execution mode is unavailable'
[[ "$OLD_INSTANCES" =~ ^[1-9][0-9]*$ ]] || fail 'existing PM2 instance count is malformed'
case "$OLD_CWD/" in
  "$RELEASE_ROOT"/*) ;;
  *) fail 'existing PM2 cwd is outside the managed release root' ;;
esac

OLD_SHA="$(sed -n '1p' "$OLD_CWD/DEPLOYED_SHA" 2>/dev/null || true)"
OLD_RELEASE_ID="$(sed -n '1p' "$OLD_CWD/WORKER_RELEASE_ID" 2>/dev/null || true)"
if [[ ! "$OLD_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  OLD_SHA="$(git_command -C "$OLD_CWD" rev-parse --verify HEAD^{commit})" || \
    fail 'existing legacy release has no provable Git identity'
fi
[[ "$OLD_SHA" =~ ^[0-9a-f]{40}$ ]] || fail 'existing release SHA is malformed'
if [[ ! "$OLD_RELEASE_ID" =~ ^[0-9a-f]{64}$ ]]; then
  OLD_RELEASE_ID=''
fi
if [ -n "$OLD_RELEASE_ID" ]; then
  [ -f "$OLD_EXEC_PATH" ] && [ ! -L "$OLD_EXEC_PATH" ] || \
    fail 'existing stamped PM2 entrypoint must be a real file'
  [ "$(cd "$(dirname "$OLD_EXEC_PATH")" && pwd -P)/$(basename "$OLD_EXEC_PATH")" = \
    "$OLD_EXEC_PATH" ] || fail 'existing stamped PM2 entrypoint must already be canonical'
  case "$OLD_EXEC_PATH" in
    "$OLD_CWD"/*) ;;
    *) fail 'existing stamped PM2 entrypoint is outside its release' ;;
  esac
else
  [ -x "$OLD_EXEC_PATH" ] || fail 'existing legacy PM2 executable is unavailable for rollback'
fi
OLD_ROSTER_RELEASE_ID="${OLD_RELEASE_ID:-unknown}"

if [ "$DRY_RUN" = 1 ]; then
  DRY_SOURCE="$(mktemp -d "${TMPDIR:-/tmp}/arena-local-dry-run.XXXXXX")"
  trap 'rm -rf "$DRY_SOURCE"' EXIT
  archive_worker_release "$DRY_SOURCE"
  WORKER_RELEASE_ID="$(compute_worker_release_id "$DRY_SOURCE/scripts/ci/worker-release-id.mjs")" || \
    fail 'archived worker release identity helper failed'
  [[ "$WORKER_RELEASE_ID" =~ ^[0-9a-f]{64}$ ]] || \
    fail 'archived worker release helper returned a malformed identity'
  printf 'DRY RUN: local ingest transaction\n'
  printf '  target_sha=%s\n  worker_release_id=%s\n  node=%s\n' \
    "$SHA" "$WORKER_RELEASE_ID" "$NODE_BIN"
  printf '  current_cwd=%s\n  release_root=%s\n' "$OLD_CWD" "$RELEASE_ROOT"
  printf '  no files, dependencies, PM2 state, or production process were changed\n'
  rm -rf "$DRY_SOURCE"
  trap - EXIT
  exit 0
fi

TS="$(date -u +%Y%m%dT%H%M%SZ)"
LOCK_TOKEN="${SHA}-${TS}-$$-${RANDOM}"
STAGING_DIR="$RELEASE_ROOT/.staging-$LOCK_TOKEN"
RELEASE_DIR=''
WORKER_RELEASE_ID=''
NEW_PID=''
NEW_PROCESS_TREE=''
OLD_PROCESS_TREE=''
LOCK_HELD=0
RECOVERY_REQUIRED=0
DEPLOY_SUCCEEDED=0
ROLLBACK_SUCCEEDED=0
RECOVERY_JOURNAL_WRITTEN=0
STOPPED_RECOVERY_SESSION=0
STOPPED_RECOVERY_CUTOVER=0
STOPPED_RECOVERY_QUARANTINED=0
RECOVERY_BLOCK_FILE="$RELEASE_ROOT/.arena-ingest-deploy-blocked"
RECOVERY_GO_CONSUMED="$LOCK_DIR/recover-from-stopped.go"

assert_no_recovery_block() {
  if [ -e "$RECOVERY_BLOCK_FILE" ] || [ -L "$RECOVERY_BLOCK_FILE" ]; then
    fail "local deploy is blocked pending supervised recovery: $RECOVERY_BLOCK_FILE"
  fi
}

if [ "$RECOVER_FROM_STOPPED" = 0 ]; then
  assert_no_recovery_block
fi

assert_local_lock() {
  [ -f "$LOCK_DIR/owner" ] && [ "$(sed -n '1p' "$LOCK_DIR/owner")" = "$LOCK_TOKEN" ] || {
    echo '✗ lost the local deploy lock; refusing further mutation' >&2
    return 1
  }
}

acquire_local_lock() {
  local old_pid stale_dir
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    [ ! -L "$LOCK_DIR" ] || fail 'local deploy lock path is a symlink'
    old_pid="$(sed -n '2p' "$LOCK_DIR/owner" 2>/dev/null || true)"
    if [[ "$old_pid" =~ ^[1-9][0-9]*$ ]] && kill -0 "$old_pid" 2>/dev/null; then
      fail "BUSY: local ingest deploy lock is held by pid $old_pid"
    fi
    stale_dir="$LOCK_DIR.stale-$LOCK_TOKEN"
    mv "$LOCK_DIR" "$stale_dir" 2>/dev/null || fail 'local deploy lock contention'
    rm -rf "$stale_dir"
    mkdir "$LOCK_DIR" || fail 'unable to replace stale local deploy lock'
  fi
  printf '%s\n%s\n' "$LOCK_TOKEN" "$$" > "$LOCK_DIR/owner.tmp"
  mv "$LOCK_DIR/owner.tmp" "$LOCK_DIR/owner"
  LOCK_HELD=1
  assert_local_lock
}

validate_recovery_go_file() {
  local path="$1" now expires line_count owner_uid
  [ -f "$path" ] && [ ! -L "$path" ] || return 1
  [ "$(portable_mode "$path")" = 600 ] || return 1
  if stat -f '%u' "$path" >/dev/null 2>&1; then
    owner_uid="$(stat -f '%u' "$path")"
  else
    owner_uid="$(stat -c '%u' "$path")"
  fi
  [ "$owner_uid" = "$(id -u)" ] || return 1
  [ "$(wc -c < "$path" | tr -d ' ')" -le 1024 ] || return 1
  line_count="$(awk 'END { print NR }' "$path")"
  [ "$line_count" = 4 ] || return 1
  [ "$(sed -n '1p' "$path")" = 'arena.ingest-recover-from-stopped@1' ] || return 1
  [ "$(sed -n '2p' "$path")" = "target_sha=$SHA" ] || return 1
  expires="$(sed -n '3s/^expires_epoch=//p' "$path")"
  [[ "$expires" =~ ^[1-9][0-9]*$ ]] || return 1
  grep -Eq '^nonce=[0-9a-f]{64}$' "$path" || return 1
  now="$(date +%s)"
  [[ "$now" =~ ^[1-9][0-9]*$ ]] || return 1
  [ "$expires" -ge "$now" ] && [ "$expires" -le $((now + 900)) ] || return 1
}

consume_stopped_recovery_go() {
  assert_local_lock || return 1
  if ! validate_recovery_go_file "$RECOVERY_GO_FILE"; then
    fail "--recover-from-stopped requires a fresh owner-only mode-0600 confirmation at $RECOVERY_GO_FILE"
  fi
  [ -e "$INCIDENT_HOLD_FILE" ] || [ -L "$INCIDENT_HOLD_FILE" ] || \
    fail '--recover-from-stopped requires the primary incident hold to remain armed'
  [ -e "$RECOVERY_BLOCK_FILE" ] || [ -L "$RECOVERY_BLOCK_FILE" ] || \
    fail '--recover-from-stopped requires the compatibility recovery guard to remain armed'
  mv "$RECOVERY_GO_FILE" "$RECOVERY_GO_CONSUMED" || \
    fail 'unable to atomically consume the stopped-recovery confirmation'
  validate_recovery_go_file "$RECOVERY_GO_CONSUMED" || \
    fail 'consumed stopped-recovery confirmation failed validation'
  STOPPED_RECOVERY_SESSION=1
}

assert_stopped_recovery_go() {
  assert_local_lock || return 1
  validate_recovery_go_file "$RECOVERY_GO_CONSUMED" || {
    echo '✗ stopped-recovery confirmation is missing, expired, or changed' >&2
    return 1
  }
}

assert_no_local_ingest_os_process() {
  local process_snapshot line pid command
  process_snapshot="$(ps -axo pid=,command=)" || return 1
  while IFS= read -r line; do
    pid="${line%% *}"
    command="${line#* }"
    case "$command" in
      *'/worker/src/'*'ingest-worker.ts'*|*'tsx worker/src/'*'ingest-worker.ts'*)
        echo "✗ stopped recovery found a live ingest OS process (pid=${pid:-unknown})" >&2
        return 1
        ;;
    esac
  done <<<"$process_snapshot"
}

assert_no_local_ingest_container() {
  local snapshot
  command -v docker >/dev/null 2>&1 || return 0
  snapshot="$(docker ps --format '{{.Names}}|{{.Label "com.arenafi.role"}}')" || {
    echo '✗ stopped recovery could not prove Docker ingest ownership absence' >&2
    return 1
  }
  if awk -F '|' '$1 ~ /^arena-ingest-worker([_-].*)?$/ || $2 == "ingest-worker" { found=1 } END { exit !found }' \
      <<<"$snapshot"; then
    echo '✗ stopped recovery found a running ingest container' >&2
    return 1
  fi
}

assert_no_fresh_local_roster_owner() {
  (cd "$OLD_CWD" && env -i \
    HOME="$HOME" USER="$DEPLOY_USER" LOGNAME="$DEPLOY_LOGNAME" NODE_ENV=production \
    PATH="$(dirname "$NODE_BIN"):/usr/bin:/bin" \
    "$NODE_BIN" -e '
      const path = require("node:path")
      require("dotenv").config({ path: process.argv[1], override: true, quiet: true })
      const Redis = require("ioredis")
      const url = process.env.REDIS_URL
      if (!url) process.exit(41)
      const redis = new Redis(url, { maxRetriesPerRequest: 1, enableReadyCheck: false,
        connectTimeout: 5000, commandTimeout: 5000, tls: url.startsWith("rediss://") ? {} : undefined })
      redis.on("error", () => {})
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000))
      Promise.race([redis.hgetall("arena:worker:roster"), timeout]).then((roster) => {
        const now = Date.now()
        for (const raw of Object.values(roster)) {
          let value
          try { value = JSON.parse(raw) } catch { process.exitCode = 42; return }
          if (!value || typeof value !== "object" || !Array.isArray(value.regions) ||
              !Number.isSafeInteger(value.ts)) { process.exitCode = 42; return }
          if (value.regions.includes("local") && value.ts >= now - 120000) {
            process.exitCode = 43; return
          }
        }
      }).catch(() => { process.exitCode = 44 }).finally(() => redis.disconnect(false))
    ' "$SHARED_ENV_FILE") >/dev/null 2>&1 || {
    echo '✗ stopped recovery could not prove absence of a fresh local Redis roster owner' >&2
    return 1
  }
}

assert_stopped_pm2_dumps() {
  "$NODE_BIN" -e '
    // arena-stopped-recovery-stopped-dumps@1
    const fs = require("node:fs")
    const path = require("node:path")
    const [home, appName, cwd] = process.argv.slice(1)
    for (const name of ["dump.pm2", "dump.pm2.bak"]) {
      const apps = JSON.parse(fs.readFileSync(path.join(home, name), "utf8"))
      const matches = apps.filter((app) => app?.name === appName ||
        JSON.stringify([app?.pm_exec_path, app?.args, app?.script]).includes("ingest-worker.ts"))
      if (matches.length !== 1 || matches[0].name !== appName ||
          matches[0].status !== "stopped" || matches[0].pm_cwd !== cwd)
        process.exit(45)
    }
  ' "$PM2_HOME_VALUE" "$PM2_APP" "$OLD_CWD" >/dev/null || return 1
}

prove_stopped_local_baseline() {
  local snapshot node_id
  assert_stopped_recovery_go || return 1
  snapshot="$(pm2_snapshot)" || return 1
  [ "$snapshot" = "$BASELINE_SNAPSHOT" ] || return 1
  [ "$(hash_shared_env)" = "$SHARED_ENV_SHA256" ] || return 1
  [ "$(sed -n '1p' "$OLD_CWD/DEPLOYED_SHA" 2>/dev/null || true)" = "$OLD_SHA" ] || return 1
  if [ -n "$OLD_RELEASE_ID" ]; then
    [ "$(sed -n '1p' "$OLD_CWD/WORKER_RELEASE_ID" 2>/dev/null || true)" = "$OLD_RELEASE_ID" ] || return 1
  fi
  assert_no_local_ingest_os_process || return 1
  assert_no_local_ingest_container || return 1
  assert_no_fresh_local_roster_owner || return 1
  pm2_command save --force >/dev/null || return 1
  pm2_command save --force >/dev/null || return 1
  assert_stopped_pm2_dumps || return 1
  [ "$(pm2_snapshot)" = "$BASELINE_SNAPSHOT" ] || return 1
  [ "$(hash_shared_env)" = "$SHARED_ENV_SHA256" ] || return 1
  [ "$(sed -n '1p' "$OLD_CWD/DEPLOYED_SHA" 2>/dev/null || true)" = "$OLD_SHA" ] || return 1
  if [ -n "$OLD_RELEASE_ID" ]; then
    [ "$(sed -n '1p' "$OLD_CWD/WORKER_RELEASE_ID" 2>/dev/null || true)" = "$OLD_RELEASE_ID" ] || return 1
  fi
  assert_no_local_ingest_os_process || return 1
  assert_no_local_ingest_container || return 1
  node_id="$(sed -n 's/^WORKER_NODE_ID=\([A-Za-z0-9][A-Za-z0-9._-]*\)$/\1/p' "$SHARED_ENV_FILE")"
  [[ "$node_id" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || return 1
  OLD_NODE_ID="$node_id"
  OLD_HEARTBEAT_PID=0
  OLD_ROSTER_IDENTITY='stopped-baseline'
}

arm_local_recovery_holds() {
  local hold_tmp="$SHARED_STATE_DIR/.ingest-deploy.hold.$LOCK_TOKEN.tmp"
  local block_tmp="$RELEASE_ROOT/.arena-ingest-deploy-blocked.$LOCK_TOKEN.tmp"
  assert_local_lock || return 1
  printf '%s\n' 'arena.ingest-incident-hold@1' > "$hold_tmp" || return 1
  mv "$hold_tmp" "$INCIDENT_HOLD_FILE" || return 1
  if [ -f "$RECOVERY_BLOCK_FILE" ] && [ ! -L "$RECOVERY_BLOCK_FILE" ]; then
    rm -f "$block_tmp"
  elif [ ! -e "$RECOVERY_BLOCK_FILE" ] || [ -L "$RECOVERY_BLOCK_FILE" ]; then
    printf '%s\n%s\n' 'arena.local-ingest-recovery-block@1' "target_sha=$SHA" > "$block_tmp" || return 1
    mv "$block_tmp" "$RECOVERY_BLOCK_FILE" || return 1
  else
    return 1
  fi
  chmod 600 "$INCIDENT_HOLD_FILE" "$RECOVERY_BLOCK_FILE" || return 1
  [ -f "$INCIDENT_HOLD_FILE" ] && [ ! -L "$INCIDENT_HOLD_FILE" ] || return 1
  [ -f "$RECOVERY_BLOCK_FILE" ] && [ ! -L "$RECOVERY_BLOCK_FILE" ] || return 1
  [ "$(portable_mode "$INCIDENT_HOLD_FILE")" = 600 ] || return 1
  [ "$(portable_mode "$RECOVERY_BLOCK_FILE")" = 600 ] || return 1
  [ "$(sed -n '1p' "$INCIDENT_HOLD_FILE")" = 'arena.ingest-incident-hold@1' ] || return 1
  assert_local_lock
}

release_local_incident_hold_for_cutover() {
  assert_stopped_recovery_go || return 1
  prove_stopped_local_baseline || return 1
  write_cutover_journal || return 1
  rm -f "$INCIDENT_HOLD_FILE" || return 1
  [ ! -e "$INCIDENT_HOLD_FILE" ] && [ ! -L "$INCIDENT_HOLD_FILE" ] || return 1
  STOPPED_RECOVERY_CUTOVER=1
}

persist_recovery_record() {
  local marker="$1" phase="$2" tmp_file="$LOCK_DIR/recovery-record.tmp"
  assert_local_lock || return 1
  rm -f "$tmp_file"
  "$NODE_BIN" -e '
    const fs = require("node:fs")
    const pathModule = require("node:path")
    const [path, destination, marker, token, phase, sha, releaseId, candidate, oldCwd, oldSha,
      oldRelease, oldPid, oldNode, oldHeartbeatPid, oldInterpreter, oldEntrypoint, oldArgs,
      oldNodeArgs, oldExecMode, oldInstances, envSha256] = process.argv.slice(1)
    const body = [
      marker,
      `lock_token=${token}`,
      `phase=${phase}`,
      `target_sha=${sha}`,
      `target_release=${releaseId}`,
      `candidate_cwd=${candidate}`,
      `old_cwd=${oldCwd}`,
      `old_sha=${oldSha}`,
      `old_release=${oldRelease || "legacy"}`,
      `old_pid=${oldPid}`,
      `old_node=${oldNode}`,
      `old_heartbeat_pid=${oldHeartbeatPid}`,
      `old_interpreter=${oldInterpreter}`,
      `old_entrypoint=${oldEntrypoint}`,
      `old_args=${oldArgs}`,
      `old_node_args=${oldNodeArgs}`,
      `old_exec_mode=${oldExecMode}`,
      `old_instances=${oldInstances}`,
      `shared_env_sha256=${envSha256}`,
    ].join("\n") + "\n"
    const fd = fs.openSync(path, "wx", 0o600)
    try {
      fs.writeFileSync(fd, body)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(path, destination)
    const directoryFd = fs.openSync(pathModule.dirname(destination), "r")
    try {
      fs.fsyncSync(directoryFd)
    } finally {
      fs.closeSync(directoryFd)
    }
  ' "$tmp_file" "$RECOVERY_BLOCK_FILE" "$marker" "$LOCK_TOKEN" "$phase" "$SHA" \
    "$WORKER_RELEASE_ID" "$RELEASE_DIR" "$OLD_CWD" "$OLD_SHA" "$OLD_RELEASE_ID" \
    "$OLD_PID" "$OLD_NODE_ID" "$OLD_HEARTBEAT_PID" "$OLD_INTERPRETER" "$OLD_EXEC_PATH" \
    "$OLD_ARGS_JSON" "$OLD_NODE_ARGS_JSON" "$OLD_EXEC_MODE" "$OLD_INSTANCES" \
    "$SHARED_ENV_SHA256" || return 1
  [ -f "$RECOVERY_BLOCK_FILE" ] && [ ! -L "$RECOVERY_BLOCK_FILE" ] || return 1
}

write_cutover_journal() {
  if [ "$RECOVER_FROM_STOPPED" = 1 ]; then
    assert_stopped_recovery_go || return 1
    [ -e "$RECOVERY_BLOCK_FILE" ] || [ -L "$RECOVERY_BLOCK_FILE" ] || return 1
  else
    assert_no_recovery_block
  fi
  persist_recovery_record 'arena.local-ingest-cutover-journal@1' 'cutover_pending' || return 1
  RECOVERY_JOURNAL_WRITTEN=1
}

write_failed_recovery_block() {
  persist_recovery_record 'arena.local-ingest-recovery-block@1' 'rollback_failed'
}

clear_recovery_journal() {
  assert_local_lock || return 1
  [ "$RECOVERY_JOURNAL_WRITTEN" = 1 ] || return 1
  [ -f "$RECOVERY_BLOCK_FILE" ] && [ ! -L "$RECOVERY_BLOCK_FILE" ] || return 1
  grep -Fqx "lock_token=$LOCK_TOKEN" "$RECOVERY_BLOCK_FILE" || return 1
  "$NODE_BIN" -e '
    const fs = require("node:fs")
    const pathModule = require("node:path")
    const target = process.argv[1]
    fs.unlinkSync(target)
    const directoryFd = fs.openSync(pathModule.dirname(target), "r")
    try {
      fs.fsyncSync(directoryFd)
    } finally {
      fs.closeSync(directoryFd)
    }
  ' "$RECOVERY_BLOCK_FILE" || return 1
  RECOVERY_JOURNAL_WRITTEN=0
}

wait_for_pm2_exact() {
  local expected_cwd="$1" expected_interpreter="$2" expected_exec_path="$3"
  local expected_args="$4" expected_exec_mode="$5" expected_instances="$6"
  local expected_node_args="$7" expected_restarts="$8"
  local i snapshot pid status cwd interpreter exec_path restarts args node_args exec_mode instances
  for i in $(seq 1 60); do
    snapshot="$(pm2_snapshot 2>/dev/null || true)"
    if [ -n "$snapshot" ]; then
      IFS=$'\x1f' read -r pid status cwd interpreter exec_path restarts args node_args exec_mode \
        instances <<<"$snapshot"
      if [ "$status" = online ] && [ "$cwd" = "$expected_cwd" ] && \
         [ "$interpreter" = "$expected_interpreter" ] && \
         [ "$exec_path" = "$expected_exec_path" ] && [ "$args" = "$expected_args" ] && \
         [ "$node_args" = "$expected_node_args" ] && \
         [ "$exec_mode" = "$expected_exec_mode" ] && \
         [ "$instances" = "$expected_instances" ] && [ "$restarts" = "$expected_restarts" ] && \
         [[ "$pid" =~ ^[1-9][0-9]*$ ]]; then
        printf '%s\n' "$pid"
        return 0
      fi
    fi
    sleep 1
  done
  return 1
}

pm2_exact_pid_once() {
  local expected_cwd="$1" expected_interpreter="$2" expected_exec_path="$3"
  local expected_args="$4" expected_exec_mode="$5" expected_instances="$6"
  local expected_node_args="$7" expected_restarts="$8"
  local snapshot pid status cwd interpreter exec_path restarts args node_args exec_mode instances
  snapshot="$(pm2_snapshot 2>/dev/null || true)"
  [ -n "$snapshot" ] || return 1
  IFS=$'\x1f' read -r pid status cwd interpreter exec_path restarts args node_args exec_mode \
    instances <<<"$snapshot"
  [ "$status" = online ] && [ "$cwd" = "$expected_cwd" ] && \
    [ "$interpreter" = "$expected_interpreter" ] && \
    [ "$exec_path" = "$expected_exec_path" ] && [ "$args" = "$expected_args" ] && \
    [ "$node_args" = "$expected_node_args" ] && \
    [ "$exec_mode" = "$expected_exec_mode" ] && \
    [ "$instances" = "$expected_instances" ] && [ "$restarts" = "$expected_restarts" ] && \
    [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  printf '%s\n' "$pid"
}

require_candidate_stability() {
  local i observed_pid
  for i in $(seq 1 11); do
    if [ -n "${INCIDENT_HOLD_FILE:-}" ] && \
       { [ -e "$INCIDENT_HOLD_FILE" ] || [ -L "$INCIDENT_HOLD_FILE" ]; }; then return 1; fi
    observed_pid="$(wait_for_pm2_exact "$RELEASE_DIR" "$NODE_BIN" "$CANDIDATE_EXEC_PATH" \
      "$CANDIDATE_ARGS_JSON" "$CANDIDATE_EXEC_MODE" "$CANDIDATE_INSTANCES" \
      "$CANDIDATE_NODE_ARGS_JSON" 0)" || return 1
    [ "$observed_pid" = "$NEW_PID" ] || return 1
    [ "$i" = 11 ] && return 0
    sleep 1
  done
  return 1
}

require_rollback_stability() {
  local expected_pid="$1" expected_cwd="$2" expected_interpreter="$3" expected_exec_path="$4"
  local expected_args="$5" expected_exec_mode="$6" expected_instances="$7"
  local expected_node_args="$8" expected_restarts="$9" i observed_pid
  for i in $(seq 1 11); do
    assert_local_lock || return 1
    observed_pid="$(pm2_exact_pid_once "$expected_cwd" "$expected_interpreter" \
      "$expected_exec_path" "$expected_args" "$expected_exec_mode" "$expected_instances" \
      "$expected_node_args" "$expected_restarts")" || return 1
    [ "$observed_pid" = "$expected_pid" ] || return 1
    assert_local_lock || return 1
    [ "$i" = 11 ] && return 0
    sleep 1
  done
  return 1
}

prove_pid_descends_from() {
  local ancestor="$1" current="$2" parent depth=0
  [[ "$ancestor" =~ ^[1-9][0-9]*$ ]] && [[ "$current" =~ ^[1-9][0-9]*$ ]] || return 1
  kill -0 "$ancestor" 2>/dev/null || return 1
  kill -0 "$current" 2>/dev/null || return 1
  while [ "$depth" -lt 16 ]; do
    [ "$current" = "$ancestor" ] && return 0
    parent="$(ps -o ppid= -p "$current" 2>/dev/null | tr -d '[:space:]')" || return 1
    [[ "$parent" =~ ^[1-9][0-9]*$ ]] || return 1
    current="$parent"
    depth=$((depth + 1))
  done
  return 1
}

discover_existing_runtime_identity() {
  local release_dir="$1" ancestor_pid="$2" not_before_ms="${3:-}"
  local request_timeout_ms="${4:-}"
  local proof marker node heartbeat_pid extra
  local -a discovery_args=(--discover-existing "$OLD_SHA" "$OLD_ROSTER_RELEASE_ID")
  if [ -n "$not_before_ms" ]; then
    [[ "$not_before_ms" =~ ^[1-9][0-9]*$ ]] || return 1
    discovery_args+=("$not_before_ms")
  fi
  if [ -n "$request_timeout_ms" ]; then
    [ -n "$not_before_ms" ] || return 1
    [[ "$request_timeout_ms" =~ ^[1-9][0-9]*$ ]] || return 1
    discovery_args+=("$request_timeout_ms")
  fi
  proof="$(
    (
      cd "$release_dir" && env -i \
        HOME="$HOME" USER="$DEPLOY_USER" LOGNAME="$DEPLOY_LOGNAME" NODE_ENV=production \
        PATH="$(dirname "$NODE_BIN"):/usr/bin:/bin" \
        "$NODE_BIN" node_modules/tsx/dist/cli.mjs worker/verify-local-heartbeat.ts \
        "${discovery_args[@]}"
    ) | awk -F '\t' '
      $1 == "ARENA_LOCAL_EXISTING_ROSTER" && NF == 3 { matches += 1; proof = $0 }
      END { if (matches != 1) exit 45; print proof }
    '
  )" || return 1
  IFS=$'\t' read -r marker node heartbeat_pid extra <<<"$proof"
  [ "$marker" = ARENA_LOCAL_EXISTING_ROSTER ] && [ -z "$extra" ] || return 1
  [[ "$node" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || return 1
  [[ "$heartbeat_pid" =~ ^[1-9][0-9]*$ ]] || return 1
  prove_pid_descends_from "$ancestor_pid" "$heartbeat_pid" || return 1
  printf '%s\x1f%s\n' "$node" "$heartbeat_pid"
}

wait_for_discovered_identity() {
  local release_dir="$1" ancestor_pid="$2" expected_node="$3" not_before_ms="${4:-}"
  local timeout deadline remaining_ms identity node _pid
  timeout="${ARENA_LEGACY_DISCOVERY_TIMEOUT_SECONDS:-90}"
  [[ "$timeout" =~ ^[1-9][0-9]*$ ]] || return 1
  [ "$timeout" -le 90 ] || timeout=90
  deadline=$((SECONDS + timeout))
  while [ "$SECONDS" -lt "$deadline" ]; do
    assert_local_lock || return 1
    remaining_ms=$(((deadline - SECONDS) * 1000))
    [ "$remaining_ms" -gt 0 ] || break
    identity="$(discover_existing_runtime_identity "$release_dir" "$ancestor_pid" \
      "$not_before_ms" "$remaining_ms" 2>/dev/null || true)"
    assert_local_lock || return 1
    if [ -n "$identity" ]; then
      IFS=$'\x1f' read -r node _pid <<<"$identity"
      if [ "$node" = "$expected_node" ]; then
        printf '%s\n' "$identity"
        return 0
      fi
    fi
    [ "$SECONDS" -lt "$deadline" ] || break
    sleep 1
  done
  return 1
}

pm2_app_absent() {
  pm2_command jlist | "$NODE_BIN" -e '
    const appName = process.argv[1]
    let raw = ""
    process.stdin.on("data", (chunk) => { raw += chunk })
    process.stdin.on("end", () => {
      const matches = JSON.parse(raw).filter((app) => app.name === appName)
      process.exit(matches.length === 0 ? 0 : 46)
    })
  ' "$PM2_APP"
}

wait_for_process_exit() {
  local pid="$1" i
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 0
  for i in $(seq 1 30); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 1
  done
  return 1
}

process_tree_pids() {
  local root_pid="$1"
  [[ "$root_pid" =~ ^[1-9][0-9]*$ ]] || return 1
  ps -axo pid=,ppid= | "$NODE_BIN" -e '
    const root = Number(process.argv[1])
    let raw = ""
    process.stdin.on("data", (chunk) => { raw += chunk })
    process.stdin.on("end", () => {
      const rows = raw.trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number))
      if (!rows.some(([pid]) => pid === root)) process.exit(48)
      const children = new Map()
      for (const [pid, ppid] of rows) {
        if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) process.exit(49)
        const values = children.get(ppid) || []
        values.push(pid)
        children.set(ppid, values)
      }
      const seen = new Set()
      const pending = [root]
      while (pending.length) {
        const pid = pending.shift()
        if (seen.has(pid)) continue
        seen.add(pid)
        pending.push(...(children.get(pid) || []))
      }
      process.stdout.write([...seen].join("\n") + "\n")
    })
  ' "$root_pid"
}

wait_for_pid_set_exit() {
  local pid_set="$1" i pid live
  for i in $(seq 1 30); do
    live=0
    for pid in $pid_set; do
      [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
      if kill -0 "$pid" 2>/dev/null; then live=1; fi
    done
    [ "$live" = 0 ] && return 0
    sleep 1
  done
  return 1
}

profile_owner_pids() {
  local release_dir="$1"
  ps -axo pid=,command= | "$NODE_BIN" -e '
    const releasePrefix = `--user-data-dir=${process.argv[1]}/.arena-ingest/profiles/`
    const sharedPrefix = `--user-data-dir=${process.argv[2]}/profiles/`
    let raw = ""
    process.stdin.on("data", (chunk) => { raw += chunk })
    process.stdin.on("end", () => {
      const matches = []
      for (const line of raw.split("\n")) {
        const match = line.match(/^\s*([1-9][0-9]*)\s+(.*)$/)
        if (!match) continue
        if (match[2].includes(releasePrefix) || match[2].includes(sharedPrefix)) matches.push(match[1])
      }
      process.stdout.write(matches.join("\n") + (matches.length ? "\n" : ""))
    })
  ' "$release_dir" "$SHARED_STATE_DIR"
}

wait_for_profile_owners_exit() {
  local release_dir="$1" i owners
  for i in $(seq 1 30); do
    owners="$(profile_owner_pids "$release_dir")" || return 1
    [ -z "$owners" ] && return 0
    sleep 1
  done
  return 1
}

wait_for_pm2_absent() {
  local expected_pid="$1" i
  for i in $(seq 1 30); do
    if pm2_app_absent 2>/dev/null && \
       { [[ ! "$expected_pid" =~ ^[1-9][0-9]*$ ]] || ! kill -0 "$expected_pid" 2>/dev/null; }; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_stamped_ready() {
  local mode="$1" marker="$2" log_file="$3" expected_sha="$4" expected_release="$5"
  local expected_node="$6" expected_pid="${7:-}" expected_region
  local timeout="${ARENA_READY_TIMEOUT_SECONDS:-$AUTHORITY_HANDOFF_TIMEOUT_SECONDS}" i
  case "$mode" in
    native)
      expected_region=local
      [[ "$expected_pid" =~ ^[1-9][0-9]*$ ]] || return 1
      ;;
    legacy) expected_region='' ;;
    *) return 1 ;;
  esac
  [[ "$timeout" =~ ^[1-9][0-9]*$ ]] || return 1
  for i in $(seq 1 "$timeout"); do
    if [ -n "${INCIDENT_HOLD_FILE:-}" ] && \
       { [ -e "$INCIDENT_HOLD_FILE" ] || [ -L "$INCIDENT_HOLD_FILE" ]; }; then return 1; fi
    awk -v mode="$mode" -v marker="$marker" -v sha="$expected_sha" -v pid="$expected_pid" \
      -v release="$expected_release" -v node="$expected_node" \
      -v region="$expected_region" '
      function exactToken(line, value, count, fields, fieldIndex) {
        count = split(line, fields, /[[:space:]]+/)
        for (fieldIndex = 1; fieldIndex <= count; fieldIndex++)
          if (fields[fieldIndex] == value) return 1
        return 0
      }
      function positiveIntegerToken(line, prefix, count, fields, fieldIndex, value) {
        count = split(line, fields, /[[:space:]]+/)
        for (fieldIndex = 1; fieldIndex <= count; fieldIndex++) {
          if (index(fields[fieldIndex], prefix) == 1) {
            value = substr(fields[fieldIndex], length(prefix) + 1)
            if (value ~ /^[1-9][0-9]*$/) return 1
          }
        }
        return 0
      }
      function canonicalPayload(line, prefix, payload) {
        if (substr(line, 1, 1) == "[") return line
        prefix = substr(line, 1, 21)
        if (prefix !~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]: $/) return ""
        payload = substr(line, 22)
        if (substr(payload, 1, 1) != "[") return ""
        return payload
      }
      function metricReady(line) {
        return index(line, "[ingest-worker] metric-trust database release contract ready")
      }
      function nativeMetricReady(line) {
        return canonicalPayload(line) == "[ingest-worker] metric-trust database release contract ready"
      }
      function committedHeartbeat(line) {
        return index(canonicalPayload(line), "[heartbeat] redis-hset-committed ") == 1
      }
      function exactCommittedHeartbeat(line, expectedNode, expectedPid, expectedSha, expectedRelease, payload, count, fields) {
        payload = canonicalPayload(line)
        count = split(payload, fields, / /)
        if (count != 7) return 0
        if (fields[1] != "[heartbeat]" || fields[2] != "redis-hset-committed") return 0
        if (fields[3] != "node=" expectedNode || fields[4] != "pid=" expectedPid) return 0
        if (fields[5] != "sha=" expectedSha || fields[6] != "release=" expectedRelease) return 0
        return fields[7] ~ /^ts=[1-9][0-9]*$/
      }
      function authorityReady(line) {
        return index(canonicalPayload(line), "[ingest-worker] native regional authority ready") == 1
      }
      function exactAuthorityReady(line, expectedRegion) {
        return canonicalPayload(line) == "[ingest-worker] native regional authority ready region=" expectedRegion
      }
      function workerReady(line) {
        return index(line, "[ingest-worker] ready")
      }
      function nativeWorkerReady(line, expectedRegion, payload) {
        payload = canonicalPayload(line)
        return payload ~ ("^\\[ingest-worker\\] ready \\(regions=" expectedRegion ", concurrency=[1-9][0-9]*, fast-lane=(off|on×[1-9][0-9]*)\\)$")
      }
      $0 == marker {
        after = 1
        db = 0
        ready = 0
        heartbeat = 0
        stage = 0
        invalid = 0
        next
      }
      mode == "native" && after && stage < 4 && nativeMetricReady($0) {
        if (stage == 0) stage = 1
        else invalid = 1
        next
      }
      mode == "native" && after && stage < 4 && committedHeartbeat($0) {
        expectedHeartbeat = exactCommittedHeartbeat($0, node, pid, sha, release)
        if (expectedHeartbeat) {
          if (stage == 1) stage = 2
          else invalid = 1
        }
        next
      }
      mode == "native" && after && stage < 4 && authorityReady($0) {
        if (stage == 2 && exactAuthorityReady($0, region)) stage = 3
        else invalid = 1
        next
      }
      mode == "native" && after && stage < 4 && index(canonicalPayload($0), "[ingest-worker] ready") == 1 {
        if (stage == 3 && nativeWorkerReady($0, region)) stage = 4
        else invalid = 1
        next
      }
      mode == "legacy" && after && metricReady($0) { db = 1 }
      mode == "legacy" && after && workerReady($0) { ready = 1 }
      mode == "legacy" && after && index($0, "[heartbeat]") &&
        exactToken($0, "node=" node) && exactToken($0, "sha=" sha) &&
        exactToken($0, "release=" release) { heartbeat = 1 }
      END {
        if (mode == "native") exit !(after && !invalid && stage == 4)
        exit !(after && db && ready && heartbeat)
      }
    ' "$log_file" && return 0
    sleep 1
  done
  return 1
}

wait_for_legacy_ready() {
  local marker="$1" log_file="$2" expected_sha="$3" expected_node="$4" short_sha i
  local timeout="${ARENA_READY_TIMEOUT_SECONDS:-$AUTHORITY_HANDOFF_TIMEOUT_SECONDS}"
  short_sha="${expected_sha:0:9}"
  [[ "$timeout" =~ ^[1-9][0-9]*$ ]] || return 1
  for i in $(seq 1 "$timeout"); do
    awk -v marker="$marker" -v sha="$expected_sha" -v short="$short_sha" -v node="$expected_node" '
      function exactToken(line, value, count, fields, fieldIndex) {
        count = split(line, fields, /[[:space:]]+/)
        for (fieldIndex = 1; fieldIndex <= count; fieldIndex++)
          if (fields[fieldIndex] == value) return 1
        return 0
      }
      index($0, marker) { after = 1; ready = 0; heartbeat = 0; next }
      after && index($0, "[ingest-worker] ready") { ready = 1 }
      after && index($0, "[heartbeat]") && exactToken($0, "node=" node) &&
        (exactToken($0, "sha=" sha) || exactToken($0, "sha=" short)) { heartbeat = 1 }
      END { exit !(after && ready && heartbeat) }
    ' "$log_file" && return 0
    sleep 1
  done
  return 1
}

start_release_config() {
  local release_dir="$1" node_bin="$2" config_file="$3" path_value
  path_value="$(dirname "$node_bin"):$(dirname "$PM2_BIN"):/opt/homebrew/bin:/usr/bin:/bin"
  env -i \
    HOME="$HOME" USER="$DEPLOY_USER" LOGNAME="$DEPLOY_LOGNAME" \
    PM2_HOME="$PM2_HOME_VALUE" PATH="$path_value" \
    ARENA_INGEST_RELEASE_DIR="$release_dir" ARENA_NODE_BIN="$node_bin" \
    PLAYWRIGHT_BROWSERS_PATH="$release_dir/.playwright-browsers" \
    "$PM2_BIN" start "$config_file" --only "$PM2_APP" --update-env >/dev/null
}

recover_previous_release() {
  local rollback_marker rollback_log rollback_config expected_interpreter displaced_pid
  local rollback_pid rollback_not_before_ms rollback_final_not_before_ms final_rollback_pid
  local current_snapshot current_roster_identity current_env_sha
  local rollback_roster_identity final_rollback_roster_identity
  local displaced_tree
  assert_local_lock || {
    echo '✗✗ local deploy lock was lost; automatic rollback is unsafe' >&2
    return 1
  }

  current_snapshot="$(pm2_snapshot 2>/dev/null || true)"
  if [ "$current_snapshot" = "$BASELINE_SNAPSHOT" ]; then
    current_env_sha="$(hash_shared_env 2>/dev/null || true)"
    if [ "$current_env_sha" != "$SHARED_ENV_SHA256" ]; then
      echo '✗✗ previous owner is still online but the shared environment changed; leaving it untouched' >&2
      return 1
    fi
    current_roster_identity="$(
      discover_existing_runtime_identity "$RELEASE_DIR" "$OLD_PID" 2>/dev/null || true
    )"
    if [ "$current_roster_identity" = "$OLD_ROSTER_IDENTITY" ]; then
      require_rollback_stability "$OLD_PID" "$OLD_CWD" "$OLD_INTERPRETER" \
        "$OLD_EXEC_PATH" "$OLD_ARGS_JSON" "$OLD_EXEC_MODE" "$OLD_INSTANCES" \
        "$OLD_NODE_ARGS_JSON" "$OLD_RESTARTS" || {
        echo '✗✗ previous owner did not remain continuously stable for ten seconds' >&2
        return 1
      }
      assert_local_lock || return 1
      rollback_final_not_before_ms="$("$NODE_BIN" -p 'Date.now()')" || return 1
      [[ "$rollback_final_not_before_ms" =~ ^[1-9][0-9]*$ ]] || return 1
      assert_local_lock || return 1
      if [ -n "$OLD_RELEASE_ID" ]; then
        (cd "$RELEASE_DIR" && env -i \
          HOME="$HOME" USER="$DEPLOY_USER" LOGNAME="$DEPLOY_LOGNAME" NODE_ENV=production \
          PATH="$(dirname "$NODE_BIN"):/usr/bin:/bin" \
          "$NODE_BIN" node_modules/tsx/dist/cli.mjs worker/verify-local-heartbeat.ts \
          "$OLD_PID" "$OLD_SHA" "$OLD_RELEASE_ID" "$OLD_NODE_ID" \
          "$rollback_final_not_before_ms") || {
          echo '✗✗ previous stamped owner lacks final fresh Redis evidence' >&2
          return 1
        }
      else
        final_rollback_roster_identity="$(wait_for_discovered_identity "$RELEASE_DIR" \
          "$OLD_PID" "$OLD_NODE_ID" "$rollback_final_not_before_ms")" || {
          echo '✗✗ previous legacy owner lacks final fresh Redis/ancestry evidence' >&2
          return 1
        }
        [ "$final_rollback_roster_identity" = "$OLD_ROSTER_IDENTITY" ] || {
          echo '✗✗ previous legacy owner heartbeat PID changed during stability proof' >&2
          return 1
        }
      fi
      assert_local_lock || return 1
      final_rollback_pid="$(pm2_exact_pid_once "$OLD_CWD" "$OLD_INTERPRETER" \
        "$OLD_EXEC_PATH" "$OLD_ARGS_JSON" "$OLD_EXEC_MODE" "$OLD_INSTANCES" \
        "$OLD_NODE_ARGS_JSON" "$OLD_RESTARTS")" || {
        echo '✗✗ previous owner lost its exact PM2 identity after final Redis proof' >&2
        return 1
      }
      [ "$final_rollback_pid" = "$OLD_PID" ] || {
        echo '✗✗ previous owner PID changed after final Redis proof' >&2
        return 1
      }
      assert_local_lock || return 1
      [ "$(hash_shared_env 2>/dev/null || true)" = "$SHARED_ENV_SHA256" ] || {
        echo '✗✗ shared worker environment changed during rollback verification' >&2
        return 1
      }
      assert_local_lock || return 1
      pm2_command save >/dev/null || return 1
      assert_local_lock || return 1
      clear_recovery_journal || return 1
      ROLLBACK_SUCCEEDED=1
      echo "✓ previous local release never left ownership: cwd=$OLD_CWD sha=$OLD_SHA" >&2
      return 0
    fi
    echo '✗✗ previous owner is still online but fresh runtime identity is ambiguous; leaving it untouched' >&2
    return 1
  fi

  displaced_pid="$(pm2_command pid "$PM2_APP" 2>/dev/null | tr -d '[:space:]' || true)"
  displaced_tree=''
  if [[ "$displaced_pid" =~ ^[1-9][0-9]*$ ]]; then
    displaced_tree="$(process_tree_pids "$displaced_pid" 2>/dev/null || printf '%s\n' "$displaced_pid")"
  fi
  pm2_command delete "$PM2_APP" >/dev/null 2>&1 || true
  wait_for_pm2_absent "$displaced_pid" || {
    echo '✗✗ failed candidate still owns PM2 state or a live process' >&2
    return 1
  }
  if [ -n "${NEW_PID:-}" ] && [ "$NEW_PID" != "$displaced_pid" ]; then
    wait_for_process_exit "$NEW_PID" || {
      echo '✗✗ failed candidate process is still alive outside PM2' >&2
      return 1
    }
  fi
  wait_for_pid_set_exit "$displaced_tree${NEW_PROCESS_TREE:+
$NEW_PROCESS_TREE}" || {
    echo '✗✗ a failed-candidate descendant process is still alive' >&2
    return 1
  }
  wait_for_profile_owners_exit "$RELEASE_DIR" || {
    echo '✗✗ a failed-candidate browser still owns a shared profile' >&2
    return 1
  }
  wait_for_process_exit "$OLD_HEARTBEAT_PID" || {
    echo '✗✗ original heartbeat child is still alive; rollback would duplicate ownership' >&2
    return 1
  }
  wait_for_process_exit "$OLD_PID" || {
    echo '✗✗ original PM2 wrapper is still alive; rollback would duplicate ownership' >&2
    return 1
  }
  current_env_sha="$(hash_shared_env 2>/dev/null || true)"
  if [ "$current_env_sha" != "$SHARED_ENV_SHA256" ]; then
    echo '✗✗ shared worker environment changed after cutover; automatic restart is unsafe' >&2
    return 1
  fi
  rollback_log="$OLD_CWD/worker/logs/ingest-out.log"
  [ -d "$OLD_CWD/worker/logs" ] || {
    echo '✗✗ previous release log directory is unavailable' >&2
    return 1
  }
  rollback_marker="arena-local-rollback-$TS-$$"
  printf '%s\n' "$rollback_marker" >> "$rollback_log"
  rollback_not_before_ms="$("$NODE_BIN" -p 'Date.now()')" || return 1
  [[ "$rollback_not_before_ms" =~ ^[1-9][0-9]*$ ]] || return 1

  if [ -f "$OLD_CWD/worker/ecosystem.local-ingest.config.cjs" ] && \
     [[ "$OLD_INTERPRETER" = /* ]] && [ -x "$OLD_INTERPRETER" ]; then
    rollback_config="$OLD_CWD/worker/ecosystem.local-ingest.config.cjs"
    expected_interpreter="$OLD_INTERPRETER"
    start_release_config "$OLD_CWD" "$OLD_INTERPRETER" "$rollback_config" || return 1
  else
    rollback_config="$OLD_CWD/worker/ecosystem.config.cjs"
    [ -f "$rollback_config" ] || return 1
    expected_interpreter="$OLD_INTERPRETER"
    env -i \
      HOME="$HOME" USER="$DEPLOY_USER" LOGNAME="$DEPLOY_LOGNAME" \
      PM2_HOME="$PM2_HOME_VALUE" \
      PATH="$(dirname "$OLD_INTERPRETER"):$(dirname "$OLD_EXEC_PATH"):/opt/homebrew/bin:/usr/bin:/bin" \
      "$PM2_BIN" start "$rollback_config" --only "$PM2_APP" --update-env >/dev/null || return 1
  fi

  rollback_pid="$(wait_for_pm2_exact "$OLD_CWD" "$expected_interpreter" "$OLD_EXEC_PATH" \
    "$OLD_ARGS_JSON" "$OLD_EXEC_MODE" "$OLD_INSTANCES" "$OLD_NODE_ARGS_JSON" 0)" || {
    echo '✗✗ previous release did not return with its exact PM2 identity' >&2
    return 1
  }
  if [ -n "$OLD_RELEASE_ID" ]; then
    wait_for_stamped_ready legacy "$rollback_marker" "$rollback_log" \
      "$OLD_SHA" "$OLD_RELEASE_ID" "$OLD_NODE_ID" "$rollback_pid" || {
      echo '✗✗ previous stamped release lacks fresh rollback evidence' >&2
      return 1
    }
    (cd "$RELEASE_DIR" && env -i \
      HOME="$HOME" USER="$DEPLOY_USER" LOGNAME="$DEPLOY_LOGNAME" NODE_ENV=production \
      PATH="$(dirname "$NODE_BIN"):/usr/bin:/bin" \
      "$NODE_BIN" node_modules/tsx/dist/cli.mjs worker/verify-local-heartbeat.ts \
      "$rollback_pid" "$OLD_SHA" "$OLD_RELEASE_ID" "$OLD_NODE_ID" \
      "$rollback_not_before_ms") || {
      echo '✗✗ previous stamped release lacks exact Redis rollback evidence' >&2
      return 1
    }
  else
    wait_for_legacy_ready "$rollback_marker" "$rollback_log" "$OLD_SHA" "$OLD_NODE_ID" || {
      echo '✗✗ previous legacy release lacks fresh rollback evidence' >&2
      return 1
    }
    rollback_roster_identity="$(wait_for_discovered_identity "$RELEASE_DIR" "$rollback_pid" \
      "$OLD_NODE_ID" "$rollback_not_before_ms")" || {
      echo '✗✗ previous legacy release lacks fresh Redis/ancestry rollback evidence' >&2
      return 1
    }
  fi

  assert_local_lock || return 1
  require_rollback_stability "$rollback_pid" "$OLD_CWD" "$expected_interpreter" \
    "$OLD_EXEC_PATH" "$OLD_ARGS_JSON" "$OLD_EXEC_MODE" "$OLD_INSTANCES" \
    "$OLD_NODE_ARGS_JSON" 0 || {
    echo '✗✗ previous release was not continuously stable for ten seconds after rollback proof' >&2
    return 1
  }
  assert_local_lock || return 1
  rollback_final_not_before_ms="$("$NODE_BIN" -p 'Date.now()')" || return 1
  [[ "$rollback_final_not_before_ms" =~ ^[1-9][0-9]*$ ]] || return 1
  assert_local_lock || return 1
  if [ -n "$OLD_RELEASE_ID" ]; then
    (cd "$RELEASE_DIR" && env -i \
      HOME="$HOME" USER="$DEPLOY_USER" LOGNAME="$DEPLOY_LOGNAME" NODE_ENV=production \
      PATH="$(dirname "$NODE_BIN"):/usr/bin:/bin" \
      "$NODE_BIN" node_modules/tsx/dist/cli.mjs worker/verify-local-heartbeat.ts \
      "$rollback_pid" "$OLD_SHA" "$OLD_RELEASE_ID" "$OLD_NODE_ID" \
      "$rollback_final_not_before_ms") || {
      echo '✗✗ previous stamped release lacks final fresh Redis rollback evidence' >&2
      return 1
    }
  else
    final_rollback_roster_identity="$(wait_for_discovered_identity "$RELEASE_DIR" \
      "$rollback_pid" "$OLD_NODE_ID" "$rollback_final_not_before_ms")" || {
      echo '✗✗ previous legacy release lacks final fresh Redis/ancestry rollback evidence' >&2
      return 1
    }
    [ "$final_rollback_roster_identity" = "$rollback_roster_identity" ] || {
      echo '✗✗ previous legacy release heartbeat PID changed during stability proof' >&2
      return 1
    }
  fi
  assert_local_lock || return 1
  final_rollback_pid="$(pm2_exact_pid_once "$OLD_CWD" "$expected_interpreter" "$OLD_EXEC_PATH" \
    "$OLD_ARGS_JSON" "$OLD_EXEC_MODE" "$OLD_INSTANCES" "$OLD_NODE_ARGS_JSON" 0)" || {
    echo '✗✗ previous release lost its exact PM2 identity after final Redis proof' >&2
    return 1
  }
  [ "$final_rollback_pid" = "$rollback_pid" ] || {
    echo '✗✗ previous release PID changed after final Redis proof' >&2
    return 1
  }
  assert_local_lock || return 1
  [ "$(hash_shared_env 2>/dev/null || true)" = "$SHARED_ENV_SHA256" ] || {
    echo '✗✗ shared worker environment changed during rollback verification' >&2
    return 1
  }
  assert_local_lock || return 1
  pm2_command save >/dev/null || return 1
  assert_local_lock || return 1
  clear_recovery_journal || {
    echo '✗✗ rollback succeeded but the durable cutover journal could not be cleared' >&2
    return 1
  }
  ROLLBACK_SUCCEEDED=1
  echo "✓ previous local release restored: cwd=$OLD_CWD sha=$OLD_SHA" >&2
}

safe_remove_generated_release() {
  local candidate="$1"
  case "$candidate/" in
    "$RELEASE_ROOT"/*) ;;
    *) return 1 ;;
  esac
  [ -d "$candidate" ] && [ ! -L "$candidate" ] || return 1
  [ "$(sed -n '1p' "$candidate/.ARENA_LOCAL_RELEASE" 2>/dev/null || true)" = \
    'arena.local-ingest-release@1' ] || return 1
  rm -rf "$candidate"
}

assert_no_online_local_pm2_owner() {
  pm2_command jlist | "$NODE_BIN" -e '
    // arena-stopped-recovery-zero-owner@1
    const appName = process.argv[1]
    let raw = ""
    process.stdin.on("data", (chunk) => { raw += chunk })
    process.stdin.on("end", () => {
      const apps = JSON.parse(raw).filter((app) => app.name === appName ||
        JSON.stringify([app?.pm2_env?.pm_exec_path, app?.pm2_env?.args,
          app?.pm_exec_path, app?.script, app?.args]).includes("ingest-worker.ts"))
      if (apps.length > 1 || apps.some((app) => app.name !== appName ||
          app.pm2_env?.status !== "stopped" || app.pid > 0))
        process.exit(46)
    })
  ' "$PM2_APP"
}

assert_no_online_local_pm2_dumps() {
  "$NODE_BIN" -e '
    // arena-stopped-recovery-zero-dump-owner@1
    const fs = require("node:fs")
    const path = require("node:path")
    const [home, appName] = process.argv.slice(1)
    for (const name of ["dump.pm2", "dump.pm2.bak"]) {
      const apps = JSON.parse(fs.readFileSync(path.join(home, name), "utf8"))
      const matches = apps.filter((app) => app?.name === appName ||
        JSON.stringify([app?.pm_exec_path, app?.args, app?.script]).includes("ingest-worker.ts"))
      if (matches.length > 1 || matches.some((app) => app.name !== appName ||
          app.status !== "stopped")) process.exit(47)
    }
  ' "$PM2_HOME_VALUE" "$PM2_APP" >/dev/null
}

quarantine_stopped_local_recovery() {
  local ok=1 active_pid active_tree=''
  assert_local_lock || return 1
  active_pid="$(pm2_command pid "$PM2_APP" 2>/dev/null | tr -d '[:space:]' || true)"
  if [[ "$active_pid" =~ ^[1-9][0-9]*$ ]]; then
    active_tree="$(process_tree_pids "$active_pid" 2>/dev/null || printf '%s\n' "$active_pid")"
  fi
  pm2_command stop "$PM2_APP" >/dev/null 2>&1 || true
  if [ -n "$active_tree" ]; then
    wait_for_pid_set_exit "$active_tree" || ok=0
  fi
  assert_no_online_local_pm2_owner || ok=0
  pm2_command save --force >/dev/null || ok=0
  pm2_command save --force >/dev/null || ok=0
  assert_no_online_local_pm2_dumps || ok=0
  assert_no_local_ingest_os_process || ok=0
  arm_local_recovery_holds || ok=0
  assert_local_lock || ok=0
  rm -f "$RECOVERY_GO_CONSUMED" || ok=0
  [ ! -e "$RECOVERY_GO_CONSUMED" ] && [ ! -L "$RECOVERY_GO_CONSUMED" ] || ok=0
  assert_local_lock || ok=0
  if [ "$ok" = 1 ]; then
    STOPPED_RECOVERY_QUARANTINED=1
    echo '✗ stopped-recovery candidate quarantined; worker remains stopped and both holds remain armed' >&2
    return 0
  fi
  echo '✗✗ stopped-recovery quarantine is incomplete; both holds were re-armed where possible' >&2
  return 1
}

finish_deploy() {
  local status=$? candidate
  trap - EXIT INT TERM
  set +e
  if [ "$status" -ne 0 ] && [ "$DEPLOY_SUCCEEDED" = 0 ]; then
    if { [ "$RECOVER_FROM_STOPPED" = 0 ] || [ "$STOPPED_RECOVERY_SESSION" = 1 ]; } && \
       { [ -e "$INCIDENT_HOLD_FILE" ] || [ -L "$INCIDENT_HOLD_FILE" ]; }; then
      quarantine_stopped_local_recovery || status=1
    elif [ "$STOPPED_RECOVERY_SESSION" = 1 ]; then
      quarantine_stopped_local_recovery || status=1
    elif [ "$RECOVERY_REQUIRED" = 1 ]; then
      if ! recover_previous_release; then
        status=1
        write_failed_recovery_block || \
          echo '✗✗ unable to update the durable recovery record; preserving existing journal' >&2
        echo "✗✗ further local deploys blocked: $RECOVERY_BLOCK_FILE" >&2
      fi
    fi
  fi
  if [ -d "$STAGING_DIR" ] && [ ! -L "$STAGING_DIR" ]; then
    rm -rf "$STAGING_DIR"
  fi
  if [ "$DEPLOY_SUCCEEDED" = 0 ] && [ -n "$RELEASE_DIR" ] && [ -d "$RELEASE_DIR" ]; then
    if [ "$RECOVERY_REQUIRED" = 0 ] || [ "$ROLLBACK_SUCCEEDED" = 1 ]; then
      safe_remove_generated_release "$RELEASE_DIR" || true
    else
      echo "⚠ preserving failed candidate for supervised recovery: $RELEASE_DIR" >&2
    fi
  fi
  if [ "$LOCK_HELD" = 1 ] && [ "$(sed -n '1p' "$LOCK_DIR/owner" 2>/dev/null)" = "$LOCK_TOKEN" ]; then
    rm -f "$RECOVERY_GO_CONSUMED"
    rm -rf "$LOCK_DIR"
  fi
  exit "$status"
}

acquire_local_lock
trap finish_deploy EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [ "$RECOVER_FROM_STOPPED" = 1 ]; then
  consume_stopped_recovery_go
  prove_stopped_local_baseline || fail 'stopped local baseline proof failed'
else
  assert_no_recovery_block
  assert_no_incident_hold
fi

echo "=== local ingest candidate $SHA ==="
echo '1/8 materializing exact committed runtime inputs'
assert_local_lock
[ ! -e "$STAGING_DIR" ] || fail 'candidate staging path collision'
mkdir "$STAGING_DIR"
archive_worker_release "$STAGING_DIR"
WORKER_RELEASE_ID="$(compute_worker_release_id "$STAGING_DIR/scripts/ci/worker-release-id.mjs")" || \
  fail 'archived worker release identity helper failed'
[[ "$WORKER_RELEASE_ID" =~ ^[0-9a-f]{64}$ ]] || \
  fail 'archived worker release helper returned a malformed identity'
RELEASE_DIR="$RELEASE_ROOT/${SHA:0:12}-${WORKER_RELEASE_ID:0:12}-$TS"
[ ! -e "$RELEASE_DIR" ] || fail 'candidate release path collision'
echo "    release=$WORKER_RELEASE_ID"
printf '%s\n' "$SHA" > "$STAGING_DIR/.DEPLOYED_SHA.tmp"
printf '%s\n' "$WORKER_RELEASE_ID" > "$STAGING_DIR/.WORKER_RELEASE_ID.tmp"
printf '%s\n' 'arena.local-ingest-release@1' > "$STAGING_DIR/.ARENA_LOCAL_RELEASE.tmp"
mv "$STAGING_DIR/.DEPLOYED_SHA.tmp" "$STAGING_DIR/DEPLOYED_SHA"
mv "$STAGING_DIR/.WORKER_RELEASE_ID.tmp" "$STAGING_DIR/WORKER_RELEASE_ID"
mv "$STAGING_DIR/.ARENA_LOCAL_RELEASE.tmp" "$STAGING_DIR/.ARENA_LOCAL_RELEASE"

echo '2/8 installing release-owned dependencies with Node 22'
read -r FREE_KB DISK_USED_PCT <<<"$(df -Pk "$RELEASE_ROOT" | awk 'END {gsub(/%/, "", $5); print $4, $5}')"
[[ "$FREE_KB" =~ ^[0-9]+$ ]] && [[ "$DISK_USED_PCT" =~ ^[0-9]+$ ]] || \
  fail 'unable to determine release storage pressure'
[ "$DISK_USED_PCT" -le 85 ] || \
  fail "local deploy refuses a ${DISK_USED_PCT}% full data volume; reduce it to at most 85%"
[ "$FREE_KB" -ge 5242880 ] || fail 'local deploy requires at least 5 GiB free before install'
INSTALL_HOME="$STAGING_DIR/.install-home"
mkdir "$INSTALL_HOME"
(cd "$STAGING_DIR" && env -i \
  HOME="$INSTALL_HOME" USER="$DEPLOY_USER" LOGNAME="$DEPLOY_LOGNAME" \
  PATH="$(dirname "$NODE_BIN"):/usr/bin:/bin" \
  "$NODE_BIN" "$NPM_CLI" ci)
[ -d "$STAGING_DIR/node_modules" ] && [ ! -L "$STAGING_DIR/node_modules" ] || \
  fail 'candidate node_modules must be a release-owned directory'

echo '3/8 installing and launching release-owned Chromium'
PLAYWRIGHT_DIR="$STAGING_DIR/.playwright-browsers"
env -i HOME="$INSTALL_HOME" USER="$DEPLOY_USER" LOGNAME="$DEPLOY_LOGNAME" \
  PATH="$(dirname "$NODE_BIN"):/usr/bin:/bin" PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_DIR" \
  "$NODE_BIN" "$STAGING_DIR/node_modules/playwright/cli.js" install chromium
[ -d "$PLAYWRIGHT_DIR" ] && [ ! -L "$PLAYWRIGHT_DIR" ] || \
  fail 'candidate Playwright browser directory is unavailable'

echo '4/8 loading critical modules and binding shared runtime state'
(cd "$STAGING_DIR" && env -i HOME="$INSTALL_HOME" PATH="$(dirname "$NODE_BIN"):/usr/bin:/bin" \
  PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_DIR" \
  "$NODE_BIN" node_modules/tsx/dist/cli.mjs --eval '
    (async () => {
      for (const module of ["bullmq","ioredis","pg","ccxt","viem","abitype","luxon","@supabase/supabase-js","dotenv","esbuild","playwright"])
        await import(module)
    })().catch((error) => { console.error(error); process.exit(1) })
  ')
rm -rf "$STAGING_DIR/.arena-ingest" "$STAGING_DIR/worker/logs"
ln -s "$SHARED_STATE_DIR" "$STAGING_DIR/.arena-ingest"
ln -s "$SHARED_LOG_DIR" "$STAGING_DIR/worker/logs"
ln -s "$SHARED_ENV_FILE" "$STAGING_DIR/worker/.env"
[ ! -e "$STAGING_DIR/.env.local" ] || fail 'candidate must not contain .env.local'

if [ "$RECOVER_FROM_STOPPED" = 0 ]; then
  OLD_ROSTER_IDENTITY="$(discover_existing_runtime_identity "$STAGING_DIR" "$OLD_PID")" || \
    fail 'unable to prove the current logical worker identity from Redis'
  IFS=$'\x1f' read -r OLD_NODE_ID OLD_HEARTBEAT_PID <<<"$OLD_ROSTER_IDENTITY"
  [[ "$OLD_NODE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]] || \
    fail 'current Redis-proven logical worker identity is malformed'
  [[ "$OLD_HEARTBEAT_PID" =~ ^[1-9][0-9]*$ ]] || \
    fail 'current Redis-proven heartbeat pid is malformed'
fi

echo '5/8 proving browser and production database readiness before PM2 stop'
(cd "$STAGING_DIR" && env -i \
  HOME="$HOME" USER="$DEPLOY_USER" LOGNAME="$DEPLOY_LOGNAME" NODE_ENV=production \
  PATH="$(dirname "$NODE_BIN"):/usr/bin:/bin" PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_DIR" \
  ARENA_EXPECTED_WORKER_NODE_ID="$OLD_NODE_ID" \
  "$NODE_BIN" node_modules/tsx/dist/cli.mjs worker/preflight-local-release.ts)
read -r FREE_KB DISK_USED_PCT <<<"$(df -Pk "$RELEASE_ROOT" | awk 'END {gsub(/%/, "", $5); print $4, $5}')"
[[ "$FREE_KB" =~ ^[0-9]+$ ]] && [[ "$DISK_USED_PCT" =~ ^[0-9]+$ ]] && \
  [ "$DISK_USED_PCT" -le 87 ] && [ "$FREE_KB" -ge 2097152 ] || \
  fail 'local deploy requires at most 87% disk use and 2 GiB free after candidate preparation'

echo '6/8 rechecking PM2 baseline, lock, and exact main'
assert_local_lock
if [ "$RECOVER_FROM_STOPPED" = 1 ]; then
  prove_stopped_local_baseline || fail 'stopped local baseline changed during candidate preparation'
else
  assert_no_incident_hold
fi
require_exact_main
[ "$(pm2_snapshot)" = "$BASELINE_SNAPSHOT" ] || fail 'PM2 owner changed during candidate preparation'
if [ "$RECOVER_FROM_STOPPED" = 0 ]; then
  [ "$(discover_existing_runtime_identity "$STAGING_DIR" "$OLD_PID")" = "$OLD_ROSTER_IDENTITY" ] || \
    fail 'current Redis-proven worker identity changed during candidate preparation'
fi
[ "$(hash_shared_env)" = "$SHARED_ENV_SHA256" ] || \
  fail 'shared worker environment changed during candidate preparation'
rm -rf "$INSTALL_HOME"
mv "$STAGING_DIR" "$RELEASE_DIR"
PLAYWRIGHT_DIR="$RELEASE_DIR/.playwright-browsers"

DEPLOY_MARKER="arena-local-deploy-$TS-${SHA:0:9}"
DEPLOY_LOG="$RELEASE_DIR/worker/logs/ingest-out.log"

echo '7/8 stopping the exact previous owner and switching PM2 cwd'
if [ "$RECOVER_FROM_STOPPED" = 1 ]; then
  release_local_incident_hold_for_cutover || \
    fail 'stopped-recovery cutover authorization failed'
  RECOVERY_REQUIRED=1
  pm2_command delete "$PM2_APP" >/dev/null 2>&1 || \
    fail 'unable to remove the stopped PM2 baseline'
  wait_for_pm2_absent 0 || fail 'stopped PM2 baseline was not removed exactly'
  pm2_command save --force >/dev/null || fail 'unable to clear the primary PM2 resurrection state'
  pm2_command save --force >/dev/null || fail 'unable to clear the backup PM2 resurrection state'
  assert_no_online_local_pm2_dumps || fail 'PM2 resurrection state still contains an active ingest owner'
else
  assert_no_incident_hold
  OLD_PROCESS_TREE="$(process_tree_pids "$OLD_PID")" || \
    fail 'unable to capture the complete previous process tree'
  printf '%s\n' "$OLD_PROCESS_TREE" | grep -Fqx "$OLD_HEARTBEAT_PID" || \
    fail 'Redis-proven heartbeat pid is not in the previous process tree'
  write_cutover_journal || fail 'unable to persist the pre-cutover recovery journal'
  RECOVERY_REQUIRED=1
  pm2_command stop "$PM2_APP" >/dev/null
  wait_for_pid_set_exit "$OLD_PROCESS_TREE" || fail 'a previous worker descendant did not stop'
  wait_for_profile_owners_exit "$OLD_CWD" || fail 'a previous browser still owns a shared profile'
  pm2_command delete "$PM2_APP" >/dev/null 2>&1 || true
  wait_for_pm2_absent "$OLD_PID" || fail 'previous PM2 owner was not deleted exactly'
fi
assert_local_lock
assert_no_incident_hold
printf '%s\n' "$DEPLOY_MARKER" >> "$DEPLOY_LOG"
CANDIDATE_EXEC_PATH="$RELEASE_DIR/worker/src/ingest-worker.ts"
CANDIDATE_ARGS_JSON='[]'
CANDIDATE_EXEC_MODE='fork_mode'
CANDIDATE_INSTANCES='1'
CANDIDATE_LOADER="$RELEASE_DIR/node_modules/tsx/dist/loader.mjs"
CANDIDATE_NODE_ARGS_JSON="$("$NODE_BIN" -e '
  process.stdout.write(JSON.stringify(["--max-old-space-size=2560", "--import", process.argv[1]]))
' "$CANDIDATE_LOADER")" || fail 'unable to construct the exact candidate Node arguments'
HEARTBEAT_NOT_BEFORE_MS="$("$NODE_BIN" -p 'Date.now()')" || \
  fail 'unable to capture the candidate start boundary'
[[ "$HEARTBEAT_NOT_BEFORE_MS" =~ ^[1-9][0-9]*$ ]] || \
  fail 'candidate start boundary is malformed'
assert_no_incident_hold
start_release_config "$RELEASE_DIR" "$NODE_BIN" \
  "$RELEASE_DIR/worker/ecosystem.local-ingest.config.cjs"
NEW_PID="$(wait_for_pm2_exact "$RELEASE_DIR" "$NODE_BIN" "$CANDIDATE_EXEC_PATH" \
  "$CANDIDATE_ARGS_JSON" "$CANDIDATE_EXEC_MODE" "$CANDIDATE_INSTANCES" \
  "$CANDIDATE_NODE_ARGS_JSON" 0)" || \
  fail 'candidate did not become the exact PM2 owner'
NEW_PROCESS_TREE="$(process_tree_pids "$NEW_PID")" || \
  fail 'unable to capture the candidate process tree'

echo '8/8 requiring fresh exact identity and committing PM2 state'
assert_no_incident_hold
wait_for_stamped_ready native "$DEPLOY_MARKER" "$DEPLOY_LOG" \
  "$SHA" "$WORKER_RELEASE_ID" "$OLD_NODE_ID" "$NEW_PID" || \
  fail 'candidate lacks ordered database, heartbeat, local authority, and ready evidence'
(cd "$RELEASE_DIR" && env -i \
  HOME="$HOME" USER="$DEPLOY_USER" LOGNAME="$DEPLOY_LOGNAME" NODE_ENV=production \
  PATH="$(dirname "$NODE_BIN"):/usr/bin:/bin" \
  "$NODE_BIN" node_modules/tsx/dist/cli.mjs worker/verify-local-heartbeat.ts \
  "$NEW_PID" "$SHA" "$WORKER_RELEASE_ID" "$OLD_NODE_ID" "$HEARTBEAT_NOT_BEFORE_MS") || \
  fail 'candidate lacks a fresh exact Redis roster identity'
assert_no_incident_hold
[ "$(hash_shared_env)" = "$SHARED_ENV_SHA256" ] || \
  fail 'shared worker environment changed during cutover verification'
require_candidate_stability || fail 'candidate was not stable for the configured minimum uptime'
assert_no_incident_hold
require_exact_main
assert_no_incident_hold
[ "$(wait_for_pm2_exact "$RELEASE_DIR" "$NODE_BIN" "$CANDIDATE_EXEC_PATH" \
  "$CANDIDATE_ARGS_JSON" "$CANDIDATE_EXEC_MODE" "$CANDIDATE_INSTANCES" \
  "$CANDIDATE_NODE_ARGS_JSON" 0)" = "$NEW_PID" ] || \
  fail 'candidate PM2 identity changed during readiness verification'
assert_no_incident_hold
pm2_command save >/dev/null
assert_no_incident_hold
clear_recovery_journal || fail 'candidate committed but the durable cutover journal could not be cleared'
if [ "$RECOVER_FROM_STOPPED" = 1 ]; then
  assert_local_lock
  rm -f "$RECOVERY_GO_CONSUMED" || fail 'unable to destroy the consumed stopped-recovery confirmation'
  [ ! -e "$RECOVERY_GO_CONSUMED" ] && [ ! -L "$RECOVERY_GO_CONSUMED" ] || \
    fail 'consumed stopped-recovery confirmation still exists'
  assert_local_lock
fi
DEPLOY_SUCCEEDED=1
RECOVERY_REQUIRED=0

# Retain the current and immediate previous release. Delete only directories
# bearing this script's exact marker, and never remove a cwd referenced by any
# PM2 app (including the separate legacy arena-worker).
if PM2_REFERENCED_CWDS="$(pm2_referenced_cwds)"; then
  for candidate in "$RELEASE_ROOT"/*; do
    [ "$candidate" = "$RELEASE_DIR" ] && continue
    [ "$candidate" = "$OLD_CWD" ] && continue
    [ -d "$candidate" ] || continue
    referenced=0
    while IFS= read -r referenced_cwd; do
      [ "$candidate" = "$referenced_cwd" ] && referenced=1
    done <<<"$PM2_REFERENCED_CWDS"
    [ "$referenced" = 1 ] && continue
    safe_remove_generated_release "$candidate" || true
  done
else
  echo '⚠ unable to enumerate all PM2 cwd references; skipping old-release cleanup' >&2
fi

echo "✓ local deploy complete: pid=$NEW_PID sha=$SHA release=$WORKER_RELEASE_ID cwd=$RELEASE_DIR"
