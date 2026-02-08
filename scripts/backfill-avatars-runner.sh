#!/bin/bash
# Run avatar backfill via the Vercel API endpoint
# Usage: ./scripts/backfill-avatars-runner.sh [platform] [limit]
#
# This calls the backfill-avatars endpoint on Vercel which runs from Japan,
# bypassing US geo-blocks on exchange APIs.
#
# Examples:
#   ./scripts/backfill-avatars-runner.sh binance_futures 200
#   ./scripts/backfill-avatars-runner.sh all 100

CRON_SECRET="arena-cron-secret-2025"
BASE_URL="https://ranking-arena.vercel.app"
PLATFORM="${1:-all}"
LIMIT="${2:-200}"

PLATFORMS=(
  "binance_futures"
  "binance_spot"
  "bybit"
  "bitget_futures"
  "bitget_spot"
  "mexc"
  "kucoin"
  "coinex"
  "xt"
  "weex"
  "lbank"
  "bingx"
  "phemex"
  "blofin"
  "htx_futures"
  "okx_futures"
)

run_platform() {
  local p=$1
  echo "🔄 Fetching avatars for $p (limit=$LIMIT)..."
  result=$(curl -s -w "\n%{http_code}" \
    -H "Authorization: Bearer $CRON_SECRET" \
    "$BASE_URL/api/cron/backfill-avatars?platform=$p&limit=$LIMIT")
  
  http_code=$(echo "$result" | tail -1)
  body=$(echo "$result" | head -n -1)
  
  if [ "$http_code" = "200" ]; then
    echo "  ✅ $p: $body"
  else
    echo "  ❌ $p: HTTP $http_code"
  fi
}

if [ "$PLATFORM" = "all" ]; then
  for p in "${PLATFORMS[@]}"; do
    run_platform "$p"
    sleep 2
  done
else
  run_platform "$PLATFORM"
fi

echo ""
echo "Done! Run again to continue backfilling more traders."
