#!/bin/bash
# Deploy Arena VPS services to SG or JP VPS
#
# Usage:
#   ./deploy.sh              # Deploy to SG VPS (default)
#   ./deploy.sh sg           # Deploy to SG VPS
#   ./deploy.sh jp           # Deploy to JP VPS
#   ./deploy.sh all          # Deploy to both
#
# What it does:
#   1. scp all scraper/proxy/cron files to /opt/arena-cron/
#   2. scp ecosystem.config.js
#   3. pm2 restart all && pm2 save (on VPS)
#   4. Verify services are running

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INFRA_DIR="$(cd "$SCRIPT_DIR/../../infra/vps-playwright" && pwd)"

SG_HOST="root@45.76.152.169"
JP_HOST="root@149.28.27.242"
REMOTE_DIR="/opt/arena-cron"

# Files to deploy (SG gets everything, JP gets proxy only)
SG_FILES=(
  "$SCRIPT_DIR/scraper-v16-parallel.js"
  "$SCRIPT_DIR/scraper-cron.mjs"
  "$SCRIPT_DIR/arena-proxy.mjs"
  "$SCRIPT_DIR/scraper-exchanges.js"
  "$INFRA_DIR/ecosystem.config.js"
)

JP_FILES=(
  "$SCRIPT_DIR/arena-proxy.mjs"
  "$INFRA_DIR/ecosystem-jp.config.js"
)

deploy_to() {
  local HOST="$1"
  local LABEL="$2"
  local VPS_TYPE="$3"   # "sg" or "jp"

  echo "=== Deploying to $LABEL ($HOST) ==="

  # Ensure remote dir + logs dir exist
  ssh "$HOST" "mkdir -p $REMOTE_DIR/logs"

  # Select files based on VPS type
  if [ "$VPS_TYPE" = "jp" ]; then
    local -a DEPLOY_FILES=("${JP_FILES[@]}")
  else
    local -a DEPLOY_FILES=("${SG_FILES[@]}")
  fi

  # Copy files
  for f in "${DEPLOY_FILES[@]}"; do
    if [ -f "$f" ]; then
      echo "  scp $(basename "$f")"
      scp -q "$f" "$HOST:$REMOTE_DIR/"
    else
      echo "  SKIP $(basename "$f") (not found)"
    fi
  done

  # Also copy scraper to /opt/scraper/ if present (SG only)
  if [ "$VPS_TYPE" = "sg" ] && [ -f "$SCRIPT_DIR/scraper-v16-parallel.js" ]; then
    echo "  scp scraper-v16-parallel.js -> /opt/scraper/server.js"
    scp -q "$SCRIPT_DIR/scraper-v16-parallel.js" "$HOST:/opt/scraper/server.js"
  fi

  # Copy arena-proxy.mjs to /opt/arena-proxy/ (both VPS)
  if [ -f "$SCRIPT_DIR/arena-proxy.mjs" ]; then
    ssh "$HOST" "mkdir -p /opt/arena-proxy"
    echo "  scp arena-proxy.mjs -> /opt/arena-proxy/server.mjs"
    scp -q "$SCRIPT_DIR/arena-proxy.mjs" "$HOST:/opt/arena-proxy/server.mjs"
  fi

  # Select ecosystem config and restart PM2
  if [ "$VPS_TYPE" = "jp" ]; then
    local ECOSYSTEM="ecosystem-jp.config.js"
  else
    local ECOSYSTEM="ecosystem.config.js"
  fi

  echo "  Restarting PM2 services ($ECOSYSTEM)..."
  ssh "$HOST" "source /etc/environment 2>/dev/null && cd $REMOTE_DIR && pm2 delete all 2>/dev/null; pm2 start $ECOSYSTEM && pm2 save"

  # Wait for startup
  sleep 3

  # Verify
  echo "  Verifying..."
  ssh "$HOST" "pm2 ls"

  # Quick health check
  echo "  Health check..."
  if [ "$VPS_TYPE" = "jp" ]; then
    # JP only runs proxy
    ssh "$HOST" "
      echo 'Proxy   (3456):' \$(curl -s --max-time 5 http://localhost:3456/health 2>/dev/null | head -c 100 || echo 'starting...')
    "
  else
    ssh "$HOST" "
      echo 'Scraper (3457):' \$(curl -s --max-time 5 http://localhost:3457/health 2>/dev/null | head -c 100 || echo 'starting...')
      echo 'Proxy   (3456):' \$(curl -s --max-time 5 http://localhost:3456/health 2>/dev/null | head -c 100 || echo 'starting...')
    "
  fi

  echo ""
  echo "=== $LABEL deploy complete ==="
  echo ""
}

TARGET="${1:-sg}"

case "$TARGET" in
  sg)
    deploy_to "$SG_HOST" "SG VPS" "sg"
    ;;
  jp)
    deploy_to "$JP_HOST" "JP VPS" "jp"
    ;;
  all)
    deploy_to "$SG_HOST" "SG VPS" "sg"
    deploy_to "$JP_HOST" "JP VPS" "jp"
    ;;
  *)
    echo "Usage: $0 [sg|jp|all]"
    exit 1
    ;;
esac
