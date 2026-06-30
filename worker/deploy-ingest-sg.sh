#!/bin/bash
# Deploy the arena INGEST worker to the Singapore VPS (the vps_sg region node).
#
# Root cause (2026-06-29): the SG ingest worker runs from a NON-GIT rsync copy at
# /opt/arena-ingest and had drifted ~18 days / 87 ingest commits behind main, with
# no deploy automation at all — so vps_sg sources (binance/okx/bitmart/toobit +
# binance_spot) ran stale parsers and missed the staging metric-sanitization fix.
# This script is the durable, repeatable deploy path that keeps SG in sync.
#
# Usage (from project root on the Mac Mini):
#   bash worker/deploy-ingest-sg.sh --dry-run   # show what rsync would change
#   bash worker/deploy-ingest-sg.sh             # real deploy (stop→sync→npm ci→start)
#
# It is intentionally stop→sync→start to minimise scheduler split-brain
# (worker/src/ingest/queues.ts:66-85) and backs up the remote dir for rollback.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

VPS_HOST="${INGEST_SG_HOST:-root@45.76.152.169}"
REMOTE_DIR="/opt/arena-ingest"
PM2_APP="arena-ingest-worker-sg"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

SHA="$(git rev-parse HEAD)"
TS="$(date +%Y%m%d-%H%M%S)"

# Files the SG worker actually runs. Exclude box-local state (env, node_modules,
# logs, browser profiles, .git) so we never clobber secrets or the local install.
RSYNC_PATHS=(lib worker package.json package-lock.json tsconfig.json)
RSYNC_EXCLUDES=(
  --exclude '.git' --exclude '.env' --exclude 'node_modules'
  --exclude 'worker/logs' --exclude '.arena-ingest' --exclude '*.log'
)

echo "=== Deploy ingest worker → $VPS_HOST:$REMOTE_DIR (main @ ${SHA:0:9}) ==="

if [ "$DRY_RUN" = "1" ]; then
  echo "--- rsync dry-run (no changes) ---"
  rsync -azn --delete "${RSYNC_EXCLUDES[@]}" "${RSYNC_PATHS[@]}" \
    "$VPS_HOST:$REMOTE_DIR/" | sed 's/^/  /'
  echo "--- end dry-run (re-run without --dry-run to apply) ---"
  exit 0
fi

# Does package-lock differ from the remote? If so we must npm ci after sync.
LOCK_CHANGED=1
if ssh -o BatchMode=yes "$VPS_HOST" "test -f $REMOTE_DIR/package-lock.json" 2>/dev/null; then
  REMOTE_LOCK_HASH="$(ssh -o BatchMode=yes "$VPS_HOST" "sha1sum $REMOTE_DIR/package-lock.json 2>/dev/null | cut -d' ' -f1" || echo '')"
  LOCAL_LOCK_HASH="$(sha1sum package-lock.json | cut -d' ' -f1)"
  [ "$REMOTE_LOCK_HASH" = "$LOCAL_LOCK_HASH" ] && LOCK_CHANGED=0
fi
echo "package-lock changed vs remote: $([ "$LOCK_CHANGED" = 1 ] && echo YES || echo no)"

# 1. Backup remote dir for rollback.
echo "1/6 backing up remote → $REMOTE_DIR.bak-$TS"
ssh -o BatchMode=yes "$VPS_HOST" "cp -a $REMOTE_DIR $REMOTE_DIR.bak-$TS && \
  ls -d $REMOTE_DIR.bak-* 2>/dev/null | sort | head -n -3 | xargs -r rm -rf"

# 2. Stop the worker (shrinks the split-brain window during the swap).
echo "2/6 stopping $PM2_APP"
ssh -o BatchMode=yes "$VPS_HOST" "pm2 stop $PM2_APP" || true

# 3. Sync code.
echo "3/6 rsync code"
rsync -az --delete "${RSYNC_EXCLUDES[@]}" "${RSYNC_PATHS[@]}" "$VPS_HOST:$REMOTE_DIR/"

# 4. Record the deployed commit for the drift sentinel.
echo "4/6 stamp DEPLOYED_SHA=$SHA"
ssh -o BatchMode=yes "$VPS_HOST" "echo '$SHA' > $REMOTE_DIR/DEPLOYED_SHA"

# 5. Install deps only if the lock changed. NOTE: full install (NOT --omit=dev) —
# the ingest worker imports devDependencies at runtime (dotenv, tsx via npx), so
# --omit=dev crash-loops it with "Cannot find module 'dotenv'".
if [ "$LOCK_CHANGED" = "1" ]; then
  echo "5/6 npm ci (deps changed — full install incl. dotenv/tsx)"
  ssh -o BatchMode=yes "$VPS_HOST" "cd $REMOTE_DIR && npm ci"
else
  echo "5/6 npm ci skipped (lock unchanged)"
fi

# 6. Start + verify boot.
echo "6/6 starting $PM2_APP"
ssh -o BatchMode=yes "$VPS_HOST" "pm2 restart $PM2_APP --update-env || pm2 start $REMOTE_DIR/worker/ecosystem.config.cjs --only $PM2_APP"

echo "--- waiting for ready (up to 30s) ---"
if ssh -o BatchMode=yes "$VPS_HOST" "
  for i in \$(seq 1 30); do
    pm2 logs $PM2_APP --lines 50 --nostream 2>/dev/null | grep -q 'ingest-worker. ready' && { echo READY; exit 0; }
    sleep 1
  done
  exit 1
"; then
  echo "✓ deploy OK — $PM2_APP ready on ${SHA:0:9}"
  echo "  rollback if needed: ssh $VPS_HOST 'rm -rf $REMOTE_DIR && mv $REMOTE_DIR.bak-$TS $REMOTE_DIR && pm2 restart $PM2_APP'"
else
  echo "✗ $PM2_APP did not report ready — check 'pm2 logs $PM2_APP'." >&2
  echo "  rollback: ssh $VPS_HOST 'rm -rf $REMOTE_DIR && mv $REMOTE_DIR.bak-$TS $REMOTE_DIR && pm2 restart $PM2_APP'" >&2
  exit 1
fi
