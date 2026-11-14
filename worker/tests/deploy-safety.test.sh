#!/usr/bin/env bash
# Offline contract tests for the SG deploy safety rails. External commands are
# replaced with exported Bash functions; no SSH, rsync, Docker, or remote writes.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEPLOY_SCRIPT="$ROOT/worker/deploy-ingest-sg.sh"
DOCKER_SCRIPT="$ROOT/worker/docker-run-sg.sh"
LOG_VERIFIER="$ROOT/worker/verify-sg-ready-log.awk"
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
  DEPLOY_INCIDENT_HOLD="$tmp/incident-hold"
  DEPLOY_RECOVERY_GUARD="$tmp/recovery-required"
  RECOVERY_GO_FILE="$tmp/recover-from-stopped.go"
  RECOVERY_GO_CONSUMED="$DEPLOY_LOCK_DIR/recover-from-stopped.go"
  RECOVER_FROM_STOPPED=0
  SHA="$TEST_SHA"
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

test_incident_hold_blocks_new_deploy_before_lock_or_inspection() {
  local tmp output status
  tmp="$(mktemp -d)"
  DEPLOY_LOCK_DIR="$tmp/deploy-lock"
  DEPLOY_INCIDENT_HOLD="$tmp/incident-hold"
  DEPLOY_RECOVERY_GUARD="$tmp/recovery-required"
  RECOVERY_GO_FILE="$tmp/recover-from-stopped.go"
  RECOVERY_GO_CONSUMED="$DEPLOY_LOCK_DIR/recover-from-stopped.go"
  RECOVER_FROM_STOPPED=0
  SHA="$TEST_SHA"
  DEPLOY_LOCK_TOKEN='hold-fixture-owner'
  DEPLOY_LOCK_STALE_SECONDS=900
  DEPLOY_LOCK_HELD=0
  ssh_sg() {
    (
      unset -f node
      bash -c "$1"
    )
  }
  eval "$(awk '/^acquire_deploy_lock\(\)/,/^}/' "$DEPLOY_SCRIPT")"
  printf '%s\n' 'incident-no-go' > "$DEPLOY_INCIDENT_HOLD"

  set +e
  output="$(acquire_deploy_lock 2>&1)"
  status=$?
  set -e
  [ "$status" -ne 0 ] || fail 'an existing SG incident hold must refuse lock acquisition'
  assert_contains "$output" 'BLOCKED: SG incident hold is armed' \
    'executable lock acquisition must identify the SG incident hold'
  [ ! -e "$DEPLOY_LOCK_DIR" ] || fail 'incident hold must precede deploy-lock mutation'
  unset -f ssh_sg acquire_deploy_lock
  rm -rf "$tmp"
  echo 'ok - SG incident hold blocks deploy before lock or inspection'
}

test_stopped_recovery_requires_one_time_confirmation() {
  local tmp output status
  local DEPLOY_LOCK_DIR DEPLOY_INCIDENT_HOLD DEPLOY_RECOVERY_GUARD
  local RECOVERY_GO_FILE RECOVERY_GO_CONSUMED RECOVER_FROM_STOPPED
  local DEPLOY_LOCK_TOKEN DEPLOY_LOCK_STALE_SECONDS DEPLOY_LOCK_HELD
  local DEPLOY_LOCK_RENEW_PID SHA
  tmp="$(mktemp -d)"
  DEPLOY_LOCK_DIR="$tmp/deploy-lock"
  DEPLOY_INCIDENT_HOLD="$tmp/incident-hold"
  DEPLOY_RECOVERY_GUARD="$tmp/recovery-required"
  RECOVERY_GO_FILE="$tmp/recover-from-stopped.go"
  RECOVERY_GO_CONSUMED="$DEPLOY_LOCK_DIR/recover-from-stopped.go"
  RECOVER_FROM_STOPPED=1
  DEPLOY_LOCK_TOKEN='stopped-missing-go-owner'
  DEPLOY_LOCK_STALE_SECONDS=900
  DEPLOY_LOCK_HELD=0
  DEPLOY_LOCK_RENEW_PID=''
  SHA="$TEST_SHA"
  printf '%s\n' incident > "$DEPLOY_INCIDENT_HOLD"
  printf '%s\n' compatibility > "$DEPLOY_RECOVERY_GUARD"
  ssh_sg() {
    (
      unset -f node
      bash -c "$1"
    )
  }
  eval "$(awk '/^acquire_deploy_lock\(\)/,/^}/' "$DEPLOY_SCRIPT")"

  set +e
  output="$(acquire_deploy_lock 2>&1)"
  status=$?
  set -e
  [ "$status" -ne 0 ] || fail 'SG stopped recovery without one-time confirmation must fail'
  assert_contains "$output" 'requires a fresh owner-only mode-0600 confirmation' \
    'missing SG stopped-recovery confirmation must be explicit'
  [ ! -e "$DEPLOY_LOCK_DIR" ] || fail 'missing confirmation must precede deploy-lock mutation'
  [ -e "$DEPLOY_INCIDENT_HOLD" ] || fail 'missing confirmation must retain the primary hold'
  [ -e "$DEPLOY_RECOVERY_GUARD" ] || fail 'missing confirmation must retain the compatibility guard'

  unset -f ssh_sg acquire_deploy_lock
  rm -rf "$tmp"
  echo 'ok - SG stopped recovery requires an unlogged one-time host confirmation'
}

