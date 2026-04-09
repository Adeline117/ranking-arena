#!/bin/bash
# Post-Cleanup Orchestration Script
# Run after cleanup-violations cron returns {"done": true}
#
# Steps:
# 1. Verify cleanup is complete
# 2. VALIDATE CONSTRAINT (8 constraints)
# 3. Trigger compute-derived-metrics recomputation
# 4. Run backfill-all-metrics
# 5. Trigger composite recomputation
# 6. Reduce cleanup cron frequency

set -e
source /Users/adelinewen/ranking-arena/.env.local
DIRECT_URL=$(echo "$DATABASE_URL" | sed 's/:6543/:5432/')

echo "=== Post-Cleanup Orchestration ==="
echo "Started: $(date)"

# Step 1: Verify cleanup complete
echo ""
echo "--- Step 1: Verify cleanup complete ---"
result=$(curl -s --max-time 55 -H "Authorization: Bearer ${CRON_SECRET}" "https://www.arenafi.org/api/cron/cleanup-violations")
if echo "$result" | grep -q '"done":true'; then
  echo "✅ Cleanup complete"
else
  echo "❌ Cleanup not complete yet: $result"
  echo "Re-run this script after cleanup finishes."
  exit 1
fi

# Step 2: VALIDATE CONSTRAINT
echo ""
echo "--- Step 2: VALIDATE CONSTRAINT (8 constraints) ---"
echo "This may take 5-20 minutes per constraint..."
constraints=(
  "chk_v2_roi_pct"
  "chk_v2_sharpe_ratio"
  "chk_v2_max_drawdown"
  "chk_v2_win_rate"
  "chk_v2_arena_score"
  "chk_v2_followers"
  "chk_v2_copiers"
  "chk_v2_trades_count"
)
for c in "${constraints[@]}"; do
  echo -n "  VALIDATE $c... "
  psql "$DIRECT_URL" -c "SET statement_timeout = '0'; ALTER TABLE trader_snapshots_v2 VALIDATE CONSTRAINT $c;" 2>&1 | tail -1
done

# Step 3: Trigger compute-derived-metrics
echo ""
echo "--- Step 3: Trigger compute-derived-metrics ---"
curl -s --max-time 300 -H "Authorization: Bearer ${CRON_SECRET}" "https://www.arenafi.org/api/cron/compute-derived-metrics" | head -200
echo ""

# Step 4: Run backfill-all-metrics
echo ""
echo "--- Step 4: Backfill all metrics ---"
cd /Users/adelinewen/ranking-arena
npx tsx scripts/backfill-all-metrics.ts 2>&1 | tail -20

# Step 5: Trigger composite recomputation
echo ""
echo "--- Step 5: Recompute composite ---"
RECOMPUTE_CRON_SECRET=$CRON_SECRET npx tsx scripts/recompute-composite.ts 2>&1 | tail -5

echo ""
echo "=== Orchestration Complete ==="
echo "Finished: $(date)"
echo ""
echo "MANUAL TODO:"
echo "  1. Reduce cleanup-violations cron: */5 → '0 */6 * * *' in vercel.json"
echo "  2. Verify rankings look correct on https://www.arenafi.org/rankings"
