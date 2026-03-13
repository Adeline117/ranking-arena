#!/bin/bash
# Mac Mini Arena Cron - Health monitoring and maintenance
# Run via launchd or manually for system health checks

set -e

cd /Users/adelinewen/ranking-arena

LOG_FILE="/tmp/mac-mini-cron-$(date +%Y%m%d-%H%M).log"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

log "==========================================="
log "Mac Mini Arena Health Check Starting"
log "==========================================="

# 1. Check data freshness
log "📊 Checking data freshness..."
node scripts/pipeline-health-check.mjs --quick >> "$LOG_FILE" 2>&1 || true

# 2. Clean up old logs
log "🧹 Cleaning old cron logs..."
find /tmp -name "mac-mini-cron-*.log" -mtime +7 -delete 2>/dev/null || true
find /tmp -name "cron-*.log" -mtime +7 -delete 2>/dev/null || true

# 3. Monitor disk space
DISK_USAGE=$(df -h / | awk 'NR==2 {print $5}' | sed 's/%//')
log "💾 Disk usage: ${DISK_USAGE}%"
if [ "$DISK_USAGE" -gt 85 ]; then
  log "⚠️  WARNING: Disk usage above 85%"
fi

# 4. Check critical processes
log "🔍 Checking critical processes..."
RUNNING_PROCS=$(ps aux | grep -E "blofin-scraper|daily-checkpoint" | grep -v grep | wc -l)
log "   Running processes: $RUNNING_PROCS"

log "==========================================="
log "Health check complete"
log "Log: $LOG_FILE"
log "==========================================="
