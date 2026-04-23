#!/bin/bash
# Sync VPS proxy key from local env to VPS server.
# Run after rotating VPS_PROXY_KEY in Vercel env vars.
#
# Root cause fix: VPS proxy key and Vercel env var are two independent
# secret stores. This script syncs them. Run manually or via CI.

set -euo pipefail

VPS_HOST="root@45.76.152.169"
KEY_FILE=".env.local"

# Read key from local env
VPS_KEY=$(grep "^VPS_PROXY_KEY=" "$KEY_FILE" | head -1 | sed 's/^[^=]*=//;s/^"//;s/"$//')

if [ -z "$VPS_KEY" ]; then
  echo "❌ VPS_PROXY_KEY not found in $KEY_FILE"
  exit 1
fi

echo "Syncing VPS proxy key (${#VPS_KEY} chars)..."

# Update systemd unit
ssh -o ConnectTimeout=10 "$VPS_HOST" "
  # Update systemd Environment
  sudo sed -i 's|Environment=PROXY_KEY=.*|Environment=PROXY_KEY=$VPS_KEY|' /etc/systemd/system/arena-proxy.service
  sudo systemctl daemon-reload
  sudo systemctl restart arena-proxy
  sleep 2
  
  # Verify
  STATUS=\$(systemctl is-active arena-proxy)
  echo \"arena-proxy: \$STATUS\"
  
  # Test auth (use api.copin.io — in VPS ALLOWED_HOSTS whitelist)
  RESP=\$(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:3456/proxy \
    -H 'X-Proxy-Key: $VPS_KEY' \
    -H 'Content-Type: application/json' \
    -d '{\"url\":\"https://api.copin.io/\",\"method\":\"GET\"}')
  echo \"Proxy auth test: HTTP \$RESP\"

  if [ \"\$RESP\" = \"401\" ]; then
    echo '❌ AUTH FAILED — key mismatch'
    exit 1
  fi
  echo '✅ VPS proxy key synced and verified'
"
