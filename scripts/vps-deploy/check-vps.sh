#!/bin/bash
# Quick VPS status check — run from local machine
#
# Usage:
#   ./check-vps.sh          # Check both VPS
#   ./check-vps.sh sg       # Check SG only
#   ./check-vps.sh jp       # Check JP only

SG_HOST="root@45.76.152.169"
JP_HOST="root@149.28.27.242"

check_vps() {
  local HOST="$1"
  local LABEL="$2"

  echo "=== $LABEL ($HOST) ==="
  echo ""

  # Check SSH connectivity
  if ! ssh -o ConnectTimeout=5 "$HOST" "echo ok" > /dev/null 2>&1; then
    echo "  UNREACHABLE"
    echo ""
    return 1
  fi

  # PM2 status
  echo "── PM2 Processes ──"
  ssh "$HOST" "pm2 ls 2>/dev/null || echo 'PM2 not installed'"
  echo ""

  # Env vars check
  echo "── Environment Variables ──"
  ssh "$HOST" "
    if [ -n \"\$SUPABASE_SERVICE_ROLE_KEY\" ]; then
      echo '  SUPABASE_SERVICE_ROLE_KEY: SET (' \$(echo \$SUPABASE_SERVICE_ROLE_KEY | head -c 8) '...)'
    else
      # Try loading from /etc/environment
      source /etc/environment 2>/dev/null
      if [ -n \"\$SUPABASE_SERVICE_ROLE_KEY\" ]; then
        echo '  SUPABASE_SERVICE_ROLE_KEY: SET in /etc/environment (' \$(echo \$SUPABASE_SERVICE_ROLE_KEY | head -c 8) '...)'
      else
        echo '  SUPABASE_SERVICE_ROLE_KEY: ❌ NOT SET'
      fi
    fi
    if [ -n \"\$TELEGRAM_BOT_TOKEN\" ]; then
      echo '  TELEGRAM_BOT_TOKEN: SET'
    else
      source /etc/environment 2>/dev/null
      [ -n \"\$TELEGRAM_BOT_TOKEN\" ] && echo '  TELEGRAM_BOT_TOKEN: SET in /etc/environment' || echo '  TELEGRAM_BOT_TOKEN: ❌ NOT SET'
    fi
  "
  echo ""

  # Scraper health
  echo "── Scraper (port 3457) ──"
  ssh "$HOST" "curl -s --max-time 5 http://localhost:3457/health 2>/dev/null || echo 'Not responding'"
  echo ""

  # Proxy health
  echo "── Proxy (port 3456) ──"
  ssh "$HOST" "curl -s --max-time 5 http://localhost:3456/health 2>/dev/null || echo 'Not responding'"
  echo ""

  # Memory / disk
  echo "── System Resources ──"
  ssh "$HOST" "
    echo '  Memory:' \$(free -h | awk '/Mem:/ {print \$3 \"/\" \$2}')
    echo '  Disk:' \$(df -h / | awk 'NR==2 {print \$3 \"/\" \$2 \" (\" \$5 \" used)\"}')
    echo '  Uptime:' \$(uptime -p 2>/dev/null || uptime)
  "
  echo ""

  # Last cron log
  echo "── Last Cron Run ──"
  ssh "$HOST" "tail -5 /opt/arena-cron/logs/cron-out.log 2>/dev/null || echo 'No cron log found'"
  echo ""
}

TARGET="${1:-all}"

case "$TARGET" in
  sg)  check_vps "$SG_HOST" "SG VPS" ;;
  jp)  check_vps "$JP_HOST" "JP VPS" ;;
  all)
    check_vps "$SG_HOST" "SG VPS"
    check_vps "$JP_HOST" "JP VPS"
    ;;
  *)
    echo "Usage: $0 [sg|jp|all]"
    exit 1
    ;;
esac
