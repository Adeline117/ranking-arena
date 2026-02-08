#!/bin/bash
AUTH="Authorization: Bearer arena-cron-secret-2025"
BASE="http://localhost:3000/api/cron/fetch-traders"
LOG="/tmp/sequential-fetch.log"

fetch_platform() {
  local p=$1
  echo "--- $p $(date '+%H:%M:%S') ---" | tee -a $LOG
  local code=$(curl -s -o /tmp/fetch-$p.json -w "%{http_code}" --max-time 120 "$BASE/$p" -H "$AUTH" 2>&1)
  local size=$(wc -c < /tmp/fetch-$p.json 2>/dev/null || echo 0)
  echo "  [$code] ${size}b | $(head -c 200 /tmp/fetch-$p.json 2>/dev/null)" | tee -a $LOG
  sleep 3
}

echo "=== START $(date) ===" | tee $LOG

# All platforms
for p in okx_futures hyperliquid binance_spot okx_web3 bingx coinex kucoin bitget_spot binance_web3 htx weex phemex xt gmx gains jupiter_perps aevo dydx bybit_spot; do
  fetch_platform $p
done

echo "" | tee -a $LOG
echo "=== FETCH DETAILS $(date) ===" | tee -a $LOG
for i in 1 2 3 4 5; do
  echo "--- details batch $i $(date '+%H:%M:%S') ---" | tee -a $LOG
  code=$(curl -s -o /tmp/details-$i.json -w "%{http_code}" --max-time 300 "http://localhost:3000/api/cron/fetch-details?concurrency=30&limit=500&force=true" -H "$AUTH")
  echo "  [$code] $(head -c 200 /tmp/details-$i.json)" | tee -a $LOG
done

echo "" | tee -a $LOG
echo "=== ENRICH $(date) ===" | tee -a $LOG
for p in binance_futures bybit bitget_futures okx_futures hyperliquid binance_spot okx_web3 coinex kucoin bitget_spot xt gmx gains jupiter_perps aevo dydx bybit_spot; do
  echo "--- enrich $p $(date '+%H:%M:%S') ---" | tee -a $LOG
  code=$(curl -s -o /tmp/enrich-$p.json -w "%{http_code}" --max-time 300 "http://localhost:3000/api/cron/enrich?platform=$p&period=90D&limit=200" -H "$AUTH")
  echo "  [$code] $(head -c 200 /tmp/enrich-$p.json)" | tee -a $LOG
done

echo "" | tee -a $LOG
echo "=== OTHER CRONS $(date) ===" | tee -a $LOG
for c in calculate-tiers calculate-advanced-metrics aggregate-daily-snapshots fetch-market-data fetch-funding-rates fetch-open-interest; do
  echo "--- $c $(date '+%H:%M:%S') ---" | tee -a $LOG
  code=$(curl -s -o /tmp/cron-$c.json -w "%{http_code}" --max-time 120 "http://localhost:3000/api/cron/$c" -H "$AUTH")
  echo "  [$code] $(head -c 200 /tmp/cron-$c.json)" | tee -a $LOG
done

echo "" | tee -a $LOG
echo "=== ALL DONE $(date) ===" | tee -a $LOG
