#!/bin/bash
AUTH="Authorization: Bearer arena-cron-secret-2025"
BASE="http://localhost:3000/api/cron/fetch-traders"

# Platforms that failed in first run
PLATFORMS=(
  okx_futures hyperliquid binance_spot okx_web3 bingx coinex
  kucoin bitget_spot binance_web3 htx weex phemex
  xt gmx gains jupiter_perps aevo dydx bybit_spot
)

echo "=== RETRY FETCH TRADERS $(date) ==="
for p in "${PLATFORMS[@]}"; do
  echo "--- $p $(date) ---"
  code=$(curl -s -o /tmp/fetch-$p.json -w "%{http_code}" --max-time 300 "$BASE/$p" -H "$AUTH" 2>&1)
  echo "  Status: $code | $(cat /tmp/fetch-$p.json | head -c 300)"
  echo ""
  sleep 2
done

echo "=== FETCH DETAILS $(date) ==="
for i in 1 2 3 4 5; do
  echo "--- batch $i $(date) ---"
  code=$(curl -s -o /tmp/fetch-details-$i.json -w "%{http_code}" --max-time 600 "http://localhost:3000/api/cron/fetch-details?concurrency=30&limit=500&force=true" -H "$AUTH")
  echo "  Status: $code | $(cat /tmp/fetch-details-$i.json | head -c 300)"
  echo ""
done

echo "=== ENRICH $(date) ==="
ENRICH_PLATFORMS=(binance_futures bybit bitget_futures okx_futures hyperliquid binance_spot okx_web3 coinex kucoin bitget_spot xt gmx gains jupiter_perps aevo dydx bybit_spot)
for p in "${ENRICH_PLATFORMS[@]}"; do
  echo "--- enrich $p $(date) ---"
  code=$(curl -s -o /tmp/enrich-$p.json -w "%{http_code}" --max-time 600 "http://localhost:3000/api/cron/enrich?platform=$p&period=90D&limit=200" -H "$AUTH")
  echo "  Status: $code | $(cat /tmp/enrich-$p.json | head -c 300)"
  echo ""
done

echo "=== OTHER CRONS $(date) ==="
for c in calculate-tiers calculate-advanced-metrics aggregate-daily-snapshots fetch-market-data fetch-funding-rates fetch-open-interest; do
  echo "--- $c $(date) ---"
  code=$(curl -s -o /tmp/cron-$c.json -w "%{http_code}" --max-time 300 "http://localhost:3000/api/cron/$c" -H "$AUTH")
  echo "  Status: $code | $(cat /tmp/cron-$c.json | head -c 300)"
  echo ""
done

echo "=== ALL DONE $(date) ==="
