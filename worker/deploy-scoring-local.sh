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
#   4. success = the release's own log shows the scoring heartbeat committed
#      to Redis within the deadline; otherwise the previous release is restored.
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
#           ARENA_SCORING_READY_TIMEOUT_SECONDS (default 90).

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
READY_TIMEOUT="${ARENA_SCORING_READY_TIMEOUT_SECONDS:-90}"
[[ "$READY_TIMEOUT" =~ ^[0-9]+$ ]] || fail 'ARENA_SCORING_READY_TIMEOUT_SECONDS must be an integer'

# Local, read-only provenance checks (no fetch: the caller refreshes origin).
git cat-file -e "${TARGET_SHA}^{commit}" 2>/dev/null || fail "target $TARGET_SHA is not a local commit"
git merge-base --is-ancestor "$TARGET_SHA" origin/main 2>/dev/null || \
  fail "target $TARGET_SHA is not in origin/main"
GATE_SOURCE="$(git show "$TARGET_SHA:$GATE_FILE" 2>/dev/null)" || \
  fail "target $TARGET_SHA has no $GATE_FILE"
GATE_OPEN=0
if grep -Eq 'V1_RANKING_COMMAND_CHAIN_PUBLISHED[[:space:]]*=[[:space:]]*true' <<<"$GATE_SOURCE"; then
  GATE_OPEN=1
fi

echo "[scoring-deploy] target=$TARGET_SHA app=$PM2_APP gate_open=$GATE_OPEN"
echo "[scoring-deploy] release dir: $RELEASE_DIR"
echo "[scoring-deploy] plan: git archive → npm ci → build worker/dist/scoring-worker.mjs → pm2 start (ecosystem.local-scoring) → wait for scoring heartbeat → current → $TARGET_SHA"

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

mkdir -p "$RELEASE_ROOT"
mkdir "$RELEASE_DIR"
git archive --format=tar "$TARGET_SHA" | tar -x -C "$RELEASE_DIR"
install -m 600 "$ENV_SOURCE" "$RELEASE_DIR/worker/.env"
mkdir -p "$RELEASE_DIR/worker/logs" "$RELEASE_DIR/worker/dist"

(cd "$RELEASE_DIR" && PATH="$(dirname "$NODE_BIN"):$PATH" "$NPM_BIN" ci --ignore-scripts --no-audit --no-fund)
"$NODE_BIN" "$RELEASE_DIR/worker/build-scoring-worker.mjs" --outdir="$RELEASE_DIR/worker/dist"

start_release() {
  local dir="$1"
  "$PM2_BIN" delete "$PM2_APP" >/dev/null 2>&1 || true
  ARENA_SCORING_RELEASE_DIR="$dir" ARENA_NODE_BIN="$NODE_BIN" \
    "$PM2_BIN" start "$dir/worker/ecosystem.local-scoring.config.cjs" --only "$PM2_APP" --update-env
}

wait_for_heartbeat() {
  local log="$1/worker/logs/scoring-out.log"
  local waited=0
  while [ "$waited" -le "$READY_TIMEOUT" ]; do
    if [ -f "$log" ] && grep -q '\[heartbeat\] redis-hset-committed node=scoring@' "$log"; then
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

rollback() {
  echo "[scoring-deploy] new release did not prove liveness; rolling back" >&2
  if [ -n "$PREVIOUS_RELEASE" ] && [ -d "$PREVIOUS_RELEASE" ]; then
    start_release "$PREVIOUS_RELEASE" || echo '✗ rollback start failed — manual recovery required' >&2
  else
    "$PM2_BIN" delete "$PM2_APP" >/dev/null 2>&1 || true
    echo '[scoring-deploy] no previous release; arena-worker left stopped' >&2
  fi
}

if ! start_release "$RELEASE_DIR" || ! wait_for_heartbeat "$RELEASE_DIR"; then
  rollback
  fail "scoring release $TARGET_SHA failed; previous release ${PREVIOUS_RELEASE:-none} restored"
fi

ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"
"$PM2_BIN" save >/dev/null 2>&1 || echo '[scoring-deploy] warning: pm2 save failed' >&2
echo "[scoring-deploy] ✓ arena-worker running $TARGET_SHA (heartbeat committed)"
