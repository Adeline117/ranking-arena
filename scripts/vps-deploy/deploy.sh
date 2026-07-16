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
#   1. copy the scraper/proxy files under /opt/arena-cron/
#   2. scp ecosystem.config.js
#   3. reload only scraper/proxy apps, preserving ingest and unrelated PM2 apps
#   4. Verify services are running

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
INFRA_DIR="$(cd "$SCRIPT_DIR/../../infra/vps-playwright" && pwd)"

SG_HOST="root@45.76.152.169"
JP_HOST="root@149.28.27.242"
REMOTE_DIR="/opt/arena-cron"

# Files to deploy (SG gets scraper + proxy, JP gets proxy only)
SG_FILES=(
  "$SCRIPT_DIR/scraper-v16-parallel.js"
  "$SCRIPT_DIR/arena-proxy.mjs"
  "$SCRIPT_DIR/proxy-key-auth.cjs"
  "$INFRA_DIR/ecosystem.config.js"
)

JP_FILES=(
  "$SCRIPT_DIR/arena-proxy.mjs"
  "$SCRIPT_DIR/proxy-key-auth.cjs"
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
      echo "ERROR: required deploy file missing: $f" >&2
      exit 1
    fi
  done

  # Also copy scraper to /opt/scraper/ (SG only)
  if [ "$VPS_TYPE" = "sg" ]; then
    echo "  scp scraper-v16-parallel.js -> /opt/scraper/server.js"
    scp -q "$SCRIPT_DIR/scraper-v16-parallel.js" "$HOST:/opt/scraper/server.js"
    scp -q "$SCRIPT_DIR/proxy-key-auth.cjs" "$HOST:/opt/scraper/proxy-key-auth.cjs"
  fi

  # Copy arena-proxy.mjs to /opt/arena-proxy/ (both VPS)
  ssh "$HOST" "mkdir -p /opt/arena-proxy"
  echo "  scp arena-proxy.mjs -> /opt/arena-proxy/server.mjs"
  scp -q "$SCRIPT_DIR/arena-proxy.mjs" "$HOST:/opt/arena-proxy/server.mjs"
  scp -q "$SCRIPT_DIR/proxy-key-auth.cjs" "$HOST:/opt/arena-proxy/proxy-key-auth.cjs"

  # Select ecosystem config and restart PM2
  if [ "$VPS_TYPE" = "jp" ]; then
    local ECOSYSTEM="ecosystem-jp.config.js"
  else
    local ECOSYSTEM="ecosystem.config.js"
  fi

  echo "  Reloading scoped PM2 services ($ECOSYSTEM)..."
  ssh "$HOST" bash -s -- "$REMOTE_DIR" "$ECOSYSTEM" "$VPS_TYPE" <<'REMOTE_PM2'
set -euo pipefail
REMOTE_DIR="$1"
ECOSYSTEM="$2"
VPS_TYPE="$3"

set -a
source /etc/environment 2>/dev/null || true
# Rotation keys live in a root-only file, not world-readable /etc/environment.
source /etc/arena-proxy.env 2>/dev/null || true
set +a
cd "$REMOTE_DIR"

INGEST_PID_BEFORE="0"
if [ "$VPS_TYPE" = "sg" ]; then
  INGEST_PID_BEFORE="$(pm2 pid arena-ingest-worker-sg 2>/dev/null || echo 0)"
  if [ -z "$INGEST_PID_BEFORE" ] || [ "$INGEST_PID_BEFORE" = "0" ]; then
    echo "ERROR: arena-ingest-worker-sg must be online before deploy" >&2
    exit 1
  fi
  APPS=(arena-scraper arena-proxy)
else
  APPS=(arena-proxy)
fi

for app in "${APPS[@]}"; do
  pm2 startOrReload "$ECOSYSTEM" --only "$app" --update-env
done

pm2 jlist | node -e '
  let input = ""
  process.stdin.on("data", (chunk) => { input += chunk })
  process.stdin.on("end", () => {
    const type = process.argv[1]
    const names = JSON.parse(input).map((app) => app.name)
    if (names.includes("arena-cron")) {
      throw new Error("retired arena-cron is present in PM2")
    }
    if (type === "jp" && names.includes("arena-scraper")) {
      throw new Error("arena-scraper must not run on JP")
    }
  })
' "$VPS_TYPE"

SYSTEMD_ACTIVE="$(systemctl is-active arena-proxy.service 2>/dev/null || true)"
SYSTEMD_ENABLED="$(systemctl is-enabled arena-proxy.service 2>/dev/null || true)"
if [ "$SYSTEMD_ACTIVE" = "active" ] || [ "$SYSTEMD_ENABLED" = "enabled" ]; then
  echo "ERROR: arena-proxy.service must remain inactive and disabled" >&2
  exit 1
fi

if [ "$VPS_TYPE" = "sg" ]; then
  INGEST_PID_AFTER="$(pm2 pid arena-ingest-worker-sg 2>/dev/null || echo 0)"
  if [ "$INGEST_PID_AFTER" != "$INGEST_PID_BEFORE" ]; then
    echo "ERROR: scoped deploy changed arena-ingest-worker-sg PID" >&2
    exit 1
  fi
fi
pm2 save
REMOTE_PM2

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
