#!/bin/bash
# Write Arena env vars to /etc/environment so they persist across reboots.
# Run once on each VPS after initial setup.
#
# Usage:
#   SUPABASE_SERVICE_ROLE_KEY=xxx TELEGRAM_BOT_TOKEN=xxx TELEGRAM_ALERT_CHAT_ID=xxx ./setup-env.sh
#
# Or interactively (prompts for each value):
#   ./setup-env.sh

set -e

echo "=== Arena VPS Environment Setup ==="

# Prompt for values if not provided
if [ -z "$SUPABASE_SERVICE_ROLE_KEY" ]; then
  read -r -p "SUPABASE_SERVICE_ROLE_KEY: " SUPABASE_SERVICE_ROLE_KEY
fi
if [ -z "$TELEGRAM_BOT_TOKEN" ]; then
  read -r -p "TELEGRAM_BOT_TOKEN (optional): " TELEGRAM_BOT_TOKEN
fi
if [ -z "$TELEGRAM_ALERT_CHAT_ID" ]; then
  read -r -p "TELEGRAM_ALERT_CHAT_ID (optional): " TELEGRAM_ALERT_CHAT_ID
fi

# Validate required key
if [ -z "$SUPABASE_SERVICE_ROLE_KEY" ]; then
  echo "ERROR: SUPABASE_SERVICE_ROLE_KEY is required"
  exit 1
fi

# Write to /etc/environment (survives reboot, available to all users + PM2)
ENV_FILE="/etc/environment"

# Remove old Arena entries
grep -v 'SUPABASE_SERVICE_ROLE_KEY\|TELEGRAM_BOT_TOKEN\|TELEGRAM_ALERT_CHAT_ID' "$ENV_FILE" > /tmp/env_clean 2>/dev/null || true
cp /tmp/env_clean "$ENV_FILE"

# Append new entries
cat >> "$ENV_FILE" << EOF
SUPABASE_SERVICE_ROLE_KEY="$SUPABASE_SERVICE_ROLE_KEY"
TELEGRAM_BOT_TOKEN="$TELEGRAM_BOT_TOKEN"
TELEGRAM_ALERT_CHAT_ID="$TELEGRAM_ALERT_CHAT_ID"
EOF

echo ""
echo "Written to $ENV_FILE:"
grep -E 'SUPABASE|TELEGRAM' "$ENV_FILE" | sed 's/=.*/=***/'

# Also export for current session
export SUPABASE_SERVICE_ROLE_KEY
export TELEGRAM_BOT_TOKEN
export TELEGRAM_ALERT_CHAT_ID

# Write PM2 ecosystem env (so PM2 picks up on next restart)
ECOSYSTEM="/opt/arena-cron/ecosystem.config.js"
if [ -f "$ECOSYSTEM" ]; then
  echo ""
  echo "PM2 ecosystem config found. Restarting PM2 to pick up env..."
  cd /opt/arena-cron && pm2 restart ecosystem.config.js && pm2 save
  echo "PM2 restarted successfully."
fi

echo ""
echo "=== Done ==="
echo "Env vars will persist across reboot via /etc/environment."
echo "Verify: source /etc/environment && echo \$SUPABASE_SERVICE_ROLE_KEY | head -c 10"
