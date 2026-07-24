#!/usr/bin/env bash
# Offline contract tests for the SG deploy safety rails. External commands are
# replaced with exported Bash functions; no SSH, rsync, Docker, or remote writes.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEPLOY_SCRIPT="$ROOT/worker/deploy-ingest-sg.sh"
DOCKER_SCRIPT="$ROOT/worker/docker-run-sg.sh"
COMPOSE_FILE="$ROOT/worker/docker-compose.sg.yml"
TEST_SHA='0123456789abcdef0123456789abcdef01234567'
TARGET_ARG="--target-sha=$TEST_SHA"
export TEST_SHA TARGET_ARG

fail() {
  echo "not ok - $*" >&2
  exit 1
}

# The deploy derives its runtime bundle identity before any remote mutation.
# Unit tests use a stable fake because their mocked Git SHA is intentionally not
# an object in the real repository.
node() {
  printf '%064d\n' 0
}
export -f node

emit_test_archive() {
  command tar -cf - \
    .npmrc package.json package-lock.json tsconfig.json \
    scripts/ci/worker-release-id.mjs worker/deploy-ingest-sg.sh \
    lib/ingest/core/regions.ts
}
export -f emit_test_archive

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local label="$3"
  [[ "$haystack" == *"$needle"* ]] || fail "$label (missing: $needle)"
}

test_dry_run_itemizes_changes() {
  git() {
    if [ "${1:-}" = archive ]; then emit_test_archive
    else printf '%s\n' "$TEST_SHA"
    fi
  }
  date() { printf '%s\n' '20260715-120000'; }
  rsync() { printf 'RSYNC_ARGS %s\n' "$*"; }
  export -f git date rsync

  local output
  output="$(INGEST_SG_HOST=test@sg bash "$DEPLOY_SCRIPT" --dry-run 2>&1)"
  assert_contains "$output" '--dry-run' 'dry-run must pass rsync dry-run mode'
  assert_contains "$output" '--itemize-changes' 'dry-run must itemize file changes'
  echo 'ok - dry-run itemizes rsync changes'
}

test_artifact_preflight_fails_before_remote_access() {
  git() {
    if [ "${1:-}" = archive ]; then emit_test_archive
    else printf '%s\n' "$TEST_SHA"
    fi
  }
  date() { printf '%s\n' '20260715-120000'; }
  ssh() { fail "artifact preflight must not reach SSH: $*"; }
  export -f git date ssh fail

  local output status
  set +e
  output="$(INGEST_SG_HOST=test@sg bash "$DEPLOY_SCRIPT" "$TARGET_ARG" \
    --from-artifact=/definitely/absent.tgz \
    --artifact-manifest=/definitely/absent.manifest 2>&1)"
  status=$?
  set -e
  [ "$status" -ne 0 ] || fail 'missing artifact must fail deployment'
  assert_contains "$output" 'artifact not found' 'artifact failure must be explicit'
  echo 'ok - artifact is validated before any remote access'
}

test_release_helper_failure_fails_before_remote_access() {
  git() {
    if [ "${1:-}" = archive ]; then emit_test_archive
    else printf '%s\n' "$TEST_SHA"
    fi
  }
  date() { printf '%s\n' '20260715-120000'; }
  node() { return 19; }
  ssh() { fail "failed release helper must not reach SSH: $*"; }
  export -f git date node ssh fail

  local output status
  set +e
  output="$(INGEST_SG_HOST=test@sg bash "$DEPLOY_SCRIPT" "$TARGET_ARG" --code-only 2>&1)"
  status=$?
  set -e
  [ "$status" -ne 0 ] || fail 'failed worker release helper must fail deployment'
  [[ "$output" != *'acquiring token-fenced'* ]] || fail 'helper failure must precede remote lock'

  node() { printf '%064d\n' 0; }
  export -f node
  echo 'ok - release helper failure is fail-closed before remote access'
}

