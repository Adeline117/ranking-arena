#!/bin/bash
# Monitor onchain enrichment progress

echo "=== Enrichment Progress Monitor ==="
echo ""

# Check running processes
echo "Running enrichment processes:"
ps aux | grep "enrich-onchain-all.mjs" | grep -v grep || echo "  No enrichment processes running"
echo ""

# Check log files
for platform in hyperliquid aevo gains gmx; do
  logfile="/tmp/enrich-${platform}-full.log"
  if [ -f "$logfile" ]; then
    echo "=== $platform (last 10 lines) ==="
    tail -10 "$logfile"
    echo ""
  fi
done

# Database status
echo "=== Current Database Status ==="
PGPASSWORD='j0qvCCZDzOHDfBka' psql -h aws-0-us-west-2.pooler.supabase.com -p 6543 -U postgres.iknktzifjdyujdccyhsv -d postgres << 'SQL'
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
