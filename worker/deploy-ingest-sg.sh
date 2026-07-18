#!/bin/bash
# Deploy the arena INGEST worker to the Singapore VPS (the vps_sg region node).
#
# Root cause (2026-06-29): the SG ingest worker runs from a NON-GIT rsync copy at
# /opt/arena-ingest and had drifted ~18 days / 87 ingest commits behind main, with
# no deploy automation at all — so vps_sg sources (binance/okx/bitmart/toobit +
# binance_spot) ran stale parsers and missed the staging metric-sanitization fix.
#
# 2026-06-30 incident: a concurrent session's lock change made this script run
# `npm ci` ON THE SG BOX, which is NOT concurrency-safe and silently dropped .js
# files (bullmq/viem/esbuild/dotenv → crash-loop, SG ingestion DOWN). Recovery was
# a code+node_modules PAIR rollback, then a code-only re-sync of the dep-free
# parser fixes. This script now encodes those lessons:
#   - DEFAULT never runs `npm ci` on the box. Dep changes go through the CI
#     artifact pipeline (.github/workflows/deploy-ingest-sg.yml — builds a
#     Linux-x64 node_modules on ubuntu and ships it). Use --force-npm-ci only as a
#     last resort, knowing the hazard.
#   - --code-only syncs ONLY code (lib/worker/tsconfig), never node_modules — the
#     safe path for the common case (parser/logic fix with no new dependency).
#   - every mutating mode refuses to start PM2 while a known SG ingest container
#     is running. Stop the container first; two vps_sg consumers hide split-brain.
#   - on a failed `ready`, it AUTO-rolls-back (pair: code + node_modules together).
#
# Usage (from project root on the Mac Mini, after pushing to main):
#   bash worker/deploy-ingest-sg.sh --dry-run     # preview what rsync would change
#   bash worker/deploy-ingest-sg.sh --code-only   # sync code only (no deps) — DEFAULT-SAFE for dep-free fixes
#   bash worker/deploy-ingest-sg.sh               # full sync; REFUSES npm ci if lock changed (points to CI)
#   bash worker/deploy-ingest-sg.sh --from-artifact=PATH.tgz  # ship a CI-built node_modules + atomic swap (CI uses this)
#   bash worker/deploy-ingest-sg.sh --force-npm-ci  # last-resort: run the hazardous npm ci on the box
#
# stop→sync→start ordering minimises scheduler split-brain (worker/src/ingest/queues.ts).

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

VPS_HOST="${INGEST_SG_HOST:-root@45.76.152.169}"
REMOTE_DIR="/opt/arena-ingest"
PM2_APP="arena-ingest-worker-sg"
DEPLOY_LOCK_DIR="$REMOTE_DIR.deploy-lock"
DEPLOY_LOCK_STALE_SECONDS=900

MODE="full"
FORCE_NPM_CI=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) MODE="dry-run" ;;
    --code-only) MODE="code-only" ;;
    --force-npm-ci) FORCE_NPM_CI=1 ;;
    --from-artifact=*) FROM_ARTIFACT="${arg#*=}"; MODE="artifact" ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done
FROM_ARTIFACT="${FROM_ARTIFACT:-}"

SHA="$(git rev-parse HEAD)"
TS="$(date +%Y%m%d-%H%M%S)"
DEPLOY_LOCK_TOKEN="${SHA}-${TS}-$$-${RANDOM}"
DEPLOY_LOCK_HELD=0
DEPLOY_LOCK_RENEW_PID=""

# CODE paths only (never node_modules). package-lock is synced in full mode so the
# remote lock hash reflects intent, but deps are NEVER installed here by default.
CODE_PATHS=(lib worker tsconfig.json)
FULL_PATHS=(lib worker package.json package-lock.json tsconfig.json)
RSYNC_EXCLUDES=(
  --exclude '.git' --exclude '.env' --exclude 'node_modules'
  --exclude 'worker/logs' --exclude '.arena-ingest' --exclude '*.log'
)

ssh_sg() { ssh -o BatchMode=yes "$VPS_HOST" "$@"; }

release_deploy_lock() {
  local status=$?
  trap - EXIT INT TERM
  if [ -n "$DEPLOY_LOCK_RENEW_PID" ]; then
    kill "$DEPLOY_LOCK_RENEW_PID" 2>/dev/null || true
    wait "$DEPLOY_LOCK_RENEW_PID" 2>/dev/null || true
  fi
  if [ "$DEPLOY_LOCK_HELD" = 1 ]; then
    # Token fencing prevents an old/crashed invocation from deleting a newer
    # deploy's lease after stale-lock recovery.
    ssh_sg "if [ \"\$(cat '$DEPLOY_LOCK_DIR/owner' 2>/dev/null || true)\" = '$DEPLOY_LOCK_TOKEN' ]; then rm -rf '$DEPLOY_LOCK_DIR'; fi" \
      >/dev/null 2>&1 || true
  fi
  exit "$status"
}