test_pm2_stop_failure_restores_previous_process() {
  local event_log hash old_sha old_release output status
  event_log="$(mktemp)"
  hash="$(printf '%064d' 0)"
  old_sha="$(printf 'f%.0s' {1..40})"
  old_release="$(printf 'e%.0s' {1..64})"
  export EVENT_LOG="$event_log" TEST_HASH="$hash" OLD_SHA="$old_sha" OLD_RELEASE="$old_release"

  git() {
    if [ "${1:-}" = archive ]; then emit_test_archive
    else printf '%s\n' "$TEST_SHA"
    fi
  }
  date() { printf '%s\n' '20260715-120000'; }
  sha256sum() {
    if [ "$#" -eq 0 ]; then while IFS= read -r _; do :; done; fi
    printf '%s  %s\n' "$TEST_HASH" "${1:--}"
  }
  rsync() { printf 'rsync %s\n' "$*" >> "$EVENT_LOG"; }
  ssh() {
    printf 'ssh %s\n' "$*" >> "$EVENT_LOG"
    if [[ "$*" == *"printf 'LOCKED"* ]]; then printf '%s\n' LOCKED; return 0; fi
    if [[ "$*" == *"test \"\$(cat '/opt/arena-ingest.deploy-lock/owner'"* ]]; then return 0; fi
    if [[ "$*" == *"rm -rf '/opt/arena-ingest.deploy-lock'"* ]]; then return 0; fi
    if [[ "$*" == *'docker ps'*'--format'* ]]; then return 0; fi
    if [[ "$*" == *'process.versions.node'*'process.arch'* ]]; then printf '%s\n' '22 x64'; return 0; fi
    if [[ "$*" == *'for f in .npmrc package.json package-lock.json'* ]]; then
      printf '%s\n' "$TEST_HASH"; return 0
    fi
    if [[ "$*" == *"pm2 stop 'arena-ingest-worker-sg'"* ]]; then return 55; fi
    if [[ "$*" == *"cat '/opt/arena-ingest/DEPLOYED_SHA'"* ]]; then printf '%s\n' "$OLD_SHA"; return 0; fi
    if [[ "$*" == *"cat '/opt/arena-ingest/WORKER_RELEASE_ID'"* ]]; then printf '%s\n' "$OLD_RELEASE"; return 0; fi
    if [[ "$*" == *'for i in $(seq 1 90)'* ]]; then printf '%s\n' READY; return 0; fi
    return 0
  }
  export -f git date sha256sum rsync ssh

  set +e
  output="$(INGEST_SG_HOST=test@sg bash "$DEPLOY_SCRIPT" "$TARGET_ARG" --code-only 2>&1)"
  status=$?
  set -e
  [ "$status" -ne 0 ] || fail 'PM2 stop failure must fail deployment'
  if [[ "$(<"$event_log")" != *"pm2 stop 'arena-ingest-worker-sg'"* ]]; then
    printf '%s\n' "$output" >&2
    printf '%s\n' "$(<"$event_log")" >&2
    fail 'test must reach the fail-closed stop'
  fi
  assert_contains "$(<"$event_log")" "pm2 stop 'arena-ingest-worker-sg'" \
    'test must reach the fail-closed stop'
  assert_contains "$(<"$event_log")" "pm2 delete 'arena-ingest-worker-sg'" \
    'post-stop uncertainty must restart the previous exact process'
  [[ "$(<"$event_log")" != *"mv '/opt/arena-ingest' '/opt/arena-ingest.bak-"* ]] || \
    fail 'failed stop must never cut over directories'
  assert_contains "$output" 'previous SG release restored' \
    'successful recovery must emit exact evidence'
  rm -f "$event_log"
  echo 'ok - PM2 stop failure restarts the previous exact release without cutover'
}

