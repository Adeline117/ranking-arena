#!/usr/bin/env bash
# Offline contract tests for the SG deploy safety rails. External commands are
# replaced with exported Bash functions; no SSH, rsync, Docker, or remote writes.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEPLOY_SCRIPT="$ROOT/worker/deploy-ingest-sg.sh"
DOCKER_SCRIPT="$ROOT/worker/docker-run-sg.sh"
COMPOSE_FILE="$ROOT/worker/docker-compose.sg.yml"
LOG_VERIFIER="$ROOT/worker/verify-sg-ready-log.awk"
SG_PREFLIGHT="$ROOT/worker/preflight-sg-runtime.ts"
SG_ENTRYPOINT="$ROOT/worker/src/ingest-worker.ts"
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
    worker/preflight-sg-runtime.ts worker/verify-sg-heartbeat.ts \
    worker/verify-sg-ready-log.awk \
    lib/ingest/core/regions.ts
}
export -f emit_test_archive

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local label="$3"
  [[ "$haystack" == *"$needle"* ]] || fail "$label (missing: $needle)"
}

# Execute selected remote shell fragments locally while retaining their actual
# arithmetic, set -e behavior, and Node predicates. These helpers are exported
# because the deploy script runs in a child Bash process with an exported ssh
# mock.
run_remote_lease_predicate_fixture() {
  local remote="$1"
  (
    unset -f node
    cat() {
      if [[ "${1:-}" == */owner ]]; then
        printf '%s\n' "$TEST_REMOTE_LOCK_OWNER"
      else
        command cat "$@"
      fi
    }
    date() {
      if [ "${1:-}" = +%s ]; then
        printf '%s\n' "$TEST_REMOTE_NOW_SECONDS"
      else
        command date "$@"
      fi
    }
    stat() {
      if [[ "${!#}" == */heartbeat ]]; then
        printf '%s\n' "$TEST_REMOTE_HEARTBEAT_SECONDS"
      else
        command stat "$@"
      fi
    }
    export -f cat date stat
    bash -c "$remote"
  )
}

run_remote_stop_token_flip_fixture() {
  local remote="$1"
  (
    unset -f node
    cat() {
      local count
      if [[ "${1:-}" == */owner ]]; then
        count="$(<"$STOP_OWNER_COUNT_FILE")"
        count=$((count + 1))
        printf '%s\n' "$count" > "$STOP_OWNER_COUNT_FILE"
        if [ "$count" -le 2 ]; then
          printf '%s\n' "$TEST_REMOTE_LOCK_OWNER"
        else
          printf '%s\n' 'replacement-deploy-owner'
        fi
      else
        command cat "$@"
      fi
    }
    pm2() {
      printf 'remote-pm2 %s\n' "$*" >> "$EVENT_LOG"
      case "${1:-}" in
        stop) return 0 ;;
        pid) printf '%s\n' 4242; return 0 ;;
        *) return 64 ;;
      esac
    }
    sleep() { return 0; }
    export -f cat pm2 sleep
    bash -c "$remote"
  )
}

run_remote_restarted_pm2_fixture() {
  local remote="$1"
  (
    unset -f node
    cat() {
      if [[ "${1:-}" == */owner ]]; then
        printf '%s\n' "$TEST_REMOTE_LOCK_OWNER"
      else
        command cat "$@"
      fi
    }
    pm2() {
      case "${1:-}" in
        jlist)
          printf '[{"name":"%s","pid":4242,"pm2_env":{"status":"online","pm_cwd":"%s","restart_time":1}}]\n' \
            "$TEST_REMOTE_PM2_APP" "$TEST_REMOTE_PM2_CWD"
          return 0
          ;;
        *) return 64 ;;
      esac
    }
    sleep() { return 0; }
    export -f cat pm2 sleep
    bash -c "$remote"
  )
}

export -f run_remote_lease_predicate_fixture run_remote_stop_token_flip_fixture
export -f run_remote_restarted_pm2_fixture

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
    if [[ "$*" == *"pm2 stop 'arena-ingest-worker-sg'"* ]]; then return 55; fi
    if [[ "$*" == *"rm -rf '/opt/arena-ingest.deploy-lock'"* ]]; then return 0; fi
    if [[ "$*" == *'docker ps'*'--format'* ]]; then return 0; fi
    if [[ "$*" == *'process.versions.node'*'process.arch'* ]]; then printf '%s\n' '22 x64'; return 0; fi
    if [[ "$*" == *'process.stdout.write(String(Date.now()))'* ]]; then
      printf '%s\n' '1800000000000'; return 0
    fi
    if [[ "$*" == *'const pid = apps[0]?.pid'* ]]; then printf '%s\n' '4242'; return 0; fi
    if [[ "$*" == *'verify-sg-heartbeat.ts'* ]]; then
      printf '%s\n' '[sg-heartbeat-proof] exact fresh Redis roster identity ready'; return 0
    fi
    if [[ "$*" == *'for f in .npmrc package.json package-lock.json'* ]]; then
      printf '%s\n' "$TEST_HASH"; return 0
    fi
    if [[ "$*" == *"cat '/opt/arena-ingest/DEPLOYED_SHA'"* ]]; then printf '%s\n' "$OLD_SHA"; return 0; fi
    if [[ "$*" == *"cat '/opt/arena-ingest/WORKER_RELEASE_ID'"* ]]; then printf '%s\n' "$OLD_RELEASE"; return 0; fi
    if [[ "$*" == *'for i in $(seq 1 300)'* ]]; then printf '%s\n' READY; return 0; fi
    if [[ "$*" == *"test \"\$(cat '/opt/arena-ingest.deploy-lock/owner'"* ]]; then return 0; fi
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
    if [[ "$*" == *"rm -rf '/opt/arena-ingest.deploy-lock'"* ]]; then return 0; fi
    if [[ "$*" == *'docker ps'*'--format'* ]]; then return 0; fi
    if [[ "$*" == *'process.versions.node'*'process.arch'* ]]; then printf '%s\n' '22 x64'; return 0; fi
    if [[ "$*" == *'process.stdout.write(String(Date.now()))'* ]]; then
      printf '%s\n' '1800000000000'; return 0
    fi
    if [[ "$*" == *'const pid = apps[0]?.pid'* ]]; then printf '%s\n' '4242'; return 0; fi
    if [[ "$*" == *'verify-sg-heartbeat.ts'* ]]; then
      printf '%s\n' '[sg-heartbeat-proof] exact fresh Redis roster identity ready'; return 0
    fi
    if [[ "$*" == *'for f in .npmrc package.json package-lock.json'* ]]; then
      printf '%s\n' "$TEST_HASH"; return 0
    fi
    if [[ "$*" == *"cat '/opt/arena-ingest/DEPLOYED_SHA'"* ]]; then printf '%s\n' "$OLD_SHA"; return 0; fi
    if [[ "$*" == *"cat '/opt/arena-ingest/WORKER_RELEASE_ID'"* ]]; then printf '%s\n' "$OLD_RELEASE"; return 0; fi
    if [[ "$*" == *'for i in $(seq 1 300)'* ]]; then
      count="$(<"$READY_COUNT_FILE")"
      count=$((count + 1))
      printf '%s\n' "$count" > "$READY_COUNT_FILE"
      if [ "$count" -eq 1 ]; then return 1; fi
      printf '%s\n' READY
      return 0
    fi
    if [[ "$*" == *"test \"\$(cat '/opt/arena-ingest.deploy-lock/owner'"* ]]; then return 0; fi
    return 0
  }
  export -f git date sha256sum rsync ssh

  set +e
  output="$(INGEST_SG_HOST=test@sg bash "$DEPLOY_SCRIPT" "$TARGET_ARG" --code-only 2>&1)"
  status=$?
  set -e
  [ "$status" -ne 0 ] || fail 'failed candidate readiness must fail deployment'
  assert_contains "$output" 'candidate did not report fresh Redis-committed log evidence' \
    'missing post-HSET token and ready line must fail the candidate'
  assert_contains "$(<"$event_log")" "mv '/opt/arena-ingest' '/opt/arena-ingest.bak-" \
    'test must reach the atomic directory cutover'
  assert_contains "$(<"$event_log")" "mv '/opt/arena-ingest.bak-20260715-120000' '/opt/arena-ingest'" \
    'rollback must restore the complete previous directory'
  start_count="$(grep -c "pm2 delete 'arena-ingest-worker-sg'" "$event_log" || true)"
  [ "$start_count" -ge 2 ] || fail 'candidate and rollback PM2 starts must both execute'
  [ "$(<"$ready_count")" -eq 1 ] || fail 'only the candidate may depend on new log evidence'
  assert_contains "$output" 'previous SG release restored' \
    'rollback must report exact fresh identity evidence'
  rm -f "$event_log" "$ready_count"
  echo 'ok - candidate without a committed HSET token rolls back the complete previous release'
}

