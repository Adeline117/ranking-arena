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

bash -n "$DEPLOY_SCRIPT" "$DOCKER_SCRIPT" "$0"
test_dry_run_itemizes_changes
test_running_container_refuses_pm2_deploy
test_docker_inspection_failure_aborts_deploy
test_stable_docker_node_identity
test_running_pm2_refuses_docker_deploy
