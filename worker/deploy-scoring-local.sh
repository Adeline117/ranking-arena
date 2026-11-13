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
#   4. success = the release's own log, from this start on, shows exactly one
#      process start, the scoring heartbeat committed to Redis, then
#      "[worker] Ready", and still exactly one start after a stability window
#      (no PM2 crash-restart); otherwise the previous release is restarted and
#      must prove the same, or the script says manual recovery is required.
#   5. one deploy at a time (lock under the release root); a release is built
#      in a staging directory and renamed into place only after the build
#      succeeds, so a failed install/build never leaves a half-built,
#      "immutable" release that blocks the retry.
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
#           ARENA_SCORING_READY_TIMEOUT_SECONDS (default 90),
#           ARENA_SCORING_STABILITY_SECONDS (default 30).

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
STABILITY_SECONDS="${ARENA_SCORING_STABILITY_SECONDS:-30}"
[[ "$STABILITY_SECONDS" =~ ^[0-9]+$ ]] || fail 'ARENA_SCORING_STABILITY_SECONDS must be an integer'
LOCK_DIR="$RELEASE_ROOT/.arena-scoring-deploy-lock"

# Local, read-only provenance checks (no fetch: the caller refreshes origin).
git cat-file -e "${TARGET_SHA}^{commit}" 2>/dev/null || fail "target $TARGET_SHA is not a local commit"
git merge-base --is-ancestor "$TARGET_SHA" origin/main 2>/dev/null || \
  fail "target $TARGET_SHA is not in origin/main"
GATE_SOURCE="$(git show "$TARGET_SHA:$GATE_FILE" 2>/dev/null)" || \
  fail "target $TARGET_SHA has no $GATE_FILE"
GATE_OPEN=0
# Only the real declaration opens the gate; a comment or string that merely
# mentions "= true" must not.
if grep -Eq '^export const V1_RANKING_COMMAND_CHAIN_PUBLISHED = true( as const)?$' <<<"$GATE_SOURCE"; then
  GATE_OPEN=1
fi

echo "[scoring-deploy] target=$TARGET_SHA app=$PM2_APP gate_open=$GATE_OPEN"
echo "[scoring-deploy] release dir: $RELEASE_DIR"
echo "[scoring-deploy] plan: lock → git archive into staging → clean-env npm ci → build worker/dist/scoring-worker.mjs → rename to release dir → pm2 start (ecosystem.local-scoring) → one start + scoring heartbeat + ready + ${STABILITY_SECONDS}s stable → current → $TARGET_SHA"

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
# package.json engines is ">=22 <23" and the artifact targets node22; the
# ingest channel pins the same major.
NODE_MAJOR="$("$NODE_BIN" -p "process.versions.node.split('.')[0]")" || \
  fail 'unable to inspect ARENA_NODE_BIN'
[ "$NODE_MAJOR" = 22 ] || fail "scoring deploy requires Node 22, got ${NODE_MAJOR:-unknown}"

