#!/usr/bin/env bash
# Offline contract and behavior tests for the transactional Mac Mini ingest
# deploy. Every production-facing executable is replaced with an exported Bash
# function. The tests may create disposable local directories, but they never
# invoke real PM2, npm, SSH, or a database connection.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEPLOY_SCRIPT="$ROOT/worker/deploy-ingest-local.sh"
TEST_SHA='0123456789abcdef0123456789abcdef01234567'
OTHER_SHA='89abcdef0123456789abcdef0123456789abcdef'
TEST_RELEASE="$(printf 'a%.0s' {1..64})"
OLD_SHA="$(printf 'f%.0s' {1..40})"
OLD_RELEASE="$(printf 'e%.0s' {1..64})"
export TEST_SHA OTHER_SHA TEST_RELEASE OLD_SHA OLD_RELEASE

fail() {
  echo "not ok - $*" >&2
  exit 1
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local label="$3"
  [[ "$haystack" == *"$needle"* ]] || fail "$label (missing: $needle)"
}

assert_not_contains() {
  local haystack="$1"
  local needle="$2"
  local label="$3"
  [[ "$haystack" != *"$needle"* ]] || fail "$label (unexpected: $needle)"
}

assert_matches() {
  local haystack="$1"
  local pattern="$2"
  local label="$3"
  grep -Eq -- "$pattern" <<<"$haystack" || fail "$label (pattern: $pattern)"
}

emit_test_archive() {
  command tar -cf - \
    .npmrc package.json package-lock.json tsconfig.json \
    scripts/ci/worker-release-id.mjs lib worker
}
export -f emit_test_archive

write_function_wrapper() {
  local path="$1"
  local function_name="$2"
  mkdir -p "$(dirname "$path")"
  {
    printf '%s\n' '#!/usr/bin/env bash'
    printf 'export EVENT_LOG=%q\n' "$EVENT_LOG"
    printf 'export ACTIVE_CWD_FILE=%q\n' "$ACTIVE_CWD_FILE"
    printf 'export OLD_CWD=%q\n' "$OLD_CWD"
    printf 'export CANDIDATE_FAILED_FILE=%q\n' "$CANDIDATE_FAILED_FILE"
    printf 'export TEST_SHA=%q\n' "$TEST_SHA"
    printf 'export TEST_RELEASE=%q\n' "$TEST_RELEASE"
    printf 'export FAKE_NODE_PATH=%q\n' "${FAKE_NODE_PATH:-}"
    printf 'export FAKE_PM2_PATH=%q\n' "${FAKE_PM2_PATH:-}"
    printf 'export FAKE_GIT_COMMON_DIR=%q\n' "${FAKE_GIT_COMMON_DIR:-}"
    printf 'export ROOT=%q\n' "$ROOT"
    printf 'export FAIL_FIRST_CANDIDATE_READY=%q\n' \
      "${FAIL_FIRST_CANDIDATE_READY:-0}"
    printf 'export FAIL_ROLLBACK_START=%q\n' "${FAIL_ROLLBACK_START:-0}"
    printf 'export FAIL_ROLLBACK_AFTER_REDIS=%q\n' "${FAIL_ROLLBACK_AFTER_REDIS:-0}"
    printf 'export ROLLBACK_REDIS_PASSED_FILE=%q\n' \
      "${ROLLBACK_REDIS_PASSED_FILE:-}"
    printf 'export ROLLBACK_RESTARTED_FILE=%q\n' "${ROLLBACK_RESTARTED_FILE:-}"
    printf 'export FAIL_FINAL_STAMPED_PROOF=%q\n' "${FAIL_FINAL_STAMPED_PROOF:-0}"
    printf 'export STAMPED_PROOF_COUNT_FILE=%q\n' "${STAMPED_PROOF_COUNT_FILE:-}"
    printf 'export FAKE_HEARTBEAT_PID=%q\n' "${FAKE_HEARTBEAT_PID:-4243}"
    printf 'export FAKE_PM2_RESTARTS=%q\n' "${FAKE_PM2_RESTARTS:-0}"
    printf 'export DEAD_PID=%q\n' "${DEAD_PID:-}"
    printf 'export FAIL_PM2_STOP_BEFORE_MUTATION=%q\n' \
      "${FAIL_PM2_STOP_BEFORE_MUTATION:-0}"
    printf 'export BASELINE_RECOVERY_STARTED_FILE=%q\n' \
      "${BASELINE_RECOVERY_STARTED_FILE:-}"
    printf 'export FAIL_BASELINE_DURING_STABILITY=%q\n' \
      "${FAIL_BASELINE_DURING_STABILITY:-0}"
    printf 'export BASELINE_SNAPSHOT_COUNT_FILE=%q\n' \
      "${BASELINE_SNAPSHOT_COUNT_FILE:-}"
    printf 'export LOSE_LOCK_DURING_ROLLBACK_STABILITY=%q\n' \
      "${LOSE_LOCK_DURING_ROLLBACK_STABILITY:-0}"
    printf 'export FAKE_LOCK_DIR=%q\n' "${FAKE_LOCK_DIR:-}"
    printf 'export LOCK_LOST_FILE=%q\n' "${LOCK_LOST_FILE:-}"
    printf 'export LEGACY_ROLLBACK_DISCOVERY_COUNT_FILE=%q\n' \
      "${LEGACY_ROLLBACK_DISCOVERY_COUNT_FILE:-}"
    printf 'export REPLACE_FINAL_LEGACY_CHILD=%q\n' \
      "${REPLACE_FINAL_LEGACY_CHILD:-0}"
    printf 'export FAIL_LEGACY_DISCOVERY_AFTER_CANDIDATE=%q\n' \
      "${FAIL_LEGACY_DISCOVERY_AFTER_CANDIDATE:-0}"
    printf 'export REQUIRE_DISCOVERY_TIMEOUT_BUDGET=%q\n' \
      "${REQUIRE_DISCOVERY_TIMEOUT_BUDGET:-0}"
    printf 'export DISCOVERY_BUDGET_SEEN_FILE=%q\n' \
      "${DISCOVERY_BUDGET_SEEN_FILE:-}"
    printf 'export FAKE_DISCOVERY_DELAY_SECONDS=%q\n' \
      "${FAKE_DISCOVERY_DELAY_SECONDS:-1}"
    printf 'export FAKE_NOW_COUNTER_FILE=%q\n' "${FAKE_NOW_COUNTER_FILE:-}"
    printf 'export STAMPED_BOUNDARY_LOG_FILE=%q\n' \
      "${STAMPED_BOUNDARY_LOG_FILE:-}"
    printf 'export REQUIRE_STAMPED_BOUNDARY_CURRENT=%q\n' \
      "${REQUIRE_STAMPED_BOUNDARY_CURRENT:-0}"
    printf 'export FINAL_REDIS_MARKER_FILE=%q\n' \
      "${FINAL_REDIS_MARKER_FILE:-}"
    printf 'export LOSE_LOCK_AT_ROLLBACK_PHASE=%q\n' \
      "${LOSE_LOCK_AT_ROLLBACK_PHASE:-}"
    printf 'export FAKE_MODULE_STATUS=%q\n' "${FAKE_MODULE_STATUS:-0}"
    printf 'export FAKE_PREFLIGHT_STATUS=%q\n' "${FAKE_PREFLIGHT_STATUS:-0}"
    printf 'export FAKE_RESIDUAL_INGEST_PROCESS=%q\n' \
      "${FAKE_RESIDUAL_INGEST_PROCESS:-0}"
    declare -f fail emit_test_archive fake_npm_ci fake_git_environment fake_git_provenance \
      "$function_name"
    printf '%s "$@"\n' "$function_name"
  } > "$path"
  chmod +x "$path"
}

install_fake_command_wrappers() {
  local tmp="$1"
  export FAKE_NODE_PATH="$tmp/bin/node"
  export FAKE_PM2_PATH="$tmp/bin/pm2"
  export FAKE_GIT_COMMON_DIR="$tmp/fake-git-common"
  mkdir -p "$tmp/bin" "$tmp/pm2-home" "$FAKE_GIT_COMMON_DIR/objects/info"
  printf '%s\n' '// fake npm CLI; interpreted only by the fake Node command' > \
    "$tmp/bin/npm-cli.js"
  write_function_wrapper "$FAKE_NODE_PATH" fake_node
  write_function_wrapper "$FAKE_PM2_PATH" fake_pm2
  write_function_wrapper "$tmp/bin/git" git
}

fake_git_provenance() {
  local destination
  case "$*" in
    *'rev-parse --show-toplevel'*) printf '%s\n' "$ROOT" ;;
    *'remote get-url origin'*) printf '%s\n' 'git@github.com:Adeline117/ranking-arena.git' ;;
    *'rev-parse --git-common-dir'*) printf '%s\n' "$FAKE_GIT_COMMON_DIR" ;;
    *'init --bare --quiet '*)
      destination="${!#}"
      mkdir -p "$destination/objects" "$destination/refs"
      ;;
    *) return 64 ;;
  esac
}

fake_git_environment() {
  local forbidden
  [ "${GIT_ATTR_NOSYSTEM:-}" = 1 ] || fail 'fake Git requires system attributes disabled'
  [ "${GIT_CONFIG_NOSYSTEM:-}" = 1 ] || fail 'fake Git requires system config disabled'
  [ "${GIT_CONFIG_GLOBAL:-}" = /dev/null ] || fail 'fake Git requires global config disabled'
  for forbidden in GIT_WORK_TREE GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG_COUNT \
    GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0 GIT_CONFIG_SYSTEM; do
    [ -z "${!forbidden:-}" ] || fail "hostile $forbidden leaked into fake Git"
  done
  case "$*" in
    *archive*)
      [[ "${GIT_DIR:-}" = */.arena-isolated-git ]] || \
        fail 'archive must use an isolated bare GIT_DIR'
      [ "${GIT_OBJECT_DIRECTORY:-}" = "$FAKE_GIT_COMMON_DIR/objects" ] || \
        fail 'archive must use only the proven object directory'
      [ "${GIT_NO_REPLACE_OBJECTS:-}" = 1 ] || \
        fail 'archive must disable replacement objects'
      [ "${GIT_OPTIONAL_LOCKS:-}" = 0 ] || \
        fail 'archive must disable optional repository locks'
      ;;
    *)
      [ -z "${GIT_DIR:-}" ] || fail 'repository command inherited a foreign GIT_DIR'
      [ -z "${GIT_OBJECT_DIRECTORY:-}" ] || \
        fail 'repository command inherited a foreign object directory'
      ;;
  esac
}

fake_npm_ci() {
  printf 'npm cwd=%s args=ci\n' "$PWD" >> "$EVENT_LOG"
  mkdir -p \
    "$PWD/node_modules/tsx/dist" \
    "$PWD/node_modules/playwright" \
    "$PWD/node_modules/.bin" \
    "$PWD/.playwright-browsers/chromium-test"
  printf '%s\n' 'export {}' > "$PWD/node_modules/tsx/dist/cli.mjs"
  printf '%s\n' 'export {}' > "$PWD/node_modules/tsx/dist/loader.mjs"
  printf '%s\n' 'export {}' > "$PWD/node_modules/playwright/cli.js"
  printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$PWD/node_modules/.bin/tsx"
  printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$PWD/node_modules/.bin/playwright"
  chmod +x "$PWD/node_modules/.bin/tsx" "$PWD/node_modules/.bin/playwright"
}

make_old_release() {
  local release_root="$1"
  local shared_dir="$2"
  local old_dir="$3"
  mkdir -p \
    "$release_root" \
    "$shared_dir/.arena-ingest" \
    "$shared_dir/worker/logs" \
    "$shared_dir/worker" \
    "$old_dir/worker" \
    "$old_dir/worker/src" \
    "$old_dir/node_modules/tsx/dist" \
    "$old_dir/.playwright-browsers/chromium-test"
  printf '%s\n' \
    'WORKER_NODE_ID=mac-mini' \
    'INGEST_LOCAL_REGION=local' \
    'INGEST_REGIONS=local' \
    'INGEST_ATTEMPT_BOUND_CAPTURE_ENABLED=true' \
    'REDIS_URL=rediss://offline.invalid:6380' \
    > "$shared_dir/worker/.env"
  chmod 600 "$shared_dir/worker/.env"
  printf '%s\n' "$OLD_SHA" > "$old_dir/DEPLOYED_SHA"
  printf '%s\n' "$OLD_RELEASE" > "$old_dir/WORKER_RELEASE_ID"
  printf '%s\n' 'export {}' > "$old_dir/node_modules/tsx/dist/cli.mjs"
  printf '%s\n' 'export {}' > "$old_dir/node_modules/tsx/dist/loader.mjs"
  printf '%s\n' 'export {}' > "$old_dir/worker/src/ingest-worker.ts"
  chmod +x "$old_dir/node_modules/tsx/dist/cli.mjs"
  ln -s "$shared_dir/.arena-ingest" "$old_dir/.arena-ingest"
  ln -s "$shared_dir/worker/logs" "$old_dir/worker/logs"
  ln -s "$shared_dir/worker/.env" "$old_dir/worker/.env"
  cp "$ROOT/worker/ecosystem.local-ingest.config.cjs" \
    "$old_dir/worker/ecosystem.local-ingest.config.cjs"
}