run_post_cutover_fault() {
  local fault="$1" event_log state_file stop_owner_count_file hash old_sha old_release
  local output status events after_restore remote heartbeat_seconds
  event_log="$(mktemp)"
  state_file="$(mktemp)"
  stop_owner_count_file="$(mktemp)"
  hash="$(printf '%064d' 0)"
  old_sha="$(printf 'f%.0s' {1..40})"
  if [ "$fault" = legacy-unknown-release ]; then
    old_release=""
  else
    old_release="$(printf 'e%.0s' {1..64})"
  fi
  : > "$state_file"
  printf '%s\n' 0 > "$stop_owner_count_file"
  export EVENT_LOG="$event_log" STATE_FILE="$state_file" TEST_HASH="$hash"
  export STOP_OWNER_COUNT_FILE="$stop_owner_count_file"
  export OLD_SHA="$old_sha" OLD_RELEASE="$old_release" POST_CUTOVER_FAULT="$fault"

  kill() {
    if [ "${1:-}" = -0 ] && [ "$POST_CUTOVER_FAULT" = renew-death ] && \
        [ "$(<"$STATE_FILE")" = candidate-proved ]; then
      return 1
    fi
    builtin kill "$@"
  }

  git() {
    if [ "${1:-}" = archive ]; then
      emit_test_archive
    elif [ "${1:-}" = fetch ]; then
      if [[ "$POST_CUTOVER_FAULT" == final-fetch-* ]] && \
          [ "$(<"$STATE_FILE")" = candidate-proved ]; then
        printf '%s\n' final-fetched > "$STATE_FILE"
      fi
    else
      printf '%s\n' "$TEST_SHA"
    fi
  }
  date() { printf '%s\n' '20260715-120000'; }
  sha256sum() {
    if [ "$#" -eq 0 ]; then while IFS= read -r _; do :; done; fi
    printf '%s  %s\n' "$TEST_HASH" "${1:--}"
  }
  rsync() { printf 'rsync %s\n' "$*" >> "$EVENT_LOG"; }
  ssh() {
    local state
    printf 'ssh %s\n' "$*" >> "$EVENT_LOG"
    if [[ "$*" == *"printf 'LOCKED"* ]]; then printf '%s\n' LOCKED; return 0; fi
    if [[ "$*" == *"rm -rf '/opt/arena-ingest.deploy-lock'"* ]]; then return 0; fi
    if [[ "$*" == *"rm -f '/opt/arena-ingest.deploy-recovery-required'"* ]]; then
      if [ "$POST_CUTOVER_FAULT" = candidate-guard-clear-failure ] && \
          [ "${DEPLOY_SUCCEEDED:-0}" = 1 ]; then
        printf '%s\n' CANDIDATE_GUARD_CLEAR_FAILED >> "$EVENT_LOG"
        return 93
      fi
      if [ "$POST_CUTOVER_FAULT" = rollback-guard-clear-failure ] && \
          [ "${ROLLBACK_COMMITTED:-0}" = 1 ]; then
        printf '%s\n' ROLLBACK_GUARD_CLEAR_FAILED >> "$EVENT_LOG"
        return 94
      fi
    fi
    if [[ "$POST_CUTOVER_FAULT" == restore-ssh-failure || \
          "$POST_CUTOVER_FAULT" == restore-quarantine-failure ]] && \
        [[ "$*" == *"if [ -d '/opt/arena-ingest.bak-20260715-120000'"* ]] && \
        [[ "$*" == *"mv '/opt/arena-ingest.bak-20260715-120000' '/opt/arena-ingest'"* ]]; then
      printf '%s\n' restore-ssh-failed > "$STATE_FILE"
      printf '%s\n' RESTORE_SSH_FAILED >> "$EVENT_LOG"
      return 66
    fi
    if [ "$POST_CUTOVER_FAULT" = stop-token-flip ] && \
        [[ "$*" == *"pm2 stop 'arena-ingest-worker-sg'"* ]] && \
        [[ "$*" == *'for i in $(seq 1 30)'* ]]; then
      remote="${!#}"
      TEST_REMOTE_LOCK_OWNER="$DEPLOY_LOCK_TOKEN"
      export TEST_REMOTE_LOCK_OWNER
      if run_remote_stop_token_flip_fixture "$remote"; then
        return 0
      fi
      printf '%s\n' stop-token-lost > "$STATE_FILE"
      return 1
    fi
    if [[ "$*" == *'pm2 save --force >/dev/null'* ]]; then
      state="$(<"$STATE_FILE")"
      if [ "$POST_CUTOVER_FAULT" = restore-quarantine-failure ] && \
          [ "$state" = restore-ssh-failed ]; then
        return 92
      fi
      case "$POST_CUTOVER_FAULT" in
        clear-save-failure) return 90 ;;
      esac
      return 0
    fi
    if [[ "$*" == *'pm2 save >/dev/null'* ]]; then
      state="$(<"$STATE_FILE")"
      case "$POST_CUTOVER_FAULT:$state" in
        candidate-save-failure:candidate-proved|rollback-save-failure:rollback-proved)
          return 90 ;;
      esac
      return 0
    fi
    if [[ "$*" == *'for sample in $(seq 1 11)'* ]]; then
      state="$(<"$STATE_FILE")"
      case "$POST_CUTOVER_FAULT:$state" in
        candidate-stability-restarted:candidate-proved|rollback-stability-restarted:rollback-proved)
          remote="${!#}"
          TEST_REMOTE_LOCK_OWNER="$DEPLOY_LOCK_TOKEN"
          TEST_REMOTE_PM2_APP='arena-ingest-worker-sg'
          TEST_REMOTE_PM2_CWD='/opt/arena-ingest'
          export TEST_REMOTE_LOCK_OWNER TEST_REMOTE_PM2_APP TEST_REMOTE_PM2_CWD
          run_remote_restarted_pm2_fixture "$remote"
          return
          ;;
      esac
      return 0
    fi
    if [[ "$*" == *"rm -rf '/opt/arena-ingest.failed-20260715-120000'"* ]] && \
        [[ "$*" != *"pm2 stop 'arena-ingest-worker-sg'"* ]]; then
      if [[ "$POST_CUTOVER_FAULT" == rollback-cleanup-* ]]; then
        printf '%s\n' rollback-cleaned > "$STATE_FILE"
      fi
      return 0
    fi
    if [[ "$*" == *'docker ps'*'--format'* ]]; then return 0; fi
    if [[ "$*" == *'process.versions.node'*'process.arch'* ]]; then printf '%s\n' '22 x64'; return 0; fi
    if [[ "$*" == *'process.stdout.write(String(Date.now()))'* ]]; then
      printf '%s\n' '1800000000000'; return 0
    fi
    if [[ "$*" == *'const pid = apps[0]?.pid'* ]]; then printf '%s\n' '4242'; return 0; fi
    if [[ "$*" == *'String(apps[0].pid) !== process.argv[3]'* ]]; then
      state="$(<"$STATE_FILE")"
      case "$POST_CUTOVER_FAULT:$state" in
        final-fetch-pm2-replaced:final-fetched|rollback-cleanup-pm2-replaced:rollback-cleaned)
          return 88 ;;
      esac
      return 0
    fi
    if [[ "$*" == *'for f in .npmrc package.json package-lock.json'* ]]; then
      printf '%s\n' "$TEST_HASH"; return 0
    fi
    if [[ "$*" == *"cat '/opt/arena-ingest/DEPLOYED_SHA'"* ]]; then printf '%s\n' "$OLD_SHA"; return 0; fi
    if [[ "$*" == *"cat '/opt/arena-ingest/WORKER_RELEASE_ID'"* ]]; then printf '%s\n' "$OLD_RELEASE"; return 0; fi
    if [[ "$*" == *'for i in $(seq 1 300)'* ]]; then return 0; fi
    if [[ "$POST_CUTOVER_FAULT" == pre-stop-heartbeat-* ]] && \
        [[ "$*" == *"mkdir -p '/opt/arena-ingest.staging-"* ]] && \
        [[ "$*" == *'ingest-out.log'* ]]; then
      printf '%s\n' pre-stop-ready > "$STATE_FILE"
      return 0
    fi
    if [[ "$*" == *'verify-sg-heartbeat.ts'*"'--candidate'"* ]]; then
      state="$(<"$STATE_FILE")"
      if [ "$POST_CUTOVER_FAULT" = final-fetch-redis-reject ] && \
          [ "$state" = final-fetched ]; then
        return 31
      fi
      case "$POST_CUTOVER_FAULT" in
        redis-reject|restore-ssh-failure|restore-quarantine-failure|rollback-redis-reject|rollback-guard-clear-failure|rollback-cleanup-pm2-replaced|rollback-cleanup-lock-loss|rollback-stability-restarted|rollback-save-failure|legacy-unknown-release)
          return 31 ;;
      esac
      printf '%s\n' candidate-proved > "$STATE_FILE"
      printf '%s\n' '[sg-heartbeat-proof] exact fresh Redis roster identity ready'
      return 0
    fi
    if [[ "$*" == *'verify-sg-heartbeat.ts'*"'--rollback'"* ]]; then
      if [ "$POST_CUTOVER_FAULT" = rollback-redis-reject ]; then
        printf '%s\n' rollback-redis-failed > "$STATE_FILE"
        printf '%s\n' ROLLBACK_REDIS_FAILED >> "$EVENT_LOG"
        return 32
      fi
      printf '%s\n' rollback-proved > "$STATE_FILE"
      printf '%s\n' '[sg-heartbeat-proof] exact fresh Redis roster identity ready'
      return 0
    fi
    if [[ "$*" == *"test -f '/opt/arena-ingest.failed-"*'verify-sg-heartbeat.ts'* ]]; then
      return 0
    fi
    state="$(<"$STATE_FILE")"
    if [[ "$POST_CUTOVER_FAULT" == pre-stop-heartbeat-* ]] && \
        [ "$state" = pre-stop-ready ] && \
        [[ "$*" == *'heartbeat=$(stat -c %Y '* ]]; then
      remote="${!#}"
      if [ "$POST_CUTOVER_FAULT" = pre-stop-heartbeat-stale ]; then
        heartbeat_seconds=879
      else
        heartbeat_seconds=1001
      fi
      TEST_REMOTE_LOCK_OWNER="$DEPLOY_LOCK_TOKEN"
      TEST_REMOTE_NOW_SECONDS=1000
      TEST_REMOTE_HEARTBEAT_SECONDS="$heartbeat_seconds"
      export TEST_REMOTE_LOCK_OWNER TEST_REMOTE_NOW_SECONDS TEST_REMOTE_HEARTBEAT_SECONDS
      run_remote_lease_predicate_fixture "$remote"
      return
    fi
    if [[ "$*" == *"test \"\$(cat '/opt/arena-ingest.deploy-lock/owner'"* ]]; then
      case "$POST_CUTOVER_FAULT:$state" in
        lock-loss:candidate-proved|final-fetch-lock-loss:final-fetched|rollback-cleanup-lock-loss:rollback-cleaned|stop-token-flip:stop-token-lost)
          return 77 ;;
      esac
      return 0
    fi
    return 0
  }
  export -f git date sha256sum kill rsync ssh

  set +e
  output="$(INGEST_SG_HOST=test@sg bash "$DEPLOY_SCRIPT" "$TARGET_ARG" --code-only 2>&1)"
  status=$?
  set -e
  [ "$status" -ne 0 ] || fail "$fault must fail deployment"

  case "$fault" in
    redis-reject)
      assert_contains "$output" 'candidate did not publish exact fresh Redis roster evidence' \
        'candidate Redis mismatch must be visible'
      assert_contains "$(<"$event_log")" "mv '/opt/arena-ingest.bak-20260715-120000' '/opt/arena-ingest'" \
        'candidate Redis mismatch must restore the prior release'
      assert_contains "$(<"$event_log")" "'--rollback'" \
        'rollback must obtain its own fresh Redis proof'
      ;;
    lock-loss|final-fetch-lock-loss|renew-death)
      assert_contains "$output" 'SG deploy lease' \
        'post-proof lock loss must remain visible'
      assert_contains "$output" 'automatic rollback is unsafe' \
        'lock loss must refuse an unfenced automatic rollback'
      ;;
    pre-stop-heartbeat-stale|pre-stop-heartbeat-future)
      assert_contains "$output" 'lost or stale SG deploy lease' \
        'invalid heartbeat age must fail the executable lease predicate'
      events="$(<"$event_log")"
      [[ "$events" != *"pm2 stop 'arena-ingest-worker-sg'"* ]] || \
        fail 'invalid heartbeat age must precede PM2 stop'
      [[ "$events" != *'pm2 save'* ]] || \
        fail 'invalid heartbeat age must precede every PM2 save'
      [[ "$events" != *"mv '/opt/arena-ingest' '/opt/arena-ingest.bak-"* ]] || \
        fail 'invalid heartbeat age must precede directory cutover'
      ;;
    stop-token-flip)
      [ "$(<"$stop_owner_count_file")" -ge 3 ] || \
        fail 'stop fixture must flip the owner during a later wait-loop sample'
      assert_contains "$output" 'automatic rollback is unsafe' \
        'stop-loop token loss must refuse an unfenced rollback'
      events="$(<"$event_log")"
      [[ "$events" != *'pm2 save'* ]] || \
        fail 'stop-loop token loss must precede every PM2 save'
      [[ "$events" != *"mv '/opt/arena-ingest' '/opt/arena-ingest.bak-"* ]] || \
        fail 'stop-loop token loss must precede directory cutover'
      ;;
    final-fetch-pm2-replaced)
      assert_contains "$output" 'candidate process changed during final origin/main verification' \
        'final origin/main fetch must be followed by an exact PM2 recheck'
      assert_contains "$output" 'previous SG release restored' \
        'a fenced final PM2 replacement must restore the previous release'
      ;;
    final-fetch-redis-reject)
      assert_contains "$output" \
        'candidate lost Redis roster evidence during final origin/main verification' \
        'final origin/main fetch must be followed by a fresh Redis roster proof'
      assert_contains "$output" 'previous SG release restored' \
        'a final Redis proof failure must restore the previous release'
      ;;
    candidate-stability-restarted)
      assert_contains "$output" 'candidate process was not stable through its minimum uptime window' \
        'candidate must reject restart_time=1 during the PM2 minimum uptime window'
      assert_contains "$output" 'previous SG release restored' \
        'candidate stability failure must restore the previous release'
      ;;
    restore-ssh-failure)
      assert_contains "$output" 'previous SG release directory could not be restored' \
        'the first rollback directory-restore SSH failure must remain visible'
      events="$(<"$event_log")"
      after_restore="${events#*RESTORE_SSH_FAILED}"
      [ "$after_restore" != "$events" ] || fail 'restore failure marker must be reached'
      [[ "$after_restore" != *'pm2 start'* ]] || \
        fail 'a failed directory restore must not start any later process'
      [[ "$after_restore" != *'pm2 save >/dev/null'* ]] || \
        fail 'a failed directory restore must not commit any later PM2 owner'
      [[ "$after_restore" != *"'--rollback'"* ]] || \
        fail 'a failed directory restore must not claim a later Redis rollback proof'
      assert_contains "$after_restore" "pm2 delete 'arena-ingest-worker-sg'" \
        'restore failure quarantine must delete the uncommitted live owner'
      [ "$(grep -o 'pm2 save --force' <<<"$after_restore" | wc -l | tr -d ' ')" -ge 2 ] || \
        fail 'restore failure quarantine must clear primary and backup PM2 dumps'
      assert_contains "$output" 'uncommitted SG owner quarantined' \
        'restore failure must finish with an explicit live-and-saved quarantine proof'
      [[ "$output" != *'previous SG release restored'* ]] || \
        fail 'a failed directory restore must never report restoration'
      ;;
    restore-quarantine-failure)
      assert_contains "$output" 'previous SG release directory could not be restored' \
        'the rollback directory-restore failure must remain visible'
      assert_contains "$output" 'uncommitted SG owner could not be removed' \
        'failed quarantine must report that live and saved state remain uncertain'
      assert_contains "$output" 'automatic SG quarantine failed; manual intervention required' \
        'failed quarantine must require explicit manual intervention'
      events="$(<"$event_log")"
      after_restore="${events#*RESTORE_SSH_FAILED}"
      [ "$after_restore" != "$events" ] || fail 'restore failure marker must be reached'
      [[ "$after_restore" != *'pm2 start'* ]] || \
        fail 'failed quarantine must not start any later process'
      [[ "$after_restore" != *"rm -f '/opt/arena-ingest.deploy-recovery-required'"* ]] || \
        fail 'failed quarantine must leave the durable recovery guard armed'
      [[ "$output" != *'uncommitted SG owner quarantined'* ]] || \
        fail 'failed quarantine must not claim a completed quarantine proof'
      [[ "$output" != *'previous SG release restored'* ]] || \
        fail 'failed quarantine must never report restoration'
      ;;
    candidate-save-failure)
      assert_contains "$output" 'candidate could not commit its proven PM2 state' \
        'candidate PM2 state must only be committed after all proofs'
      assert_contains "$output" 'previous SG release restored' \
        'candidate PM2 save failure must restore the previous release'
      ;;
    candidate-guard-clear-failure)
      assert_contains "$output" \
        'candidate is safely committed, but recovery-guard cleanup is uncertain' \
        'candidate guard-clear uncertainty must require manual inspection'
      events="$(<"$event_log")"
      after_restore="${events#*CANDIDATE_GUARD_CLEAR_FAILED}"
      [ "$after_restore" != "$events" ] || fail 'candidate guard-clear failure marker must be reached'
      [[ "$after_restore" != *"mv '/opt/arena-ingest.bak-"* ]] || \
        fail 'a safely committed candidate must not roll back after guard-clear uncertainty'
      [[ "$after_restore" != *"pm2 delete 'arena-ingest-worker-sg'"* ]] || \
        fail 'a safely committed candidate must not be quarantined after guard-clear uncertainty'
      [[ "$output" != *'previous SG release restored'* ]] || \
        fail 'candidate guard-clear uncertainty must not report rollback restoration'
      ;;
    clear-save-failure)
      assert_contains "$output" 'could not remove the unproven SG owner from saved PM2 state' \
        'cutover must fail if the old stable-path owner cannot be removed from PM2 dump'
      assert_contains "$output" 'previous SG release restored' \
        'failed PM2 dump clearing must restart and prove the previous release'
      ;;
    rollback-redis-reject)
      assert_contains "$output" 'fresh Redis roster evidence is unavailable' \
        'rollback Redis rejection must remain visible'
      assert_contains "$output" 'uncommitted SG owner quarantined' \
        'a Redis-unproven rollback must be removed from live and saved PM2 state'
      events="$(<"$event_log")"
      after_restore="${events#*ROLLBACK_REDIS_FAILED}"
      [ "$after_restore" != "$events" ] || fail 'rollback Redis failure marker must be reached'
      [[ "$after_restore" != *'pm2 start'* ]] || \
        fail 'a Redis-unproven rollback must not start another process during quarantine'
      assert_contains "$after_restore" "pm2 delete 'arena-ingest-worker-sg'" \
        'quarantine must delete the Redis-unproven live owner'
      [ "$(grep -o 'pm2 save --force' <<<"$after_restore" | wc -l | tr -d ' ')" -ge 2 ] || \
        fail 'quarantine must clear both primary and backup PM2 dumps'
      [[ "$output" != *'previous SG release restored'* ]] || \
        fail 'failed rollback Redis proof must never report restoration'
      ;;
    rollback-guard-clear-failure)
      assert_contains "$output" \
        'previous SG release is safely committed, but recovery-guard cleanup is uncertain' \
        'rollback guard-clear uncertainty must require manual inspection'
      events="$(<"$event_log")"
      after_restore="${events#*ROLLBACK_GUARD_CLEAR_FAILED}"
      [ "$after_restore" != "$events" ] || fail 'rollback guard-clear failure marker must be reached'
      [[ "$after_restore" != *'pm2 start'* ]] || \
        fail 'a safely committed rollback must not start another process'
      [[ "$after_restore" != *"pm2 delete 'arena-ingest-worker-sg'"* ]] || \
        fail 'a safely committed rollback must not be quarantined'
      [[ "$after_restore" != *'pm2 save --force'* ]] || \
        fail 'a safely committed rollback must not clear its saved state'
      [[ "$output" != *'previous SG release restored'* ]] || \
        fail 'uncertain guard cleanup must not report completed restoration'
      ;;
    rollback-cleanup-pm2-replaced)
      assert_contains "$output" 'previous SG process changed during rollback cleanup' \
        'rollback cleanup must end with another exact PM2 proof'
      [[ "$output" != *'previous SG release restored'* ]] || \
        fail 'rollback cleanup PM2 replacement must never report restoration'
      ;;
    rollback-cleanup-lock-loss)
      assert_contains "$output" 'SG deploy lease' \
        'rollback cleanup must end with another lock proof'
      [[ "$output" != *'previous SG release restored'* ]] || \
        fail 'rollback cleanup lock loss must never report restoration'
      ;;
    rollback-stability-restarted)
      assert_contains "$output" 'previous SG process was not stable through its minimum uptime window' \
        'rollback must reject restart_time=1 during the PM2 minimum uptime window'
      [[ "$output" != *'previous SG release restored'* ]] || \
        fail 'unstable rollback must never report restoration'
      ;;
    rollback-save-failure)
      assert_contains "$output" 'previous SG process could not commit its proven PM2 state' \
        'rollback PM2 save failure must remain visible'
      [[ "$output" != *'previous SG release restored'* ]] || \
        fail 'rollback PM2 save failure must never report restoration'
      ;;
    legacy-unknown-release)
      assert_contains "$(<"$event_log")" \
        "'--rollback' '$OLD_SHA' 'unknown'" \
        'legacy rollback must pass an explicit unknown release identity'
      assert_contains "$output" 'previous SG release restored' \
        'legacy rollback without a release stamp must remain recoverable'
      ;;
  esac
  [[ "$output" != *'SG deploy complete'* ]] || fail "$fault must never report deploy success"
  rm -f "$event_log" "$state_file" "$stop_owner_count_file"
  unset -f kill
}