STAGING_DIR=''
LOCK_HELD=0
cleanup() {
  if [ -n "$STAGING_DIR" ] && [ -d "$STAGING_DIR" ]; then
    rm -rf "$STAGING_DIR"
  fi
  if [ "$LOCK_HELD" = 1 ]; then
    rm -rf "$LOCK_DIR"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$RELEASE_ROOT"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  LOCK_OWNER="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [[ "$LOCK_OWNER" =~ ^[1-9][0-9]*$ ]] && kill -0 "$LOCK_OWNER" 2>/dev/null; then
    fail "BUSY: another scoring deploy (pid $LOCK_OWNER) holds $LOCK_DIR"
  fi
  fail "stale scoring deploy lock $LOCK_DIR (owner ${LOCK_OWNER:-unknown} is gone); inspect PM2 and the release root, then remove it by hand"
fi
LOCK_HELD=1
printf '%s\n' "$$" > "$LOCK_DIR/pid"

[ ! -e "$RELEASE_DIR" ] || fail "release directory already exists (releases are immutable): $RELEASE_DIR"

PREVIOUS_RELEASE=''
if [ -L "$CURRENT_LINK" ]; then
  PREVIOUS_RELEASE="$(readlink "$CURRENT_LINK")"
fi

# Clean, release-owned install/build environment: an inherited NODE_ENV,
# npm_config_* (e.g. omit=dev) or user ~/.npmrc must not change what is
# installed. esbuild is only a transitive dev dependency (via tsx), so
# --include=dev is required for the build step.
STAGING_DIR="$(mktemp -d "$RELEASE_ROOT/.staging-$TARGET_SHA.XXXXXX")"
INSTALL_HOME="$STAGING_DIR/.install-home"
CLEAN_PATH="$(dirname "$NODE_BIN"):/usr/bin:/bin"
git archive --format=tar "$TARGET_SHA" | tar -x -C "$STAGING_DIR"
install -m 600 "$ENV_SOURCE" "$STAGING_DIR/worker/.env"
mkdir -p "$STAGING_DIR/worker/logs" "$STAGING_DIR/worker/dist" "$INSTALL_HOME"
(cd "$STAGING_DIR" && env -i HOME="$INSTALL_HOME" PATH="$CLEAN_PATH" \
  "$NPM_BIN" ci --include=dev --ignore-scripts --no-audit --no-fund)
(cd "$STAGING_DIR" && env -i HOME="$INSTALL_HOME" PATH="$CLEAN_PATH" \
  "$NODE_BIN" "$STAGING_DIR/worker/build-scoring-worker.mjs" --outdir="$STAGING_DIR/worker/dist")
[ -f "$STAGING_DIR/worker/dist/scoring-worker.mjs" ] || fail 'build produced no scoring-worker.mjs'
rm -rf "$INSTALL_HOME"
[ ! -e "$RELEASE_DIR" ] || fail "release directory appeared during the build: $RELEASE_DIR"
mv "$STAGING_DIR" "$RELEASE_DIR"
STAGING_DIR=''

start_release() {
  local dir="$1"
  "$PM2_BIN" delete "$PM2_APP" >/dev/null 2>&1 || true
  ARENA_SCORING_RELEASE_DIR="$dir" ARENA_NODE_BIN="$NODE_BIN" \
    "$PM2_BIN" start "$dir/worker/ecosystem.local-scoring.config.cjs" --only "$PM2_APP" --update-env
}

log_size() {
  if [ -f "$1" ]; then wc -c <"$1" | tr -d ' '; else echo 0; fi
}

# Reads only the bytes appended since this start (a rolled-back release's log
# already holds old heartbeat lines). Exit 0 = ready, 1 = not yet, 2 = more
# than one process start (PM2 restarted it: crash loop).
log_verdict() {
  local log="$1" offset="$2"
  [ -f "$log" ] || return 1
  tail -c "+$((offset + 1))" "$log" | awk '
    index($0, "[worker] Arena Pipeline Worker starting") { starts++ }
    index($0, "[heartbeat] redis-hset-committed node=") { heartbeat = 1 }
    heartbeat && index($0, "[worker] Ready") { ready = 1 }
    END {
      if (starts > 1) exit 2
      exit !(starts == 1 && heartbeat && ready)
    }'
}

prove_liveness() {
  local log="$1/worker/logs/scoring-out.log" offset="$2" waited=0 verdict
  while [ "$waited" -le "$READY_TIMEOUT" ]; do
    verdict=0
    log_verdict "$log" "$offset" || verdict=$?
    [ "$verdict" != 2 ] || return 1
    if [ "$verdict" = 0 ]; then
      sleep "$STABILITY_SECONDS"
      log_verdict "$log" "$offset"
      return
    fi
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

rollback() {
  echo "[scoring-deploy] new release did not prove liveness; rolling back" >&2
  if [ -n "$PREVIOUS_RELEASE" ] && [ -d "$PREVIOUS_RELEASE" ]; then
    local offset
    offset="$(log_size "$PREVIOUS_RELEASE/worker/logs/scoring-out.log")"
    if start_release "$PREVIOUS_RELEASE" && prove_liveness "$PREVIOUS_RELEASE" "$offset"; then
      fail "scoring release $TARGET_SHA failed; previous release $PREVIOUS_RELEASE restored and live"
    fi
    "$PM2_BIN" stop "$PM2_APP" >/dev/null 2>&1 || true
    fail "scoring release $TARGET_SHA failed AND the previous release $PREVIOUS_RELEASE did not prove liveness; arena-worker stopped, manual recovery required"
  fi
  "$PM2_BIN" delete "$PM2_APP" >/dev/null 2>&1 || true
  fail "scoring release $TARGET_SHA failed; no previous release, arena-worker left stopped"
}

if ! start_release "$RELEASE_DIR" || ! prove_liveness "$RELEASE_DIR" 0; then
  rollback
fi

ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"
"$PM2_BIN" save >/dev/null 2>&1 || echo '[scoring-deploy] warning: pm2 save failed' >&2
echo "[scoring-deploy] ✓ arena-worker running $TARGET_SHA (one start, heartbeat committed, ready, stable ${STABILITY_SECONDS}s)"