install_common_fake_functions() {
  git() {
    local provenance_status
    fake_git_environment "$@"
    printf 'git %s\n' "$*" >> "$EVENT_LOG"
    if fake_git_provenance "$@"; then return 0; else provenance_status=$?; fi
    [ "$provenance_status" -eq 64 ] || return "$provenance_status"
    case "$*" in
      *'fetch --force --no-tags origin refs/heads/main:refs/remotes/origin/main'*) return 0 ;;
      *'hash-object'*deploy-ingest-local.sh*) printf '%s\n' "$TEST_SHA" ;;
      *'rev-parse'*) printf '%s\n' "$TEST_SHA" ;;
      *'ls-tree'*worker/deploy-ingest-local.sh*)
        printf '100755 blob %s\tworker/deploy-ingest-local.sh\n' "$TEST_SHA"
        ;;
      *'ls-tree -r --name-only'*)
        printf '%s\n' .npmrc package.json package-lock.json tsconfig.json \
          scripts/ci/worker-release-id.mjs worker/deploy-ingest-local.sh
        ;;
      *'ls-tree -r '*' -- .npmrc'*)
        printf '100644 blob %s\t.npmrc\n' "$TEST_SHA"
        printf '100755 blob %s\tworker/deploy-ingest-local.sh\n' "$TEST_SHA"
        ;;
      *'archive'*) emit_test_archive ;;
      *) fail "unexpected fake git invocation: $*" ;;
    esac
  }

  npm() {
    [ "${1:-}" = ci ] || fail "only npm ci is allowed in deploy tests: $*"
    fake_npm_ci
  }

  npx() {
    printf 'npx cwd=%s args=%s\n' "$PWD" "$*" >> "$EVENT_LOG"
    mkdir -p "${PLAYWRIGHT_BROWSERS_PATH:-$PWD/.playwright-browsers}/chromium-test"
  }

  df() {
    printf '%s\n' \
      'Filesystem 1024-blocks Used Available Capacity Mounted on' \
      '/dev/fake 100000000 1000 99999000 1% /tmp'
  }

  ssh() { fail "local deployment must never invoke SSH: $*"; }
  scp() { fail "local deployment must never invoke SCP: $*"; }
  rsync() { fail "local deployment must never invoke rsync: $*"; }
  docker() {
    [ "${1:-}" = ps ] || fail "unexpected fake Docker invocation: $*"
    return 0
  }
  kill() {
    local signal="${1:-}" pid="${2:-}"
    if [ "$signal" = -0 ] && [[ "$pid" =~ ^[1-9][0-9]*$ ]]; then
      [ -z "${DEAD_PID:-}" ] || [ "$pid" != "$DEAD_PID" ] || return 1
      case "$pid" in
        4242|4243|4343|5252)
          [ ! -e "$ACTIVE_CWD_FILE.absent" ] && [ ! -e "$ACTIVE_CWD_FILE.stopped" ]
          ;;
        *) builtin kill "$@" ;;
      esac
      return
    fi
    builtin kill "$@"
  }
  ps() {
    printf 'ps %s\n' "$*" >> "$EVENT_LOG"
    case "$*" in
      *'-axo pid=,ppid='*)
        printf '%s\n' '1 0' '4242 1' '4243 4242'
        ;;
      *'-axo pid=,command='*)
        printf '%s\n' '1 /sbin/launchd'
        if [ "${FAKE_RESIDUAL_INGEST_PROCESS:-0}" = 1 ]; then
          printf '%s\n' '777 /usr/bin/node /tmp/release/worker/src/ingest-worker.ts'
        fi
        ;;
      *'-p 4243'*) printf '%s\n' 4242 ;;
      *'-p 4343'*) printf '%s\n' 4242 ;;
      *'-p 4242'*) printf '%s\n' 1 ;;
      *) fail "unexpected fake ps invocation: $*" ;;
    esac
  }

  fake_node() {
    local joined="$*" proof_count heartbeat_pid discovery_count request_timeout snapshot_count
    local fake_restarts boundary fake_now
    printf 'node cwd=%s args=%s\n' "$PWD" "$joined" >> "$EVENT_LOG"
    case "$joined" in
      *worker-release-id.mjs*) printf '%s\n' "$TEST_RELEASE" ;;
      *process.versions.node*process.arch*) printf '%s\n' '22 arm64 darwin' ;;
      *crypto.createHash*sha256*) printf '%s' "$TEST_RELEASE" ;;
      *'rows.some'*'const children'*) printf '%s\n' 4242 4243 ;;
      *releasePrefix*sharedPrefix*)
        while IFS= read -r _; do :; done
        ;;
      *verify-local-heartbeat.ts*--discover-existing*|*discover-local*|*discover*worker*node*)
        heartbeat_pid="${FAKE_HEARTBEAT_PID:-4243}"
        if [ -e "$CANDIDATE_FAILED_FILE" ] && \
          [ -n "${LEGACY_ROLLBACK_DISCOVERY_COUNT_FILE:-}" ]; then
          discovery_count="$(sed -n '1p' "$LEGACY_ROLLBACK_DISCOVERY_COUNT_FILE" \
            2>/dev/null || true)"
          [[ "$discovery_count" =~ ^[0-9]+$ ]] || discovery_count=0
          discovery_count=$((discovery_count + 1))
          printf '%s\n' "$discovery_count" > "$LEGACY_ROLLBACK_DISCOVERY_COUNT_FILE"
          if [ "${REPLACE_FINAL_LEGACY_CHILD:-0}" = 1 ] && \
            [ "$discovery_count" -ge 2 ]; then
            heartbeat_pid=4343
          fi
        fi
        if [ "${FAIL_LEGACY_DISCOVERY_AFTER_CANDIDATE:-0}" = 1 ] && \
          [ -e "$CANDIDATE_FAILED_FILE" ]; then
          if [ "${REQUIRE_DISCOVERY_TIMEOUT_BUDGET:-0}" = 1 ]; then
            request_timeout="${!#}"
            [[ "$request_timeout" =~ ^[1-9][0-9]*$ ]] && \
              [ "$request_timeout" -le 90000 ] || return 80
            [ -n "${DISCOVERY_BUDGET_SEEN_FILE:-}" ] && \
              printf '%s\n' "$request_timeout" >> "$DISCOVERY_BUDGET_SEEN_FILE"
          fi
          sleep "${FAKE_DISCOVERY_DELAY_SECONDS:-1}"
          return 79
        fi
        if [ "${FAIL_ROLLBACK_AFTER_REDIS:-0}" = 1 ] && \
          [ -e "$CANDIDATE_FAILED_FILE" ] && [ -n "${ROLLBACK_REDIS_PASSED_FILE:-}" ]; then
          : > "$ROLLBACK_REDIS_PASSED_FILE"
        fi
        printf '%s\n' \
          '[redis] offline fake connection ready' \
          $'ARENA_LOCAL_EXISTING_ROSTER\tmac-mini\t'"$heartbeat_pid"
        ;;
      *'new Set'*pm_cwd*)
        while IFS= read -r _; do :; done
        if [ -s "$ACTIVE_CWD_FILE" ] && [ ! -e "$ACTIVE_CWD_FILE.absent" ]; then
          printf '%s\n' "$(<"$ACTIVE_CWD_FILE")"
        fi
        ;;
      *'matches.length === 0'*)
        while IFS= read -r _; do :; done
        [ -e "$ACTIVE_CWD_FILE.absent" ] && return 0
        return 46
        ;;
      *arena-stopped-recovery-zero-owner@1*)
        while IFS= read -r _; do :; done
        [ -e "$ACTIVE_CWD_FILE.stopped" ] || [ -e "$ACTIVE_CWD_FILE.absent" ]
        ;;
      *arena-stopped-recovery-zero-dump-owner@1*|*arena-stopped-recovery-stopped-dumps@1*)
        return 0
        ;;
      *'const appName'*pm_cwd*|*'const apps'*pm_cwd*)
        while IFS= read -r _; do :; done
        if [ -n "${FINAL_REDIS_MARKER_FILE:-}" ] && \
          [ -e "$FINAL_REDIS_MARKER_FILE" ]; then
          printf '%s\n' 'rollback final-pm2' >> "$EVENT_LOG"
          if [ "${LOSE_LOCK_AT_ROLLBACK_PHASE:-}" = after_final_pm2 ]; then
            rm -f "$FAKE_LOCK_DIR/owner"
            [ -n "${LOCK_LOST_FILE:-}" ] && : > "$LOCK_LOST_FILE"
          fi
        fi
        if [ -e "$ACTIVE_CWD_FILE.stopped" ] && [ -s "$ACTIVE_CWD_FILE" ]; then
          printf '0\037stopped\037%s\037%s\037%s/worker/src/ingest-worker.ts\037%s\037[]\037["--max-old-space-size=2560","--import","%s/node_modules/tsx/dist/loader.mjs"]\037fork_mode\0371\n' \
            "$(<"$ACTIVE_CWD_FILE")" "$FAKE_NODE_PATH" "$(<"$ACTIVE_CWD_FILE")" \
            "${FAKE_PM2_RESTARTS:-0}" "$(<"$ACTIVE_CWD_FILE")"
          return 0
        fi
        if [ "${FAIL_BASELINE_DURING_STABILITY:-0}" = 1 ] && \
          [ -n "${BASELINE_RECOVERY_STARTED_FILE:-}" ] && \
          [ -e "$BASELINE_RECOVERY_STARTED_FILE" ]; then
          snapshot_count="$(sed -n '1p' "$BASELINE_SNAPSHOT_COUNT_FILE" 2>/dev/null || true)"
          [[ "$snapshot_count" =~ ^[0-9]+$ ]] || snapshot_count=0
          snapshot_count=$((snapshot_count + 1))
          printf '%s\n' "$snapshot_count" > "$BASELINE_SNAPSHOT_COUNT_FILE"
          [ "$snapshot_count" -lt 5 ] || return 41
        fi
        if [ "${LOSE_LOCK_DURING_ROLLBACK_STABILITY:-0}" = 1 ] && \
          [ -n "${ROLLBACK_REDIS_PASSED_FILE:-}" ] && \
          [ -e "$ROLLBACK_REDIS_PASSED_FILE" ]; then
          rm -f "$FAKE_LOCK_DIR/owner"
          [ -n "${LOCK_LOST_FILE:-}" ] && : > "$LOCK_LOST_FILE"
        fi
        if [ -s "$ACTIVE_CWD_FILE" ] && [ ! -e "$ACTIVE_CWD_FILE.absent" ]; then
          if [ "${FAIL_ROLLBACK_AFTER_REDIS:-0}" = 1 ] && \
            [ -n "${ROLLBACK_REDIS_PASSED_FILE:-}" ] && \
            [ -e "$ROLLBACK_REDIS_PASSED_FILE" ]; then
            [ -n "${ROLLBACK_RESTARTED_FILE:-}" ] && : > "$ROLLBACK_RESTARTED_FILE"
            printf '5252\037online\037%s\037%s\037%s/worker/src/ingest-worker.ts\0371\037[]\037["--max-old-space-size=2560","--import","%s/node_modules/tsx/dist/loader.mjs"]\037fork_mode\0371\n' \
              "$(<"$ACTIVE_CWD_FILE")" "$FAKE_NODE_PATH" \
              "$(<"$ACTIVE_CWD_FILE")" "$(<"$ACTIVE_CWD_FILE")"
          else
            fake_restarts="${FAKE_PM2_RESTARTS:-0}"
            printf '4242\037online\037%s\037%s\037%s/worker/src/ingest-worker.ts\037%s\037[]\037["--max-old-space-size=2560","--import","%s/node_modules/tsx/dist/loader.mjs"]\037fork_mode\0371\n' \
              "$(<"$ACTIVE_CWD_FILE")" "$FAKE_NODE_PATH" \
              "$(<"$ACTIVE_CWD_FILE")" "$fake_restarts" "$(<"$ACTIVE_CWD_FILE")"
          fi
        else
          return 41
        fi
        ;;
      *verify-local-heartbeat.ts*)
        boundary="${!#}"
        if [ -e "$CANDIDATE_FAILED_FILE" ] && [ -n "${STAMPED_PROOF_COUNT_FILE:-}" ]; then
          proof_count="$(sed -n '1p' "$STAMPED_PROOF_COUNT_FILE" 2>/dev/null || true)"
          [[ "$proof_count" =~ ^[0-9]+$ ]] || proof_count=0
          proof_count=$((proof_count + 1))
          printf '%s\n' "$proof_count" > "$STAMPED_PROOF_COUNT_FILE"
          if [ "${FAIL_FINAL_STAMPED_PROOF:-0}" = 1 ] && [ "$proof_count" -ge 2 ]; then
            return 78
          fi
        fi
        if { [ "${FAIL_ROLLBACK_AFTER_REDIS:-0}" = 1 ] || \
          [ "${LOSE_LOCK_DURING_ROLLBACK_STABILITY:-0}" = 1 ]; } && \
          [ -e "$CANDIDATE_FAILED_FILE" ] && [ -n "${ROLLBACK_REDIS_PASSED_FILE:-}" ]; then
          : > "$ROLLBACK_REDIS_PASSED_FILE"
        fi
        if [ -e "$CANDIDATE_FAILED_FILE" ] && \
          [ -n "${STAMPED_BOUNDARY_LOG_FILE:-}" ]; then
          printf '%s\n' "$boundary" >> "$STAMPED_BOUNDARY_LOG_FILE"
          if [ "${REQUIRE_STAMPED_BOUNDARY_CURRENT:-0}" = 1 ]; then
            fake_now="$(sed -n '1p' "$FAKE_NOW_COUNTER_FILE" 2>/dev/null || true)"
            [ "$boundary" = "$fake_now" ] || return 81
          fi
        fi
        if [ -n "${FINAL_REDIS_MARKER_FILE:-}" ] && \
          { { [ -n "${BASELINE_RECOVERY_STARTED_FILE:-}" ] && \
              [ -e "$BASELINE_RECOVERY_STARTED_FILE" ]; } || \
            { [ -e "$CANDIDATE_FAILED_FILE" ] && \
              [ "${proof_count:-0}" -ge 2 ]; }; }; then
          printf 'rollback final-redis boundary=%s\n' "$boundary" >> "$EVENT_LOG"
          : > "$FINAL_REDIS_MARKER_FILE"
          if [ "${LOSE_LOCK_AT_ROLLBACK_PHASE:-}" = after_final_redis ]; then
            rm -f "$FAKE_LOCK_DIR/owner"
            [ -n "${LOCK_LOST_FILE:-}" ] && : > "$LOCK_LOST_FILE"
          fi
        fi
        printf '%s\n' '[local-heartbeat-proof] exact fresh Redis roster identity ready'
        ;;
      *npm-cli.js*' ci') fake_npm_ci ;;
      *fs.renameSync*lock_token*|*lock_token*fs.renameSync*)
        printf '%s\n' \
          "${5:-arena.local-ingest-cutover-journal@1}" \
          "lock_token=${6:-missing}" \
          "phase=${7:-unknown}" \
          "target_sha=${8:-unknown}" \
          "target_release=${9:-unknown}" \
          "candidate_cwd=${10:-unknown}" \
          "old_cwd=${11:-unknown}" \
          "old_sha=${12:-unknown}" \
          "old_release=${13:-legacy}" \
          "old_pid=${14:-unknown}" \
          "old_node=${15:-unknown}" \
          "old_heartbeat_pid=${16:-unknown}" \
          "old_interpreter=${17:-unknown}" \
          "old_entrypoint=${18:-unknown}" \
          "old_args=${19:-unknown}" \
          "old_node_args=${20:-unknown}" \
          "old_exec_mode=${21:-unknown}" \
          "old_instances=${22:-unknown}" \
          "shared_env_sha256=${23:-unknown}" \
          > "${3:?fake recovery record path missing}"
        mv -f "$3" "${4:?fake recovery destination missing}"
        ;;
      *fs.openSync*lock_token*|*lock_token*fs.openSync*)
        printf '%s\n' \
          "${4:-arena.local-ingest-cutover-journal@1}" \
          "lock_token=${5:-missing}" \
          "phase=${6:-unknown}" \
          "target_sha=${7:-unknown}" \
          "target_release=${8:-unknown}" \
          "candidate_cwd=${9:-unknown}" \
          > "${3:?fake recovery record path missing}"
        ;;
      *fs.unlinkSync*)
        printf '%s\n' 'journal unlink' >> "$EVENT_LOG"
        rm -f "${3:?fake recovery target missing}"
        ;;
      *JSON.stringify*max-old-space-size*)
        printf '["--max-old-space-size=2560","--import","%s"]' \
          "${3:?fake loader path missing}"
        ;;
      *Date.now*)
        if [ -n "${FAKE_NOW_COUNTER_FILE:-}" ]; then
          fake_now="$(sed -n '1p' "$FAKE_NOW_COUNTER_FILE" 2>/dev/null || true)"
          [[ "$fake_now" =~ ^[0-9]+$ ]] || fake_now=1999999999000
          fake_now=$((fake_now + 1000))
          printf '%s\n' "$fake_now" > "$FAKE_NOW_COUNTER_FILE"
          printf '%s\n' "$fake_now"
        else
          printf '%s\n' 2000000000000
        fi
        ;;
      *playwright/cli.js*install*)
        mkdir -p "${PLAYWRIGHT_BROWSERS_PATH:-$PWD/.playwright-browsers}/chromium-test"
        ;;
      *preflight-local-release.ts*) [ "${FAKE_PREFLIGHT_STATUS:-0}" -eq 0 ] ;;
      *require.resolve*|*'await import'*|*metric-trust*|*MetricTrust*)
        [ "${FAKE_MODULE_STATUS:-0}" -eq 0 ]
        ;;
      *) return 0 ;;
    esac
  }

  fake_pm2() {
    local command="${1:-}" active config release_dir log_file sha release marker
    printf 'pm2 %s\n' "$*" >> "$EVENT_LOG"
    active="$(<"$ACTIVE_CWD_FILE")"
    case "$command" in
      jlist)
        if [ -e "$ACTIVE_CWD_FILE.absent" ]; then
          printf '%s\n' '[]'
        elif [ -e "$ACTIVE_CWD_FILE.stopped" ]; then
          printf '[{"name":"arena-ingest-worker","pid":0,"pm2_env":{"status":"stopped","pm_cwd":"%s","exec_interpreter":"%s","pm_exec_path":"%s/worker/src/ingest-worker.ts","restart_time":%s,"args":[],"node_args":["--max-old-space-size=2560","--import","%s/node_modules/tsx/dist/loader.mjs"],"exec_mode":"fork_mode","instances":1}}]\n' \
            "$active" "$FAKE_NODE_PATH" "$active" "${FAKE_PM2_RESTARTS:-0}" "$active"
        else
          printf '[{"name":"arena-ingest-worker","pid":4242,"pm2_env":{"status":"online","pm_cwd":"%s","exec_interpreter":"%s","pm_exec_path":"%s/worker/src/ingest-worker.ts","restart_time":%s,"args":[],"node_args":["--max-old-space-size=2560","--import","%s/node_modules/tsx/dist/loader.mjs"],"exec_mode":"fork_mode","instances":1}}]\n' \
            "$active" "$FAKE_NODE_PATH" "$active" "${FAKE_PM2_RESTARTS:-0}" "$active"
        fi
        ;;
      describe|show|status) return 0 ;;
      pid)
        if [ -e "$ACTIVE_CWD_FILE.absent" ] || [ -e "$ACTIVE_CWD_FILE.stopped" ]; then
          printf '%s\n' 0
        else
          printf '%s\n' 4242
        fi
        ;;
      stop)
        if [ "${FAIL_PM2_STOP_BEFORE_MUTATION:-0}" = 1 ]; then
          [ -n "${BASELINE_RECOVERY_STARTED_FILE:-}" ] && \
            : > "$BASELINE_RECOVERY_STARTED_FILE"
          return 72
        fi
        : > "$ACTIVE_CWD_FILE.stopped"
        return 0
        ;;
      save)
        if [ "${LOSE_LOCK_AT_ROLLBACK_PHASE:-}" = after_save ]; then
          rm -f "$FAKE_LOCK_DIR/owner"
          [ -n "${LOCK_LOST_FILE:-}" ] && : > "$LOCK_LOST_FILE"
        fi
        return 0
        ;;
      delete) : > "$ACTIVE_CWD_FILE.absent" ;;
      start)
        config="${2:-}"
        case "$config" in
          */worker/ecosystem.local-ingest.config.cjs)
            release_dir="${config%/worker/ecosystem.local-ingest.config.cjs}"
            ;;
          *)
            release_dir="${ARENA_INGEST_RELEASE_DIR:-$active}"
            ;;
        esac
        if [ "${FAIL_ROLLBACK_START:-0}" = 1 ] && [ "$release_dir" = "$OLD_CWD" ] && \
          [ -e "$CANDIDATE_FAILED_FILE" ]; then
          return 73
        fi
        printf '%s\n' "$release_dir" > "$ACTIVE_CWD_FILE"
        rm -f "$ACTIVE_CWD_FILE.absent" "$ACTIVE_CWD_FILE.stopped"
        log_file="$release_dir/worker/logs/ingest-out.log"
        mkdir -p "$(dirname "$log_file")"
        if [ "${FAIL_FIRST_CANDIDATE_READY:-0}" = 1 ] && \
          [ "$release_dir" != "$OLD_CWD" ] && [ ! -e "$CANDIDATE_FAILED_FILE" ]; then
          : > "$CANDIDATE_FAILED_FILE"
          return 0
        fi
        sha="$(<"$release_dir/DEPLOYED_SHA")"
        release="$(sed -n '1p' "$release_dir/WORKER_RELEASE_ID" 2>/dev/null || true)"
        marker="$(grep 'arena-\(deploy\|rollback\)-' "$log_file" | tail -1 || true)"
        [ -n "$marker" ] || marker='arena-test-marker'
        if [ "$release_dir" != "$OLD_CWD" ]; then
          printf '%s\n' \
            '[ingest-worker] metric-trust database release contract ready' \
            "[heartbeat] redis-hset-committed node=mac-mini pid=4242 sha=$sha release=$release ts=1800000000001" \
            '[ingest-worker] native regional authority ready region=local' \
            '[ingest-worker] ready (regions=local, concurrency=5, fast-lane=off)' \
            >> "$log_file"
        elif [ -n "$release" ]; then
          printf '%s\n' \
            '[ingest-worker] metric-trust database release contract ready' \
            '[ingest-worker] ready (regions=local, concurrency=5)' \
            "[heartbeat] node=mac-mini pid=4242 sha=$sha release=$release" \
            >> "$log_file"
        else
          printf '%s\n' \
            '[ingest-worker] metric-trust database release contract ready' \
            '[ingest-worker] ready (regions=local, concurrency=5)' \
            "[heartbeat] node=mac-mini pid=4242 sha=$sha" \
            >> "$log_file"
        fi
        ;;
      *) fail "unexpected fake PM2 command: $*" ;;
    esac
  }

  export -f git npm npx df ssh scp rsync docker kill ps fake_node fake_pm2 fake_npm_ci fail \
    emit_test_archive
}

