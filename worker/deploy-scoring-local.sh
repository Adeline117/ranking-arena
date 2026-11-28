#!/usr/bin/env bash
# Controlled local release channel for the scoring process (`arena-worker`).
#
# WHY (2026-11 audit P1-3): arena-worker is the only writer of the public
# leaderboard, yet it only existed in the legacy worker/ecosystem.config.cjs
# (`npx tsx worker/src/index.ts` from the SHARED working tree: whatever HEAD
# the shared checkout happened to be on, no pinned release, no rollback).
# This script is the scoring counterpart of deploy-ingest-local.sh:
#   1. the target must be an exact 40-hex commit already in origin/main;
#   2. the release is materialized with `git archive` into its own immutable
#      directory  <ARENA_SCORING_RELEASE_ROOT>/<sha>  (never the dirty tree);
#   3. dependencies come from that commit's lockfile; the worker is built into
#      one artifact (worker/build-scoring-worker.mjs) and PM2 runs it with an
#      explicit Node binary (worker/ecosystem.local-scoring.config.cjs);
#   4. the candidate must pass the worker's own startup gate (database release
#      contract) BEFORE the running process is touched; a failed preflight
#      changes nothing;
#   5. success = the release's log shows a scoring heartbeat committed to Redis
#      AFTER this start's stamp, and the same pid then stays up; otherwise the
#      previous release is restored and held to the same proof.
#
# V1 NO-GO: a real (non --dry-run) run REFUSES unless the target commit itself
# sets V1_RANKING_COMMAND_CHAIN_PUBLISHED = true. During the V1 suspension no
# agent or automation may run this script for real; only --dry-run (read-only:
# no file written, PM2 untouched) is allowed. Reopening needs a separate owner
# release plan (docs/RELEASE.md).
#
# Usage:
#   ARENA_NODE_BIN=/abs/node22 \
#     bash worker/deploy-scoring-local.sh --target-sha=<40hex> --dry-run
#   ARENA_NODE_BIN=/abs/node22 ARENA_SCORING_ENV_FILE=/abs/worker.env \
#     bash worker/deploy-scoring-local.sh --target-sha=<40hex>
#
# Optional: ARENA_SCORING_RELEASE_ROOT (default $HOME/arena-releases/scoring),
#           ARENA_PM2_BIN (default: pm2 on PATH),
#           ARENA_SCORING_READY_TIMEOUT_SECONDS (default 150; must exceed the
#           startup gate's own budget),
#           ARENA_SCORING_STABLE_SECONDS (default 15: the pid must not change
#           for this long after the heartbeat).

set -Eeuo pipefail
umask 077

SCRIPT_SOURCE_DIR="$(cd "$(dirname "$0")" && pwd -P)"
REPO_DIR="$(cd "$SCRIPT_SOURCE_DIR/.." && pwd -P)"
cd "$REPO_DIR"

PM2_APP='arena-worker'
GATE_FILE='lib/cron/v1-ranking-command-chain-publication.ts'
TARGET_SHA=''
DRY_RUN=0

fail() {
  echo "✗ $*" >&2
  exit 1
}