test_candidate_redis_rejection_rolls_back() {
  run_post_cutover_fault redis-reject
  echo 'ok - candidate Redis roster rejection automatically restores a Redis-proven rollback'
}

test_post_proof_lock_loss_never_reports_success() {
  run_post_cutover_fault lock-loss
  echo 'ok - post-proof deploy lock loss fails closed without an unsafe rollback'
}

test_pre_stop_stale_heartbeat_never_mutates_runtime() {
  run_post_cutover_fault pre-stop-heartbeat-stale
  echo 'ok - heartbeat age 121 fails closed before PM2 stop, save, or cutover'
}

test_pre_stop_future_heartbeat_never_mutates_runtime() {
  run_post_cutover_fault pre-stop-heartbeat-future
  echo 'ok - a future heartbeat mtime fails closed before PM2 stop, save, or cutover'
}

test_post_proof_renewer_death_never_reports_success() {
  run_post_cutover_fault renew-death
  echo 'ok - dead local lease renewer fails closed before further mutation'
}

test_stop_wait_loop_owner_flip_never_mutates_further() {
  run_post_cutover_fault stop-token-flip
  echo 'ok - stop wait-loop owner flip forbids save, cutover, rollback, and success'
}

test_final_fetch_lock_loss_never_reports_success() {
  run_post_cutover_fault final-fetch-lock-loss
  echo 'ok - final origin/main fetch is followed by a token-fenced lock proof'
}

