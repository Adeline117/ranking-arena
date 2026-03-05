#!/bin/bash
# Manual Data Backfill Script
# Checks data gaps and triggers backfill until no gaps remain
#
# Usage:
#   ./scripts/manual-data-backfill.sh [BASE_URL] [CRON_SECRET]
#
# Environment Variables:
#   BASE_URL - API base URL (default: http://localhost:3000)
#   CRON_SECRET - Authentication secret for cron endpoints
#
# Examples:
#   # Local development
#   CRON_SECRET=your-secret ./scripts/manual-data-backfill.sh
#
#   # Production
#   BASE_URL=https://ranking-arena.vercel.app CRON_SECRET=your-secret ./scripts/manual-data-backfill.sh

set -e

BASE_URL="${1:-${BASE_URL:-http://localhost:3000}}"
CRON_SECRET="${2:-$CRON_SECRET}"

if [ -z "$CRON_SECRET" ]; then
  echo "Error: CRON_SECRET is required"
  echo "Usage: CRON_SECRET=your-secret ./scripts/manual-data-backfill.sh [BASE_URL]"
  exit 1
fi

echo "============================================"
echo "Data Backfill Script"
echo "Base URL: $BASE_URL"
echo "============================================"
echo ""

# Function to make authenticated API calls
api_call() {
  local endpoint="$1"
  curl -s -X GET "$BASE_URL$endpoint" \
    -H "Authorization: Bearer $CRON_SECRET" \
    -H "Content-Type: application/json"
}

# Step 1: Check data gaps
echo "[1/3] Checking data gaps..."
echo ""
gaps_response=$(api_call "/api/cron/check-data-gaps")
echo "$gaps_response" | jq -r '.summary // .' 2>/dev/null || echo "$gaps_response"
echo ""

# Extract gap count
total_gaps=$(echo "$gaps_response" | jq -r '.summary.totalGaps // 0' 2>/dev/null || echo "0")
echo "Total gaps found: $total_gaps"
echo ""

if [ "$total_gaps" = "0" ]; then
  echo "No data gaps found. Exiting."
  exit 0
fi

# Step 2: Run backfill iterations
MAX_ITERATIONS=10
iteration=1

while [ "$iteration" -le "$MAX_ITERATIONS" ]; do
  echo "============================================"
  echo "[2/3] Backfill iteration $iteration/$MAX_ITERATIONS"
  echo "============================================"

  # Run snapshot backfill
  echo "Running snapshot backfill..."
  snapshot_result=$(api_call "/api/cron/backfill-data?type=snapshots&limit=200")
  snapshot_success=$(echo "$snapshot_result" | jq -r '.summary.success // 0' 2>/dev/null || echo "0")
  snapshot_gaps=$(echo "$snapshot_result" | jq -r '.gapsFound // 0' 2>/dev/null || echo "0")
  echo "Snapshots: $snapshot_success saved, $snapshot_gaps gaps remaining"

  sleep 2

  # Run enrichment backfill
  echo "Running enrichment backfill..."
  enrich_result=$(api_call "/api/cron/backfill-data?type=enrichment&limit=150")
  enrich_success=$(echo "$enrich_result" | jq -r '.summary.success // 0' 2>/dev/null || echo "0")
  enrich_gaps=$(echo "$enrich_result" | jq -r '.gapsFound // 0' 2>/dev/null || echo "0")
  echo "Enrichment: $enrich_success saved, $enrich_gaps gaps remaining"

  # Check if more gaps exist
  has_more_snapshot=$(echo "$snapshot_result" | jq -r '.hasMoreGaps // false' 2>/dev/null || echo "false")
  has_more_enrich=$(echo "$enrich_result" | jq -r '.hasMoreGaps // false' 2>/dev/null || echo "false")

  if [ "$has_more_snapshot" = "false" ] && [ "$has_more_enrich" = "false" ]; then
    echo ""
    echo "All gaps filled!"
    break
  fi

  echo ""
  iteration=$((iteration + 1))
  sleep 5
done

# Step 3: Final gap check
echo "============================================"
echo "[3/3] Final gap check..."
echo "============================================"
final_gaps=$(api_call "/api/cron/check-data-gaps")
echo "$final_gaps" | jq -r '.summary // .' 2>/dev/null || echo "$final_gaps"

echo ""
echo "============================================"
echo "Backfill complete!"
echo "============================================"
