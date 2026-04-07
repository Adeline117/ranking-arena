#!/bin/bash
# P0 batch fix v3: two-step (SELECT IDs then UPDATE by IDs)
# The subquery approach was slow because Postgres optimized it as a seq scan.
# This approach fetches IDs first (uses partial index), then updates by PK.
source /Users/adelinewen/ranking-arena/.env.local
DIRECT_URL=$(echo "$DATABASE_URL" | sed 's/:6543/:5432/')
BATCH=200

fix_twostep() {
  local label="$1"
  local condition="$2"
  local set_clause="$3"
  local total=0
  local fails=0

  echo "=== $label ==="
  while true; do
    # Step 1: Fetch IDs using partial index (fast)
    ids=$(psql "$DIRECT_URL" -t -A -c "
      SET statement_timeout = '30s';
      SELECT id FROM trader_snapshots_v2_p2026_04
      WHERE $condition LIMIT $BATCH;
    " 2>&1)

    if echo "$ids" | grep -q "ERROR"; then
      fails=$((fails + 1))
      if [ "$fails" -ge 5 ]; then
        echo "  FAILED SELECT after $fails errors"
        return 1
      fi
      sleep 2
      continue
    fi

    # Count non-empty lines
    id_count=$(echo "$ids" | grep -c '[a-f0-9]' || true)
    if [ "$id_count" = "0" ] || [ -z "$id_count" ]; then
      echo "  Complete. Total: $total"
      return 0
    fi

    # Step 2: Format IDs as SQL IN list and UPDATE
    in_list=$(echo "$ids" | grep '[a-f0-9]' | sed "s/^/'/;s/$/'/" | paste -sd, -)

    result=$(psql "$DIRECT_URL" -t -A -c "
      SET statement_timeout = '60s';
      UPDATE trader_snapshots_v2_p2026_04 SET $set_clause
      WHERE id IN ($in_list);
    " 2>&1)

    if echo "$result" | grep -q "ERROR"; then
      fails=$((fails + 1))
      if [ "$fails" -ge 5 ]; then
        echo "  FAILED UPDATE after $fails errors. Total: $total"
        return 1
      fi
      echo "  Retry ($fails): $(echo "$result" | grep ERROR | head -1)"
      sleep 2
      continue
    fi

    n=$(echo "$result" | sed -n 's/UPDATE //p')
    n=${n:-0}
    fails=0
    total=$((total + n))
    if [ $((total % 2000)) -lt "$BATCH" ] || [ "$total" -le "$BATCH" ]; then
      echo "  Progress: $total"
    fi
  done
}

echo "P0 April partition fix v3 — $(date)"

fix_twostep "Sharpe violations (~103k)" \
  "sharpe_ratio IS NOT NULL AND (sharpe_ratio < -10 OR sharpe_ratio > 10)" \
  "sharpe_ratio = NULL"

fix_twostep "ROI > 10k (~6.8k)" \
  "roi_pct IS NOT NULL AND abs(roi_pct) > 10000" \
  "roi_pct = NULL"

fix_twostep "MDD out of bounds (~4k)" \
  "max_drawdown IS NOT NULL AND (max_drawdown < 0 OR max_drawdown > 100)" \
  "max_drawdown = NULL"

fix_twostep "ROI ≈ PnL" \
  "roi_pct IS NOT NULL AND pnl_usd IS NOT NULL AND abs(roi_pct) > 1000 AND abs(roi_pct - pnl_usd) < 1" \
  "roi_pct = NULL"

echo ""
echo "=== Complete at $(date) ==="
