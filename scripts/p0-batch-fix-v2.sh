#!/bin/bash
# P0 batch fix v2: small transactions, one psql per batch
source /Users/adelinewen/ranking-arena/.env.local
DIRECT_URL=$(echo "$DATABASE_URL" | sed 's/:6543/:5432/')

fix_batch() {
  local label="$1"
  local condition="$2"
  local set_clause="$3"
  local batch_size="${4:-500}"
  local total=0
  local fails=0

  echo "=== $label ==="
  while true; do
    output=$(psql "$DIRECT_URL" -t -A -c "
      SET statement_timeout = '60s';
      WITH batch AS (
        SELECT id FROM trader_snapshots_v2_p2026_04
        WHERE $condition LIMIT $batch_size
      )
      UPDATE trader_snapshots_v2_p2026_04 t SET $set_clause
      FROM batch b WHERE t.id = b.id;
    " 2>&1)

    if echo "$output" | grep -q "UPDATE 0"; then
      echo "  Complete. Total: $total"
      return
    fi

    n=$(echo "$output" | sed -n 's/UPDATE //p')
    if [ -z "$n" ] || [ "$n" = "0" ]; then
      # Might be an error
      if echo "$output" | grep -q "ERROR\|timeout\|connection"; then
        fails=$((fails + 1))
        if [ "$fails" -ge 5 ]; then
          echo "  FAILED after $fails errors. Total so far: $total"
          echo "  Last error: $output"
          return 1
        fi
        echo "  Retry ($fails): $(echo "$output" | grep ERROR | head -1)"
        sleep 3
        continue
      fi
      echo "  Complete. Total: $total"
      return
    fi

    fails=0
    total=$((total + n))
    if [ $((total % 2000)) -lt "$batch_size" ]; then
      echo "  Progress: $total"
    fi
  done
}

echo "P0 April partition fix — $(date)"

# Constraints were already dropped. Fix all violations.
fix_batch "Sharpe violations" \
  "sharpe_ratio IS NOT NULL AND (sharpe_ratio < -10 OR sharpe_ratio > 10)" \
  "sharpe_ratio = NULL" 500

fix_batch "ROI > 10k" \
  "roi_pct IS NOT NULL AND abs(roi_pct) > 10000" \
  "roi_pct = NULL" 500

fix_batch "MDD out of bounds" \
  "max_drawdown IS NOT NULL AND (max_drawdown < 0 OR max_drawdown > 100)" \
  "max_drawdown = NULL" 500

fix_batch "ROI ≈ PnL" \
  "roi_pct IS NOT NULL AND pnl_usd IS NOT NULL AND abs(roi_pct) > 1000 AND abs(roi_pct - pnl_usd) < 1" \
  "roi_pct = NULL" 500

echo ""
echo "=== Done at $(date) ==="