run_fake_deploy() {
  local tmp="$1" status
  shift
  invoke_fake_deploy() {
    if [ "${ARENA_RECOVER_TEST:-0}" = 1 ]; then
      "$@" bash "$DEPLOY_SCRIPT" "--target-sha=$TEST_SHA" --recover-from-stopped
    else
      "$@" bash "$DEPLOY_SCRIPT" "--target-sha=$TEST_SHA"
    fi
  }
  # A one-second legacy default can expire on a shell `SECONDS` boundary before
  # the first discovery attempt runs. Ordinary behavior tests get one full
  # retry window; the dedicated deadline test overrides this with 4 seconds.
  ARENA_LOCAL_RELEASE_ROOT="$tmp/releases" \
  ARENA_LOCAL_SHARED_DIR="$tmp/shared" \
  ARENA_LOCAL_LOCK_DIR="$tmp/releases/.arena-ingest-deploy-lock-test" \
  ARENA_GIT_BIN="$tmp/bin/git" \
  ARENA_NODE_BIN="$tmp/bin/node" \
  ARENA_NPM_CLI="$tmp/bin/npm-cli.js" \
  ARENA_PM2_BIN="$tmp/bin/pm2" \
  ARENA_PM2_HOME="$tmp/pm2-home" \
  ARENA_READY_TIMEOUT_SECONDS=1 \
  ARENA_LEGACY_DISCOVERY_TIMEOUT_SECONDS="${ARENA_LEGACY_DISCOVERY_TIMEOUT_SECONDS:-3}" \
  GIT_ATTR_NOSYSTEM=0 GIT_CONFIG_NOSYSTEM=0 \
  GIT_CONFIG_GLOBAL="$tmp/hostile-global-config" \
  GIT_CONFIG_SYSTEM="$tmp/hostile-system-config" \
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.attributesFile \
  GIT_CONFIG_VALUE_0="$tmp/hostile-attributes" \
  GIT_DIR="$tmp/hostile-git-dir" GIT_WORK_TREE="$tmp/hostile-worktree" \
  GIT_OBJECT_DIRECTORY="$tmp/hostile-objects" \
  GIT_ALTERNATE_OBJECT_DIRECTORIES="$tmp/hostile-alternates" \
  invoke_fake_deploy "$@"
  status=$?
  unset -f invoke_fake_deploy
  return "$status"
}

test_non_main_target_fails_before_local_mutation() {
  local tmp event_log old_dir output status events
  tmp="$(mktemp -d)"
  tmp="$(cd "$tmp" && pwd -P)"
  event_log="$tmp/events"
  old_dir="$tmp/releases/$OLD_SHA-$OLD_RELEASE"
  : > "$event_log"
  export EVENT_LOG="$event_log" ACTIVE_CWD_FILE="$tmp/active-cwd"
  export OLD_CWD="$old_dir" CANDIDATE_FAILED_FILE="$tmp/candidate-failed"
  printf '%s\n' "$old_dir" > "$ACTIVE_CWD_FILE"
  make_old_release "$tmp/releases" "$tmp/shared" "$old_dir"
  install_common_fake_functions

  git() {
    local provenance_status
    fake_git_environment "$@"
    printf 'git %s\n' "$*" >> "$EVENT_LOG"
    if fake_git_provenance "$@"; then return 0; else provenance_status=$?; fi
    [ "$provenance_status" -eq 64 ] || return "$provenance_status"
    case "$*" in
      *'fetch --force --no-tags origin refs/heads/main:refs/remotes/origin/main'*) return 0 ;;
      *'rev-parse'*'origin/main'*) printf '%s\n' "$OTHER_SHA" ;;
      *'rev-parse'*) printf '%s\n' "$TEST_SHA" ;;
      *) fail "unexpected git after non-main mismatch: $*" ;;
    esac
  }
  export -f git
  install_fake_command_wrappers "$tmp"

  set +e
  output="$(run_fake_deploy "$tmp" 2>&1)"
  status=$?
  set -e

  [ "$status" -ne 0 ] || fail 'non-main target must fail closed'
  assert_contains "$output" 'not exact origin/main' \
    'target mismatch must be explicit'
  events="$(<"$event_log")"
  [[ "$events" != *'archive'* ]] || \
    fail 'target mismatch must precede source materialization'
  assert_not_contains "$events" 'npm cwd=' 'target mismatch must precede candidate install'
  assert_not_contains "$events" 'pm2 stop' 'target mismatch must precede PM2 stop'
  [ ! -e "$tmp/releases/.arena-ingest-deploy-lock-test" ] || \
    fail 'target mismatch must precede deploy lock mutation'
  rm -rf "$tmp"
  echo 'ok - stale or unreviewed target fails before local mutation'
}

test_dirty_or_stale_orchestrator_fails_before_local_mutation() {
  local tmp old_dir output status events
  tmp="$(mktemp -d)"
  tmp="$(cd "$tmp" && pwd -P)"
  old_dir="$tmp/releases/$OLD_SHA-$OLD_RELEASE"
  export EVENT_LOG="$tmp/events" ACTIVE_CWD_FILE="$tmp/active-cwd"
  export OLD_CWD="$old_dir" CANDIDATE_FAILED_FILE="$tmp/candidate-failed"
  : > "$EVENT_LOG"
  printf '%s\n' "$old_dir" > "$ACTIVE_CWD_FILE"
  make_old_release "$tmp/releases" "$tmp/shared" "$old_dir"
  install_common_fake_functions
  git() {
    local provenance_status
    fake_git_environment "$@"
    printf 'git %s\n' "$*" >> "$EVENT_LOG"
    if fake_git_provenance "$@"; then return 0; else provenance_status=$?; fi
    [ "$provenance_status" -eq 64 ] || return "$provenance_status"
    case "$*" in
      *'fetch --force --no-tags origin refs/heads/main:refs/remotes/origin/main'*) return 0 ;;
      *'hash-object'*deploy-ingest-local.sh*) printf '%s\n' "$OTHER_SHA" ;;
      *'rev-parse'*) printf '%s\n' "$TEST_SHA" ;;
      *'ls-tree'*worker/deploy-ingest-local.sh*)
        printf '100755 blob %s\tworker/deploy-ingest-local.sh\n' "$TEST_SHA"
        ;;
      *) fail "unexpected git after orchestrator mismatch: $*" ;;
    esac
  }
  export -f git
  install_fake_command_wrappers "$tmp"

  set +e
  output="$(run_fake_deploy "$tmp" 2>&1)"
  status=$?
  set -e

  [ "$status" -ne 0 ] || fail 'dirty or stale deploy orchestrator must fail closed'
  assert_matches "$output" 'orchestrator|deploy script|reviewed.*script|self.*mismatch' \
    'self-attestation failure must explain the reviewed-script mismatch'
  events="$(<"$EVENT_LOG")"
  assert_not_contains "$events" 'git archive' 'self mismatch must precede release materialization'
  assert_not_contains "$events" 'npm cwd=' 'self mismatch must precede candidate install'
  assert_not_contains "$events" 'pm2 stop' 'self mismatch must precede PM2 stop'
  [ ! -e "$tmp/releases/.arena-ingest-deploy-lock-test" ] || \
    fail 'self mismatch must precede deploy lock mutation'
  rm -rf "$tmp"
  echo 'ok - dirty or stale orchestrator fails before any local mutation'
}

