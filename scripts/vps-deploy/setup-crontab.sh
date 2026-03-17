#!/bin/bash
# VPS Scraper Crontab Setup
# Adds nightly restart + health check for arena-scraper-3457
#
# Usage: sudo bash setup-crontab.sh

set -e

SCRAPER_PM2_NAME="arena-scraper-3457"
HEALTH_SCRIPT="/opt/arena-proxy/scraper-health-check.sh"

echo "=== Setting up scraper crontab ==="

# Create health check script
cat > "$HEALTH_SCRIPT" << 'HEALTHEOF'
#!/bin/bash
# Scraper health check: restart if queue > 20 or uptime > 24h

PM2_NAME="arena-scraper-3457"
MAX_QUEUE=20
MAX_UPTIME_HOURS=24

# Get scraper status via HTTP
HEALTH=$(curl -s --max-time 5 http://localhost:3457/health 2>/dev/null || echo '{}')
QUEUE=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('queueLength', d.get('queue_length', 0)))" 2>/dev/null || echo "0")

# Get uptime from pm2 (in ms)
UPTIME_MS=$(pm2 jlist 2>/dev/null | python3 -c "
import sys, json
procs = json.load(sys.stdin)
for p in procs:
    if p.get('name') == '$PM2_NAME':
        print(p.get('pm2_env', {}).get('pm_uptime', 0))
        break
else:
    print(0)
" 2>/dev/null || echo "0")

NOW_MS=$(date +%s%3N)
UPTIME_HOURS=$(( (NOW_MS - UPTIME_MS) / 3600000 ))

RESTART_REASON=""

if [ "$QUEUE" -gt "$MAX_QUEUE" ]; then
    RESTART_REASON="queue=$QUEUE (>${MAX_QUEUE})"
fi

if [ "$UPTIME_HOURS" -gt "$MAX_UPTIME_HOURS" ]; then
    if [ -n "$RESTART_REASON" ]; then
        RESTART_REASON="$RESTART_REASON + uptime=${UPTIME_HOURS}h (>${MAX_UPTIME_HOURS}h)"
    else
        RESTART_REASON="uptime=${UPTIME_HOURS}h (>${MAX_UPTIME_HOURS}h)"
    fi
fi

if [ -n "$RESTART_REASON" ]; then
    echo "$(date): Restarting $PM2_NAME — $RESTART_REASON"
    pm2 restart "$PM2_NAME"
fi
HEALTHEOF

chmod +x "$HEALTH_SCRIPT"

# Add crontab entries (idempotent — removes old entries first)
CRON_TAG="# arena-scraper-cron"
(crontab -l 2>/dev/null | grep -v "$CRON_TAG" | grep -v "scraper-health-check" | grep -v "pm2 restart $SCRAPER_PM2_NAME") | crontab -

# Append new entries
(crontab -l 2>/dev/null; cat << CRONEOF
# Nightly restart at 4 AM UTC $CRON_TAG
0 4 * * * pm2 restart $SCRAPER_PM2_NAME >> /var/log/scraper-restart.log 2>&1
# Health check every 15 min $CRON_TAG
*/15 * * * * $HEALTH_SCRIPT >> /var/log/scraper-health.log 2>&1
CRONEOF
) | crontab -

echo "Crontab updated:"
crontab -l | grep -A1 "$CRON_TAG"
echo ""
echo "=== Done ==="
echo "Health check script: $HEALTH_SCRIPT"
echo "Logs: /var/log/scraper-restart.log, /var/log/scraper-health.log"