test_stopped_recovery_failed_go_consumption_cleans_lock() {
  local tmp output status expires nonce
  local DEPLOY_LOCK_DIR DEPLOY_INCIDENT_HOLD DEPLOY_RECOVERY_GUARD
  local RECOVERY_GO_FILE RECOVERY_GO_CONSUMED RECOVER_FROM_STOPPED
  local DEPLOY_LOCK_TOKEN DEPLOY_LOCK_STALE_SECONDS DEPLOY_LOCK_HELD
  local DEPLOY_LOCK_RENEW_PID SHA
  tmp="$(mktemp -d)"
  DEPLOY_LOCK_DIR="$tmp/deploy-lock"
  DEPLOY_INCIDENT_HOLD="$tmp/incident-hold"
  DEPLOY_RECOVERY_GUARD="$tmp/recovery-required"
  RECOVERY_GO_FILE="$tmp/recover-from-stopped.go"
  RECOVERY_GO_CONSUMED="$DEPLOY_LOCK_DIR/recover-from-stopped.go"
  RECOVER_FROM_STOPPED=1
  DEPLOY_LOCK_TOKEN='stopped-failed-consume-owner'
  DEPLOY_LOCK_STALE_SECONDS=900
  DEPLOY_LOCK_HELD=0
  DEPLOY_LOCK_RENEW_PID=''
  SHA="$TEST_SHA"
  printf '%s\n' incident > "$DEPLOY_INCIDENT_HOLD"
  printf '%s\n' compatibility > "$DEPLOY_RECOVERY_GUARD"
  expires=$(( $(command date +%s) + 600 ))
  nonce="$(printf 'a%.0s' {1..64})"
  printf '%s\n' \
    'arena.ingest-recover-from-stopped@1' \
    "target_sha=$SHA" \
    "expires_epoch=$expires" \
    "nonce=$nonce" \
    > "$RECOVERY_GO_FILE"
  chmod 600 "$RECOVERY_GO_FILE"

  ssh_sg() {
    (
      unset -f node date
      stat() {
        case "${2:-}" in
          %a) command stat -f %Lp "$3" ;;
          %u) command stat -f %u "$3" ;;
          %Y) command stat -f %m "$3" ;;
          *) command stat "$@" ;;
        esac
      }
      mv() {
        command mv "$@"
        if [ "${!#}" = "$RECOVERY_GO_CONSUMED" ]; then
          chmod 644 "$RECOVERY_GO_CONSUMED"
        fi
      }
      export RECOVERY_GO_CONSUMED
      export -f stat mv
      bash -c "$1"
    )
  }
  eval "$(awk '/^acquire_deploy_lock\(\)/,/^}/' "$DEPLOY_SCRIPT")"

  set +e
  output="$(acquire_deploy_lock 2>&1)"
  status=$?
  set -e
  [ "$status" -ne 0 ] || fail 'post-move GO validation failure must fail lock acquisition'
  [ ! -e "$DEPLOY_LOCK_DIR" ] || fail 'failed GO consumption must token-clean the new deploy lock'
  [ ! -e "$RECOVERY_GO_FILE" ] || fail 'a moved one-time GO must not be replayable after acquisition failure'
  [ ! -e "$RECOVERY_GO_CONSUMED" ] || fail 'failed consumed GO must be destroyed with the lock'
  [ -e "$DEPLOY_INCIDENT_HOLD" ] && [ -e "$DEPLOY_RECOVERY_GUARD" ] || \
    fail 'failed GO consumption must leave both host holds armed'
  [ -z "$output" ] || [[ "$output" != *"$nonce"* ]] || fail 'GO nonce must never appear in output'

  unset -f ssh_sg acquire_deploy_lock
  rm -rf "$tmp"
  echo 'ok - failed SG GO consumption is one-time and leaves no orphan deploy lock'
}