test_archive_invocation_has_no_ui_paths() {
  local tmp event_log old_dir output status archive_event events
  tmp="$(mktemp -d)"
  tmp="$(cd "$tmp" && pwd -P)"
  event_log="$tmp/events"
  old_dir="$tmp/releases/$OLD_SHA-$OLD_RELEASE"
  : > "$event_log"
  export EVENT_LOG="$event_log" ACTIVE_CWD_FILE="$tmp/active-cwd"
  export OLD_CWD="$old_dir" CANDIDATE_FAILED_FILE="$tmp/candidate-failed"
  printf '%s\n' "$old_dir" > "$ACTIVE_CWD_FILE"
  make_old_release "$tmp/releases" "$tmp/shared" "$old_dir"
  install_common_fake_functions

  git() {
    local provenance_status
    fake_git_environment "$@"
    printf 'git %s\n' "$*" >> "$EVENT_LOG"
    if fake_git_provenance "$@"; then return 0; else provenance_status=$?; fi
    [ "$provenance_status" -eq 64 ] || return "$provenance_status"
    case "$*" in
      *'fetch --force --no-tags origin refs/heads/main:refs/remotes/origin/main'*) return 0 ;;
      *'hash-object'*deploy-ingest-local.sh*) printf '%s\n' "$TEST_SHA" ;;
      *'rev-parse'*) printf '%s\n' "$TEST_SHA" ;;
      *'ls-tree'*worker/deploy-ingest-local.sh*)
        printf '100755 blob %s\tworker/deploy-ingest-local.sh\n' "$TEST_SHA"
        ;;
      *'ls-tree -r --name-only'*)
        printf '%s\n' .npmrc package.json package-lock.json tsconfig.json \
          scripts/ci/worker-release-id.mjs worker/deploy-ingest-local.sh
        ;;
      *'ls-tree -r '*' -- .npmrc'*)
        printf '100644 blob %s\t.npmrc\n' "$TEST_SHA"
        printf '100755 blob %s\tworker/deploy-ingest-local.sh\n' "$TEST_SHA"
        ;;
      *'archive'*) return 71 ;;
      *) fail "unexpected git before deliberate archive failure: $*" ;;
    esac
  }
  export -f git
  install_fake_command_wrappers "$tmp"

  set +e
  output="$(run_fake_deploy "$tmp" 2>&1)"
  status=$?
  set -e

  [ "$status" -ne 0 ] || fail 'deliberate archive failure must fail deployment'
  events="$(<"$event_log")"
  assert_contains "$events" 'rev-parse --show-toplevel' \
    'executed deploy must prove its canonical Git worktree'
  assert_contains "$events" 'remote get-url origin' \
    'executed deploy must prove its authorized origin'
  assert_contains "$events" 'rev-parse --git-common-dir' \
    'executed deploy must resolve its canonical Git object store'
  assert_contains "$events" 'init --bare --quiet' \
    'executed archive must create isolated bare metadata'
  archive_event="$(grep 'git archive' "$event_log" || true)"
  [ -n "$archive_event" ] || { printf '%s\n' "$output" >&2; fail 'test must reach exact archive'; }
  for required in .npmrc lib worker package.json package-lock.json tsconfig.json \
    scripts/ci/worker-release-id.mjs; do
    assert_contains "$archive_event" "$required" "archive command must include $required"
  done
  for forbidden in ' app ' ' components ' ' public ' ' styles ' '.env.local'; do
    assert_not_contains " $archive_event " "$forbidden" \
      "archive command must exclude $forbidden"
  done
  assert_not_contains "$events" 'npm cwd=' 'failed archive must precede candidate install'
  assert_not_contains "$events" 'pm2 stop' 'failed archive must precede PM2 stop'
  rm -rf "$tmp"
  echo 'ok - executed archive is exact-worker-only and cannot carry UI paths'
}

test_incident_hold_refuses_before_candidate_or_pm2() {
  local tmp old_dir output status events
  tmp="$(mktemp -d)"
  tmp="$(cd "$tmp" && pwd -P)"
  old_dir="$tmp/releases/$OLD_SHA-$OLD_RELEASE"
  export EVENT_LOG="$tmp/events" ACTIVE_CWD_FILE="$tmp/active-cwd"
  export OLD_CWD="$old_dir" CANDIDATE_FAILED_FILE="$tmp/candidate-failed"
  : > "$EVENT_LOG"
  printf '%s\n' "$old_dir" > "$ACTIVE_CWD_FILE"
  make_old_release "$tmp/releases" "$tmp/shared" "$old_dir"
  install_common_fake_functions
  install_fake_command_wrappers "$tmp"
  printf '%s\n' 'incident-no-go' > "$tmp/shared/.arena-ingest/ingest-deploy.hold"

  set +e
  output="$(run_fake_deploy "$tmp" 2>&1)"
  status=$?
  set -e

  [ "$status" -ne 0 ] || fail 'an armed local incident hold must refuse deployment'
  assert_contains "$output" 'local ingest deploy is blocked by incident hold' \
    'incident hold refusal must be explicit'
  events="$(<"$EVENT_LOG")"
  assert_not_contains "$events" 'npm cwd=' 'incident hold must precede candidate install'
  assert_not_contains "$events" 'pm2 ' 'incident hold must precede every PM2 operation'
  [ ! -e "$tmp/releases/.arena-ingest-deploy-lock-test" ] || \
    fail 'incident hold must precede deploy-lock mutation'
  rm -rf "$tmp"
  echo 'ok - local incident hold blocks deploy before candidate or PM2 mutation'
}

arm_stopped_recovery_fixture() {
  local tmp="$1" expires nonce
  : > "$ACTIVE_CWD_FILE.stopped"
  printf '%s\n' 'incident-no-go' > "$tmp/shared/.arena-ingest/ingest-deploy.hold"
  printf '%s\n' 'incident-compatibility-guard' > \
    "$tmp/releases/.arena-ingest-deploy-blocked"
  expires=$(( $(date +%s) + 600 ))
  nonce="$(printf 'b%.0s' {1..64})"
  printf '%s\n' \
    'arena.ingest-recover-from-stopped@1' \
    "target_sha=$TEST_SHA" \
    "expires_epoch=$expires" \
    "nonce=$nonce" \
    > "$tmp/shared/.arena-ingest/recover-from-stopped.go"
  chmod 600 "$tmp/shared/.arena-ingest/recover-from-stopped.go"
}

prepare_stopped_recovery_test() {
  local tmp="$1" old_dir="$2"
  export EVENT_LOG="$tmp/events" ACTIVE_CWD_FILE="$tmp/active-cwd"
  export OLD_CWD="$old_dir" CANDIDATE_FAILED_FILE="$tmp/candidate-failed"
  : > "$EVENT_LOG"
  printf '%s\n' "$old_dir" > "$ACTIVE_CWD_FILE"
  make_old_release "$tmp/releases" "$tmp/shared" "$old_dir"
  install_common_fake_functions
  install_fake_command_wrappers "$tmp"
}

test_stopped_recovery_requires_one_time_confirmation() {
  local tmp old_dir output status events
  tmp="$(mktemp -d)"; tmp="$(cd "$tmp" && pwd -P)"
  old_dir="$tmp/releases/$OLD_SHA-$OLD_RELEASE"
  prepare_stopped_recovery_test "$tmp" "$old_dir"
  : > "$ACTIVE_CWD_FILE.stopped"
  printf '%s\n' incident > "$tmp/shared/.arena-ingest/ingest-deploy.hold"
  printf '%s\n' compatibility > "$tmp/releases/.arena-ingest-deploy-blocked"

  set +e
  output="$(ARENA_RECOVER_TEST=1 run_fake_deploy "$tmp" 2>&1)"
  status=$?
  set -e
  [ "$status" -ne 0 ] || fail 'stopped recovery without a one-time confirmation must fail'
  assert_contains "$output" 'requires a fresh owner-only mode-0600 confirmation' \
    'missing stopped-recovery confirmation must be explicit'
  events="$(<"$EVENT_LOG")"
  assert_not_contains "$events" 'pm2 stop' 'missing confirmation must not stop PM2'
  assert_not_contains "$events" 'pm2 save' 'missing confirmation must not rewrite PM2 dumps'
  assert_not_contains "$events" 'npm cwd=' 'missing confirmation must precede candidate preparation'
  [ -e "$tmp/shared/.arena-ingest/ingest-deploy.hold" ] || fail 'missing confirmation must retain primary hold'
  [ -e "$tmp/releases/.arena-ingest-deploy-blocked" ] || fail 'missing confirmation must retain compatibility guard'
  rm -rf "$tmp"
  echo 'ok - local stopped recovery requires an unlogged one-time host confirmation'
}

test_stopped_recovery_rejects_residual_os_owner() {
  local tmp old_dir output status
  tmp="$(mktemp -d)"; tmp="$(cd "$tmp" && pwd -P)"
  old_dir="$tmp/releases/$OLD_SHA-$OLD_RELEASE"
  prepare_stopped_recovery_test "$tmp" "$old_dir"
  arm_stopped_recovery_fixture "$tmp"
  export FAKE_RESIDUAL_INGEST_PROCESS=1
  install_fake_command_wrappers "$tmp"

  set +e
  output="$(ARENA_RECOVER_TEST=1 run_fake_deploy "$tmp" 2>&1)"
  status=$?
  set -e
  [ "$status" -ne 0 ] || fail 'a residual local ingest OS process must block stopped recovery'
  assert_contains "$output" 'live ingest OS process' 'residual process refusal must be explicit'
  [ -e "$tmp/shared/.arena-ingest/ingest-deploy.hold" ] || fail 'residual owner failure must keep primary hold armed'
  [ -e "$tmp/releases/.arena-ingest-deploy-blocked" ] || fail 'residual owner failure must keep compatibility guard armed'
  unset FAKE_RESIDUAL_INGEST_PROCESS
  rm -rf "$tmp"
  echo 'ok - local stopped recovery rejects residual OS ownership'
}

test_stopped_recovery_failure_stays_stopped_and_rearms_holds() {
  local tmp old_dir output status events candidate_starts old_starts
  tmp="$(mktemp -d)"; tmp="$(cd "$tmp" && pwd -P)"
  old_dir="$tmp/releases/$OLD_SHA-$OLD_RELEASE"
  prepare_stopped_recovery_test "$tmp" "$old_dir"
  arm_stopped_recovery_fixture "$tmp"
  export FAIL_FIRST_CANDIDATE_READY=1
  install_fake_command_wrappers "$tmp"

  set +e
  output="$(ARENA_RECOVER_TEST=1 run_fake_deploy "$tmp" 2>&1)"
  status=$?
  set -e
  [ "$status" -ne 0 ] || fail 'failed stopped-recovery candidate must not report success'
  assert_contains "$output" 'worker remains stopped and both holds remain armed' \
    'failed stopped recovery must report zero-owner quarantine'
  [ -e "$ACTIVE_CWD_FILE.stopped" ] || fail 'failed stopped recovery must leave PM2 stopped'
  [ -e "$tmp/shared/.arena-ingest/ingest-deploy.hold" ] || fail 'failed stopped recovery must re-arm primary hold'
  [ -e "$tmp/releases/.arena-ingest-deploy-blocked" ] || fail 'failed stopped recovery must retain compatibility guard'
  events="$(<"$EVENT_LOG")"
  candidate_starts="$(grep -c 'pm2 start ' <<<"$events" || true)"
  old_starts="$(grep -c "pm2 start $old_dir" <<<"$events" || true)"
  [ "$candidate_starts" -ge 1 ] || fail 'failure fixture must reach candidate start'
  [ "$old_starts" -eq 0 ] || fail 'stopped recovery must never restart the old release'
  [ "$(grep -c 'pm2 save --force' <<<"$events" || true)" -ge 4 ] || \
    fail 'baseline and quarantine must each update both PM2 dump generations'
  unset FAIL_FIRST_CANDIDATE_READY
  rm -rf "$tmp"
  echo 'ok - failed local stopped recovery remains stopped with both holds armed'
}

test_stopped_recovery_success_starts_only_proven_candidate() {
  local tmp old_dir output events
  tmp="$(mktemp -d)"; tmp="$(cd "$tmp" && pwd -P)"
  old_dir="$tmp/releases/$OLD_SHA-$OLD_RELEASE"
  prepare_stopped_recovery_test "$tmp" "$old_dir"
  arm_stopped_recovery_fixture "$tmp"

  output="$(ARENA_RECOVER_TEST=1 run_fake_deploy "$tmp" 2>&1)" || \
    fail "valid local stopped recovery failed: $output"
  assert_contains "$output" '✓ local deploy complete' 'successful recovery must prove the candidate'
  [ ! -e "$ACTIVE_CWD_FILE.stopped" ] || fail 'successful recovery must leave the proven candidate online'
  [ ! -e "$tmp/shared/.arena-ingest/ingest-deploy.hold" ] || fail 'successful recovery must consume primary hold'
  [ ! -e "$tmp/releases/.arena-ingest-deploy-blocked" ] || fail 'successful recovery must clear transactional guard'
  [ ! -e "$tmp/shared/.arena-ingest/recover-from-stopped.go" ] || fail 'successful recovery must consume GO file'
  events="$(<"$EVENT_LOG")"
  [ "$(grep -c "pm2 start $old_dir" <<<"$events" || true)" -eq 0 ] || \
    fail 'successful stopped recovery must never start the old release'
  rm -rf "$tmp"
  echo 'ok - successful local stopped recovery starts only the exact proven candidate'
}