test_final_fetch_pm2_replacement_rolls_back() {
  run_post_cutover_fault final-fetch-pm2-replaced
  echo 'ok - final origin/main fetch is followed by an exact PM2 proof'
}

test_final_fetch_redis_rejection_rolls_back() {
  run_post_cutover_fault final-fetch-redis-reject
  echo 'ok - final origin/main fetch is followed by fresh Redis roster evidence'
}

test_candidate_must_survive_minimum_uptime() {
  run_post_cutover_fault candidate-stability-restarted
  echo 'ok - candidate rejects restart_time=1 through the PM2 minimum uptime window'
}

test_candidate_pm2_state_is_saved_only_after_proof() {
  run_post_cutover_fault candidate-save-failure
  echo 'ok - candidate PM2 state is saved only after every readiness proof'
}

test_candidate_guard_clear_uncertainty_does_not_undo_commit() {
  run_post_cutover_fault candidate-guard-clear-failure
  echo 'ok - candidate guard-clear uncertainty preserves the safely committed owner'
}

test_unproven_candidate_is_absent_from_saved_pm2_state() {
  run_post_cutover_fault clear-save-failure
  echo 'ok - unproven candidate cannot inherit a stable-path PM2 resurrection entry'
}

test_rollback_redis_rejection_never_reports_restored() {
  run_post_cutover_fault rollback-redis-reject
  echo 'ok - rollback Redis rejection cannot report restoration'
}

test_rollback_guard_clear_uncertainty_does_not_undo_commit() {
  run_post_cutover_fault rollback-guard-clear-failure
  echo 'ok - rollback guard-clear uncertainty preserves the safely committed owner'
}

test_restore_ssh_failure_stops_rollback_immediately() {
  run_post_cutover_fault restore-ssh-failure
  echo 'ok - rollback directory-restore SSH failure cannot continue or report restoration'
}

test_failed_quarantine_leaves_durable_recovery_guard() {
  run_post_cutover_fault restore-quarantine-failure
  echo 'ok - failed quarantine leaves the durable recovery guard armed for manual intervention'
}

test_rollback_cleanup_pm2_replacement_never_reports_restored() {
  run_post_cutover_fault rollback-cleanup-pm2-replaced
  echo 'ok - rollback cleanup PM2 replacement cannot report restoration'
}

test_rollback_cleanup_lock_loss_never_reports_restored() {
  run_post_cutover_fault rollback-cleanup-lock-loss
  echo 'ok - rollback cleanup lock loss cannot report restoration'
}

test_rollback_must_survive_minimum_uptime() {
  run_post_cutover_fault rollback-stability-restarted
  echo 'ok - rollback rejects restart_time=1 through the PM2 minimum uptime window'
}

test_rollback_pm2_state_is_saved_only_after_proof() {
  run_post_cutover_fault rollback-save-failure
  echo 'ok - rollback PM2 state is saved only after every readiness proof'
}

test_legacy_rollback_without_release_stamp_is_recoverable() {
  run_post_cutover_fault legacy-unknown-release
  echo 'ok - legacy rollback without a release stamp remains Redis-proven and recoverable'
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

test_docker_ownership_probe_executes_one_fail_closed_snapshot() {
  local tmp docker_guard_source output status snapshot_calls real_path real_bash
  tmp="$(mktemp -d)"
  mkdir -p "$tmp/empty-path"
  printf '%s\n' 0 > "$tmp/docker-ps-count"
  real_path="$PATH"
  real_bash="$BASH"
  DOCKER_PS_COUNT_FILE="$tmp/docker-ps-count"
  DOCKER_FIXTURE_MODE=owners
  DOCKER_FIXTURE_PATH="$real_path"
  REAL_FIXTURE_BASH="$real_bash"
  export DOCKER_PS_COUNT_FILE DOCKER_FIXTURE_MODE DOCKER_FIXTURE_PATH REAL_FIXTURE_BASH

  docker() {
    local count
    [ "${1:-}" = ps ] || return 64
    count="$(<"$DOCKER_PS_COUNT_FILE")"
    count=$((count + 1))
    printf '%s\n' "$count" > "$DOCKER_PS_COUNT_FILE"
    case "$DOCKER_FIXTURE_MODE" in
      fail) return 23 ;;
      owners)
        printf '%s\n' \
          'arena-ingest-worker-sg-blue|unrelated' \
          'label-owned-consumer|ingest-worker' \
          'ordinary-container|unrelated'
        ;;
      *) return 64 ;;
    esac
  }
  ssh_sg() {
    (
      unset -f node
      PATH="$DOCKER_FIXTURE_PATH" "$REAL_FIXTURE_BASH" -c "$1"
    )
  }
  export -f docker
  docker_guard_source="$(awk '
    /^if ! RUNNING_INGEST_CONTAINERS=/ { capture=1 }
    capture { print }
    capture && /^fi$/ { endings += 1; if (endings == 2) exit }
  ' "$DEPLOY_SCRIPT")"
  [ -n "$docker_guard_source" ] || {
    rm -rf "$tmp"
    fail 'Docker ownership guard source must be extractable'
  }
  eval "run_sg_docker_guard() {
