#!/usr/bin/env bash
# Offline contract tests for the SG deploy safety rails. External commands are
# replaced with exported Bash functions; no SSH, rsync, Docker, or remote writes.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEPLOY_SCRIPT="$ROOT/worker/deploy-ingest-sg.sh"
DOCKER_SCRIPT="$ROOT/worker/docker-run-sg.sh"
COMPOSE_FILE="$ROOT/worker/docker-compose.sg.yml"

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

test_dry_run_itemizes_changes() {
  git() { printf '%s\n' '0123456789abcdef0123456789abcdef01234567'; }
  date() { printf '%s\n' '20260715-120000'; }
  rsync() { printf 'RSYNC_ARGS %s\n' "$*"; }
  export -f git date rsync

  local output
  output="$(INGEST_SG_HOST=test@sg bash "$DEPLOY_SCRIPT" --dry-run 2>&1)"
  assert_contains "$output" '--dry-run' 'dry-run must pass rsync dry-run mode'
  assert_contains "$output" '--itemize-changes' 'dry-run must itemize file changes'
  echo 'ok - dry-run itemizes rsync changes'
}

test_running_container_refuses_pm2_deploy() {
  git() { printf '%s\n' '0123456789abcdef0123456789abcdef01234567'; }
  date() { printf '%s\n' '20260715-120000'; }
  ssh() {
    if [[ "$*" == *'docker ps'*'--format'* ]]; then
      printf '%s\n' 'arena-ingest-worker-sg-ctr'
      return 0
    fi
    fail "unexpected SSH after container guard: $*"
  }
  export -f git date ssh fail

  local output status
  set +e
  output="$(INGEST_SG_HOST=test@sg bash "$DEPLOY_SCRIPT" --code-only 2>&1)"
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
  git() { printf '%s\n' '0123456789abcdef0123456789abcdef01234567'; }
  date() { printf '%s\n' '20260715-120000'; }
  ssh() {
    if [[ "$*" == *'docker ps'*'--format'* ]]; then
      return 23
    fi
    fail "unexpected SSH after failed Docker inspection: $*"
  }
  export -f git date ssh fail

  local output status
  set +e
  output="$(INGEST_SG_HOST=test@sg bash "$DEPLOY_SCRIPT" --code-only 2>&1)"
  status=$?
  set -e
  [[ "$status" -ne 0 ]] || fail 'failed Docker inspection must abort the deploy'
  [[ "$output" != *'backing up remote'* ]] || fail 'inspection failure must precede backup'
  [[ "$output" != *'gracefully stopping'* ]] || fail 'inspection failure must precede PM2 stop'
  echo 'ok - Docker inspection failure aborts deploy before mutation'
}

test_concurrent_deploy_refuses_before_backup() {
  git() { printf '%s\n' '0123456789abcdef0123456789abcdef01234567'; }
  date() { printf '%s\n' '20260715-120000'; }
  sha1sum() { printf '%s  %s\n' 'same-lock-hash' "${1:-file}"; }
  ssh() {
    if [[ "$*" == *'docker ps'*'--format'* ]]; then
      return 0
    fi
    if [[ "$*" == *'test -f /opt/arena-ingest/package-lock.json'* ]]; then
      return 0
    fi
    if [[ "$*" == *'sha1sum /opt/arena-ingest/package-lock.json'* ]]; then
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
  output="$(INGEST_SG_HOST=test@sg bash "$DEPLOY_SCRIPT" --code-only 2>&1)"
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
  assert_contains "$deploy" '= '\''$DEPLOY_LOCK_TOKEN'\'' ]; then rm -rf' \
    'lease cleanup must be token fenced'
  [[ "${deploy%%1/5 backing up remote*}" == *'acquire_deploy_lock'* ]] || \
    fail 'deploy lease must be acquired before backup'
  echo 'ok - deploy lease is token-fenced with bounded stale recovery'
}

test_stable_docker_node_identity() {
  local docker_script compose
  docker_script="$(<"$DOCKER_SCRIPT")"
  compose="$(<"$COMPOSE_FILE")"
  assert_contains "$docker_script" 'WORKER_NODE_ID="${INGEST_WORKER_NODE_ID:-vps-sg-docker}"' \
    'docker runner must define a stable default node id'
  assert_contains "$docker_script" '-e WORKER_NODE_ID="${WORKER_NODE_ID}"' \
    'docker runner must override env-file node id explicitly'
  assert_contains "$compose" 'WORKER_NODE_ID: vps-sg-docker' \
    'compose path must use the same stable logical node id'
  echo 'ok - Docker deployment paths use a stable heartbeat identity'
}

test_running_pm2_refuses_docker_deploy() {
  pm2() {
    [[ "${1:-}" == 'pid' ]] || fail "unexpected PM2 call before cutover guard: $*"
    printf '%s\n' '4242'
  }
  docker() { fail "Docker must not run while PM2 is online: $*"; }
  export -f pm2 docker fail

  local output status
  set +e
  output="$(bash "$DOCKER_SCRIPT" deploy latest 2>&1)"
  status=$?
  set -e
  [[ "$status" -ne 0 ]] || fail 'online PM2 worker must block Docker deploy'
  assert_contains "$output" 'Docker deploy refused' 'guard must explain Docker refusal'
  assert_contains "$output" 'pid=4242' 'guard must surface the conflicting PM2 pid'
  echo 'ok - running PM2 consumer blocks Docker deploy before mutation'
}

test_ready_check_requires_fresh_sha_evidence() {
  local deploy
  deploy="$(<"$DEPLOY_SCRIPT")"
  assert_contains "$deploy" 'READY_MARKER="arena-deploy-' \
    'PM2 deploy must create a unique readiness marker'
  assert_contains "$deploy" 'index(\$0, marker) { after = 1; ready = 0; heartbeat = 0; next }' \
    'readiness must ignore log lines before the deployment marker'
  assert_contains "$deploy" 'index(\$0, \"sha=\" sha)' \
    'readiness must require the expected deployed heartbeat SHA'
  [[ "${deploy%%ssh_sg \"pm2 restart*}" == *'printf '\''%s\\n'\'' '\''$READY_MARKER'\'''* ]] || \
    fail 'deployment marker must be written before PM2 restart'
  [[ "$deploy" != *"pm2 logs \$PM2_APP --lines 400"* ]] || \
    fail 'readiness must not pass on an old line from a fixed PM2 log window'
  echo 'ok - PM2 readiness requires fresh post-marker SHA evidence'
}

bash -n "$DEPLOY_SCRIPT" "$DOCKER_SCRIPT" "$0"
test_dry_run_itemizes_changes
test_running_container_refuses_pm2_deploy
test_docker_inspection_failure_aborts_deploy
test_concurrent_deploy_refuses_before_backup
test_deploy_lease_is_fenced_and_recoverable
test_stable_docker_node_identity
test_running_pm2_refuses_docker_deploy
test_ready_check_requires_fresh_sha_evidence