test_busy_lock_refuses_before_candidate_or_pm2_stop() {
  local tmp old_dir output status events
  tmp="$(mktemp -d)"
  tmp="$(cd "$tmp" && pwd -P)"
  old_dir="$tmp/releases/$OLD_SHA-$OLD_RELEASE"
  export EVENT_LOG="$tmp/events" ACTIVE_CWD_FILE="$tmp/active-cwd"
  export OLD_CWD="$old_dir" CANDIDATE_FAILED_FILE="$tmp/candidate-failed"
  : > "$EVENT_LOG"
  printf '%s\n' "$old_dir" > "$ACTIVE_CWD_FILE"
  make_old_release "$tmp/releases" "$tmp/shared" "$old_dir"
  install_common_fake_functions
  install_fake_command_wrappers "$tmp"
  mkdir -p "$tmp/releases/.arena-ingest-deploy-lock-test"
  printf '%s\n%s\n' 'another-deployment' "$$" > \
    "$tmp/releases/.arena-ingest-deploy-lock-test/owner"

  set +e
  output="$(run_fake_deploy "$tmp" 2>&1)"
  status=$?
  set -e

  [ "$status" -ne 0 ] || fail 'a live local deploy lock must refuse concurrency'
  assert_contains "$output" 'BUSY:' 'lock contention must identify the existing deploy'
  events="$(<"$EVENT_LOG")"
  assert_not_contains "$events" 'npm cwd=' 'lock contention must precede candidate install'
  assert_not_contains "$events" 'pm2 stop' 'lock contention must precede PM2 stop'
  assert_not_contains "$events" 'pm2 delete' 'lock contention must precede PM2 mutation'
  [ -d "$tmp/releases/.arena-ingest-deploy-lock-test" ] || \
    fail 'a contender must not remove the owner lock'
  rm -rf "$tmp"
  echo 'ok - live deploy lock rejects a contender before candidate or PM2 mutation'
}

test_runtime_mismatch_fails_before_pm2_stop() {
  local tmp old_dir output status events
  tmp="$(mktemp -d)"
  tmp="$(cd "$tmp" && pwd -P)"
  old_dir="$tmp/releases/$OLD_SHA-$OLD_RELEASE"
  export EVENT_LOG="$tmp/events" ACTIVE_CWD_FILE="$tmp/active-cwd"
  export OLD_CWD="$old_dir" CANDIDATE_FAILED_FILE="$tmp/candidate-failed"
  : > "$EVENT_LOG"
  printf '%s\n' "$old_dir" > "$ACTIVE_CWD_FILE"
  make_old_release "$tmp/releases" "$tmp/shared" "$old_dir"
  install_common_fake_functions
  fake_node() {
    local joined="$*"
    printf 'node cwd=%s args=%s\n' "$PWD" "$joined" >> "$EVENT_LOG"
    case "$joined" in
      *worker-release-id.mjs*) printf '%s\n' "$TEST_RELEASE" ;;
      *process.versions.node*process.arch*) printf '%s\n' '21 x64 linux' ;;
      *verify-local-heartbeat.ts*--discover-existing*|*discover-local*|*discover*worker*node*)
        printf '%s\n' \
          '[redis] offline fake connection ready' \
          $'ARENA_LOCAL_EXISTING_ROSTER\tmac-mini\t4243'
        ;;
      *'new Set'*pm_cwd*)
        while IFS= read -r _; do :; done
        printf '%s\n' "$(<"$ACTIVE_CWD_FILE")"
        ;;
      *'const appName'*pm_cwd*|*JSON.parse*filter*)
        while IFS= read -r _; do :; done
        printf '4242\037online\037%s\037%s\037%s/worker/src/ingest-worker.ts\0370\037[]\037["--max-old-space-size=2560","--import","%s/node_modules/tsx/dist/loader.mjs"]\037fork_mode\0371\n' \
          "$(<"$ACTIVE_CWD_FILE")" "$FAKE_NODE_PATH" \
          "$(<"$ACTIVE_CWD_FILE")" "$(<"$ACTIVE_CWD_FILE")"
        ;;
      *) return 0 ;;
    esac
  }
  export -f fake_node
  install_fake_command_wrappers "$tmp"

  set +e
  output="$(run_fake_deploy "$tmp" 2>&1)"
  status=$?
  set -e

  [ "$status" -ne 0 ] || fail 'wrong local Node runtime must fail deployment'
  assert_matches "$output" 'runtime mismatch|expected 22 arm64|requires Node 22 arm64' \
    'runtime mismatch must explain the exact required platform'
  events="$(<"$EVENT_LOG")"
  assert_not_contains "$events" 'pm2 stop' 'runtime gate must precede PM2 stop'
  assert_not_contains "$events" 'pm2 delete' 'runtime gate must precede PM2 mutation'
  [ "$(<"$ACTIVE_CWD_FILE")" = "$old_dir" ] || \
    fail 'runtime failure must leave the old cwd active'
  rm -rf "$tmp"
  echo 'ok - exact Node 22 arm64 gate fails before PM2 stop'
}

test_disk_module_and_database_failures_precede_pm2_stop() {
  local gate tmp old_dir output status events
  for gate in disk_free disk_pressure module database; do
    tmp="$(mktemp -d)"
    tmp="$(cd "$tmp" && pwd -P)"
    old_dir="$tmp/releases/$OLD_SHA-$OLD_RELEASE"
    export EVENT_LOG="$tmp/events" ACTIVE_CWD_FILE="$tmp/active-cwd"
    export OLD_CWD="$old_dir" CANDIDATE_FAILED_FILE="$tmp/candidate-failed"
    export FAIL_FIRST_CANDIDATE_READY=0 FAKE_MODULE_STATUS=0 FAKE_PREFLIGHT_STATUS=0
    : > "$EVENT_LOG"
    printf '%s\n' "$old_dir" > "$ACTIVE_CWD_FILE"
    make_old_release "$tmp/releases" "$tmp/shared" "$old_dir"
    install_common_fake_functions

    case "$gate" in
      disk_free)
        df() {
          printf '%s\n' \
            'Filesystem 1024-blocks Used Available Capacity Mounted on' \
            '/dev/fake 100000000 99999999 1 1% /tmp'
        }
        export -f df
        ;;
      disk_pressure)
        df() {
          printf '%s\n' \
            'Filesystem 1024-blocks Used Available Capacity Mounted on' \
            '/dev/fake 100000000 93708544 6291456 96% /tmp'
        }
        export -f df
        ;;
      module) export FAKE_MODULE_STATUS=65 ;;
      database) export FAKE_PREFLIGHT_STATUS=66 ;;
    esac
    install_fake_command_wrappers "$tmp"

    set +e
    output="$(run_fake_deploy "$tmp" 2>&1)"
    status=$?
    set -e

    [ "$status" -ne 0 ] || fail "$gate gate failure must abort deployment"
    events="$(<"$EVENT_LOG")"
    assert_not_contains "$events" 'pm2 stop' "$gate gate must precede PM2 stop"
    assert_not_contains "$events" 'pm2 delete' "$gate gate must precede PM2 mutation"
    assert_not_contains "$events" 'pm2 start' "$gate gate must precede candidate start"
    [ "$(<"$ACTIVE_CWD_FILE")" = "$old_dir" ] || \
      fail "$gate gate must leave the old exact cwd active"
    case "$gate" in
      disk_free)
        assert_matches "$output" 'at least 5 GiB|free.*storage' \
          'free-space failure must state the capacity gate'
        assert_not_contains "$events" 'npm cwd=' \
          'disk capacity must be proven before npm ci'
        ;;
      disk_pressure)
        assert_matches "$output" 'full data volume|at most 85%' \
          'disk pressure must fail even while more than 5 GiB remains free'
        assert_not_contains "$events" 'npm cwd=' \
          'disk percentage must be proven before npm ci'
        ;;
      module)
        assert_contains "$events" 'npm cwd=' 'module failure must occur after isolated npm ci'
        assert_contains "$events" '--eval' 'module test must reach actual import evaluation'
        ;;
      database)
        assert_contains "$events" 'preflight-local-release.ts' \
          'database test must reach the production readiness preflight'
        ;;
    esac
    rm -rf "$tmp"
    unset FAIL_FIRST_CANDIDATE_READY FAKE_MODULE_STATUS FAKE_PREFLIGHT_STATUS
  done
  echo 'ok - disk, actual-module, and production-DB gates all fail before PM2 stop'
}

test_failed_candidate_readiness_restores_old_exact_cwd() {
  local tmp old_dir output status events start_count last_start started elapsed
  local first_proof_line second_proof_line save_line stability_probes final_probes
  local boundary_count first_boundary second_boundary
  tmp="$(mktemp -d)"
  tmp="$(cd "$tmp" && pwd -P)"
  old_dir="$tmp/releases/$OLD_SHA-$OLD_RELEASE"
  export EVENT_LOG="$tmp/events" ACTIVE_CWD_FILE="$tmp/active-cwd"
  export OLD_CWD="$old_dir" CANDIDATE_FAILED_FILE="$tmp/candidate-failed"
  export FAIL_FIRST_CANDIDATE_READY=1 FAKE_MODULE_STATUS=0 FAKE_PREFLIGHT_STATUS=0
  export FAKE_NOW_COUNTER_FILE="$tmp/fake-now-counter"
  export STAMPED_BOUNDARY_LOG_FILE="$tmp/stamped-boundaries"
  export REQUIRE_STAMPED_BOUNDARY_CURRENT=1
  : > "$EVENT_LOG"
  printf '%s\n' 1999999999000 > "$FAKE_NOW_COUNTER_FILE"
  printf '%s\n' "$old_dir" > "$ACTIVE_CWD_FILE"
  make_old_release "$tmp/releases" "$tmp/shared" "$old_dir"
  install_common_fake_functions
  install_fake_command_wrappers "$tmp"

  started=$SECONDS
  set +e
  output="$(run_fake_deploy "$tmp" 2>&1)"
  status=$?
  set -e
  elapsed=$((SECONDS - started))
  unset FAIL_FIRST_CANDIDATE_READY FAKE_MODULE_STATUS FAKE_PREFLIGHT_STATUS

  [ "$status" -ne 0 ] || fail 'candidate without fresh readiness must fail deployment'
  events="$(<"$EVENT_LOG")"
  assert_contains "$events" 'pm2 stop' 'test must reach the guarded PM2 stop'
  start_count="$(grep -c '^pm2 start ' "$EVENT_LOG" || true)"
  if [ "$start_count" -lt 2 ]; then
    printf '%s\n' "$output" "$events" >&2
    fail 'candidate and rollback must both perform exact PM2 starts'
  fi
  last_start="$(grep '^pm2 start ' "$EVENT_LOG" | tail -1)"
  assert_contains "$last_start" "$old_dir/worker/ecosystem.local-ingest.config.cjs" \
    'rollback must restart from the complete old exact cwd'
  [ "$(<"$ACTIVE_CWD_FILE")" = "$old_dir" ] || \
    fail 'failed candidate must leave the old exact cwd active'
  [ "$elapsed" -ge 10 ] || fail 'successful rollback proof must span at least ten seconds'
  first_proof_line="$(grep -n 'verify-local-heartbeat.ts 4242 ' "$EVENT_LOG" | head -1 | cut -d: -f1)"
  second_proof_line="$(grep -n 'verify-local-heartbeat.ts 4242 ' "$EVENT_LOG" | tail -1 | cut -d: -f1)"
  [ -n "$first_proof_line" ] && [ "$second_proof_line" -gt "$first_proof_line" ] || \
    fail 'stamped rollback must obtain a second fresh Redis proof after stability'
  boundary_count="$(wc -l < "$STAMPED_BOUNDARY_LOG_FILE" | tr -d '[:space:]')"
  [ "$boundary_count" = 2 ] || \
    fail 'stamped rollback must bind exactly two Redis proofs to captured time boundaries'
  first_boundary="$(sed -n '1p' "$STAMPED_BOUNDARY_LOG_FILE")"
  second_boundary="$(sed -n '2p' "$STAMPED_BOUNDARY_LOG_FILE")"
  [[ "$first_boundary" =~ ^[1-9][0-9]*$ ]] && \
    [[ "$second_boundary" =~ ^[1-9][0-9]*$ ]] && \
    [ "$second_boundary" -gt "$first_boundary" ] || \
    fail 'final stamped Redis proof must use a newly captured, increasing not-before boundary'
  stability_probes="$(awk -v first="$first_proof_line" -v second="$second_proof_line" \
    'NR > first && NR < second && $0 == "pm2 jlist" { count += 1 } END { print count + 0 }' \
    "$EVENT_LOG")"
  [ "$stability_probes" -ge 11 ] || \
    fail 'stamped rollback must retain one exact PID and PM2 shape across eleven probes'
  save_line="$(grep -n '^pm2 save$' "$EVENT_LOG" | tail -1 | cut -d: -f1)"
  final_probes="$(awk -v second="$second_proof_line" -v save="$save_line" \
    'NR > second && NR < save && $0 == "pm2 jlist" { count += 1 } END { print count + 0 }' \
    "$EVENT_LOG")"
  [ -n "$save_line" ] && [ "$save_line" -gt "$second_proof_line" ] && \
    [ "$final_probes" -ge 1 ] || \
    fail 'stamped rollback must perform one final exact PM2 recheck before pm2 save'
  [ ! -e "$tmp/releases/.arena-ingest-deploy-blocked" ] || \
    fail 'fully proven stamped rollback must clear its durable cutover journal'
  if ! grep -Eq 'previous.*release restored|rollback.*fresh.*identity' <<<"$output"; then
    printf '%s\n' "$output" >&2
    fail 'rollback success must report fresh old identity evidence'
  fi
  [ ! -e "$tmp/releases/.arena-ingest-deploy-lock-test" ] || \
    fail 'rollback completion must release the local lock'
  rm -rf "$tmp"
  unset FAKE_NOW_COUNTER_FILE STAMPED_BOUNDARY_LOG_FILE REQUIRE_STAMPED_BOUNDARY_CURRENT
  echo 'ok - failed candidate readiness restores and proves the old exact cwd'
}

test_legacy_rollback_requires_stability_and_reproof() {
  local tmp old_dir output status started elapsed redis_proofs
  tmp="$(mktemp -d)"
  tmp="$(cd "$tmp" && pwd -P)"
  old_dir="$tmp/releases/$OLD_SHA-legacy"
  export EVENT_LOG="$tmp/events" ACTIVE_CWD_FILE="$tmp/active-cwd"
  export OLD_CWD="$old_dir" CANDIDATE_FAILED_FILE="$tmp/candidate-failed"
  export FAIL_FIRST_CANDIDATE_READY=1 FAKE_MODULE_STATUS=0 FAKE_PREFLIGHT_STATUS=0
  : > "$EVENT_LOG"
  printf '%s\n' "$old_dir" > "$ACTIVE_CWD_FILE"
  make_old_release "$tmp/releases" "$tmp/shared" "$old_dir"
  rm "$old_dir/WORKER_RELEASE_ID"
  chmod +x "$old_dir/worker/src/ingest-worker.ts"
  install_common_fake_functions
  install_fake_command_wrappers "$tmp"

  started=$SECONDS
  set +e
  output="$(run_fake_deploy "$tmp" 2>&1)"
  status=$?
  set -e
  elapsed=$((SECONDS - started))
  unset FAIL_FIRST_CANDIDATE_READY FAKE_MODULE_STATUS FAKE_PREFLIGHT_STATUS

  [ "$status" -ne 0 ] || fail 'candidate failure must remain the terminal deploy status'
  [ "$elapsed" -ge 10 ] || fail 'legacy rollback proof must span at least ten seconds'
  [ "$(<"$ACTIVE_CWD_FILE")" = "$old_dir" ] || \
    fail 'legacy rollback must restore the exact old cwd'
  redis_proofs="$(grep -c 'verify-local-heartbeat.ts --discover-existing' "$EVENT_LOG" || true)"
  [ "$redis_proofs" -ge 4 ] || \
    fail 'legacy rollback must repeat fresh Redis discovery and ancestry after stability'
  assert_contains "$(<"$EVENT_LOG")" 'pm2 save' \
    'fully stable legacy rollback must commit the restored PM2 state'
  [ ! -e "$tmp/releases/.arena-ingest-deploy-blocked" ] || \
    fail 'fully proven legacy rollback must clear its durable cutover journal'
  assert_contains "$output" 'previous local release restored' \
    'stable legacy rollback must report exact restoration success'
  rm -rf "$tmp"
  echo 'ok - legacy rollback stays stable, re-proves Redis ancestry, then commits'
}