$docker_guard_source
  }"

  set +e
  output="$(run_sg_docker_guard 2>&1)"
  status=$?
  set -e
  [ "$status" -ne 0 ] || fail 'name- or label-owned containers must block PM2 deployment'
  assert_contains "$output" 'arena-ingest-worker-sg-blue' \
    'one snapshot must detect the SG name ownership pattern'
  assert_contains "$output" 'label-owned-consumer' \
    'the same snapshot must detect the ingest-worker ownership label'
  snapshot_calls="$(<"$DOCKER_PS_COUNT_FILE")"
  [ "$snapshot_calls" -eq 1 ] || fail 'name and label ownership must use one docker ps snapshot'

  printf '%s\n' 0 > "$DOCKER_PS_COUNT_FILE"
  DOCKER_FIXTURE_MODE=fail
  export DOCKER_FIXTURE_MODE
  set +e
  output="$(run_sg_docker_guard 2>&1)"
  status=$?
  set -e
  [ "$status" -ne 0 ] || fail 'docker ps failure must fail the ownership probe closed'
  assert_contains "$output" 'SG Docker ownership inspection failed' \
    'docker ps failure must have an explicit fail-closed diagnostic'
  [ "$(<"$DOCKER_PS_COUNT_FILE")" -eq 1 ] || \
    fail 'failed Docker inspection must still use exactly one snapshot attempt'

  unset -f docker
  DOCKER_FIXTURE_PATH="$tmp/empty-path"
  export DOCKER_FIXTURE_PATH
  output="$(run_sg_docker_guard 2>&1)" || {
    rm -rf "$tmp"
    fail 'a host without the docker command must allow an empty ownership result'
  }
  [ -z "$output" ] || fail 'a host without Docker must produce no container owners'

  unset -f ssh_sg run_sg_docker_guard
  rm -rf "$tmp"
  echo 'ok - executable Docker probe is single-snapshot, fail-closed, and absence-safe'
}

test_durable_recovery_guard_blocks_new_deploy_before_inspection() {
  local tmp event_log output status events
  tmp="$(mktemp -d)"
  DEPLOY_LOCK_DIR="$tmp/deploy-lock"
  DEPLOY_RECOVERY_GUARD="$tmp/recovery-required"
  DEPLOY_LOCK_TOKEN='guard-fixture-owner'
  DEPLOY_LOCK_STALE_SECONDS=900
  DEPLOY_LOCK_HELD=0
  ssh_sg() {
    (
      unset -f node
      bash -c "$1"
    )
  }
  eval "$(awk '/^acquire_deploy_lock\(\)/,/^}/' "$DEPLOY_SCRIPT")"
  printf '%s\n' 'unresolved-release' > "$DEPLOY_RECOVERY_GUARD"

  set +e
  output="$(acquire_deploy_lock 2>&1)"
  status=$?
  set -e
  [ "$status" -ne 0 ] || fail 'an existing durable recovery guard must refuse lock acquisition'
  assert_contains "$output" 'BLOCKED: SG recovery guard requires manual inspection' \
    'executable lock acquisition must identify the durable recovery guard'
  [ ! -e "$DEPLOY_LOCK_DIR" ] || fail 'guard refusal must precede deploy-lock mutation'
  unset -f ssh_sg acquire_deploy_lock

  event_log="$(mktemp)"
  export EVENT_LOG="$event_log"
  git() {
    if [ "${1:-}" = archive ]; then emit_test_archive
    else printf '%s\n' "$TEST_SHA"
    fi
  }
  date() { printf '%s\n' '20260715-120000'; }
  ssh() {
    printf 'ssh %s\n' "$*" >> "$EVENT_LOG"
    if [[ "$*" == *"guard='/opt/arena-ingest.deploy-recovery-required'"* ]]; then
      printf '%s\n' \
        'BLOCKED: SG recovery guard requires manual inspection: /opt/arena-ingest.deploy-recovery-required' >&2
      return 76
    fi
    fail "unexpected remote access after durable recovery guard: $*"
  }
  export -f git date ssh fail

  set +e
  output="$(INGEST_SG_HOST=test@sg bash "$DEPLOY_SCRIPT" "$TARGET_ARG" --code-only 2>&1)"
  status=$?
  set -e
  [ "$status" -ne 0 ] || fail 'durable recovery guard must fail the complete deploy closed'
  assert_contains "$output" 'BLOCKED: SG recovery guard requires manual inspection' \
    'complete deploy must surface the durable recovery block'
  events="$(<"$event_log")"
  [[ "$events" != *'docker ps'* ]] || fail 'recovery guard must precede Docker inspection'
  [[ "$events" != *'pm2 '* ]] || fail 'recovery guard must precede every PM2 operation'
  [[ "$events" != *'.staging-'* ]] || fail 'recovery guard must precede candidate mutation'
  [[ "$output" != *'SG deploy complete'* ]] || fail 'recovery-guard refusal must not report success'

  rm -rf "$tmp"
  rm -f "$event_log"
  echo 'ok - durable recovery guard blocks a new deploy before inspection or mutation'
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
  local deploy assert_body acquire_body stop_body owner_checks arm_line recovery_line stop_line
  local candidate_commit_line candidate_success_line candidate_recovery_clear_line
  local candidate_guard_clear_line rollback_exact_line rollback_lock_line
  local rollback_committed_line rollback_guard_clear_line
  deploy="$(<"$DEPLOY_SCRIPT")"
  assert_body="$(awk '/^assert_deploy_lock\(\)/,/^}/' "$DEPLOY_SCRIPT")"
  acquire_body="$(awk '/^acquire_deploy_lock\(\)/,/^}/' "$DEPLOY_SCRIPT")"
  stop_body="$(sed -n '/^RECOVERY_REQUIRED=1$/,/^assert_deploy_lock$/p' "$DEPLOY_SCRIPT")"
  assert_contains "$deploy" 'DEPLOY_LOCK_STALE_SECONDS=900' \
    'deploy lease must have a bounded crash-recovery window'
  assert_contains "$deploy" 'DEPLOY_LOCK_MAX_HEARTBEAT_AGE_SECONDS=120' \
    'active lease proof must expire well before stale takeover is possible'
  assert_contains "$deploy" 'touch \"\$lock_dir/heartbeat\"' \
    'deploy lease must publish a heartbeat'
  assert_contains "$deploy" 'mv \"\$lock_dir\" \"\$stale_dir\"' \
    'stale lease takeover must use an atomic rename'
  assert_contains "$deploy" 'cat '\''$DEPLOY_LOCK_DIR/owner'\''' \
    'lease cleanup must read the remote owner token'
  assert_contains "$deploy" "rm -rf '\$DEPLOY_LOCK_DIR'" \
    'token-fenced cleanup must remove the lease'
  assert_contains "$assert_body" 'kill -0 "$DEPLOY_LOCK_RENEW_PID"' \
    'every mutation boundary must require a live local lease renewer'
  assert_contains "$assert_body" "stat -c %Y '\$DEPLOY_LOCK_DIR/heartbeat'" \
    'every mutation boundary must verify remote heartbeat freshness'
  assert_contains "$acquire_body" '>/dev/null 2>&1 || true' \
    'a transient renewal SSH failure must not silently kill the renew loop'
  owner_checks="$(grep -c "cat '\$DEPLOY_LOCK_DIR/owner'" <<<"$stop_body" || true)"
  [ "$owner_checks" -ge 2 ] || \
    fail 'PM2 stop must recheck the owner token at start and while waiting'
  [[ "${deploy%%RUNNING_INGEST_CONTAINERS=*}" == *'acquire_deploy_lock'* ]] || \
    fail 'deploy lease must be acquired before remote Docker inspection'

  arm_line="$(grep -n '^arm_recovery_guard$' "$DEPLOY_SCRIPT" | cut -d: -f1)"
  recovery_line="$(grep -n '^RECOVERY_REQUIRED=1$' "$DEPLOY_SCRIPT" | cut -d: -f1)"
  stop_line="$(awk '/^RECOVERY_REQUIRED=1$/ { armed=1 } armed && /pm2 stop.*PM2_APP/ { print NR; exit }' "$DEPLOY_SCRIPT")"
  [ "$arm_line" -lt "$recovery_line" ] && [ "$recovery_line" -lt "$stop_line" ] || \
    fail 'durable recovery guard must arm before recovery state and PM2 stop'

  candidate_commit_line="$(grep -n '^commit_exact_pm2 "\$CANDIDATE_PM2_PID"' "$DEPLOY_SCRIPT" | cut -d: -f1)"
  candidate_success_line="$(grep -n '^DEPLOY_SUCCEEDED=1$' "$DEPLOY_SCRIPT" | cut -d: -f1)"
  candidate_recovery_clear_line="$(grep -n '^RECOVERY_REQUIRED=0$' "$DEPLOY_SCRIPT" | tail -1 | cut -d: -f1)"
  candidate_guard_clear_line="$(grep -n '^if ! clear_recovery_guard; then$' "$DEPLOY_SCRIPT" | cut -d: -f1)"
  [ "$candidate_commit_line" -lt "$candidate_success_line" ] && \
    [ "$candidate_success_line" -le "$candidate_recovery_clear_line" ] && \
    [ "$candidate_recovery_clear_line" -lt "$candidate_guard_clear_line" ] || \
    fail 'candidate commit must precede success flags, which must precede guard cleanup'

  rollback_exact_line="$(grep -n 'assert_exact_pm2_process "\$rollback_pm2_pid"' "$DEPLOY_SCRIPT" | tail -1 | cut -d: -f1)"
  rollback_lock_line="$(awk '
    /^recover_previous_release\(\)/ { recovery=1 }
    recovery && /^  assert_deploy_lock \|\| return 1$/ { line=NR }
    recovery && /^  ROLLBACK_COMMITTED=1$/ { print line; exit }
  ' "$DEPLOY_SCRIPT")"
  rollback_committed_line="$(grep -n '^  ROLLBACK_COMMITTED=1$' "$DEPLOY_SCRIPT" | cut -d: -f1)"
  rollback_guard_clear_line="$(grep -n '^  clear_recovery_guard || {$' "$DEPLOY_SCRIPT" | tail -1 | cut -d: -f1)"
  [ "$rollback_exact_line" -lt "$rollback_lock_line" ] && \
    [ "$rollback_lock_line" -lt "$rollback_committed_line" ] && \
    [ "$rollback_committed_line" -lt "$rollback_guard_clear_line" ] || \
    fail 'rollback final exact+lock proof must precede commit state and guard cleanup'
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
  local deploy verifier marker_line not_before_line start_line handoff_timeout
  deploy="$(<"$DEPLOY_SCRIPT")"
  verifier="$(<"$LOG_VERIFIER")"
  handoff_timeout="$(sed -n 's/^AUTHORITY_HANDOFF_TIMEOUT_SECONDS=//p' "$DEPLOY_SCRIPT")"
  [ "$handoff_timeout" = 300 ] || \
    fail 'candidate readiness must reserve the exact 300-second authority handoff window'
  assert_contains "$deploy" 'seq 1 $AUTHORITY_HANDOFF_TIMEOUT_SECONDS' \
    'candidate readiness must consume the authority handoff constant'
  assert_contains "$deploy" 'READY_MARKER="arena-deploy-' \
    'PM2 deploy must create a unique readiness marker'
  assert_contains "$verifier" 'index($0, marker)' \
    'readiness must ignore log lines before the deployment marker'
  assert_contains "$verifier" '[heartbeat] redis-hset-committed' \
    'candidate logs must use only the post-HSET commit token'
  assert_contains "$verifier" 'exactToken($0, "sha=", sha)' \
    'readiness must require the exact deployed heartbeat SHA token'
  assert_contains "$verifier" 'exactToken($0, "release=", release)' \
    'readiness must require the exact worker release ID token'
  assert_contains "$deploy" 'verify_sg_roster --candidate "$SHA" "$WORKER_RELEASE_ID"' \
    'candidate success must require an independent Redis roster readback'
  assert_contains "$deploy" 'verify_sg_roster --rollback "$rollback_sha" "$rollback_release"' \
    'rollback success must require a fresh Redis roster readback without new logs'
  assert_contains "$deploy" 'CANDIDATE_PM2_PID="$(exact_pm2_pid)"' \
    'candidate Redis proof must bind the exact new PM2 PID'
  assert_contains "$deploy" 'node node_modules/tsx/dist/cli.mjs worker/preflight-sg-runtime.ts' \
    'candidate must validate the exact SG node and region env contract before cutover'
  marker_line="$(grep -n '^READY_MARKER=' "$DEPLOY_SCRIPT" | tail -1 | cut -d: -f1)"
  not_before_line="$(grep -n '^CANDIDATE_NOT_BEFORE_MS=' "$DEPLOY_SCRIPT" | tail -1 | cut -d: -f1)"
  start_line="$(grep -n '^start_exact_pm2$' "$DEPLOY_SCRIPT" | tail -1 | cut -d: -f1)"
  [ "$not_before_line" -lt "$marker_line" ] && [ "$marker_line" -lt "$start_line" ] || \
    fail 'remote not-before time and deployment marker must precede exact PM2 start'
  [[ "$deploy" != *"pm2 logs \$PM2_APP --lines 400"* ]] || \
    fail 'readiness must not pass on an old line from a fixed PM2 log window'
  echo 'ok - PM2 readiness requires fresh post-marker logs plus Redis roster evidence'
}