test_failed_candidate_readiness_rolls_back_complete_directory() {
  local event_log ready_count hash old_sha old_release output status start_count
  event_log="$(mktemp)"
  ready_count="$(mktemp)"
  printf '%s\n' 0 > "$ready_count"
  hash="$(printf '%064d' 0)"
  old_sha="$(printf 'f%.0s' {1..40})"
  old_release="$(printf 'e%.0s' {1..64})"
  export EVENT_LOG="$event_log" READY_COUNT_FILE="$ready_count" TEST_HASH="$hash"
  export OLD_SHA="$old_sha" OLD_RELEASE="$old_release"

  git() {
    if [ "${1:-}" = archive ]; then emit_test_archive
    else printf '%s\n' "$TEST_SHA"
    fi
  }
  date() { printf '%s\n' '20260715-120000'; }
  sha256sum() {
    if [ "$#" -eq 0 ]; then while IFS= read -r _; do :; done; fi
    printf '%s  %s\n' "$TEST_HASH" "${1:--}"
  }
  rsync() { printf 'rsync %s\n' "$*" >> "$EVENT_LOG"; }
  ssh() {
    local count
    printf 'ssh %s\n' "$*" >> "$EVENT_LOG"
    if [[ "$*" == *"printf 'LOCKED"* ]]; then printf '%s\n' LOCKED; return 0; fi
    if [[ "$*" == *"test \"\$(cat '/opt/arena-ingest.deploy-lock/owner'"* ]]; then return 0; fi
    if [[ "$*" == *"rm -rf '/opt/arena-ingest.deploy-lock'"* ]]; then return 0; fi
    if [[ "$*" == *'docker ps'*'--format'* ]]; then return 0; fi
    if [[ "$*" == *'process.versions.node'*'process.arch'* ]]; then printf '%s\n' '22 x64'; return 0; fi
    if [[ "$*" == *'for f in .npmrc package.json package-lock.json'* ]]; then
      printf '%s\n' "$TEST_HASH"; return 0
    fi
    if [[ "$*" == *"cat '/opt/arena-ingest/DEPLOYED_SHA'"* ]]; then printf '%s\n' "$OLD_SHA"; return 0; fi
    if [[ "$*" == *"cat '/opt/arena-ingest/WORKER_RELEASE_ID'"* ]]; then printf '%s\n' "$OLD_RELEASE"; return 0; fi
    if [[ "$*" == *'for i in $(seq 1 90)'* ]]; then
      count="$(<"$READY_COUNT_FILE")"
      count=$((count + 1))
      printf '%s\n' "$count" > "$READY_COUNT_FILE"
      if [ "$count" -eq 1 ]; then return 1; fi
      printf '%s\n' READY
      return 0
    fi
    return 0
  }
  export -f git date sha256sum rsync ssh

  set +e
  output="$(INGEST_SG_HOST=test@sg bash "$DEPLOY_SCRIPT" "$TARGET_ARG" --code-only 2>&1)"
  status=$?
  set -e
  [ "$status" -ne 0 ] || fail 'failed candidate readiness must fail deployment'
  assert_contains "$(<"$event_log")" "mv '/opt/arena-ingest' '/opt/arena-ingest.bak-" \
    'test must reach the atomic directory cutover'
  assert_contains "$(<"$event_log")" "mv '/opt/arena-ingest.bak-20260715-120000' '/opt/arena-ingest'" \
    'rollback must restore the complete previous directory'
  start_count="$(grep -c "pm2 delete 'arena-ingest-worker-sg'" "$event_log" || true)"
  [ "$start_count" -ge 2 ] || fail 'candidate and rollback PM2 starts must both execute'
  [ "$(<"$ready_count")" -eq 2 ] || fail 'rollback must obtain a second fresh readiness proof'
  assert_contains "$output" 'previous SG release restored' \
    'rollback must report exact fresh identity evidence'
  rm -f "$event_log" "$ready_count"
  echo 'ok - failed candidate readiness restores and verifies the complete previous release'
}

test_running_container_refuses_pm2_deploy() {
  git() {
    if [ "${1:-}" = archive ]; then emit_test_archive
    else printf '%s\n' "$TEST_SHA"
    fi
  }
  date() { printf '%s\n' '20260715-120000'; }
  ssh() {
    if [[ "$*" == *"printf 'LOCKED"* ]]; then
      printf '%s\n' LOCKED
      return 0
    fi
    if [[ "$*" == *"test \"\$(cat '/opt/arena-ingest.deploy-lock/owner'"* ]]; then
      return 0
    fi
    if [[ "$*" == *"rm -rf '/opt/arena-ingest.deploy-lock'"* ]]; then
      return 0
    fi
    if [[ "$*" == *'docker ps'*'--format'* ]]; then
      printf '%s\n' 'arena-ingest-worker-sg-ctr'
      return 0
    fi
    fail "unexpected SSH after container guard: $*"
  }
  export -f git date ssh fail

  local output status
  set +e
  output="$(INGEST_SG_HOST=test@sg bash "$DEPLOY_SCRIPT" "$TARGET_ARG" --code-only 2>&1)"
  status=$?
  set -e
  [[ "$status" -eq 1 ]] || fail "running container must make deploy exit 1 (got $status)"
  assert_contains "$output" 'PM2 deploy refused' 'guard must explain refusal'
  assert_contains "$output" 'arena-ingest-worker-sg-ctr' 'guard must name the running container'
  [[ "$output" != *'backing up remote'* ]] || fail 'guard must run before remote backup'
  [[ "$output" != *'gracefully stopping'* ]] || fail 'guard must run before PM2 stop'
  echo 'ok - running Docker consumer blocks PM2 deploy before mutation'
}