test_post_redis_restart_never_commits_rollback() {
  local kind tmp old_dir output status events
  for kind in stamped legacy; do
    tmp="$(mktemp -d)"
    tmp="$(cd "$tmp" && pwd -P)"
    old_dir="$tmp/releases/$OLD_SHA-$kind"
    export EVENT_LOG="$tmp/events" ACTIVE_CWD_FILE="$tmp/active-cwd"
    export OLD_CWD="$old_dir" CANDIDATE_FAILED_FILE="$tmp/candidate-failed"
    export ROLLBACK_REDIS_PASSED_FILE="$tmp/rollback-redis-passed"
    export ROLLBACK_RESTARTED_FILE="$tmp/rollback-restarted"
    export FAIL_FIRST_CANDIDATE_READY=1 FAIL_ROLLBACK_AFTER_REDIS=1
    export FAKE_MODULE_STATUS=0 FAKE_PREFLIGHT_STATUS=0
    : > "$EVENT_LOG"
    printf '%s\n' "$old_dir" > "$ACTIVE_CWD_FILE"
    make_old_release "$tmp/releases" "$tmp/shared" "$old_dir"
    if [ "$kind" = legacy ]; then
      rm "$old_dir/WORKER_RELEASE_ID"
      chmod +x "$old_dir/worker/src/ingest-worker.ts"
    fi
    install_common_fake_functions
    install_fake_command_wrappers "$tmp"

    set +e
    output="$(run_fake_deploy "$tmp" 2>&1)"
    status=$?
    set -e
    unset FAIL_FIRST_CANDIDATE_READY FAIL_ROLLBACK_AFTER_REDIS
    unset FAKE_MODULE_STATUS FAKE_PREFLIGHT_STATUS

    [ "$status" -ne 0 ] || fail "$kind post-Redis restart must fail deployment"
    [ -e "$ROLLBACK_REDIS_PASSED_FILE" ] && [ -e "$ROLLBACK_RESTARTED_FILE" ] || \
      fail "$kind test must simulate a restart immediately after the first Redis proof"
    events="$(<"$EVENT_LOG")"
    assert_not_contains "$events" 'pm2 save' \
      "$kind unstable rollback must never commit PM2 state"
    assert_not_contains "$events" 'fs.unlinkSync' \
      "$kind unstable rollback must never clear the durable journal"
    assert_not_contains "$output" 'previous local release restored' \
      "$kind unstable rollback must never report restoration success"
    assert_contains "$output" 'not continuously stable for ten seconds' \
      "$kind restart must fail the continuous rollback stability gate"
    [ -f "$tmp/releases/.arena-ingest-deploy-blocked" ] || \
      fail "$kind unstable rollback must retain a durable recovery block"
    [ "$(sed -n '1p' "$tmp/releases/.arena-ingest-deploy-blocked")" = \
      'arena.local-ingest-recovery-block@1' ] || \
      fail "$kind unstable rollback must replace the journal with an explicit failed block"
    rm -rf "$tmp"
  done
  unset ROLLBACK_REDIS_PASSED_FILE ROLLBACK_RESTARTED_FILE
  echo 'ok - stamped and legacy post-Redis restarts retain the journal and never report success'
}

test_stamped_final_freshness_timeout_never_commits_rollback() {
  local tmp old_dir output status events
  tmp="$(mktemp -d)"
  tmp="$(cd "$tmp" && pwd -P)"
  old_dir="$tmp/releases/$OLD_SHA-stamped-final-timeout"
  export EVENT_LOG="$tmp/events" ACTIVE_CWD_FILE="$tmp/active-cwd"
  export OLD_CWD="$old_dir" CANDIDATE_FAILED_FILE="$tmp/candidate-failed"
  export STAMPED_PROOF_COUNT_FILE="$tmp/stamped-proof-count"
  export FAIL_FIRST_CANDIDATE_READY=1 FAIL_FINAL_STAMPED_PROOF=1
  export FAKE_MODULE_STATUS=0 FAKE_PREFLIGHT_STATUS=0
  : > "$EVENT_LOG"
  printf '%s\n' "$old_dir" > "$ACTIVE_CWD_FILE"
  make_old_release "$tmp/releases" "$tmp/shared" "$old_dir"
  install_common_fake_functions
  install_fake_command_wrappers "$tmp"

  set +e
  output="$(run_fake_deploy "$tmp" 2>&1)"
  status=$?
  set -e
  unset FAIL_FIRST_CANDIDATE_READY FAIL_FINAL_STAMPED_PROOF
  unset FAKE_MODULE_STATUS FAKE_PREFLIGHT_STATUS

  [ "$status" -ne 0 ] || fail 'stale final stamped heartbeat must fail deployment'
  [ "$(sed -n '1p' "$STAMPED_PROOF_COUNT_FILE")" = 2 ] || \
    fail 'test must pass initial stamped proof and reject the final post-boundary proof'
  events="$(<"$EVENT_LOG")"
  assert_not_contains "$events" 'pm2 save' \
    'stale final stamped heartbeat must never commit PM2 state'
  assert_not_contains "$events" 'fs.unlinkSync' \
    'stale final stamped heartbeat must never clear the durable journal'
  assert_not_contains "$output" 'previous local release restored' \
    'stale final stamped heartbeat must never report restoration success'
  assert_contains "$output" 'lacks final fresh Redis rollback evidence' \
    'operator must see the exact failed final stamped freshness gate'
  [ -f "$tmp/releases/.arena-ingest-deploy-blocked" ] || \
    fail 'stale final stamped heartbeat must retain a durable recovery block'
  rm -rf "$tmp"
  unset STAMPED_PROOF_COUNT_FILE
  echo 'ok - stale final stamped heartbeat never saves state or clears the journal'
}

test_dead_equal_pid_is_not_live_ancestry() {
  local tmp old_dir output status events
  tmp="$(mktemp -d)"
  tmp="$(cd "$tmp" && pwd -P)"
  old_dir="$tmp/releases/$OLD_SHA-dead-equal-pid"
  export EVENT_LOG="$tmp/events" ACTIVE_CWD_FILE="$tmp/active-cwd"
  export OLD_CWD="$old_dir" CANDIDATE_FAILED_FILE="$tmp/candidate-failed"
  export FAKE_HEARTBEAT_PID=4242 DEAD_PID=4242
  export FAKE_MODULE_STATUS=0 FAKE_PREFLIGHT_STATUS=0
  : > "$EVENT_LOG"
  printf '%s\n' "$old_dir" > "$ACTIVE_CWD_FILE"
  make_old_release "$tmp/releases" "$tmp/shared" "$old_dir"
  install_common_fake_functions
  install_fake_command_wrappers "$tmp"

  set +e
  output="$(run_fake_deploy "$tmp" 2>&1)"
  status=$?
  set -e
  unset FAKE_HEARTBEAT_PID DEAD_PID FAKE_MODULE_STATUS FAKE_PREFLIGHT_STATUS

  [ "$status" -ne 0 ] || fail 'dead heartbeat PID equal to PM2 PID must not prove ancestry'
  assert_contains "$output" 'unable to prove the current logical worker identity' \
    'dead equal PID must fail the runtime identity gate explicitly'
  events="$(<"$EVENT_LOG")"
  assert_not_contains "$events" 'pm2 stop' 'dead equal PID must fail before PM2 stop'
  assert_not_contains "$events" 'pm2 save' 'dead equal PID must never save PM2 state'
  rm -rf "$tmp"
  echo 'ok - PID equality without a live process is never ancestry evidence'
}

test_baseline_owner_delayed_death_preserves_journal() {
  local tmp old_dir output status events snapshot_count
  tmp="$(mktemp -d)"
  tmp="$(cd "$tmp" && pwd -P)"
  old_dir="$tmp/releases/$OLD_SHA-baseline-delayed-death"
  export EVENT_LOG="$tmp/events" ACTIVE_CWD_FILE="$tmp/active-cwd"
  export OLD_CWD="$old_dir" CANDIDATE_FAILED_FILE="$tmp/candidate-failed"
  export BASELINE_RECOVERY_STARTED_FILE="$tmp/baseline-recovery-started"
  export BASELINE_SNAPSHOT_COUNT_FILE="$tmp/baseline-snapshot-count"
  export FAIL_PM2_STOP_BEFORE_MUTATION=1 FAIL_BASELINE_DURING_STABILITY=1
  export FAKE_PM2_RESTARTS=7 FAKE_MODULE_STATUS=0 FAKE_PREFLIGHT_STATUS=0
  : > "$EVENT_LOG"
  printf '%s\n' "$old_dir" > "$ACTIVE_CWD_FILE"
  make_old_release "$tmp/releases" "$tmp/shared" "$old_dir"
  install_common_fake_functions
  install_fake_command_wrappers "$tmp"

  set +e
  output="$(run_fake_deploy "$tmp" 2>&1)"
  status=$?
  set -e
  unset FAIL_PM2_STOP_BEFORE_MUTATION FAIL_BASELINE_DURING_STABILITY FAKE_PM2_RESTARTS
  unset FAKE_MODULE_STATUS FAKE_PREFLIGHT_STATUS

  [ "$status" -ne 0 ] || fail 'baseline owner death during stability must fail deployment'
  snapshot_count="$(sed -n '1p' "$BASELINE_SNAPSHOT_COUNT_FILE")"
  [ "$snapshot_count" -ge 5 ] || fail 'baseline owner must die only after delayed exact probes'
  events="$(<"$EVENT_LOG")"
  assert_contains "$events" 'pm2 stop' 'test must reach the journaled stop attempt'
  assert_not_contains "$events" 'pm2 start' 'failed stop must leave baseline ownership untouched'
  assert_not_contains "$events" 'pm2 save' 'unstable baseline owner must never save PM2 state'
  assert_not_contains "$events" 'fs.unlinkSync' 'unstable baseline owner must never clear the journal'
  assert_not_contains "$output" 'never left ownership' \
    'unstable baseline owner must never report shortcut success'
  assert_contains "$output" 'did not remain continuously stable for ten seconds' \
    'baseline shortcut must expose the failed stability gate'
  [ -f "$tmp/releases/.arena-ingest-deploy-blocked" ] || \
    fail 'unstable baseline owner must retain a durable recovery block'
  rm -rf "$tmp"
  unset BASELINE_RECOVERY_STARTED_FILE BASELINE_SNAPSHOT_COUNT_FILE
  echo 'ok - delayed baseline-owner death never saves state or clears the journal'
}

test_stable_baseline_owner_reproves_before_clearing_journal() {
  local tmp old_dir output status events started elapsed stability_probes
  local final_redis_line final_pm2_line save_line unlink_line
  tmp="$(mktemp -d)"
  tmp="$(cd "$tmp" && pwd -P)"
  old_dir="$tmp/releases/$OLD_SHA-stable-baseline"
  export EVENT_LOG="$tmp/events" ACTIVE_CWD_FILE="$tmp/active-cwd"
  export OLD_CWD="$old_dir" CANDIDATE_FAILED_FILE="$tmp/candidate-failed"
  export BASELINE_RECOVERY_STARTED_FILE="$tmp/baseline-recovery-started"
  export FINAL_REDIS_MARKER_FILE="$tmp/final-redis-passed"
  export FAIL_PM2_STOP_BEFORE_MUTATION=1 FAKE_PM2_RESTARTS=7
  export FAKE_MODULE_STATUS=0 FAKE_PREFLIGHT_STATUS=0
  : > "$EVENT_LOG"
  printf '%s\n' "$old_dir" > "$ACTIVE_CWD_FILE"
  make_old_release "$tmp/releases" "$tmp/shared" "$old_dir"
  install_common_fake_functions
  install_fake_command_wrappers "$tmp"

  started=$SECONDS
  set +e
  output="$(run_fake_deploy "$tmp" 2>&1)"
  status=$?
  set -e
  elapsed=$((SECONDS - started))
  unset FAIL_PM2_STOP_BEFORE_MUTATION FAKE_PM2_RESTARTS
  unset FAKE_MODULE_STATUS FAKE_PREFLIGHT_STATUS

  [ "$status" -ne 0 ] || fail 'original stop failure must remain the terminal deploy status'
  [ "$elapsed" -ge 10 ] || fail 'baseline shortcut must prove ten real seconds of stability'
  events="$(<"$EVENT_LOG")"
  stability_probes="$(grep -c '^pm2 jlist$' "$EVENT_LOG" || true)"
  [ "$stability_probes" -ge 14 ] || \
    fail 'baseline shortcut must perform eleven stable probes and one final exact PM2 check'
  assert_not_contains "$events" 'pm2 start' 'never-left baseline owner must not be restarted'
  assert_contains "$events" 'verify-local-heartbeat.ts 4242' \
    'baseline owner must publish a post-window exact stamped heartbeat'
  final_redis_line="$(grep -n '^rollback final-redis boundary=' "$EVENT_LOG" | \
    head -1 | cut -d: -f1 || true)"
  final_pm2_line="$(grep -n '^rollback final-pm2$' "$EVENT_LOG" | \
    head -1 | cut -d: -f1 || true)"
  save_line="$(grep -n '^pm2 save$' "$EVENT_LOG" | head -1 | cut -d: -f1 || true)"
  unlink_line="$(grep -n '^journal unlink$' "$EVENT_LOG" | head -1 | cut -d: -f1 || true)"
  [ "$(grep -c '^rollback final-redis boundary=' "$EVENT_LOG" || true)" = 1 ] && \
    [ "$(grep -c '^rollback final-pm2$' "$EVENT_LOG" || true)" = 1 ] && \
    [ "$(grep -c '^pm2 save$' "$EVENT_LOG" || true)" = 1 ] && \
    [ "$(grep -c '^journal unlink$' "$EVENT_LOG" || true)" = 1 ] && \
    [ "$final_redis_line" -lt "$final_pm2_line" ] && \
    [ "$final_pm2_line" -lt "$save_line" ] && [ "$save_line" -lt "$unlink_line" ] || \
    fail 'baseline commit must order final Redis, final PM2, PM2 save, then journal unlink'
  assert_contains "$output" 'previous local release never left ownership' \
    'baseline shortcut success must describe the unchanged exact owner'
  [ ! -e "$tmp/releases/.arena-ingest-deploy-blocked" ] || \
    fail 'fully proven baseline owner must clear its durable journal'
  rm -rf "$tmp"
  unset BASELINE_RECOVERY_STARTED_FILE FINAL_REDIS_MARKER_FILE
  echo 'ok - stable never-left owner re-proves Redis and PM2 before journal clear'
}

