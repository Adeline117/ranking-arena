#!/bin/bash
# Sync VPS proxy key from VERCEL (source of truth) to VPS server.
#
# Root cause fix: VPS proxy key and Vercel env var were two independent
# secret stores. This script makes Vercel the single source of truth.
# Reads the actual production key via `vercel env pull`, syncs to VPS.
#
# Runs daily via Mac Mini crontab. Also run manually after key rotation.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VPS_HOST="root@45.76.152.169"
TEMP_ENV=$(mktemp)

cd "$REPO_DIR"

# Read key from Vercel (the ACTUAL production value, not local .env)
echo "Reading VPS_PROXY_KEY from Vercel production..."
vercel env pull "$TEMP_ENV" --environment production --yes >/dev/null 2>&1

VPS_KEY=$(grep "^VPS_PROXY_KEY=" "$TEMP_ENV" | sed 's/^[^=]*=//;s/^"//;s/"$//')
rm -f "$TEMP_ENV"

if [ -z "$VPS_KEY" ]; then
  echo "❌ VPS_PROXY_KEY not found in Vercel production env"
  exit 1
fi

echo "Syncing VPS proxy key (${#VPS_KEY} chars) from Vercel → VPS..."

# Check current VPS key first — skip if already matches
CURRENT_VPS_KEY=$(ssh -o ConnectTimeout=10 "$VPS_HOST" "grep 'Environment=PROXY_KEY=' /etc/systemd/system/arena-proxy.service | sed 's/.*PROXY_KEY=//'") || true

if [ "$CURRENT_VPS_KEY" = "$VPS_KEY" ]; then
  echo "✅ VPS key already matches Vercel — no sync needed"
  exit 0
fi

echo "Key mismatch detected. VPS has: ${CURRENT_VPS_KEY:0:10}... Vercel has: ${VPS_KEY:0:10}..."

# Update VPS
ssh -o ConnectTimeout=10 "$VPS_HOST" "
  sed -i 's|Environment=PROXY_KEY=.*|Environment=PROXY_KEY=$VPS_KEY|' /etc/systemd/system/arena-proxy.service
  systemctl daemon-reload
  systemctl restart arena-proxy
  sleep 2
  STATUS=\$(systemctl is-active arena-proxy)
  echo \"arena-proxy: \$STATUS\"

  RESP=\$(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:3456/proxy \
    -H 'X-Proxy-Key: $VPS_KEY' \
    -H 'Content-Type: application/json' \
    -d '{\"url\":\"https://api.copin.io/\",\"method\":\"GET\"}')
  echo \"Auth test: HTTP \$RESP\"

  if [ \"\$RESP\" = \"401\" ]; then
    echo '❌ AUTH FAILED after sync'
    exit 1
  fi
  echo '✅ VPS proxy key synced from Vercel and verified'
"
