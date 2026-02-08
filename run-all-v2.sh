#!/bin/bash
AUTH="Authorization: Bearer arena-cron-secret-2025"
BASE="http://localhost:3000/api/cron/fetch-traders"
RESULTS="/tmp/fetch-results"
mkdir -p "$RESULTS"

PLATFORMS=(
  okx_futures hyperliquid binance_spot okx_web3 bingx coinex
  kucoin bitget_spot binance_web3 htx weex phemex
  xt gmx gains jupiter_perps aevo dydx bybit_spot
  lbank blofin binance_futures bybit bitget_futures
)

echo "=== START $(date) ==="
for p in "${PLATFORMS[@]}"; do
  echo -n "[$p] "
  http_code=$(curl -s -o "$RESULTS/$p.json" -w "%{http_code}" --max-time 300 "$BASE/$p" -H "$AUTH" 2>/dev/null)
  size=$(wc -c < "$RESULTS/$p.json" 2>/dev/null | tr -d ' ')
  echo "HTTP $http_code, ${size}b at $(date '+%H:%M:%S')"
  sleep 2
done

echo ""
echo "=== SUMMARY ==="
for f in "$RESULTS"/*.json; do
  p=$(basename "$f" .json)
  python3 -c "
import json,sys
try:
  d=json.load(open('$f'))
  ok=d.get('ok')
  dur=d.get('duration',0)
  saved=sum(v.get('saved',0) for v in d.get('periods',{}).values())
  total=sum(v.get('total',0) for v in d.get('periods',{}).values())
  errs=set(v.get('error','')[:50] for v in d.get('periods',{}).values() if v.get('error'))
  err='; '.join(errs) if errs else 'none'
  print(f'$p: ok={ok} total={total} saved={saved} dur={dur}ms err={err}')
except Exception as e:
  print(f'$p: parse_error={e}')
" 2>&1
done

echo ""
echo "=== FETCH DETAILS ==="
for i in 1 2 3; do
  echo -n "  batch$i: "
  http_code=$(curl -s -o "$RESULTS/details-$i.json" -w "%{http_code}" --max-time 600 "http://localhost:3000/api/cron/fetch-details?concurrency=20&limit=300&force=true" -H "$AUTH" 2>/dev/null)
  echo "HTTP $http_code at $(date '+%H:%M:%S')"
done

echo ""
echo "=== ENRICH ==="
for p in binance_futures bybit bitget_futures okx_futures hyperliquid binance_spot okx_web3 coinex kucoin bitget_spot xt gmx gains jupiter_perps aevo dydx bybit_spot; do
  echo -n "  enrich $p: "
  http_code=$(curl -s -o "$RESULTS/enrich-$p.json" -w "%{http_code}" --max-time 600 "http://localhost:3000/api/cron/enrich?platform=$p&period=90D&limit=200" -H "$AUTH" 2>/dev/null)
  echo "HTTP $http_code at $(date '+%H:%M:%S')"
done

echo ""
echo "=== OTHER CRONS ==="
for c in calculate-tiers calculate-advanced-metrics aggregate-daily-snapshots fetch-market-data; do
  echo -n "  $c: "
  http_code=$(curl -s -o "$RESULTS/cron-$c.json" -w "%{http_code}" --max-time 300 "http://localhost:3000/api/cron/$c" -H "$AUTH" 2>/dev/null)
  echo "HTTP $http_code at $(date '+%H:%M:%S')"
done

echo ""
echo "=== ALL DONE $(date) ==="