test_legacy_heartbeat_child_replacement_is_rejected() {
  local tmp old_dir output status events
  tmp="$(mktemp -d)"
  tmp="$(cd "$tmp" && pwd -P)"
  old_dir="$tmp/releases/$OLD_SHA-legacy-child-replacement"
  export EVENT_LOG="$tmp/events" ACTIVE_CWD_FILE="$tmp/active-cwd"
  export OLD_CWD="$old_dir" CANDIDATE_FAILED_FILE="$tmp/candidate-failed"
  export LEGACY_ROLLBACK_DISCOVERY_COUNT_FILE="$tmp/legacy-discovery-count"
  export FAIL_FIRST_CANDIDATE_READY=1 REPLACE_FINAL_LEGACY_CHILD=1
  export FAKE_MODULE_STATUS=0 FAKE_PREFLIGHT_STATUS=0
  : > "$EVENT_LOG"
  printf '%s\n' "$old_dir" > "$ACTIVE_CWD_FILE"
  make_old_release "$tmp/releases" "$tmp/shared" "$old_dir"
  rm "$old_dir/WORKER_RELEASE_ID"
  chmod +x "$old_dir/worker/src/ingest-worker.ts"
  install_common_fake_functions
  install_fake_command_wrappers "$tmp"

  set +e
  output="$(run_fake_deploy "$tmp" 2>&1)"
  status=$?
  set -e
  unset FAIL_FIRST_CANDIDATE_READY REPLACE_FINAL_LEGACY_CHILD
  unset FAKE_MODULE_STATUS FAKE_PREFLIGHT_STATUS

  [ "$status" -ne 0 ] || fail 'legacy heartbeat child replacement must fail deployment'
  [ "$(sed -n '1p' "$LEGACY_ROLLBACK_DISCOVERY_COUNT_FILE")" = 2 ] || \
    fail 'legacy test must observe initial and final post-start heartbeat children'
  events="$(<"$EVENT_LOG")"
  assert_not_contains "$events" 'pm2 save' 'replacement legacy child must never save PM2 state'
  assert_not_contains "$events" 'fs.unlinkSync' \
    'replacement legacy child must never clear the journal'
  assert_contains "$output" 'heartbeat PID changed during stability proof' \
    'legacy child replacement must fail with exact identity evidence'
  [ -f "$tmp/releases/.arena-ingest-deploy-blocked" ] || \
    fail 'replacement legacy child must retain a durable recovery block'
  rm -rf "$tmp"
  unset LEGACY_ROLLBACK_DISCOVERY_COUNT_FILE
  echo 'ok - legacy rollback binds one heartbeat child across both Redis proofs'
}

test_rollback_stability_lock_loss_is_rejected() {
  local tmp old_dir output status events
  tmp="$(mktemp -d)"
  tmp="$(cd "$tmp" && pwd -P)"
  old_dir="$tmp/releases/$OLD_SHA-lock-loss"
  export EVENT_LOG="$tmp/events" ACTIVE_CWD_FILE="$tmp/active-cwd"
  export OLD_CWD="$old_dir" CANDIDATE_FAILED_FILE="$tmp/candidate-failed"
  export ROLLBACK_REDIS_PASSED_FILE="$tmp/rollback-redis-passed"
  export FAKE_LOCK_DIR="$tmp/releases/.arena-ingest-deploy-lock-test"
  export LOCK_LOST_FILE="$tmp/lock-lost"
  export FAIL_FIRST_CANDIDATE_READY=1 LOSE_LOCK_DURING_ROLLBACK_STABILITY=1
  export FAKE_MODULE_STATUS=0 FAKE_PREFLIGHT_STATUS=0
  : > "$EVENT_LOG"
  printf '%s\n' "$old_dir" > "$ACTIVE_CWD_FILE"
  make_old_release "$tmp/releases" "$tmp/shared" "$old_dir"
  install_common_fake_functions
  install_fake_command_wrappers "$tmp"

  set +e
  output="$(run_fake_deploy "$tmp" 2>&1)"
  status=$?
  set -e
  unset FAIL_FIRST_CANDIDATE_READY LOSE_LOCK_DURING_ROLLBACK_STABILITY
  unset FAKE_MODULE_STATUS FAKE_PREFLIGHT_STATUS

  [ "$status" -ne 0 ] || fail 'lock loss during rollback stability must fail deployment'
  [ -e "$LOCK_LOST_FILE" ] || fail 'test must remove the lock during an exact stability probe'
  events="$(<"$EVENT_LOG")"
  assert_not_contains "$events" 'pm2 save' 'lock-lost rollback must never save PM2 state'
  assert_not_contains "$events" 'fs.unlinkSync' 'lock-lost rollback must never clear the journal'
  assert_contains "$output" 'lost the local deploy lock' \
    'lock loss must be detected inside the stability window'
  [ "$(sed -n '1p' "$tmp/releases/.arena-ingest-deploy-blocked")" = \
    'arena.local-ingest-cutover-journal@1' ] || \
    fail 'lock loss must preserve the original durable cutover journal'
  rm -rf "$tmp"
  unset ROLLBACK_REDIS_PASSED_FILE FAKE_LOCK_DIR LOCK_LOST_FILE
  echo 'ok - rollback stability aborts immediately when its local lock is lost'
}

test_rollback_finalization_lock_gaps_are_rejected() {
  local phase tmp old_dir output status events journal
  for phase in after_final_redis after_final_pm2 after_save; do
    tmp="$(mktemp -d)"
    tmp="$(cd "$tmp" && pwd -P)"
    old_dir="$tmp/releases/$OLD_SHA-lock-gap-$phase"
    export EVENT_LOG="$tmp/events" ACTIVE_CWD_FILE="$tmp/active-cwd"
    export OLD_CWD="$old_dir" CANDIDATE_FAILED_FILE="$tmp/candidate-failed"
    export STAMPED_PROOF_COUNT_FILE="$tmp/stamped-proof-count"
    export FINAL_REDIS_MARKER_FILE="$tmp/final-redis-passed"
    export FAKE_LOCK_DIR="$tmp/releases/.arena-ingest-deploy-lock-test"
    export LOCK_LOST_FILE="$tmp/lock-lost"
    export LOSE_LOCK_AT_ROLLBACK_PHASE="$phase" FAIL_FIRST_CANDIDATE_READY=1
    export FAKE_MODULE_STATUS=0 FAKE_PREFLIGHT_STATUS=0
    : > "$EVENT_LOG"
    printf '%s\n' "$old_dir" > "$ACTIVE_CWD_FILE"
    make_old_release "$tmp/releases" "$tmp/shared" "$old_dir"
    install_common_fake_functions
    install_fake_command_wrappers "$tmp"

    set +e
    output="$(run_fake_deploy "$tmp" 2>&1)"
    status=$?
    set -e

    [ "$status" -ne 0 ] || fail "lock loss at $phase must fail deployment"
    [ -e "$LOCK_LOST_FILE" ] || fail "test must remove the lock at $phase"
    events="$(<"$EVENT_LOG")"
    assert_contains "$events" 'rollback final-redis boundary=' \
      "$phase must happen only after the final Redis proof"
    case "$phase" in
      after_final_redis)
        assert_not_contains "$events" 'rollback final-pm2' \
          'lock loss after final Redis must fence the final PM2 proof'
        assert_not_contains "$events" 'pm2 save' \
          'lock loss after final Redis must fence PM2 save'
        ;;
      after_final_pm2)
        assert_contains "$events" 'rollback final-pm2' \
          'test must reach the final PM2 proof before taking the lock'
        assert_not_contains "$events" 'pm2 save' \
          'lock loss after final PM2 must fence PM2 save'
        ;;
      after_save)
        assert_contains "$events" 'rollback final-pm2' \
          'save-gap test must first finish the final PM2 proof'
        assert_contains "$events" 'pm2 save' \
          'save-gap test must take the lock only after PM2 save returns'
        ;;
    esac
    assert_not_contains "$events" 'journal unlink' \
      "lock loss at $phase must always fence journal removal"
    assert_contains "$output" 'lost the local deploy lock' \
      "$phase must be rejected by an explicit lock assertion"
    journal="$tmp/releases/.arena-ingest-deploy-blocked"
    [ "$(sed -n '1p' "$journal")" = 'arena.local-ingest-cutover-journal@1' ] || \
      fail "lock loss at $phase must preserve the original cutover journal"
    rm -rf "$tmp"
  done
  unset STAMPED_PROOF_COUNT_FILE FINAL_REDIS_MARKER_FILE FAKE_LOCK_DIR LOCK_LOST_FILE
  unset LOSE_LOCK_AT_ROLLBACK_PHASE FAIL_FIRST_CANDIDATE_READY
  unset FAKE_MODULE_STATUS FAKE_PREFLIGHT_STATUS
  echo 'ok - every final rollback commit gap is fenced by the same live lock'
}

test_legacy_discovery_uses_real_deadline_and_bounded_requests() {
  local tmp old_dir output status events started elapsed attempts first_budget last_budget
  tmp="$(mktemp -d)"
  tmp="$(cd "$tmp" && pwd -P)"
  old_dir="$tmp/releases/$OLD_SHA-legacy-deadline"
  export EVENT_LOG="$tmp/events" ACTIVE_CWD_FILE="$tmp/active-cwd"
  export OLD_CWD="$old_dir" CANDIDATE_FAILED_FILE="$tmp/candidate-failed"
  export DISCOVERY_BUDGET_SEEN_FILE="$tmp/discovery-budget-seen"
  export FAIL_FIRST_CANDIDATE_READY=1 FAIL_LEGACY_DISCOVERY_AFTER_CANDIDATE=1
  export REQUIRE_DISCOVERY_TIMEOUT_BUDGET=1 FAKE_MODULE_STATUS=0 FAKE_PREFLIGHT_STATUS=0
  export ARENA_LEGACY_DISCOVERY_TIMEOUT_SECONDS=4 FAKE_DISCOVERY_DELAY_SECONDS=0.4
  : > "$EVENT_LOG"
  printf '%s\n' "$old_dir" > "$ACTIVE_CWD_FILE"
  make_old_release "$tmp/releases" "$tmp/shared" "$old_dir"
  rm "$old_dir/WORKER_RELEASE_ID"
  chmod +x "$old_dir/worker/src/ingest-worker.ts"
  install_common_fake_functions
  install_fake_command_wrappers "$tmp"

  started=$SECONDS
  set +e
  output="$(run_fake_deploy "$tmp" 2>&1)"
  status=$?
  set -e
  elapsed=$((SECONDS - started))
  unset FAIL_FIRST_CANDIDATE_READY FAIL_LEGACY_DISCOVERY_AFTER_CANDIDATE
  unset REQUIRE_DISCOVERY_TIMEOUT_BUDGET FAKE_MODULE_STATUS FAKE_PREFLIGHT_STATUS

  [ "$status" -ne 0 ] || fail 'legacy Redis discovery timeout must fail deployment'
  [ -s "$DISCOVERY_BUDGET_SEEN_FILE" ] || \
    fail 'fake discovery must observe a real remaining wall-clock request budget'
  attempts="$(wc -l < "$DISCOVERY_BUDGET_SEEN_FILE" | tr -d '[:space:]')"
  [ "$attempts" -ge 3 ] || \
    fail 'legacy deadline test must make multiple HGETALL attempts against one deadline'
  awk '
    $0 !~ /^[1-9][0-9]*$/ || $1 > 4000 { exit 1 }
    NR > 1 && $1 >= previous { exit 1 }
    { previous = $1 }
  ' "$DISCOVERY_BUDGET_SEEN_FILE" || \
    fail 'each legacy HGETALL attempt must receive a smaller positive remaining budget'
  first_budget="$(sed -n '1p' "$DISCOVERY_BUDGET_SEEN_FILE")"
  last_budget="$(tail -1 "$DISCOVERY_BUDGET_SEEN_FILE")"
  [ "$first_budget" -gt "$last_budget" ] || \
    fail 'legacy discovery must spend one global budget instead of resetting per attempt'
  [ "$elapsed" -ge 4 ] && [ "$elapsed" -le 9 ] || \
    fail "legacy deadline must use real elapsed time despite frozen fake Date.now (got ${elapsed}s)"
  events="$(<"$EVENT_LOG")"
  assert_not_contains "$events" 'pm2 save' 'timed-out legacy proof must never save PM2 state'
  assert_not_contains "$events" 'fs.unlinkSync' 'timed-out legacy proof must never clear journal'
  assert_contains "$output" 'lacks fresh Redis/ancestry rollback evidence' \
    'legacy deadline failure must identify the Redis/ancestry gate'
  rm -rf "$tmp"
  unset DISCOVERY_BUDGET_SEEN_FILE ARENA_LEGACY_DISCOVERY_TIMEOUT_SECONDS
  unset FAKE_DISCOVERY_DELAY_SECONDS
  echo 'ok - legacy Redis discovery honors one real deadline and per-request remaining budget'
}

