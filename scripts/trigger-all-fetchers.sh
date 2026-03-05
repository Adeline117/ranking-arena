#!/bin/bash
# Trigger All Fetchers Script
# Manually triggers all batch-fetch-traders groups to populate data
#
# Usage:
#   ./scripts/trigger-all-fetchers.sh [BASE_URL] [CRON_SECRET]
#
# Examples:
#   # Local development
#   CRON_SECRET=your-secret ./scripts/trigger-all-fetchers.sh
#
#   # Production
#   BASE_URL=https://ranking-arena.vercel.app CRON_SECRET=your-secret ./scripts/trigger-all-fetchers.sh

set -e

BASE_URL="${1:-${BASE_URL:-http://localhost:3000}}"
CRON_SECRET="${2:-$CRON_SECRET}"

if [ -z "$CRON_SECRET" ]; then
  echo "Error: CRON_SECRET is required"
  echo "Usage: CRON_SECRET=your-secret ./scripts/trigger-all-fetchers.sh [BASE_URL]"
  exit 1
fi

echo "============================================"
echo "Trigger All Fetchers"
echo "Base URL: $BASE_URL"
echo "============================================"
echo ""

# Function to make authenticated API calls
api_call() {
  local endpoint="$1"
  local timeout="${2:-300}"
  curl -s -X GET "$BASE_URL$endpoint" \
    -H "Authorization: Bearer $CRON_SECRET" \
    -H "Content-Type: application/json" \
    --max-time "$timeout"
}

GROUPS=("a" "b" "c" "d" "e" "f")

for group in "${GROUPS[@]}"; do
  echo "============================================"
  echo "Triggering Group $group..."
  echo "============================================"

  result=$(api_call "/api/cron/batch-fetch-traders?group=$group" 300)

  ok=$(echo "$result" | jq -r '.ok // false' 2>/dev/null || echo "false")
  succeeded=$(echo "$result" | jq -r '.succeeded // 0' 2>/dev/null || echo "0")
  failed=$(echo "$result" | jq -r '.failed // 0' 2>/dev/null || echo "0")
  platforms=$(echo "$result" | jq -r '.platforms // 0' 2>/dev/null || echo "0")
  duration=$(echo "$result" | jq -r '.totalDurationMs // 0' 2>/dev/null || echo "0")

  echo "Group $group: $succeeded/$platforms succeeded, $failed failed (${duration}ms)"

  # Show any errors
  errors=$(echo "$result" | jq -r '.results[]? | select(.status == "error") | "\(.platform): \(.error)"' 2>/dev/null || true)
  if [ -n "$errors" ]; then
    echo "Errors:"
    echo "$errors"
  fi

  echo ""
  sleep 5
done

echo "============================================"
echo "All groups triggered!"
echo "============================================"

# Now trigger enrichment for all periods
echo ""
echo "============================================"
echo "Triggering Enrichment..."
echo "============================================"

for period in "90D" "30D" "7D"; do
  echo "Enriching $period..."
  result=$(api_call "/api/cron/batch-enrich?period=$period" 300)
  echo "$result" | jq -r '.summary // .' 2>/dev/null || echo "$result"
  echo ""
  sleep 5
done

echo "============================================"
echo "Complete! Run ./scripts/manual-data-backfill.sh to fill any remaining gaps"
echo "============================================"
