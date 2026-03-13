#!/bin/bash
# Test script to verify NO_ENRICHMENT_PLATFORMS early return fix

set -e

API_BASE="${API_BASE:-https://ranking.arena.adeline.quest}"
CRON_SECRET="${CRON_SECRET:-}"

if [ -z "$CRON_SECRET" ]; then
  echo "❌ CRON_SECRET not set"
  echo "Usage: CRON_SECRET=xxx ./test-enrich-fix.sh"
  exit 1
fi

echo "🧪 Testing NO_ENRICHMENT_PLATFORMS early return fix"
echo "API Base: $API_BASE"
echo ""

PLATFORMS=("binance_web3" "bingx" "bybit" "bybit_spot" "etoro")

for platform in "${PLATFORMS[@]}"; do
  echo "Testing: $platform"
  response=$(curl -s -w "\n%{http_code}" \
    -H "Authorization: Bearer $CRON_SECRET" \
    "$API_BASE/api/cron/enrich?platform=$platform&period=90D&limit=1")
  
  http_code=$(echo "$response" | tail -1)
  body=$(echo "$response" | head -n -1)
  
  if [ "$http_code" = "200" ]; then
    ok=$(echo "$body" | jq -r '.ok')
    reason=$(echo "$body" | jq -r '.reason // "N/A"')
    
    if [ "$ok" = "true" ] && [ "$reason" = "platform does not support enrichment" ]; then
      echo "  ✅ HTTP 200, ok=true, reason='platform does not support enrichment'"
    else
      echo "  ⚠️  HTTP 200, but ok=$ok, reason=$reason"
    fi
  else
    echo "  ❌ HTTP $http_code"
    echo "  Response: $body" | head -c 200
  fi
  echo ""
done

echo "✅ Test complete!"