test_docker_inspection_failure_aborts_deploy() {
  git() {
    if [ "${1:-}" = archive ]; then emit_test_archive
    else printf '%s\n' "$TEST_SHA"
    fi
  }
  date() { printf '%s\n' '20260715-120000'; }
  ssh() {
    if [[ "$*" == *"printf 'LOCKED"* ]]; then
      printf '%s\n' LOCKED
      return 0
    fi
    if [[ "$*" == *"test \"\$(cat '/opt/arena-ingest.deploy-lock/owner'"* ]]; then
      return 0
    fi
    if [[ "$*" == *"rm -rf '/opt/arena-ingest.deploy-lock'"* ]]; then
      return 0
    fi
    if [[ "$*" == *'docker ps'*'--format'* ]]; then
      return 23
    fi
    fail "unexpected SSH after failed Docker inspection: $*"
  }
  export -f git date ssh fail

  local output status
  set +e
  output="$(INGEST_SG_HOST=test@sg bash "$DEPLOY_SCRIPT" "$TARGET_ARG" --code-only 2>&1)"
  status=$?
  set -e
  [[ "$status" -ne 0 ]] || fail 'failed Docker inspection must abort the deploy'
  [[ "$output" != *'backing up remote'* ]] || fail 'inspection failure must precede backup'
  [[ "$output" != *'gracefully stopping'* ]] || fail 'inspection failure must precede PM2 stop'
  echo 'ok - Docker inspection failure aborts deploy before mutation'
}

test_concurrent_deploy_refuses_before_backup() {
  git() {
    if [ "${1:-}" = archive ]; then emit_test_archive
    else printf '%s\n' "$TEST_SHA"
    fi
  }
  date() { printf '%s\n' '20260715-120000'; }
  sha1sum() { printf '%s  %s\n' 'same-lock-hash' "${1:-file}"; }
  ssh() {
    if [[ "$*" == *'docker ps'*'--format'* ]]; then
      return 0
    fi
    if [[ "$*" == *"test -f '/opt/arena-ingest/.npmrc'"* ]]; then
      return 0
    fi
    if [[ "$*" == *"sha1sum .npmrc package.json package-lock.json"* ]]; then
      printf '%s\n' 'same-lock-hash'
      return 0
    fi
    if [[ "$*" == *'/opt/arena-ingest.deploy-lock'*'mkdir'* ]]; then
      printf '%s\n' 'BUSY: SG ingest deploy lease is held by existing-run' >&2
      return 75
    fi
    fail "unexpected SSH after deploy lease contention: $*"
  }
  export -f git date sha1sum ssh fail

  local output status
  set +e
  output="$(INGEST_SG_HOST=test@sg bash "$DEPLOY_SCRIPT" "$TARGET_ARG" --code-only 2>&1)"
  status=$?
  set -e
  [[ "$status" -ne 0 ]] || fail 'concurrent deploy must be refused'
  assert_contains "$output" 'BUSY: SG ingest deploy lease is held' \
    'contention must identify the existing deploy lease'
  [[ "$output" != *'backing up remote'* ]] || fail 'lease contention must precede backup'
  [[ "$output" != *'gracefully stopping'* ]] || fail 'lease contention must precede PM2 stop'
  echo 'ok - concurrent SG deploy is refused before remote mutation'
}

test_deploy_lease_is_fenced_and_recoverable() {
  local deploy
  deploy="$(<"$DEPLOY_SCRIPT")"
  assert_contains "$deploy" 'DEPLOY_LOCK_STALE_SECONDS=900' \
    'deploy lease must have a bounded crash-recovery window'
  assert_contains "$deploy" 'touch \"\$lock_dir/heartbeat\"' \
    'deploy lease must publish a heartbeat'
  assert_contains "$deploy" 'mv \"\$lock_dir\" \"\$stale_dir\"' \
    'stale lease takeover must use an atomic rename'
  assert_contains "$deploy" 'cat '\''$DEPLOY_LOCK_DIR/owner'\''' \
    'lease cleanup must read the remote owner token'
  assert_contains "$deploy" "rm -rf '\$DEPLOY_LOCK_DIR'" \
    'token-fenced cleanup must remove the lease'
  [[ "${deploy%%RUNNING_INGEST_CONTAINERS=*}" == *'acquire_deploy_lock'* ]] || \
    fail 'deploy lease must be acquired before remote Docker inspection'
  echo 'ok - deploy lease is token-fenced with bounded stale recovery'
}