test_stopped_recovery_baseline_rechecks_residual_owner() {
  local tmp output status
  local REMOTE_DIR PM2_APP DEPLOY_LOCK_DIR DEPLOY_LOCK_TOKEN
  local DEPLOY_INCIDENT_HOLD DEPLOY_RECOVERY_GUARD
  local RECOVERY_OLD_SHA RECOVERY_OLD_RELEASE RECOVERY_ENV_SHA256
  tmp="$(mktemp -d)"
  REMOTE_DIR="$tmp/arena-ingest"
  PM2_APP='arena-ingest-worker-sg'
  DEPLOY_LOCK_DIR="$tmp/deploy-lock"
  DEPLOY_LOCK_TOKEN='stopped-baseline-owner'
  DEPLOY_INCIDENT_HOLD="$tmp/incident-hold"
  DEPLOY_RECOVERY_GUARD="$tmp/recovery-required"
  RECOVERY_OLD_SHA=''
  RECOVERY_OLD_RELEASE=''
  RECOVERY_ENV_SHA256=''
  BASELINE_OLD_SHA='1111111111111111111111111111111111111111'
  BASELINE_OLD_RELEASE='2222222222222222222222222222222222222222222222222222222222222222'
  BASELINE_ENV_SHA='3333333333333333333333333333333333333333333333333333333333333333'
  BASELINE_JLIST_COUNT_FILE="$tmp/jlist-count"
  BASELINE_SAVE_COUNT_FILE="$tmp/save-count"
  BASELINE_INJECT_RESIDUAL=0
  BASELINE_PM2_FAIL=0
  BASELINE_REDIS_MODE=stale
  PM2_HOME="$tmp/pm2"
  export BASELINE_OLD_SHA BASELINE_OLD_RELEASE BASELINE_ENV_SHA
  export BASELINE_JLIST_COUNT_FILE BASELINE_SAVE_COUNT_FILE
  export BASELINE_INJECT_RESIDUAL BASELINE_PM2_FAIL BASELINE_REDIS_MODE PM2_HOME
  mkdir -p "$REMOTE_DIR/worker" "$REMOTE_DIR/node_modules/dotenv" \
    "$REMOTE_DIR/node_modules/ioredis" "$DEPLOY_LOCK_DIR" "$PM2_HOME"
  printf '%s\n' \
    'exports.config = () => ({ parsed: {} })' \
    > "$REMOTE_DIR/node_modules/dotenv/index.js"
  printf '%s\n' \
    'class Redis {' \
    '  on() {}' \
    '  hgetall() {' \
    '    return Promise.resolve({ future: JSON.stringify({ regions: ["vps_sg"], ts: Date.now() + 6000 }) })' \
    '  }' \
    '  disconnect() {}' \
    '}' \
    'module.exports = Redis' \
    > "$REMOTE_DIR/node_modules/ioredis/index.js"
  printf '%s\n' "$DEPLOY_LOCK_TOKEN" > "$DEPLOY_LOCK_DIR/owner"
  : > "$DEPLOY_LOCK_DIR/heartbeat"
  printf '%s\n' incident > "$DEPLOY_INCIDENT_HOLD"
  printf '%s\n' compatibility > "$DEPLOY_RECOVERY_GUARD"
  printf '%s\n' REDIS_URL=redis://fixture > "$REMOTE_DIR/worker/.env"
  chmod 600 "$REMOTE_DIR/worker/.env"
  printf '%s\n' "$BASELINE_OLD_SHA" > "$REMOTE_DIR/DEPLOYED_SHA"
  printf '%s\n' "$BASELINE_OLD_RELEASE" > "$REMOTE_DIR/WORKER_RELEASE_ID"
  printf '[{"name":"%s","status":"stopped","pm_cwd":"%s"}]\n' \
    "$PM2_APP" "$REMOTE_DIR" > "$PM2_HOME/dump.pm2"
  cp "$PM2_HOME/dump.pm2" "$PM2_HOME/dump.pm2.bak"
  printf '%s\n' 0 > "$BASELINE_JLIST_COUNT_FILE"
  printf '%s\n' 0 > "$BASELINE_SAVE_COUNT_FILE"

  ssh_sg() {
    (
      unset -f node
      export PM2_APP REMOTE_DIR
      node() {
        if [[ "$*" == *'require("dotenv")'* && "$BASELINE_REDIS_MODE" != future ]]; then
          return 0
        fi
        command node "$@"
      }
      pm2() {
        local count
        case "${1:-}" in
          jlist)
            count="$(<"$BASELINE_JLIST_COUNT_FILE")"
            count=$((count + 1))
            printf '%s\n' "$count" > "$BASELINE_JLIST_COUNT_FILE"
            if [ "$BASELINE_INJECT_RESIDUAL" = 1 ] && [ "$count" -ge 2 ]; then
              printf '[{"name":"%s","pid":9191,"pm2_env":{"status":"online","pm_cwd":"%s"}}]\n' \
                "$PM2_APP" "$REMOTE_DIR"
            else
              printf '[{"name":"%s","pid":0,"pm2_env":{"status":"stopped","pm_cwd":"%s"}}]\n' \
                "$PM2_APP" "$REMOTE_DIR"
            fi
            [ "$BASELINE_PM2_FAIL" = 0 ]
            ;;
          save)
            [ "${2:-}" = --force ] || return 64
            count="$(<"$BASELINE_SAVE_COUNT_FILE")"
            printf '%s\n' "$((count + 1))" > "$BASELINE_SAVE_COUNT_FILE"
            ;;
          *) return 64 ;;
        esac
      }
      ps() { printf '%s\n' '777 harmless-process'; }
      docker() {
        [ "${1:-}" = ps ] || return 64
        return 0
      }
      stat() {
        if [ "${2:-}" = %a ]; then printf '%s\n' 600
        else command stat "$@"
        fi
      }
      sha256sum() { printf '%s  %s\n' "$BASELINE_ENV_SHA" "${1:-fixture}"; }
      export -f node pm2 ps docker stat sha256sum
      bash -c "$1"
    )
  }
  assert_stopped_recovery_prep_authority() { return 0; }
  eval "$(awk '/^prove_stopped_sg_baseline\(\)/,/^}/' "$DEPLOY_SCRIPT")"

  prove_stopped_sg_baseline || {
    rm -rf "$tmp"
    fail 'a stable stopped SG PM2/dump/process/Docker/Redis baseline must pass'
  }
  [ "$RECOVERY_OLD_SHA" = "$BASELINE_OLD_SHA" ] || fail 'baseline must bind old SHA'
  [ "$RECOVERY_OLD_RELEASE" = "$BASELINE_OLD_RELEASE" ] || fail 'baseline must bind old release'
  [ "$RECOVERY_ENV_SHA256" = "$BASELINE_ENV_SHA" ] || fail 'baseline must bind old environment digest'
  [ "$(<"$BASELINE_SAVE_COUNT_FILE")" -eq 2 ] || fail 'baseline must force-save both PM2 dump generations'

  RECOVERY_OLD_SHA=''; RECOVERY_OLD_RELEASE=''; RECOVERY_ENV_SHA256=''
  BASELINE_INJECT_RESIDUAL=1
  export BASELINE_INJECT_RESIDUAL
  printf '%s\n' 0 > "$BASELINE_JLIST_COUNT_FILE"
  printf '%s\n' 0 > "$BASELINE_SAVE_COUNT_FILE"
  set +e
  output="$(prove_stopped_sg_baseline 2>&1)"
  status=$?
  set -e
  [ "$status" -ne 0 ] || fail 'an owner injected after the first baseline snapshot must be rejected'
  assert_contains "$output" 'lacks exact zero-owner' 'residual-owner rejection must be explicit'

  RECOVERY_OLD_SHA=''; RECOVERY_OLD_RELEASE=''; RECOVERY_ENV_SHA256=''
  BASELINE_INJECT_RESIDUAL=0
  BASELINE_PM2_FAIL=1
  export BASELINE_INJECT_RESIDUAL BASELINE_PM2_FAIL
  printf '%s\n' 0 > "$BASELINE_JLIST_COUNT_FILE"
  set +e
  prove_stopped_sg_baseline >/dev/null 2>&1
  status=$?
  set -e
  [ "$status" -ne 0 ] || fail 'a failing pm2 jlist producer must fail the stopped proof closed'

  BASELINE_PM2_FAIL=0
  BASELINE_REDIS_MODE=future
  export BASELINE_PM2_FAIL BASELINE_REDIS_MODE
  printf '%s\n' 0 > "$BASELINE_JLIST_COUNT_FILE"
  set +e
  output="$(prove_stopped_sg_baseline 2>&1)"
  status=$?
  set -e
  [ "$status" -ne 0 ] || fail 'a future vps_sg Redis heartbeat must block stopped recovery'
  assert_contains "$output" 'lacks exact zero-owner' 'future Redis ownership must fail explicitly'

  BASELINE_REDIS_MODE=stale
  export BASELINE_REDIS_MODE
  printf '[{"name":"legacy-ingest","status":"stopped","pm_cwd":"%s","script":"worker/src/ingest-worker.ts"}]\n' \
    "$REMOTE_DIR" > "$PM2_HOME/dump.pm2.bak"
  printf '%s\n' 0 > "$BASELINE_JLIST_COUNT_FILE"
  set +e
  prove_stopped_sg_baseline >/dev/null 2>&1
  status=$?
  set -e
  [ "$status" -ne 0 ] || fail 'a legacy ingest alias in dump.pm2.bak must block stopped recovery'
  cp "$PM2_HOME/dump.pm2" "$PM2_HOME/dump.pm2.bak"

  mv "$REMOTE_DIR" "$tmp/arena-ingest-real"
  ln -s "$tmp/arena-ingest-real" "$REMOTE_DIR"
  set +e
  prove_stopped_sg_baseline >/dev/null 2>&1
  status=$?
  set -e
  [ "$status" -ne 0 ] || fail 'a symlinked SG live directory must fail the stopped baseline'

  unset -f ssh_sg assert_stopped_recovery_prep_authority prove_stopped_sg_baseline
  unset BASELINE_OLD_SHA BASELINE_OLD_RELEASE BASELINE_ENV_SHA
  unset BASELINE_JLIST_COUNT_FILE BASELINE_SAVE_COUNT_FILE
  unset BASELINE_INJECT_RESIDUAL BASELINE_PM2_FAIL BASELINE_REDIS_MODE PM2_HOME
  rm -rf "$tmp"
  echo 'ok - SG stopped baseline rechecks ownership and fails closed on PM2 snapshot errors'
}

