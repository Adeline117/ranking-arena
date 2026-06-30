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

# CODE paths only (never node_modules). package-lock is synced in full mode so the
# remote lock hash reflects intent, but deps are NEVER installed here by default.
CODE_PATHS=(lib worker tsconfig.json)
FULL_PATHS=(lib worker package.json package-lock.json tsconfig.json)
RSYNC_EXCLUDES=(
  --exclude '.git' --exclude '.env' --exclude 'node_modules'
  --exclude 'worker/logs' --exclude '.arena-ingest' --exclude '*.log'
)

ssh_sg() { ssh -o BatchMode=yes "$VPS_HOST" "$@"; }

echo "=== Deploy ingest worker → $VPS_HOST:$REMOTE_DIR (main @ ${SHA:0:9}, mode=$MODE) ==="

# ── dry-run ────────────────────────────────────────────────────────────────
if [ "$MODE" = "dry-run" ]; then
  echo "--- rsync dry-run (no changes) ---"
  rsync -azn --delete "${RSYNC_EXCLUDES[@]}" "${FULL_PATHS[@]}" "$VPS_HOST:$REMOTE_DIR/" | sed 's/^/  /'
  echo "--- end dry-run ---"
  exit 0
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

# 1. Backup (full dir — node_modules included — so rollback restores a consistent pair).
echo "1/5 backing up remote → $REMOTE_DIR.bak-$TS (keep last 3)"
ssh_sg "cp -a $REMOTE_DIR $REMOTE_DIR.bak-$TS && ls -d $REMOTE_DIR.bak-* 2>/dev/null | sort | head -n -3 | xargs -r rm -rf"

# 2. Graceful stop — SIGTERM lets in-flight BullMQ jobs finish (kill_timeout=30s in ecosystem).
echo "2/5 gracefully stopping $PM2_APP"
ssh_sg "pm2 stop $PM2_APP" || true

# 3. Sync code (+ lock in full mode). node_modules is always excluded.
echo "3/5 rsync ($MODE)"
rsync -az --delete "${RSYNC_EXCLUDES[@]}" "${PATHS[@]}" "$VPS_HOST:$REMOTE_DIR/"
ssh_sg "echo '$SHA' > $REMOTE_DIR/DEPLOYED_SHA"

# 4. Deps.
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
echo "5/5 restarting $PM2_APP"
ssh_sg "pm2 restart $PM2_APP --update-env || pm2 start $REMOTE_DIR/worker/ecosystem.sg.config.cjs --only $PM2_APP" || true

echo "--- waiting for ready (up to 30s) ---"
if ssh_sg "for i in \$(seq 1 30); do pm2 logs $PM2_APP --lines 50 --nostream 2>/dev/null | grep -q 'ingest-worker. ready' && { echo READY; exit 0; }; sleep 1; done; exit 1"; then
  echo "✓ deploy OK — $PM2_APP ready on ${SHA:0:9}"
  echo "  (manual rollback if needed: ssh $VPS_HOST 'rm -rf $REMOTE_DIR && mv $REMOTE_DIR.bak-$TS $REMOTE_DIR && pm2 restart $PM2_APP')"
else
  echo "✗ $PM2_APP did NOT report ready — AUTO-ROLLING BACK to $REMOTE_DIR.bak-$TS (code+node_modules pair)…" >&2
  ssh_sg "pm2 stop $PM2_APP || true; rm -rf $REMOTE_DIR && mv $REMOTE_DIR.bak-$TS $REMOTE_DIR && pm2 restart $PM2_APP --update-env"
  if ssh_sg "for i in \$(seq 1 30); do pm2 logs $PM2_APP --lines 50 --nostream 2>/dev/null | grep -q 'ingest-worker. ready' && exit 0; sleep 1; done; exit 1"; then
    echo "✓ rolled back — $PM2_APP is ready on the previous version. Investigate 'pm2 logs $PM2_APP' before retrying." >&2
  else
    echo "✗✗ ROLLBACK ALSO FAILED — SG ingestion is DOWN. Manual intervention required: 'ssh $VPS_HOST pm2 logs $PM2_APP'." >&2
  fi
  exit 1
fi