test_unproven_rollback_preserves_candidate_and_blocks_redeploy() {
  local tmp old_dir output status candidate=''
  tmp="$(mktemp -d)"
  tmp="$(cd "$tmp" && pwd -P)"
  old_dir="$tmp/releases/$OLD_SHA-$OLD_RELEASE"
  export EVENT_LOG="$tmp/events" ACTIVE_CWD_FILE="$tmp/active-cwd"
  export OLD_CWD="$old_dir" CANDIDATE_FAILED_FILE="$tmp/candidate-failed"
  export FAIL_FIRST_CANDIDATE_READY=1 FAIL_ROLLBACK_START=1
  export FAKE_MODULE_STATUS=0 FAKE_PREFLIGHT_STATUS=0
  : > "$EVENT_LOG"
  printf '%s\n' "$old_dir" > "$ACTIVE_CWD_FILE"
  make_old_release "$tmp/releases" "$tmp/shared" "$old_dir"
  install_common_fake_functions
  install_fake_command_wrappers "$tmp"

  set +e
  output="$(run_fake_deploy "$tmp" 2>&1)"
  status=$?
  set -e
  unset FAIL_FIRST_CANDIDATE_READY FAIL_ROLLBACK_START
  unset FAKE_MODULE_STATUS FAKE_PREFLIGHT_STATUS

  [ "$status" -ne 0 ] || fail 'unproven rollback must keep deployment failed'
  for candidate_dir in "$tmp/releases"/*; do
    [ -d "$candidate_dir" ] && [ ! -L "$candidate_dir" ] || continue
    if [ -f "$candidate_dir/DEPLOYED_SHA" ] && \
      [ "$(<"$candidate_dir/DEPLOYED_SHA")" = "$TEST_SHA" ]; then
      candidate="$candidate_dir"
    fi
  done
  [ -n "$candidate" ] || fail 'unproven rollback must preserve the candidate for forensics'
  assert_contains "$output" 'preserving failed candidate for supervised recovery' \
    'operator must receive explicit candidate-preservation evidence'
  [ -f "$tmp/releases/.arena-ingest-deploy-blocked" ] || \
    fail 'unproven rollback must durably block the next deployment'
  assert_contains "$(<"$tmp/releases/.arena-ingest-deploy-blocked")" "$candidate" \
    'recovery block must identify the exact preserved candidate cwd'
  rm -rf "$tmp"
  echo 'ok - unproven rollback preserves evidence and blocks automatic redeploy'
}

test_native_ready_log_requires_ordered_local_authority() (
  local tmp log marker function_source heartbeat
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  log="$tmp/ingest-out.log"
  marker='arena-local-deploy-authority-test'
  heartbeat="[heartbeat] redis-hset-committed node=mac-mini pid=4242 sha=$TEST_SHA release=$TEST_RELEASE ts=1800000000001"
  function_source="$(awk '
    /^wait_for_stamped_ready\(\) \{/ { capture = 1 }
    capture { print }
    capture && /^}$/ { exit }
  ' "$DEPLOY_SCRIPT")"
  [ -n "$function_source" ] || fail 'unable to load the production readiness verifier'
  eval "$function_source"
  sleep() { :; }
  AUTHORITY_HANDOFF_TIMEOUT_SECONDS=300
  ARENA_READY_TIMEOUT_SECONDS=1

  printf '%s\n' \
    "$marker" \
    "[heartbeat] redis-hset-committed node=mac-mini pid=3131 sha=$OLD_SHA release=$OLD_RELEASE ts=1800000000000" \
    '2026-07-28 12:00:00: [ingest-worker] metric-trust database release contract ready' \
    "2026-07-28 12:00:01: $heartbeat" \
    '2026-07-28 12:00:02: [ingest-worker] native regional authority ready region=local' \
    '2026-07-28 12:00:03: [ingest-worker] ready (regions=local, concurrency=5, fast-lane=off)' > "$log"
  wait_for_stamped_ready native "$marker" "$log" \
    "$TEST_SHA" "$TEST_RELEASE" mac-mini 4242 || \
    fail 'the exact ordered local authority sequence must pass'

  printf '%s\n' \
    "$marker" \
    '[ingest-worker] metric-trust database release contract ready' \
    "$heartbeat" \
    '[ingest-worker] ready (regions=local, concurrency=5, fast-lane=off)' > "$log"
  if wait_for_stamped_ready native "$marker" "$log" \
      "$TEST_SHA" "$TEST_RELEASE" mac-mini 4242; then
    fail 'native candidate readiness must reject a missing authority token'
  fi

  printf '%s\n' \
    "$marker" \
    '[ingest-worker] metric-trust database release contract ready' \
    "$heartbeat" \
    '[ingest-worker] native regional authority ready region=vps_sg' \
    '[ingest-worker] ready (regions=local, concurrency=5, fast-lane=off)' > "$log"
  if wait_for_stamped_ready native "$marker" "$log" \
      "$TEST_SHA" "$TEST_RELEASE" mac-mini 4242; then
    fail 'native candidate readiness must reject an authority token for the wrong region'
  fi

  printf '%s\n' \
    "$marker" \
    '[ingest-worker] metric-trust database release contract ready' \
    "$heartbeat" \
    '[ingest-worker] native regional authority ready region=local database_epoch=forged' \
    '[ingest-worker] ready (regions=local, concurrency=5, fast-lane=off)' > "$log"
  if wait_for_stamped_ready native "$marker" "$log" \
      "$TEST_SHA" "$TEST_RELEASE" mac-mini 4242; then
    fail 'native candidate readiness must reject authority suffix fields'
  fi

  printf '%s\n' \
    "$marker" \
    '[ingest-worker] metric-trust database release contract ready' \
    '[ingest-worker] native regional authority ready region=local' \
    "$heartbeat" \
    '[ingest-worker] ready (regions=local, concurrency=5, fast-lane=off)' > "$log"
  if wait_for_stamped_ready native "$marker" "$log" \
      "$TEST_SHA" "$TEST_RELEASE" mac-mini 4242; then
    fail 'native candidate readiness must reject authority before the committed heartbeat'
  fi

  printf '%s\n' \
    '[ingest-worker] native regional authority ready region=local' \
    "$marker" \
    '[ingest-worker] metric-trust database release contract ready' \
    "$heartbeat" \
    '[ingest-worker] ready (regions=local, concurrency=5, fast-lane=off)' > "$log"
  if wait_for_stamped_ready native "$marker" "$log" \
      "$TEST_SHA" "$TEST_RELEASE" mac-mini 4242; then
    fail 'native candidate readiness must reject authority evidence before the marker'
  fi

  printf '%s\n' \
    "$marker" \
    'noise [ingest-worker] metric-trust database release contract ready' \
    "noise $heartbeat" \
    'noise [ingest-worker] native regional authority ready region=local' \
    'noise [ingest-worker] ready (regions=local, concurrency=5, fast-lane=off)' > "$log"
  if wait_for_stamped_ready native "$marker" "$log" \
      "$TEST_SHA" "$TEST_RELEASE" mac-mini 4242; then
    fail 'embedded readiness substrings outside a canonical PM2 payload must not pass'
  fi

  printf '%s\n' \
    "$marker" \
    '[ingest-worker] metric-trust database release contract ready' \
    "[heartbeat] redis-hset-committed node=wrong node=mac-mini pid=4242 sha=$TEST_SHA release=$TEST_RELEASE ts=1800000000001" \
    '[ingest-worker] native regional authority ready region=local' \
    '[ingest-worker] ready (regions=local, concurrency=5, fast-lane=off)' > "$log"
  if wait_for_stamped_ready native "$marker" "$log" \
      "$TEST_SHA" "$TEST_RELEASE" mac-mini 4242; then
    fail 'duplicate heartbeat identity fields must not pass canonical evidence'
  fi

  printf '%s\n' \
    "$marker" \
    '[ingest-worker] metric-trust database release contract ready' \
    "[heartbeat] redis-hset-committed node=mac-mini pid=3131 sha=$TEST_SHA release=$TEST_RELEASE ts=1800000000001" \
    '[ingest-worker] native regional authority ready region=local' \
    '[ingest-worker] ready (regions=local, concurrency=5, fast-lane=off)' > "$log"
  if wait_for_stamped_ready native "$marker" "$log" \
      "$TEST_SHA" "$TEST_RELEASE" mac-mini 4242; then
    fail 'a canonical heartbeat from the previous PID must not pass candidate readiness'
  fi

  printf '%s\n' \
    "$marker" \
    '[ingest-worker] metric-trust database release contract ready' \
    '[ingest-worker] ready (regions=local, concurrency=5)' \
    "[heartbeat] node=mac-mini pid=4242 sha=$OLD_SHA release=$OLD_RELEASE" > "$log"
  wait_for_stamped_ready legacy "$marker" "$log" \
    "$OLD_SHA" "$OLD_RELEASE" mac-mini 4242 || \
    fail 'stamped rollback must remain compatible with the legacy readiness contract'

  echo 'ok - native readiness is ordered and legacy stamped rollback stays compatible'
)

test_success_keeps_only_current_and_previous_immutable_releases() {
  local tmp old_dir stale_one stale_two outside new_dir output status release_count link rel
  tmp="$(mktemp -d)"
  tmp="$(cd "$tmp" && pwd -P)"
  old_dir="$tmp/releases/$OLD_SHA-$OLD_RELEASE"
  stale_one="$tmp/releases/1111111111111111111111111111111111111111-$(printf '1%.0s' {1..64})"
  stale_two="$tmp/releases/2222222222222222222222222222222222222222-$(printf '2%.0s' {1..64})"
  outside="$tmp/outside-must-survive"
  export EVENT_LOG="$tmp/events" ACTIVE_CWD_FILE="$tmp/active-cwd"
  export OLD_CWD="$old_dir" CANDIDATE_FAILED_FILE="$tmp/candidate-failed"
  export FAIL_FIRST_CANDIDATE_READY=0 FAKE_MODULE_STATUS=0 FAKE_PREFLIGHT_STATUS=0
  : > "$EVENT_LOG"
  printf '%s\n' "$old_dir" > "$ACTIVE_CWD_FILE"
  make_old_release "$tmp/releases" "$tmp/shared" "$old_dir"
  cp -a "$old_dir" "$stale_one"
  cp -a "$old_dir" "$stale_two"
  printf '%s\n' '1111111111111111111111111111111111111111' > "$stale_one/DEPLOYED_SHA"
  printf '%s\n' "$(printf '1%.0s' {1..64})" > "$stale_one/WORKER_RELEASE_ID"
  printf '%s\n' 'arena.local-ingest-release@1' > "$stale_one/.ARENA_LOCAL_RELEASE"
  printf '%s\n' '2222222222222222222222222222222222222222' > "$stale_two/DEPLOYED_SHA"
  printf '%s\n' "$(printf '2%.0s' {1..64})" > "$stale_two/WORKER_RELEASE_ID"
  printf '%s\n' 'arena.local-ingest-release@1' > "$stale_two/.ARENA_LOCAL_RELEASE"
  printf '%s\n' SAFE > "$outside"
  ln -s "$outside" "$tmp/releases/outside-link"
  install_common_fake_functions
  install_fake_command_wrappers "$tmp"

  set +e
  output="$(run_fake_deploy "$tmp" 2>&1)"
  status=$?
  set -e
  unset FAIL_FIRST_CANDIDATE_READY FAKE_MODULE_STATUS FAKE_PREFLIGHT_STATUS

  [ "$status" -eq 0 ] || { printf '%s\n' "$output" >&2; fail 'fully gated fake deploy must succeed'; }
  [ -f "$outside" ] && [ "$(<"$outside")" = SAFE ] || \
    fail 'safe retention must never follow an out-of-root symlink'
  release_count="$(find "$tmp/releases" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
  [ "$release_count" -eq 2 ] || \
    fail "retention must leave exactly current and previous directories (got $release_count)"
  [ -d "$old_dir" ] || fail 'successful cutover must retain the immediately previous release'

  new_dir=''
  for rel in "$tmp/releases"/*; do
    [ -d "$rel" ] && [ ! -L "$rel" ] || continue
    if [ -f "$rel/DEPLOYED_SHA" ] && [ "$(<"$rel/DEPLOYED_SHA")" = "$TEST_SHA" ]; then
      new_dir="$rel"
    fi
  done
  [ -n "$new_dir" ] || fail 'current release must retain the exact target stamp'
  [ "$(<"$new_dir/WORKER_RELEASE_ID")" = "$TEST_RELEASE" ] || \
    fail 'current release must retain the deterministic release stamp'
  [ -d "$new_dir/node_modules" ] && [ ! -L "$new_dir/node_modules" ] || \
    fail 'current node_modules must be a release-owned real directory'
  [ -d "$new_dir/.playwright-browsers" ] && [ ! -L "$new_dir/.playwright-browsers" ] || \
    fail 'current browser bytes must be a release-owned real directory'
  [ ! -e "$new_dir/.env.local" ] || fail '.env.local must never enter a worker release'
  while IFS= read -r link; do
    case "${link#"$new_dir"/}" in
      .arena-ingest|worker/logs|worker/.env) ;;
      *) fail "unexpected shared symlink in immutable release: $link" ;;
    esac
  done < <(find "$new_dir" -type l -print)
  [ "$(<"$ACTIVE_CWD_FILE")" = "$new_dir" ] || \
    fail 'successful PM2 owner must use the exact immutable current cwd'
  rm -rf "$tmp"
  echo 'ok - success keeps only immutable current and previous releases safely'
}

bash -n "$DEPLOY_SCRIPT" "$0"
test_non_main_target_fails_before_local_mutation
test_dirty_or_stale_orchestrator_fails_before_local_mutation
test_archive_invocation_has_no_ui_paths
test_incident_hold_refuses_before_candidate_or_pm2
test_stopped_recovery_requires_one_time_confirmation
test_stopped_recovery_rejects_residual_os_owner
test_stopped_recovery_failure_stays_stopped_and_rearms_holds
test_stopped_recovery_success_starts_only_proven_candidate
test_busy_lock_refuses_before_candidate_or_pm2_stop
test_runtime_mismatch_fails_before_pm2_stop
test_disk_module_and_database_failures_precede_pm2_stop
test_failed_candidate_readiness_restores_old_exact_cwd
test_legacy_rollback_requires_stability_and_reproof
test_post_redis_restart_never_commits_rollback
test_stamped_final_freshness_timeout_never_commits_rollback
test_dead_equal_pid_is_not_live_ancestry
test_baseline_owner_delayed_death_preserves_journal
test_stable_baseline_owner_reproves_before_clearing_journal
test_legacy_heartbeat_child_replacement_is_rejected
test_rollback_stability_lock_loss_is_rejected
test_rollback_finalization_lock_gaps_are_rejected
test_legacy_discovery_uses_real_deadline_and_bounded_requests
test_unproven_rollback_preserves_candidate_and_blocks_redeploy
test_native_ready_log_requires_ordered_local_authority
test_success_keeps_only_current_and_previous_immutable_releases
