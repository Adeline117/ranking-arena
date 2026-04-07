#!/bin/bash
# P0 batch fix: fix all constraint violations in April partition
# Runs 500-row batches to stay within 90s timeout

set -e
source /Users/adelinewen/ranking-arena/.env.local
DIRECT_URL=$(echo "$DATABASE_URL" | sed 's/:6543/:5432/')
BATCH=500

fix_column() {
  local label="$1"
  local condition="$2"
  local set_clause="$3"
  local total=0

  echo "=== Fixing: $label ==="
  while true; do
    result=$(psql "$DIRECT_URL" -t -c "
      SET statement_timeout = '90s';
      UPDATE trader_snapshots_v2_p2026_04
      SET $set_clause
      WHERE ctid = ANY(
        ARRAY(
          SELECT ctid FROM trader_snapshots_v2_p2026_04
          WHERE $condition
          LIMIT $BATCH
        )
      );
    " 2>&1)

    # Extract row count from "UPDATE N"
    count=$(echo "$result" | grep -oP 'UPDATE \K\d+' || echo "0")

    if [ "$count" = "0" ] || [ -z "$count" ]; then
      echo "  Done. Total: $total"
      break
    fi

    total=$((total + count))
    echo "  Batch: $count (total: $total)"
  done
}

echo "Starting P0 April partition fixes..."
echo "Timestamp: $(date)"

# 1. Sharpe ratio violations (~103k rows)
fix_column "Sharpe > 10 or < -10" \
  "sharpe_ratio IS NOT NULL AND (sharpe_ratio < -10 OR sharpe_ratio > 10)" \
  "sharpe_ratio = NULL"

# 2. ROI out of range (~6.8k rows)
fix_column "ROI > 10000 or < -10000" \
  "roi_pct IS NOT NULL AND abs(roi_pct) > 10000" \
  "roi_pct = NULL"

# 3. MDD out of bounds (~4k rows)
fix_column "MDD > 100 or < 0" \
  "max_drawdown IS NOT NULL AND (max_drawdown < 0 OR max_drawdown > 100)" \
  "max_drawdown = NULL"

# 4. ROI ≈ PnL
fix_column "ROI ≈ PnL" \
  "roi_pct IS NOT NULL AND pnl_usd IS NOT NULL AND abs(roi_pct) > 1000 AND abs(roi_pct - pnl_usd) < 1" \
  "roi_pct = NULL"

echo ""
echo "=== Verification ==="
psql "$DIRECT_URL" -c "
SET statement_timeout = '30s';
SELECT 'sharpe_bad' as issue, count(*) FROM trader_snapshots_v2_p2026_04 WHERE sharpe_ratio IS NOT NULL AND (sharpe_ratio < -10 OR sharpe_ratio > 10)
UNION ALL SELECT 'roi_bad', count(*) FROM trader_snapshots_v2_p2026_04 WHERE roi_pct IS NOT NULL AND abs(roi_pct) > 10000
UNION ALL SELECT 'mdd_bad', count(*) FROM trader_snapshots_v2_p2026_04 WHERE max_drawdown IS NOT NULL AND (max_drawdown < 0 OR max_drawdown > 100)
UNION ALL SELECT 'wr_bad', count(*) FROM trader_snapshots_v2_p2026_04 WHERE win_rate IS NOT NULL AND (win_rate < 0 OR win_rate > 100);
"

echo ""
echo "Done at $(date)"
