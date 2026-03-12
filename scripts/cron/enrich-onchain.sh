#!/bin/bash
# Cron job for onchain trader enrichment
# Run every 6 hours to keep data fresh
# Add to crontab: 0 */6 * * * /opt/arena/scripts/cron/enrich-onchain.sh

set -e

cd ~/arena || cd /opt/arena

# Log file
LOGFILE="/tmp/cron-enrich-onchain-$(date +%Y%m%d-%H%M).log"

echo "Starting onchain enrichment at $(date)" | tee -a "$LOGFILE"

# Run enrichment for each platform with rate limiting
for platform in hyperliquid aevo gains gmx dydx drift jupiter_perps; do
  echo "=== Enriching $platform ===" | tee -a "$LOGFILE"
  
  node scripts/enrich-onchain-all.mjs --platform="$platform" --batch=200 2>&1 | tee -a "$LOGFILE"
  
  # Cool down between platforms
  echo "Sleeping 30s before next platform..." | tee -a "$LOGFILE"
  sleep 30
done

echo "Enrichment complete at $(date)" | tee -a "$LOGFILE"

# Clean up old logs (keep last 7 days)
find /tmp -name "cron-enrich-onchain-*.log" -mtime +7 -delete

# Send summary to monitoring (optional)
PGPASSWORD='j0qvCCZDzOHDfBka' psql -h aws-0-us-west-2.pooler.supabase.com -p 6543 -U postgres.iknktzifjdyujdccyhsv -d postgres << 'SQL' | tee -a "$LOGFILE"
SELECT 
  source,
  COUNT(*) as total,
  COUNT(*) FILTER (WHERE win_rate IS NULL) as wr_null,
  COUNT(*) FILTER (WHERE max_drawdown IS NULL) as mdd_null,
  ROUND(COUNT(*) FILTER (WHERE win_rate IS NULL)::numeric / COUNT(*) * 100, 1) as wr_pct,
  ROUND(COUNT(*) FILTER (WHERE max_drawdown IS NULL)::numeric / COUNT(*) * 100, 1) as mdd_pct
FROM leaderboard_ranks
WHERE source IN ('hyperliquid', 'dydx', 'aevo', 'drift', 'jupiter_perps', 'gains', 'gmx')
GROUP BY source
ORDER BY total DESC;
SQL

echo "Log saved to: $LOGFILE"
