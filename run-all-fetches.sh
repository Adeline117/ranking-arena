#!/bin/bash
# Run all fetch-traders crons sequentially
AUTH="Authorization: Bearer arena-cron-secret-2025"
BASE="http://localhost:3000/api/cron/fetch-traders"

PLATFORMS=(
  binance_futures bybit bitget_futures okx_futures hyperliquid
  binance_spot okx_web3 bingx coinex kucoin
  bitget_spot binance_web3 htx weex phemex
  xt gmx gains lbank blofin
  jupiter_perps aevo dydx bybit_spot
)

echo "=== FETCH TRADERS - Starting $(date) ==="
for p in "${PLATFORMS[@]}"; do
  echo "--- Fetching $p at $(date) ---"
  response=$(curl -s -w "\n%{http_code}" --max-time 300 "$BASE/$p" -H "$AUTH" 2>&1)
  http_code=$(echo "$response" | tail -1)
  body=$(echo "$response" | head -n -1)
  echo "  Status: $http_code"
  echo "  Response: $(echo "$body" | head -c 500)"
  echo ""
done

echo "=== FETCH DETAILS - Starting $(date) ==="
for i in 1 2 3 4 5; do
  echo "--- fetch-details batch $i at $(date) ---"
  curl -s --max-time 600 "http://localhost:3000/api/cron/fetch-details?concurrency=30&limit=500&force=true" -H "$AUTH" | head -c 500
  echo ""
done

echo "=== ENRICH - Starting $(date) ==="
ENRICH_PLATFORMS=(binance_futures bybit bitget_futures okx_futures hyperliquid binance_spot okx_web3 coinex kucoin bitget_spot xt gmx gains jupiter_perps aevo dydx bybit_spot)
for p in "${ENRICH_PLATFORMS[@]}"; do
  echo "--- Enriching $p at $(date) ---"
  curl -s --max-time 600 "http://localhost:3000/api/cron/enrich?platform=$p&period=90D&limit=200" -H "$AUTH" | head -c 500
  echo ""
done

echo "=== OTHER CRONS - Starting $(date) ==="
OTHER_CRONS=(
  "discover-traders"
  "discover-rankings"
  "calculate-tiers"
  "calculate-advanced-metrics"
  "aggregate-daily-snapshots"
  "fetch-market-data"
  "fetch-funding-rates"
  "fetch-open-interest"
)
for c in "${OTHER_CRONS[@]}"; do
  echo "--- Running $c at $(date) ---"
  curl -s --max-time 300 "http://localhost:3000/api/cron/$c" -H "$AUTH" | head -c 500
  echo ""
done

echo "=== ALL DONE $(date) ==="