test_rollback_capture_policy_is_preflighted() {
  local deploy preflight entrypoint preflight_line stop_line env_load_line
  local concurrency_line regions_line consumer_line
  deploy="$(<"$DEPLOY_SCRIPT")"
  preflight="$(<"$SG_PREFLIGHT")"
  entrypoint="$(<"$SG_ENTRYPOINT")"
  assert_contains "$preflight" "INGEST_ATTEMPT_BOUND_CAPTURE_ENABLED !== 'true'" \
    'SG preflight must reject an explicitly disabled capture environment'
  assert_contains "$entrypoint" "config({ path: resolve(__dirname, '..', '.env') })" \
    'the worker entrypoint itself must load the box-local worker/.env'
  assert_contains "$deploy" "cp -a '\$REMOTE_DIR' '\$STAGING_DIR'" \
    'preflight must inspect the box-local environment copied from the rollback release'
  assert_contains "$deploy" "--exclude '.env'" \
    'source sync must preserve the box-local environment that rollback will reload'
  preflight_line="$(grep -n 'worker/preflight-sg-runtime.ts' "$DEPLOY_SCRIPT" | tail -1 | cut -d: -f1)"
  stop_line="$(grep -n '^RECOVERY_REQUIRED=1$' "$DEPLOY_SCRIPT" | cut -d: -f1)"
  [ "$preflight_line" -lt "$stop_line" ] || \
    fail 'capture-enabled rollback environment must be proven before the old worker stops'
  env_load_line="$(grep -n "^config({ path: resolve(__dirname, '..', '.env') })$" "$SG_ENTRYPOINT" | cut -d: -f1)"
  concurrency_line="$(grep -n '^const INGEST_CONCURRENCY = ' "$SG_ENTRYPOINT" | cut -d: -f1)"
  regions_line="$(grep -n 'const regions = consumedRegions()' "$SG_ENTRYPOINT" | cut -d: -f1)"
  consumer_line="$(grep -n 'new Worker(' "$SG_ENTRYPOINT" | head -1 | cut -d: -f1)"
  [ "$env_load_line" -lt "$concurrency_line" ] && \
    [ "$env_load_line" -lt "$regions_line" ] && \
    [ "$env_load_line" -lt "$consumer_line" ] || \
    fail 'worker/.env must load before env-derived concurrency, regions, or consumers'
  echo 'ok - capture=false is refused and worker/.env loads before serving logic'
}

test_log_verifier_rejects_old_or_forged_evidence() {
  local marker='arena-deploy-unique' release
  release="$(printf 'b%.0s' {1..64})"

  if printf '%s\n' \
      "[heartbeat] redis-hset-committed node=vps_sg pid=41 sha=$TEST_SHA release=$release ts=1800000000001" \
      '[ingest-worker] ready' \
      "$marker" \
      '[ingest-worker] ready' |
      awk -v marker="$marker" -v node=vps_sg -v sha="$TEST_SHA" -v release="$release" \
        -f "$LOG_VERIFIER"; then
    fail 'valid-looking lines before the unique marker must not pass'
  fi

  if printf '%s\n' \
      "$marker" \
      "[heartbeat] node=vps_sg pid=41 sha=$TEST_SHA release=$release every 60s" \
      '[ingest-worker] ready' |
      awk -v marker="$marker" -v node=vps_sg -v sha="$TEST_SHA" -v release="$release" \
        -f "$LOG_VERIFIER"; then
    fail 'the legacy pre-HSET heartbeat line must not pass'
  fi

  if printf '%s\n' \
      "$marker" \
      "[heartbeat] redis-hset-committed node=vps_sg pid=41 sha=$TEST_SHA release=wrong ts=1800000000001" \
      '[ingest-worker] ready' |
      awk -v marker="$marker" -v node=vps_sg -v sha="$TEST_SHA" -v release="$release" \
        -f "$LOG_VERIFIER"; then
    fail 'wrong release token must not pass'
  fi

  printf '%s\n' \
    "$marker" \
    "[heartbeat] redis-hset-committed node=vps_sg pid=41 sha=$TEST_SHA release=$release ts=1800000000001" \
    '[ingest-worker] ready' |
    awk -v marker="$marker" -v node=vps_sg -v sha="$TEST_SHA" -v release="$release" \
      -f "$LOG_VERIFIER" || fail 'exact fresh committed log evidence must pass'
  echo 'ok - candidate log verifier rejects old, legacy, and forged identity evidence'
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
  assert_contains "$deploy" 'if ! recover_previous_release; then' \
    'every post-stop failure must run the centralized rollback path'
  assert_contains "$deploy" 'quarantine_uncommitted_pm2_owner || {' \
    'an uncommitted failed rollback must be removed from live and saved PM2 state'
  assert_contains "$deploy" 'wait_for_candidate_log_evidence "$READY_MARKER" "$SHA" "$WORKER_RELEASE_ID"' \
    'fresh candidate logs must compare the full SHA and release ID'
  echo 'ok - release stamp is bound to exact committed code and dependency inputs'
}