acquire_deploy_lock() {
  local output
  if ! output="$(
    ssh_sg "set -eu
      lock_dir='$DEPLOY_LOCK_DIR'
      token='$DEPLOY_LOCK_TOKEN'
      stale_after='$DEPLOY_LOCK_STALE_SECONDS'
      now=\$(date +%s)
      created=0

      if mkdir \"\$lock_dir\" 2>/dev/null; then
        created=1
      else
        heartbeat=\$(
          stat -c %Y \"\$lock_dir/heartbeat\" 2>/dev/null ||
            stat -c %Y \"\$lock_dir\" 2>/dev/null ||
            echo 0
        )
        age=\$((now - heartbeat))
        if [ \"\$heartbeat\" -gt 0 ] && [ \"\$age\" -gt \"\$stale_after\" ]; then
          stale_dir=\"\$lock_dir.stale.\$token\"
          if mv \"\$lock_dir\" \"\$stale_dir\" 2>/dev/null; then
            rm -rf \"\$stale_dir\"
            mkdir \"\$lock_dir\"
            created=1
          fi
        fi
      fi

      if [ \"\$created\" -ne 1 ]; then
        owner=\$(cat \"\$lock_dir/owner\" 2>/dev/null || echo unknown)
        printf 'BUSY: SG ingest deploy lease is held by %s\\n' \"\$owner\" >&2
        exit 75
      fi

      printf '%s\\n' \"\$token\" > \"\$lock_dir/owner\"
      touch \"\$lock_dir/heartbeat\"
      printf 'LOCKED\\n'"
  )"; then
    printf '%s\n' "$output" >&2
    return 1
  fi
  [ "$output" = "LOCKED" ] || {
    echo "✗ SG deploy lease returned unexpected evidence: $output" >&2
    return 1
  }

  DEPLOY_LOCK_HELD=1
  trap release_deploy_lock EXIT INT TERM

  # Keep long artifact uploads/backups live. A crashed caller stops renewing;
  # after 15 minutes a later deploy can atomically quarantine the stale lease.
  (
    while sleep 30; do
      ssh_sg "if [ \"\$(cat '$DEPLOY_LOCK_DIR/owner' 2>/dev/null || true)\" = '$DEPLOY_LOCK_TOKEN' ]; then touch '$DEPLOY_LOCK_DIR/heartbeat'; else exit 1; fi" \
        >/dev/null 2>&1 || exit 0
    done
  ) &
  DEPLOY_LOCK_RENEW_PID=$!
}

assert_deploy_lock() {
  ssh_sg "test \"\$(cat '$DEPLOY_LOCK_DIR/owner' 2>/dev/null || true)\" = '$DEPLOY_LOCK_TOKEN'" || {
    echo "✗ Lost the SG deploy lease; refusing further remote mutation." >&2
    exit 1
  }
}

echo "=== Deploy ingest worker → $VPS_HOST:$REMOTE_DIR (main @ ${SHA:0:9}, mode=$MODE) ==="

# ── dry-run ────────────────────────────────────────────────────────────────
if [ "$MODE" = "dry-run" ]; then
  echo "--- rsync dry-run (no changes) ---"
  rsync -az --dry-run --itemize-changes --delete \
    "${RSYNC_EXCLUDES[@]}" "${FULL_PATHS[@]}" "$VPS_HOST:$REMOTE_DIR/" | sed 's/^/  /'
  echo "--- end dry-run ---"
  exit 0
fi

# ── GUARD: PM2 and Docker must never consume vps_sg together ───────────────
# Both container deployment paths include this name prefix. Check before backup,
# stop, or sync so a refused deploy has made no remote changes. A stopped
# container is safe and intentionally ignored. `docker ps` errors propagate and
# abort the deploy; inability to prove exclusivity must fail closed.
RUNNING_INGEST_CONTAINERS="$(
  ssh_sg "if command -v docker >/dev/null 2>&1; then docker ps --filter 'name=arena-ingest-worker-sg' --format '{{.Names}}'; fi"
)"
if [ -n "$RUNNING_INGEST_CONTAINERS" ]; then
  echo "✗ PM2 deploy refused: Docker ingest consumer still running on $VPS_HOST:" >&2
  printf '  %s\n' "$RUNNING_INGEST_CONTAINERS" >&2
  echo "  Stop it first, verify it is stopped, then rerun this deploy:" >&2
  echo "    ssh $VPS_HOST \"docker stop \$(docker ps -q --filter 'name=arena-ingest-worker-sg')\"" >&2
  echo "  This guard prevents two workers from consuming arena-ingest-vps_sg." >&2
  exit 1
fi

# ── lock-change detection (drives whether deps need a rebuild) ───────────────
LOCK_CHANGED=1
if ssh_sg "test -f $REMOTE_DIR/package-lock.json" 2>/dev/null; then
  REMOTE_LOCK_HASH="$(ssh_sg "sha1sum $REMOTE_DIR/package-lock.json 2>/dev/null | cut -d' ' -f1" || echo '')"
  LOCAL_LOCK_HASH="$(sha1sum package-lock.json | cut -d' ' -f1)"
  [ "$REMOTE_LOCK_HASH" = "$LOCAL_LOCK_HASH" ] && LOCK_CHANGED=0
fi
echo "package-lock changed vs remote: $([ "$LOCK_CHANGED" = 1 ] && echo YES || echo no)"

# ── GUARD: dependency changes must NOT npm-install on the box ────────────────
# The SG box's npm is not concurrency-safe and drops .js files under interruption.
# Dep changes belong in the CI artifact pipeline (ships a prebuilt Linux-x64 tree).
if [ "$MODE" = "code-only" ] && [ "$LOCK_CHANGED" = 1 ]; then
  echo "✗ --code-only refused: package-lock CHANGED → deps differ, code-only would crash-loop on a missing module." >&2
  echo "  Deploy deps via CI: gh workflow run deploy-ingest-sg.yml   (builds + ships a Linux-x64 node_modules)." >&2
  exit 1
fi
if [ "$MODE" = "full" ] && [ "$LOCK_CHANGED" = 1 ] && [ "$FORCE_NPM_CI" = 0 ]; then
  echo "✗ Refusing to npm-install on the SG box (lock changed). This is the 2026-06-30 crash-loop hazard." >&2
  echo "  → Preferred: deploy deps via CI: gh workflow run deploy-ingest-sg.yml" >&2
  echo "  → Last resort (knowing the risk): re-run with --force-npm-ci, then verify 'ready' and surgically" >&2
  echo "    repair any 'Cannot find module' package (npm pack + tar + cp). NEVER 'rm -rf node_modules'." >&2
  exit 1
fi

if [ "$MODE" = "code-only" ]; then PATHS=("${CODE_PATHS[@]}"); else PATHS=("${FULL_PATHS[@]}"); fi

# Serialize every deployment channel, including local/manual calls that are
# outside GitHub Actions' concurrency group. This must precede the first remote
# mutation (backup) and remain held through readiness or rollback.
echo "0/5 acquiring exclusive SG deploy lease"
acquire_deploy_lock
assert_deploy_lock

# 1. Backup (full dir — node_modules included — so rollback restores a consistent pair).
echo "1/5 backing up remote → $REMOTE_DIR.bak-$TS (keep last 3)"
ssh_sg "cp -a $REMOTE_DIR $REMOTE_DIR.bak-$TS && ls -d $REMOTE_DIR.bak-* 2>/dev/null | sort | head -n -3 | xargs -r rm -rf"

# 2. Graceful stop — SIGTERM lets in-flight BullMQ jobs finish (kill_timeout=30s in ecosystem).
assert_deploy_lock
echo "2/5 gracefully stopping $PM2_APP"
ssh_sg "pm2 stop $PM2_APP" || true

# 3. Sync code (+ lock in full mode). node_modules is always excluded.
assert_deploy_lock
echo "3/5 rsync ($MODE)"
rsync -az --delete "${RSYNC_EXCLUDES[@]}" "${PATHS[@]}" "$VPS_HOST:$REMOTE_DIR/"
ssh_sg "echo '$SHA' > $REMOTE_DIR/DEPLOYED_SHA"

# 4. Deps.
assert_deploy_lock
if [ "$MODE" = "artifact" ]; then
  # Ship a CI-built, platform-matched node_modules tree and swap it in atomically.
  # This is the SAFE dep-deploy path (no npm on the box → no .js-drop hazard). The
  # swap is a `mv` rename; the .bak-$TS backup preserves the old tree for rollback.
  [ -f "$FROM_ARTIFACT" ] || { echo "✗ artifact not found: $FROM_ARTIFACT" >&2; exit 1; }
  echo "4/5 shipping prebuilt deps artifact → $VPS_HOST (atomic swap, no npm on box)"
  scp -q -o BatchMode=yes "$FROM_ARTIFACT" "$VPS_HOST:/tmp/arena-ingest-deps.tgz"
  ssh_sg "set -e; cd $REMOTE_DIR
    rm -rf .nm-staging && mkdir .nm-staging
    tar -xzf /tmp/arena-ingest-deps.tgz -C .nm-staging        # → .nm-staging/node_modules
    test -d .nm-staging/node_modules
    rm -rf node_modules.old
    [ -d node_modules ] && mv node_modules node_modules.old
    mv .nm-staging/node_modules node_modules
    rm -rf node_modules.old .nm-staging /tmp/arena-ingest-deps.tgz"
elif [ "$MODE" = "full" ] && [ "$LOCK_CHANGED" = 1 ] && [ "$FORCE_NPM_CI" = 1 ]; then
  echo "4/5 ⚠️ npm ci (FORCED — hazardous on this box; full install incl. dotenv/tsx)"
  ssh_sg "cd $REMOTE_DIR && npm ci"
else
  echo "4/5 deps unchanged on box (no npm install)"
fi

# 5. Restart + verify ready, AUTO-ROLLBACK on failure.
# Ready-check evidence must be newer than this deployment. Grepping a fixed PM2
# log window can match an old "ready" line and falsely pass a broken restart.
# Append a unique marker before each restart, then require BOTH a ready line and
# the expected heartbeat SHA after that marker. 90s < BullMQ's stall window.
READY_LOG="$REMOTE_DIR/worker/logs/ingest-out.log"
READY_MARKER="arena-deploy-$TS-${SHA:0:9}"

wait_for_fresh_ready() {
  local marker="$1"
  local expected_sha="$2"
  ssh_sg "for i in \$(seq 1 90); do
    awk -v marker='$marker' -v sha='$expected_sha' '
      index(\$0, marker) { after = 1; ready = 0; heartbeat = 0; next }
      after && index(\$0, \"[ingest-worker] ready\") { ready = 1 }
      after && index(\$0, \"[heartbeat]\") && (sha == \"\" || index(\$0, \"sha=\" sha)) { heartbeat = 1 }
      END { exit !(ready && heartbeat) }
    ' '$READY_LOG' && { echo READY; exit 0; }
    sleep 1
  done
  exit 1"
}

assert_deploy_lock
ssh_sg "mkdir -p '$REMOTE_DIR/worker/logs'; printf '%s\\n' '$READY_MARKER' >> '$READY_LOG'"
echo "5/5 restarting $PM2_APP"
ssh_sg "pm2 restart $PM2_APP --update-env || pm2 start $REMOTE_DIR/worker/ecosystem.sg.config.cjs --only $PM2_APP" || true

echo "--- waiting for ready (up to 90s) ---"
if wait_for_fresh_ready "$READY_MARKER" "${SHA:0:9}"; then
  echo "✓ deploy OK — $PM2_APP ready on ${SHA:0:9}"
  echo "  (manual rollback if needed: ssh $VPS_HOST 'rm -rf $REMOTE_DIR && mv $REMOTE_DIR.bak-$TS $REMOTE_DIR && pm2 restart $PM2_APP')"
else
  echo "✗ $PM2_APP did NOT report ready — AUTO-ROLLING BACK to $REMOTE_DIR.bak-$TS (code+node_modules pair)…" >&2
  ROLLBACK_MARKER="arena-rollback-$TS"
  ssh_sg "pm2 stop $PM2_APP || true
    rm -rf $REMOTE_DIR && mv $REMOTE_DIR.bak-$TS $REMOTE_DIR
    mkdir -p '$REMOTE_DIR/worker/logs'
    printf '%s\\n' '$ROLLBACK_MARKER' >> '$READY_LOG'
    pm2 restart $PM2_APP --update-env"
  ROLLBACK_SHA="$(ssh_sg "cat '$REMOTE_DIR/DEPLOYED_SHA' 2>/dev/null | cut -c1-9" || true)"
  if wait_for_fresh_ready "$ROLLBACK_MARKER" "$ROLLBACK_SHA"; then
    echo "✓ rolled back — $PM2_APP is ready on the previous version. Investigate 'pm2 logs $PM2_APP' before retrying." >&2
  else
    echo "✗✗ ROLLBACK ALSO FAILED — SG ingestion is DOWN. Manual intervention required: 'ssh $VPS_HOST pm2 logs $PM2_APP'." >&2
  fi
  exit 1
fi