test_stopped_recovery_failure_stays_stopped_and_rearms_holds() {
  local tmp output status now
  local REMOTE_DIR PM2_APP DEPLOY_LOCK_DIR DEPLOY_LOCK_TOKEN
  local DEPLOY_INCIDENT_HOLD DEPLOY_RECOVERY_GUARD RECOVERY_GO_CONSUMED
  local DEPLOY_LOCK_MAX_HEARTBEAT_AGE_SECONDS DEPLOY_LOCK_STALE_SECONDS
  local DEPLOY_LOCK_RENEW_PID CUTOVER_STARTED BACKUP_DIR FAILED_DIR
  local RECOVERY_OLD_SHA RECOVERY_OLD_RELEASE RECOVERY_ENV_SHA256
  local STOPPED_RECOVERY_QUARANTINED SHA
  tmp="$(mktemp -d)"
  REMOTE_DIR="$tmp/arena-ingest"
  PM2_APP='arena-ingest-worker-sg'
  DEPLOY_LOCK_DIR="$tmp/deploy-lock"
  DEPLOY_LOCK_TOKEN='stopped-quarantine-owner'
  DEPLOY_INCIDENT_HOLD="$tmp/incident-hold"
  DEPLOY_RECOVERY_GUARD="$tmp/recovery-required"
  RECOVERY_GO_CONSUMED="$DEPLOY_LOCK_DIR/recover-from-stopped.go"
  DEPLOY_LOCK_MAX_HEARTBEAT_AGE_SECONDS=120
  DEPLOY_LOCK_STALE_SECONDS=900
  DEPLOY_LOCK_RENEW_PID=999999
  CUTOVER_STARTED=0
  BACKUP_DIR="$tmp/backup"
  FAILED_DIR="$tmp/failed"
  RECOVERY_OLD_SHA='4444444444444444444444444444444444444444'
  RECOVERY_OLD_RELEASE='5555555555555555555555555555555555555555555555555555555555555555'
  RECOVERY_ENV_SHA256='6666666666666666666666666666666666666666666666666666666666666666'
  STOPPED_RECOVERY_QUARANTINED=0
  SHA="$TEST_SHA"
  QUARANTINE_EVENT_LOG="$tmp/events"
  QUARANTINE_SAVE_COUNT_FILE="$tmp/save-count"
  QUARANTINE_RESIDUAL=0
  QUARANTINE_HEARTBEAT_SECONDS=$(( $(command date +%s) - 300 ))
  PM2_HOME="$tmp/pm2"
  export QUARANTINE_EVENT_LOG QUARANTINE_SAVE_COUNT_FILE
  export QUARANTINE_RESIDUAL QUARANTINE_HEARTBEAT_SECONDS PM2_HOME
  mkdir -p "$REMOTE_DIR/worker" "$DEPLOY_LOCK_DIR" "$PM2_HOME"
  printf '%s\n' "$DEPLOY_LOCK_TOKEN" > "$DEPLOY_LOCK_DIR/owner"
  : > "$DEPLOY_LOCK_DIR/heartbeat"
  printf '%s\n' compatibility > "$DEPLOY_RECOVERY_GUARD"
  printf '%s\n' consumed > "$RECOVERY_GO_CONSUMED"
  printf '%s\n' "$RECOVERY_OLD_SHA" > "$REMOTE_DIR/DEPLOYED_SHA"
  printf '%s\n' "$RECOVERY_OLD_RELEASE" > "$REMOTE_DIR/WORKER_RELEASE_ID"
  printf '%s\n' REDIS_URL=redis://fixture > "$REMOTE_DIR/worker/.env"
  printf '%s\n' '[]' > "$PM2_HOME/dump.pm2"
  printf '%s\n' '[]' > "$PM2_HOME/dump.pm2.bak"
  : > "$QUARANTINE_EVENT_LOG"
  printf '%s\n' 0 > "$QUARANTINE_SAVE_COUNT_FILE"

  ssh_sg() {
    (
      unset -f node date
      export PM2_APP REMOTE_DIR RECOVERY_ENV_SHA256
      node() { command node "$@"; }
      pm2() {
        local count
        printf 'pm2 %s\n' "$*" >> "$QUARANTINE_EVENT_LOG"
        case "${1:-}" in
          stop|delete) return 0 ;;
          save)
            [ "${2:-}" = --force ] || return 64
            count="$(<"$QUARANTINE_SAVE_COUNT_FILE")"
            printf '%s\n' "$((count + 1))" > "$QUARANTINE_SAVE_COUNT_FILE"
            printf '%s\n' '[]' > "$PM2_HOME/dump.pm2"
            printf '%s\n' '[]' > "$PM2_HOME/dump.pm2.bak"
            ;;
          jlist)
            if [ "$QUARANTINE_RESIDUAL" = 1 ]; then
              printf '[{"name":"%s","pid":8181,"pm2_env":{"status":"online","pm_cwd":"%s"}}]\n' \
                "$PM2_APP" "$REMOTE_DIR"
            else
              printf '%s\n' '[]'
            fi
            ;;
          start|restart) return 70 ;;
          *) return 64 ;;
        esac
      }
      ps() { printf '%s\n' '778 harmless-process'; }
      docker() {
        [ "${1:-}" = ps ] || return 64
        return 0
      }
      stat() {
        case "${2:-}" in
          %Y) printf '%s\n' "$QUARANTINE_HEARTBEAT_SECONDS" ;;
          %a) printf '%s\n' 600 ;;
          *) command stat "$@" ;;
        esac
      }
      sha256sum() { printf '%s  %s\n' "$RECOVERY_ENV_SHA256" "${1:-fixture}"; }
      export -f node pm2 ps docker stat sha256sum
      bash -c "$1"
    )
  }
  eval "$(awk '/^assert_cleanup_deploy_lock\(\)/,/^}/' "$DEPLOY_SCRIPT")"
  eval "$(awk '/^arm_sg_incident_holds\(\)/,/^}/' "$DEPLOY_SCRIPT")"
  eval "$(awk '/^quarantine_stopped_sg_recovery\(\)/,/^}/' "$DEPLOY_SCRIPT")"

  quarantine_stopped_sg_recovery >/dev/null 2>&1 || {
    rm -rf "$tmp"
    fail 'stopped recovery cleanup must survive a dead renewer with a fresh pre-takeover owner token'
  }
  [ "$STOPPED_RECOVERY_QUARANTINED" = 1 ] || fail 'successful quarantine must set its stopped marker'
  [ -e "$DEPLOY_INCIDENT_HOLD" ] && [ -e "$DEPLOY_RECOVERY_GUARD" ] || \
    fail 'failed recovery must leave both SG holds armed'
  [ ! -e "$RECOVERY_GO_CONSUMED" ] || fail 'failed recovery must destroy the consumed GO'
  [ "$(<"$QUARANTINE_SAVE_COUNT_FILE")" -eq 2 ] || fail 'quarantine must force-save both PM2 generations'
  output="$(<"$QUARANTINE_EVENT_LOG")"
  assert_contains "$output" 'pm2 stop arena-ingest-worker-sg' 'quarantine must stop the candidate'
  assert_contains "$output" 'pm2 delete arena-ingest-worker-sg' 'quarantine must delete the candidate'
  [[ "$output" != *'pm2 start'* && "$output" != *'pm2 restart'* ]] || \
    fail 'stopped recovery quarantine must never start an old owner'

  rm -f "$DEPLOY_INCIDENT_HOLD" "$DEPLOY_RECOVERY_GUARD"
  ln -s "$tmp/missing-compatibility-target" "$DEPLOY_RECOVERY_GUARD"
  printf '%s\n' consumed > "$RECOVERY_GO_CONSUMED"
  : > "$QUARANTINE_EVENT_LOG"
  printf '%s\n' 0 > "$QUARANTINE_SAVE_COUNT_FILE"
  STOPPED_RECOVERY_QUARANTINED=0
  quarantine_stopped_sg_recovery >/dev/null 2>&1 || {
    rm -rf "$tmp"
    fail 'quarantine must recreate both holds even when the compatibility guard disappeared'
  }
  [ -e "$DEPLOY_INCIDENT_HOLD" ] && [ -e "$DEPLOY_RECOVERY_GUARD" ] || \
    fail 'missing holds must be re-created after candidate stop'
  [ ! -L "$DEPLOY_RECOVERY_GUARD" ] && [ -f "$DEPLOY_RECOVERY_GUARD" ] || \
    fail 'a broken compatibility symlink must be replaced by a regular hold file'
  [ "$(command stat -f %Lp "$DEPLOY_RECOVERY_GUARD")" = 600 ] || \
    fail 'recreated compatibility hold must be mode 0600'

  rm -f "$DEPLOY_INCIDENT_HOLD"
  printf '%s\n' consumed > "$RECOVERY_GO_CONSUMED"
  QUARANTINE_RESIDUAL=1
  export QUARANTINE_RESIDUAL
  set +e
  output="$(quarantine_stopped_sg_recovery 2>&1)"
  status=$?
  set -e
  [ "$status" -ne 0 ] || fail 'live PM2 residue must make quarantine explicitly incomplete'
  assert_contains "$output" 'quarantine is incomplete' 'live-residue failure must not claim stopped success'
  [ -e "$DEPLOY_INCIDENT_HOLD" ] && [ -e "$DEPLOY_RECOVERY_GUARD" ] || \
    fail 'incomplete live-owner cleanup must still rearm both holds'

  QUARANTINE_RESIDUAL=0
  export QUARANTINE_RESIDUAL
  printf '%s\n' '7777777777777777777777777777777777777777' > "$REMOTE_DIR/DEPLOYED_SHA"
  rm -f "$DEPLOY_INCIDENT_HOLD"
  printf '%s\n' consumed > "$RECOVERY_GO_CONSUMED"
  set +e
  quarantine_stopped_sg_recovery >/dev/null 2>&1
  status=$?
  set -e
  [ "$status" -ne 0 ] || fail 'a restored directory with the wrong bound SHA must be incomplete'
  [ -e "$DEPLOY_INCIDENT_HOLD" ] && [ -e "$DEPLOY_RECOVERY_GUARD" ] || \
    fail 'wrong rollback digest must still rearm both holds'

  unset -f ssh_sg assert_cleanup_deploy_lock arm_sg_incident_holds quarantine_stopped_sg_recovery
  unset QUARANTINE_EVENT_LOG QUARANTINE_SAVE_COUNT_FILE
  unset QUARANTINE_RESIDUAL QUARANTINE_HEARTBEAT_SECONDS PM2_HOME
  rm -rf "$tmp"
  echo 'ok - failed SG stopped recovery remains stopped, digest-bound, and double-held'
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