test_remote_javascript_quotes_survive_shell_rendering() {
  local rendered
  PM2_APP='arena-ingest-worker-sg'
  REMOTE_DIR='/opt/arena-ingest'
  DEPLOY_LOCK_DIR='/opt/arena-ingest.deploy-lock'
  DEPLOY_LOCK_TOKEN='test-token'
  ssh_sg() { printf '%s\n' "$1"; }

  eval "$(awk '/^start_exact_pm2\(\)/,/^}/' "$DEPLOY_SCRIPT")"
  rendered="$(start_exact_pm2)"
  assert_contains "$rendered" 'let raw=""; process.stdin.on("data"' \
    'PM2 start proof must retain JavaScript string literals after Bash rendering'

  eval "$(awk '/^clear_saved_pm2_owner\(\)/,/^}/' "$DEPLOY_SCRIPT")"
  rendered="$(clear_saved_pm2_owner)"
  assert_contains "$rendered" 'require("node:fs")' \
    'PM2 dump proof must retain module string literals after Bash rendering'
  assert_contains "$rendered" '["dump.pm2", "dump.pm2.bak"]' \
    'PM2 dump proof must retain both quoted resurrection filenames'

  unset -f ssh_sg start_exact_pm2 clear_saved_pm2_owner
  echo 'ok - remote PM2 JavaScript remains syntactically quoted after shell rendering'
}

test_pm2_dump_predicate_rejects_primary_and_backup_residue() {
  local tmp residue save_count
  tmp="$(mktemp -d)"
  PM2_APP='arena-ingest-worker-sg'
  REMOTE_DIR="$tmp/remote"
  DEPLOY_LOCK_DIR="$tmp/deploy-lock"
  DEPLOY_LOCK_TOKEN='dump-fixture-owner'
  PM2_HOME="$tmp/pm2"
  PM2_SAVE_COUNT_FILE="$tmp/save-count"
  PM2_RESIDUE_FILE=''
  export PM2_HOME PM2_SAVE_COUNT_FILE PM2_RESIDUE_FILE
  mkdir -p "$REMOTE_DIR" "$DEPLOY_LOCK_DIR" "$PM2_HOME"
  printf '%s\n' "$DEPLOY_LOCK_TOKEN" > "$DEPLOY_LOCK_DIR/owner"

  pm2() {
    local count
    case "${1:-}" in
      delete) return 0 ;;
      save)
        [ "${2:-}" = --force ] || return 64
        count="$(<"$PM2_SAVE_COUNT_FILE")"
        count=$((count + 1))
        printf '%s\n' "$count" > "$PM2_SAVE_COUNT_FILE"
        if [ "$count" -eq 2 ] && [ -n "$PM2_RESIDUE_FILE" ]; then
          printf '[{"name":"arena-ingest-worker-sg"}]\n' > "$PM2_HOME/$PM2_RESIDUE_FILE"
        fi
        return 0
        ;;
      jlist) printf '[]\n'; return 0 ;;
      *) return 64 ;;
    esac
  }
  ssh_sg() {
    (
      # The suite exports a fake node for release-ID calculation. The remote
      # dump predicate must instead execute the system Node binary.
      unset -f node
      bash -c "$1"
    )
  }
  export -f pm2
  eval "$(awk '/^clear_saved_pm2_owner\(\)/,/^}/' "$DEPLOY_SCRIPT")"

  for residue in dump.pm2 dump.pm2.bak; do
    printf '%s\n' 0 > "$PM2_SAVE_COUNT_FILE"
    printf '[]\n' > "$PM2_HOME/dump.pm2"
    printf '[]\n' > "$PM2_HOME/dump.pm2.bak"
    PM2_RESIDUE_FILE="$residue"
    export PM2_RESIDUE_FILE
    if clear_saved_pm2_owner; then
      rm -rf "$tmp"
      fail "$residue residue must fail the executable PM2 dump predicate"
    fi
    save_count="$(<"$PM2_SAVE_COUNT_FILE")"
    [ "$save_count" -eq 2 ] || {
      rm -rf "$tmp"
      fail "$residue fixture must reach both successful forced PM2 saves"
    }
  done

  printf '%s\n' 0 > "$PM2_SAVE_COUNT_FILE"
  printf '[]\n' > "$PM2_HOME/dump.pm2"
  printf '[]\n' > "$PM2_HOME/dump.pm2.bak"
  PM2_RESIDUE_FILE=''
  export PM2_RESIDUE_FILE
  clear_saved_pm2_owner || {
    rm -rf "$tmp"
    fail 'clean primary and backup PM2 dumps must pass the executable predicate'
  }
  [ "$(<"$PM2_SAVE_COUNT_FILE")" -eq 2 ] || {
    rm -rf "$tmp"
    fail 'clean dump fixture must execute both forced PM2 saves'
  }

  unset -f pm2 ssh_sg clear_saved_pm2_owner
  rm -rf "$tmp"
  echo 'ok - real Node rejects primary or backup PM2 resurrection residue after two saves'
}

test_pm2_restart_counter_predicates_execute_against_jlist() {
  local tmp exact_pid actions
  tmp="$(mktemp -d)"
  PM2_APP='arena-ingest-worker-sg'
  REMOTE_DIR="$tmp/remote"
  DEPLOY_LOCK_DIR="$tmp/deploy-lock"
  DEPLOY_LOCK_TOKEN='restart-fixture-owner'
  PM2_JLIST_FILE="$tmp/jlist.json"
  PM2_ACTION_LOG="$tmp/pm2-actions"
  PM2_FLIP_AFTER_SAVE=0
  PM2_RESTARTED_JSON="[{\"name\":\"$PM2_APP\",\"pid\":4242,\"pm2_env\":{\"status\":\"online\",\"pm_cwd\":\"$REMOTE_DIR\",\"restart_time\":1}}]"
  export PM2_JLIST_FILE PM2_ACTION_LOG PM2_FLIP_AFTER_SAVE PM2_RESTARTED_JSON
  mkdir -p "$REMOTE_DIR" "$DEPLOY_LOCK_DIR"
  printf '%s\n' "$DEPLOY_LOCK_TOKEN" > "$DEPLOY_LOCK_DIR/owner"
  : > "$PM2_ACTION_LOG"

  pm2() {
    case "${1:-}" in
      jlist) command cat "$PM2_JLIST_FILE" ;;
      delete|start)
        printf '%s\n' "$*" >> "$PM2_ACTION_LOG"
        ;;
      save)
        printf '%s\n' "$*" >> "$PM2_ACTION_LOG"
        if [ "$PM2_FLIP_AFTER_SAVE" = 1 ]; then
          printf '%s\n' "$PM2_RESTARTED_JSON" > "$PM2_JLIST_FILE"
        fi
        ;;
      *) return 64 ;;
    esac
  }
  sleep() { return 0; }
  ssh_sg() {
    (
      unset -f node
      bash -c "$1"
    )
  }
  export -f pm2 sleep
  eval "$(awk '/^exact_pm2_pid\(\)/,/^}/' "$DEPLOY_SCRIPT")"
  eval "$(awk '/^assert_exact_pm2_process\(\)/,/^}/' "$DEPLOY_SCRIPT")"
  eval "$(awk '/^prove_exact_pm2_stability\(\)/,/^}/' "$DEPLOY_SCRIPT")"
  eval "$(awk '/^start_exact_pm2\(\)/,/^}/' "$DEPLOY_SCRIPT")"
  eval "$(awk '/^commit_exact_pm2\(\)/,/^}/' "$DEPLOY_SCRIPT")"

  printf '[{"name":"%s","pid":4242,"pm2_env":{"status":"online","pm_cwd":"%s","restart_time":0}}]\n' \
    "$PM2_APP" "$REMOTE_DIR" > "$PM2_JLIST_FILE"
  exact_pid="$(exact_pm2_pid)" || fail 'restart_time=0 must yield the exact PM2 PID'
  [ "$exact_pid" = 4242 ] || fail 'exact PM2 PID fixture must return 4242'
  assert_exact_pm2_process 4242 || fail 'restart_time=0 must pass the exact-process predicate'
  prove_exact_pm2_stability 4242 || fail 'restart_time=0 must pass the stability predicate'
  start_exact_pm2 || fail 'restart_time=0 must pass the post-start predicate'
  commit_exact_pm2 4242 || fail 'restart_time=0 must pass both PM2 commit predicates'
  actions="$(<"$PM2_ACTION_LOG")"
  [ "$(grep -c '^save$' <<<"$actions" || true)" -eq 1 ] || \
    fail 'clean PM2 commit fixture must execute exactly one pm2 save'

  printf '%s\n' "$PM2_RESTARTED_JSON" > "$PM2_JLIST_FILE"
  : > "$PM2_ACTION_LOG"
  if exact_pm2_pid >/dev/null; then fail 'PID capture must reject restart_time=1'; fi
  if assert_exact_pm2_process 4242; then fail 'exact-process proof must reject restart_time=1'; fi
  if prove_exact_pm2_stability 4242; then fail 'stability proof must reject restart_time=1'; fi
  if start_exact_pm2; then fail 'post-start proof must reject restart_time=1'; fi
  : > "$PM2_ACTION_LOG"
  if commit_exact_pm2 4242; then fail 'pre-save PM2 commit proof must reject restart_time=1'; fi
  actions="$(<"$PM2_ACTION_LOG")"
  [[ "$actions" != *save* ]] || fail 'pre-save restart rejection must occur before pm2 save'

  printf '[{"name":"%s","pid":4242,"pm2_env":{"status":"online","pm_cwd":"%s","restart_time":0}}]\n' \
    "$PM2_APP" "$REMOTE_DIR" > "$PM2_JLIST_FILE"
  : > "$PM2_ACTION_LOG"
  PM2_FLIP_AFTER_SAVE=1
  export PM2_FLIP_AFTER_SAVE
  if commit_exact_pm2 4242; then
    fail 'post-save PM2 commit proof must reject a restart counter increment'
  fi
  actions="$(<"$PM2_ACTION_LOG")"
  [ "$(grep -c '^save$' <<<"$actions" || true)" -eq 1 ] || \
    fail 'post-save restart fixture must execute exactly one pm2 save before rejection'

  unset -f pm2 sleep ssh_sg exact_pm2_pid assert_exact_pm2_process
  unset -f prove_exact_pm2_stability start_exact_pm2 commit_exact_pm2
  rm -rf "$tmp"
  echo 'ok - real PM2 JSON predicates reject restart_time=1 before and after save'
}