for arg in "$@"; do
  case "$arg" in
    --target-sha=*) TARGET_SHA="${arg#*=}" ;;
    --dry-run) DRY_RUN=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if [[ ! "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo '✗ --target-sha must be exactly 40 lowercase hexadecimal characters' >&2
  exit 2
fi

NODE_BIN="${ARENA_NODE_BIN:-}"
[ -n "$NODE_BIN" ] || fail 'ARENA_NODE_BIN is required'
[[ "$NODE_BIN" = /* ]] || fail 'ARENA_NODE_BIN must be an absolute path'
[ -f "$NODE_BIN" ] && [ ! -L "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || \
  fail 'ARENA_NODE_BIN must be an executable regular file'
NPM_BIN="$(dirname "$NODE_BIN")/npm"

RELEASE_ROOT="${ARENA_SCORING_RELEASE_ROOT:-$HOME/arena-releases/scoring}"
[[ "$RELEASE_ROOT" = /* ]] || fail 'ARENA_SCORING_RELEASE_ROOT must be an absolute path'
RELEASE_DIR="$RELEASE_ROOT/$TARGET_SHA"
CURRENT_LINK="$RELEASE_ROOT/current"
PM2_BIN="${ARENA_PM2_BIN:-pm2}"
# The worker's startup gate may itself take up to 100 s (readiness RPC budget,
# worker/src/ingest/metric-trust-readiness.ts); waiting less than that would
# roll back a healthy release whose gate is merely slow. 100 s gate + 10 s
# connection timeout + start-up margin. scripts/qa/local-scoring-deploy.test.mjs
# fails if this default drops below the gate's budget.
READY_TIMEOUT="${ARENA_SCORING_READY_TIMEOUT_SECONDS:-150}"
[[ "$READY_TIMEOUT" =~ ^[0-9]+$ ]] || fail 'ARENA_SCORING_READY_TIMEOUT_SECONDS must be an integer'
STABLE_SECONDS="${ARENA_SCORING_STABLE_SECONDS:-15}"
[[ "$STABLE_SECONDS" =~ ^[0-9]+$ ]] || fail 'ARENA_SCORING_STABLE_SECONDS must be an integer'

# Local, read-only provenance checks (no fetch: the caller refreshes origin).
git cat-file -e "${TARGET_SHA}^{commit}" 2>/dev/null || fail "target $TARGET_SHA is not a local commit"
git merge-base --is-ancestor "$TARGET_SHA" origin/main 2>/dev/null || \
  fail "target $TARGET_SHA is not in origin/main"
GATE_SOURCE="$(git show "$TARGET_SHA:$GATE_FILE" 2>/dev/null)" || \
  fail "target $TARGET_SHA has no $GATE_FILE"
GATE_OPEN=0
if grep -Eq '^export const V1_RANKING_COMMAND_CHAIN_PUBLISHED[[:space:]]*=[[:space:]]*true([^[:alnum:]_]|$)' <<<"$GATE_SOURCE"; then
  GATE_OPEN=1
fi

echo "[scoring-deploy] target=$TARGET_SHA app=$PM2_APP gate_open=$GATE_OPEN"
echo "[scoring-deploy] release dir: $RELEASE_DIR"
echo "[scoring-deploy] plan: git archive → npm ci → build worker/dist/scoring-worker.mjs → database preflight → pm2 start (ecosystem.local-scoring) → wait for scoring heartbeat → current → $TARGET_SHA"

if [ "$DRY_RUN" = 1 ]; then
  echo '[scoring-deploy] dry-run: no files written, PM2 untouched'
  exit 0
fi

[ "$GATE_OPEN" = 1 ] || \
  fail "V1 ranking command chain is not published at $TARGET_SHA; scoring deploy is suspended (dry-run only)"

ENV_SOURCE="${ARENA_SCORING_ENV_FILE:-}"
[ -n "$ENV_SOURCE" ] && [[ "$ENV_SOURCE" = /* ]] && [ -f "$ENV_SOURCE" ] || \
  fail 'ARENA_SCORING_ENV_FILE must be an absolute path to an existing file'
[ -x "$NPM_BIN" ] || fail "npm not found next to ARENA_NODE_BIN: $NPM_BIN"
[ ! -e "$RELEASE_DIR" ] || fail "release directory already exists (releases are immutable): $RELEASE_DIR"

PREVIOUS_RELEASE=''
if [ -L "$CURRENT_LINK" ]; then
  PREVIOUS_RELEASE="$(readlink "$CURRENT_LINK")"
fi

# Build in a staging dir so a failed npm ci/build never occupies the immutable
# release name (which would refuse every retry of this sha).
mkdir -p "$RELEASE_ROOT"
STAGE_DIR="$RELEASE_ROOT/.staging-$TARGET_SHA-$$"
trap 'rm -rf "$STAGE_DIR"' EXIT
mkdir "$STAGE_DIR"
git archive --format=tar "$TARGET_SHA" | tar -x -C "$STAGE_DIR"
install -m 600 "$ENV_SOURCE" "$STAGE_DIR/worker/.env"
mkdir -p "$STAGE_DIR/worker/logs" "$STAGE_DIR/worker/dist"

(cd "$STAGE_DIR" && PATH="$(dirname "$NODE_BIN"):$PATH" "$NPM_BIN" ci --ignore-scripts --no-audit --no-fund)
"$NODE_BIN" "$STAGE_DIR/worker/build-scoring-worker.mjs" --outdir="$STAGE_DIR/worker/dist"

# Prove the candidate can pass the worker's startup gate BEFORE the running
# process is touched (same order as deploy-ingest-local.sh step 5/8). On
# 2026-11-26 the database was unreachable; the deploy deleted the healthy
# process first, then neither the new release nor the rollback could start.
# A failure here leaves arena-worker exactly as it was and frees the sha.
echo '[scoring-deploy] proving the database release contract before touching PM2'
"$NODE_BIN" "$STAGE_DIR/worker/dist/scoring-preflight.mjs" || \
  fail 'scoring preflight failed; arena-worker was not touched (see the line above for the cause)'

mv "$STAGE_DIR" "$RELEASE_DIR"
trap - EXIT

HEARTBEAT_LINE='[heartbeat] redis-hset-committed node=scoring@'
LIVENESS_MARKER=''

# Start a release and stamp its log first. Only a heartbeat line written AFTER
# this stamp proves this start: a rolled-back release keeps the log of its
# earlier life, and a heartbeat left there would "prove" a process that is
# crash-looping (2026-11-26: only a midnight log rotation kept the rollback
# from being reported as restored). Same idea as deploy-ingest-local.sh's
# rollback marker.
start_release() {
  local dir="$1"
  local log="$dir/worker/logs/scoring-out.log"
  "$PM2_BIN" delete "$PM2_APP" >/dev/null 2>&1 || true
  LIVENESS_MARKER="arena-scoring-deploy-$(date +%s)-$$-$RANDOM"
  mkdir -p "$dir/worker/logs"
  printf '%s\n' "$LIVENESS_MARKER" >> "$log"
  ARENA_SCORING_RELEASE_DIR="$dir" ARENA_NODE_BIN="$NODE_BIN" \
    "$PM2_BIN" start "$dir/worker/ecosystem.local-scoring.config.cjs" --only "$PM2_APP" --update-env
}

live_pid() {
  local pid
  pid="$("$PM2_BIN" pid "$PM2_APP" 2>/dev/null)" || return 1
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  printf '%s' "$pid"
}

heartbeat_after_marker() {
  # Fixed-string matching: no regular expression is built from the marker.
  awk -v marker="$LIVENESS_MARKER" -v heartbeat="$HEARTBEAT_LINE" '
    $0 == marker { stamped = 1; next }
    stamped && index($0, heartbeat) > 0 { proven = 1 }
    END { exit proven ? 0 : 1 }
  ' "$1"
}

# Liveness = a heartbeat after this start's stamp, then the SAME pid for
# STABLE_SECONDS. A worker that fails its startup gate lives about ten seconds
# per restart, so one "pid exists" sample is not evidence.
wait_for_heartbeat() {
  local log="$1/worker/logs/scoring-out.log"
  local waited=0 pid='' stable=0 current=''
  [ -n "$LIVENESS_MARKER" ] || return 1
  while [ "$waited" -le "$READY_TIMEOUT" ]; do
    if [ -f "$log" ] && heartbeat_after_marker "$log" && pid="$(live_pid)"; then
      while [ "$stable" -lt "$STABLE_SECONDS" ]; do
        sleep 1
        stable=$((stable + 1))
        current="$(live_pid)" || return 1
        [ "$current" = "$pid" ] || return 1
      done
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

ROLLBACK_OUTCOME=''
rollback() {
  echo "[scoring-deploy] new release did not prove liveness; rolling back" >&2
  if [ -n "$PREVIOUS_RELEASE" ] && [ -d "$PREVIOUS_RELEASE" ]; then
    if start_release "$PREVIOUS_RELEASE" && wait_for_heartbeat "$PREVIOUS_RELEASE"; then
      ROLLBACK_OUTCOME="previous release $PREVIOUS_RELEASE restored"
    else
      ROLLBACK_OUTCOME="rollback to $PREVIOUS_RELEASE FAILED — manual recovery required"
    fi
  else
    "$PM2_BIN" delete "$PM2_APP" >/dev/null 2>&1 || true
    ROLLBACK_OUTCOME='no previous release; arena-worker left stopped'
  fi
}

if ! start_release "$RELEASE_DIR" || ! wait_for_heartbeat "$RELEASE_DIR"; then
  rollback
  fail "scoring release $TARGET_SHA failed; $ROLLBACK_OUTCOME"
fi

ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"
"$PM2_BIN" save >/dev/null 2>&1 || echo '[scoring-deploy] warning: pm2 save failed' >&2
echo "[scoring-deploy] ✓ arena-worker running $TARGET_SHA (heartbeat committed)"