test_container_bypass_is_disabled() {
  local output status compose
  set +e
  output="$(bash "$DOCKER_SCRIPT" deploy ignored 2>&1)"
  status=$?
  set -e
  [ "$status" -eq 2 ] || fail 'disabled Docker runner must exit 2'
  assert_contains "$output" 'disabled: use the exact-main transactional SG deploy workflow' \
    'Docker runner must direct operators to the sole deployment channel'

  compose="$(<"$COMPOSE_FILE")"
  assert_contains "$compose" 'services: {}' 'Compose must expose no bypass service'
  [[ "$compose" != *'image:'* ]] || fail 'disabled Compose file must not name a runnable image'
  echo 'ok - Docker and Compose bypass deployment paths are disabled'
}

test_ready_check_requires_fresh_sha_evidence() {
  local deploy marker_line start_line
  deploy="$(<"$DEPLOY_SCRIPT")"
  assert_contains "$deploy" 'READY_MARKER="arena-deploy-' \
    'PM2 deploy must create a unique readiness marker'
  assert_contains "$deploy" 'index(\$0, marker) { after = 1; ready = 0; heartbeat = 0; next }' \
    'readiness must ignore log lines before the deployment marker'
  assert_contains "$deploy" 'index(\$0, \"sha=\" sha)' \
    'readiness must require the expected deployed heartbeat SHA'
  assert_contains "$deploy" 'index(\$0, \"release=\" release)' \
    'readiness must require the expected worker release ID'
  marker_line="$(grep -n '^READY_MARKER=' "$DEPLOY_SCRIPT" | tail -1 | cut -d: -f1)"
  start_line="$(grep -n '^start_exact_pm2$' "$DEPLOY_SCRIPT" | tail -1 | cut -d: -f1)"
  [ "$marker_line" -lt "$start_line" ] || fail 'deployment marker must precede exact PM2 start'
  [[ "$deploy" != *"pm2 logs \$PM2_APP --lines 400"* ]] || \
    fail 'readiness must not pass on an old line from a fixed PM2 log window'
  echo 'ok - PM2 readiness requires fresh post-marker SHA evidence'
}

test_release_stamp_matches_exact_committed_inputs() {
  local deploy
  deploy="$(<"$DEPLOY_SCRIPT")"
  assert_contains "$deploy" 'GIT_NO_REPLACE_OBJECTS=1 git archive "$SHA"' \
    'deployment source must be materialized from the exact commit'
  assert_contains "$deploy" 'CODE_PATHS=(.npmrc lib worker package.json package-lock.json tsconfig.json)' \
    'every deploy mode must ship the complete worker release inputs'
  assert_contains "$deploy" 'LOCAL_DEP_INPUTS_HASH="$(dependency_input_hash "$DEPLOY_SOURCE_DIR")"' \
    'code-only must attest every dependency install input'
  assert_contains "$deploy" '"${SOURCE_PATHS[@]}" "$VPS_HOST:$STAGING_DIR/"' \
    'rsync must populate an isolated candidate from the immutable snapshot'
  assert_contains "$deploy" "mv '\$STAGING_DIR/.WORKER_RELEASE_ID.tmp' '\$STAGING_DIR/WORKER_RELEASE_ID'" \
    'worker release stamp must be atomically renamed'
  assert_contains "$deploy" "mv '\$REMOTE_DIR' '\$BACKUP_DIR'" \
    'cutover must preserve the previous complete release directory'
  assert_contains "$deploy" 'recover_previous_release || status=1' \
    'every post-stop failure must run the centralized rollback path'
  assert_contains "$deploy" 'wait_for_fresh_ready "$READY_MARKER" "$SHA" "$WORKER_RELEASE_ID"' \
    'fresh readiness must compare the full SHA and release ID'
  echo 'ok - release stamp is bound to exact committed code and dependency inputs'
}

bash -n "$DEPLOY_SCRIPT" "$DOCKER_SCRIPT" "$0"
test_dry_run_itemizes_changes
test_artifact_preflight_fails_before_remote_access
test_release_helper_failure_fails_before_remote_access
test_pm2_stop_failure_restores_previous_process
test_failed_candidate_readiness_rolls_back_complete_directory
test_running_container_refuses_pm2_deploy
test_docker_inspection_failure_aborts_deploy
test_concurrent_deploy_refuses_before_backup
test_deploy_lease_is_fenced_and_recoverable
test_container_bypass_is_disabled
test_ready_check_requires_fresh_sha_evidence
test_release_stamp_matches_exact_committed_inputs