test_pm2_save_follows_stable_redis_proof() {
  local start_body clear_body force_saves final_main_line candidate_roster_line
  local candidate_save_line success_line
  local rollback_roster_line rollback_save_line restored_line clear_line cutover_line
  start_body="$(awk '/^start_exact_pm2\(\)/,/^}/' "$DEPLOY_SCRIPT")"
  clear_body="$(awk '/^clear_saved_pm2_owner\(\)/,/^}/' "$DEPLOY_SCRIPT")"
  [[ "$start_body" != *'pm2 save'* ]] || \
    fail 'an unproven candidate or rollback must never enter the PM2 dump'
  force_saves="$(grep -o 'pm2 save --force' <<<"$clear_body" | wc -l | tr -d ' ')"
  [ "$force_saves" -ge 2 ] || \
    fail 'empty PM2 state must be force-saved twice to replace primary and fallback dumps'
  assert_contains "$clear_body" '[\"dump.pm2\", \"dump.pm2.bak\"]' \
    'cutover must parse both PM2 resurrection files after clearing the owner'
  assert_contains "$clear_body" 'apps.some(app => app && app.name === process.argv[1])' \
    'cutover must reject a persisted dump that still names the stable-path owner'
  clear_line="$(grep -n '^clear_saved_pm2_owner || {' "$DEPLOY_SCRIPT" | cut -d: -f1)"
  cutover_line="$(grep -n '^CUTOVER_STARTED=1$' "$DEPLOY_SCRIPT" | cut -d: -f1)"
  [ "$clear_line" -lt "$cutover_line" ] || \
    fail 'stable-path PM2 owner must be removed from saved state before cutover'

  final_main_line="$(grep -n '^require_exact_main$' "$DEPLOY_SCRIPT" | tail -1 | cut -d: -f1)"
  candidate_roster_line="$(grep -n 'verify_sg_roster --candidate' "$DEPLOY_SCRIPT" | tail -1 | cut -d: -f1)"
  candidate_save_line="$(grep -n 'commit_exact_pm2 "$CANDIDATE_PM2_PID"' "$DEPLOY_SCRIPT" | cut -d: -f1)"
  success_line="$(grep -n '^DEPLOY_SUCCEEDED=1$' "$DEPLOY_SCRIPT" | cut -d: -f1)"
  [ "$final_main_line" -lt "$candidate_roster_line" ] && \
    [ "$candidate_roster_line" -lt "$candidate_save_line" ] && \
    [ "$candidate_save_line" -lt "$success_line" ] || \
    fail 'candidate PM2 save must follow final-main Redis proof and precede success'

  rollback_roster_line="$(grep -n 'verify_sg_roster --rollback' "$DEPLOY_SCRIPT" | tail -1 | cut -d: -f1)"
  rollback_save_line="$(grep -n 'commit_exact_pm2 "$rollback_pm2_pid"' "$DEPLOY_SCRIPT" | cut -d: -f1)"
  restored_line="$(grep -n 'previous SG release restored with exact fresh Redis identity evidence' "$DEPLOY_SCRIPT" | cut -d: -f1)"
  [ "$rollback_roster_line" -lt "$rollback_save_line" ] && \
    [ "$rollback_save_line" -lt "$restored_line" ] || \
    fail 'rollback PM2 save must follow stable Redis proof and precede restoration'
  echo 'ok - PM2 state is saved only after stable Redis-backed readiness proof'
}

test_post_success_retention_cleanup_is_best_effort() {
  local deploy success_line cleanup_line complete_line
  deploy="$(<"$DEPLOY_SCRIPT")"
  assert_contains "$deploy" "ls -d '\$REMOTE_DIR'.bak-*" \
    'backup retention cleanup must be explicitly best effort'
  assert_contains "$deploy" \
    'test \"\$(cat '\''$DEPLOY_LOCK_DIR/owner'\'' 2>/dev/null || true)\" = '\''$DEPLOY_LOCK_TOKEN'\''' \
    'backup retention cleanup must remain token-fenced'
  assert_contains "$deploy" 'SG deploy succeeded, but old-backup retention cleanup failed' \
    'cleanup failure must remain visible without falsifying rollout status'
  success_line="$(grep -n '^DEPLOY_SUCCEEDED=1$' "$DEPLOY_SCRIPT" | cut -d: -f1)"
  cleanup_line="$(grep -n 'old-backup retention cleanup failed' "$DEPLOY_SCRIPT" | cut -d: -f1)"
  complete_line="$(grep -n 'SG deploy complete' "$DEPLOY_SCRIPT" | cut -d: -f1)"
  [ "$success_line" -lt "$cleanup_line" ] && [ "$cleanup_line" -lt "$complete_line" ] || \
    fail 'retention cleanup must run only after transactional success and before completion reporting'
  echo 'ok - post-success retention cleanup cannot falsify deploy failure'
}

bash -n "$DEPLOY_SCRIPT" "$DOCKER_SCRIPT" "$0"
test_dry_run_itemizes_changes
test_artifact_preflight_fails_before_remote_access
test_release_helper_failure_fails_before_remote_access
test_pm2_stop_failure_restores_previous_process
test_failed_candidate_readiness_rolls_back_complete_directory
test_candidate_redis_rejection_rolls_back
test_post_proof_lock_loss_never_reports_success
test_pre_stop_stale_heartbeat_never_mutates_runtime
test_pre_stop_future_heartbeat_never_mutates_runtime
test_post_proof_renewer_death_never_reports_success
test_stop_wait_loop_owner_flip_never_mutates_further
test_final_fetch_lock_loss_never_reports_success
test_final_fetch_pm2_replacement_rolls_back
test_final_fetch_redis_rejection_rolls_back
test_candidate_must_survive_minimum_uptime
test_candidate_pm2_state_is_saved_only_after_proof
test_candidate_guard_clear_uncertainty_does_not_undo_commit
test_unproven_candidate_is_absent_from_saved_pm2_state
test_rollback_redis_rejection_never_reports_restored
test_rollback_guard_clear_uncertainty_does_not_undo_commit
test_restore_ssh_failure_stops_rollback_immediately
test_failed_quarantine_leaves_durable_recovery_guard
test_rollback_cleanup_pm2_replacement_never_reports_restored
test_rollback_cleanup_lock_loss_never_reports_restored
test_rollback_must_survive_minimum_uptime
test_rollback_pm2_state_is_saved_only_after_proof
test_legacy_rollback_without_release_stamp_is_recoverable
test_running_container_refuses_pm2_deploy
test_docker_inspection_failure_aborts_deploy
test_docker_ownership_probe_executes_one_fail_closed_snapshot
test_durable_recovery_guard_blocks_new_deploy_before_inspection
test_concurrent_deploy_refuses_before_backup
test_deploy_lease_is_fenced_and_recoverable
test_container_bypass_is_disabled
test_ready_check_requires_fresh_sha_evidence
test_rollback_capture_policy_is_preflighted
test_log_verifier_rejects_old_or_forged_evidence
test_release_stamp_matches_exact_committed_inputs
test_remote_javascript_quotes_survive_shell_rendering
test_pm2_dump_predicate_rejects_primary_and_backup_residue
test_pm2_restart_counter_predicates_execute_against_jlist
test_pm2_save_follows_stable_redis_proof
test_post_success_retention_cleanup_is_best_effort