test_log_verifier_rejects_old_or_forged_evidence() {
  local marker='arena-deploy-unique' release
  release="$(printf 'b%.0s' {1..64})"

  if printf '%s\n' \
      '[ingest-worker] metric-trust database release contract ready' \
      "[heartbeat] redis-hset-committed node=vps_sg pid=41 sha=$TEST_SHA release=$release ts=1800000000001" \
      '[ingest-worker] native regional authority ready region=vps_sg' \
      '[ingest-worker] ready (regions=vps_sg, concurrency=5, fast-lane=off)' \
      "$marker" \
      '[ingest-worker] metric-trust database release contract ready' \
      '[ingest-worker] ready (regions=vps_sg, concurrency=5, fast-lane=off)' |
      awk -v marker="$marker" -v node=vps_sg -v region=vps_sg \
        -v pid=41 -v sha="$TEST_SHA" -v release="$release" \
        -f "$LOG_VERIFIER"; then
    fail 'valid-looking lines before the unique marker must not pass'
  fi

  if printf '%s\n' \
      "$marker" \
      '[ingest-worker] metric-trust database release contract ready' \
      "[heartbeat] node=vps_sg pid=41 sha=$TEST_SHA release=$release every 60s" \
      '[ingest-worker] native regional authority ready region=vps_sg' \
      '[ingest-worker] ready (regions=vps_sg, concurrency=5, fast-lane=off)' |
      awk -v marker="$marker" -v node=vps_sg -v region=vps_sg \
        -v pid=41 -v sha="$TEST_SHA" -v release="$release" \
        -f "$LOG_VERIFIER"; then
    fail 'the legacy pre-HSET heartbeat line must not pass'
  fi

  if printf '%s\n' \
      "$marker" \
      '[ingest-worker] metric-trust database release contract ready' \
      "[heartbeat] redis-hset-committed node=vps_sg pid=41 sha=$TEST_SHA release=wrong ts=1800000000001" \
      '[ingest-worker] native regional authority ready region=vps_sg' \
      '[ingest-worker] ready (regions=vps_sg, concurrency=5, fast-lane=off)' |
      awk -v marker="$marker" -v node=vps_sg -v region=vps_sg \
        -v pid=41 -v sha="$TEST_SHA" -v release="$release" \
        -f "$LOG_VERIFIER"; then
    fail 'wrong release token must not pass'
  fi

  if printf '%s\n' \
      "$marker" \
      '[ingest-worker] metric-trust database release contract ready' \
      "[heartbeat] redis-hset-committed node=vps_sg pid=3131 sha=$TEST_SHA release=$release ts=1800000000001" \
      '[ingest-worker] native regional authority ready region=vps_sg' \
      '[ingest-worker] ready (regions=vps_sg, concurrency=5, fast-lane=off)' |
      awk -v marker="$marker" -v node=vps_sg -v region=vps_sg \
        -v pid=41 -v sha="$TEST_SHA" -v release="$release" \
        -f "$LOG_VERIFIER"; then
    fail 'a canonical heartbeat from the wrong PM2 PID must not pass'
  fi

  if printf '%s\n' \
      "$marker" \
      '[ingest-worker] metric-trust database release contract ready' \
      "[heartbeat] redis-hset-committed node=vps_sg pid=41 sha=$TEST_SHA release=$release ts=1800000000001" \
      '[ingest-worker] ready (regions=vps_sg, concurrency=5, fast-lane=off)' |
      awk -v marker="$marker" -v node=vps_sg -v region=vps_sg \
        -v pid=41 -v sha="$TEST_SHA" -v release="$release" \
        -f "$LOG_VERIFIER"; then
    fail 'missing native authority evidence must not pass'
  fi

  if printf '%s\n' \
      "$marker" \
      '[ingest-worker] metric-trust database release contract ready' \
      "[heartbeat] redis-hset-committed node=vps_sg pid=41 sha=$TEST_SHA release=$release ts=1800000000001" \
      '[ingest-worker] native regional authority ready region=local' \
      '[ingest-worker] ready (regions=vps_sg, concurrency=5, fast-lane=off)' |
      awk -v marker="$marker" -v node=vps_sg -v region=vps_sg \
        -v pid=41 -v sha="$TEST_SHA" -v release="$release" \
        -f "$LOG_VERIFIER"; then
    fail 'an authority token for the wrong region must not pass'
  fi

  if printf '%s\n' \
      "$marker" \
      '[ingest-worker] metric-trust database release contract ready' \
      "[heartbeat] redis-hset-committed node=vps_sg pid=41 sha=$TEST_SHA release=$release ts=1800000000001" \
      '[ingest-worker] native regional authority ready region=vps_sg control_epoch=forged' \
      '[ingest-worker] ready (regions=vps_sg, concurrency=5, fast-lane=off)' |
      awk -v marker="$marker" -v node=vps_sg -v region=vps_sg \
        -v pid=41 -v sha="$TEST_SHA" -v release="$release" \
        -f "$LOG_VERIFIER"; then
    fail 'an authority token with forged suffix fields must not pass'
  fi

  if printf '%s\n' \
      "$marker" \
      '[ingest-worker] metric-trust database release contract ready' \
      '[ingest-worker] native regional authority ready region=vps_sg' \
      "[heartbeat] redis-hset-committed node=vps_sg pid=41 sha=$TEST_SHA release=$release ts=1800000000001" \
      '[ingest-worker] ready (regions=vps_sg, concurrency=5, fast-lane=off)' |
      awk -v marker="$marker" -v node=vps_sg -v region=vps_sg \
        -v pid=41 -v sha="$TEST_SHA" -v release="$release" \
        -f "$LOG_VERIFIER"; then
    fail 'authority evidence before the committed heartbeat must not pass'
  fi

  if printf '%s\n' \
      '[ingest-worker] native regional authority ready region=vps_sg' \
      "$marker" \
      '[ingest-worker] metric-trust database release contract ready' \
      "[heartbeat] redis-hset-committed node=vps_sg pid=41 sha=$TEST_SHA release=$release ts=1800000000001" \
      '[ingest-worker] ready (regions=vps_sg, concurrency=5, fast-lane=off)' |
      awk -v marker="$marker" -v node=vps_sg -v region=vps_sg \
        -v pid=41 -v sha="$TEST_SHA" -v release="$release" \
        -f "$LOG_VERIFIER"; then
    fail 'authority evidence before the unique marker must not pass'
  fi

  if printf '%s\n' \
      "$marker" \
      'noise [ingest-worker] metric-trust database release contract ready' \
      "noise [heartbeat] redis-hset-committed node=vps_sg pid=41 sha=$TEST_SHA release=$release ts=1800000000001" \
      'noise [ingest-worker] native regional authority ready region=vps_sg' \
      'noise [ingest-worker] ready (regions=vps_sg, concurrency=5, fast-lane=off)' |
      awk -v marker="$marker" -v node=vps_sg -v region=vps_sg \
        -v pid=41 -v sha="$TEST_SHA" -v release="$release" \
        -f "$LOG_VERIFIER"; then
    fail 'embedded readiness substrings outside a canonical PM2 payload must not pass'
  fi

  if printf '%s\n' \
      "$marker" \
      '[ingest-worker] metric-trust database release contract ready' \
      "[heartbeat] redis-hset-committed node=wrong node=vps_sg pid=41 sha=$TEST_SHA release=$release ts=1800000000001" \
      '[ingest-worker] native regional authority ready region=vps_sg' \
      '[ingest-worker] ready (regions=vps_sg, concurrency=5, fast-lane=off)' |
      awk -v marker="$marker" -v node=vps_sg -v region=vps_sg \
        -v pid=41 -v sha="$TEST_SHA" -v release="$release" \
        -f "$LOG_VERIFIER"; then
    fail 'duplicate heartbeat identity fields must not pass canonical evidence'
  fi

  printf '%s\n' \
    "$marker" \
    '2026-07-28 12:00:00: [ingest-worker] metric-trust database release contract ready' \
    "2026-07-28 12:00:01: [heartbeat] redis-hset-committed node=vps_sg pid=41 sha=$TEST_SHA release=$release ts=1800000000001" \
    '2026-07-28 12:00:02: [ingest-worker] native regional authority ready region=vps_sg' \
    '2026-07-28 12:00:03: [ingest-worker] ready (regions=vps_sg, concurrency=5, fast-lane=off)' |
    awk -v marker="$marker" -v node=vps_sg -v region=vps_sg \
        -v pid=41 -v sha="$TEST_SHA" -v release="$release" \
      -f "$LOG_VERIFIER" || fail 'exact fresh committed log evidence must pass'
  echo 'ok - candidate log verifier enforces fresh ordered native-authority evidence'
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
  PM2_JLIST_EXIT=0
  PM2_RESTARTED_JSON="[{\"name\":\"$PM2_APP\",\"pid\":4242,\"pm2_env\":{\"status\":\"online\",\"pm_cwd\":\"$REMOTE_DIR\",\"restart_time\":1}}]"
  export PM2_JLIST_FILE PM2_ACTION_LOG PM2_FLIP_AFTER_SAVE PM2_JLIST_EXIT PM2_RESTARTED_JSON
  mkdir -p "$REMOTE_DIR" "$DEPLOY_LOCK_DIR"
  printf '%s\n' "$DEPLOY_LOCK_TOKEN" > "$DEPLOY_LOCK_DIR/owner"
  : > "$PM2_ACTION_LOG"

  pm2() {
    case "${1:-}" in
      jlist) command cat "$PM2_JLIST_FILE"; return "$PM2_JLIST_EXIT" ;;
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

  printf '[{"name":"%s","pid":4242,"pm2_env":{"status":"online","pm_cwd":"%s","restart_time":0}}]\n' \
    "$PM2_APP" "$REMOTE_DIR" > "$PM2_JLIST_FILE"
  PM2_FLIP_AFTER_SAVE=0
  PM2_JLIST_EXIT=55
  export PM2_FLIP_AFTER_SAVE PM2_JLIST_EXIT
  : > "$PM2_ACTION_LOG"
  if exact_pm2_pid >/dev/null; then fail 'PID capture must reject a failed PM2 snapshot producer'; fi
  if assert_exact_pm2_process 4242; then fail 'exact-process proof must reject a failed PM2 snapshot producer'; fi
  if prove_exact_pm2_stability 4242; then fail 'stability proof must reject a failed PM2 snapshot producer'; fi
  if start_exact_pm2; then fail 'post-start proof must reject a failed PM2 snapshot producer'; fi
  : > "$PM2_ACTION_LOG"
  if commit_exact_pm2 4242; then fail 'commit must reject a failed PM2 snapshot producer'; fi
  actions="$(<"$PM2_ACTION_LOG")"
  [[ "$actions" != *save* ]] || fail 'failed PM2 snapshot producer must be rejected before pm2 save'

  unset -f pm2 sleep ssh_sg exact_pm2_pid assert_exact_pm2_process
  unset -f prove_exact_pm2_stability start_exact_pm2 commit_exact_pm2
  rm -rf "$tmp"
  unset PM2_JLIST_EXIT
  echo 'ok - real PM2 predicates reject restart_time=1 and failed snapshot producers'
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
test_incident_hold_blocks_new_deploy_before_lock_or_inspection
test_stopped_recovery_requires_one_time_confirmation
test_stopped_recovery_failed_go_consumption_cleans_lock
test_stopped_recovery_baseline_rechecks_residual_owner
test_stopped_recovery_failure_stays_stopped_and_rearms_holds
test_concurrent_deploy_refuses_before_backup
test_log_verifier_rejects_old_or_forged_evidence
test_remote_javascript_quotes_survive_shell_rendering
test_pm2_dump_predicate_rejects_primary_and_backup_residue
test_pm2_restart_counter_predicates_execute_against_jlist
