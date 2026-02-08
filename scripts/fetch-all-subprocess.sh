#!/bin/bash
cd /Users/adelinewen/ranking-arena

# Platforms that work from US
FAST_PLATFORMS=(htx htx_futures lbank blofin gmx gains jupiter_perps aevo synthetix kwenta mux vertex drift)
MEDIUM_PLATFORMS=(okx_web3 bitget_futures bitget_spot xt pionex bingx gateio mexc kucoin coinex phemex weex)
SLOW_PLATFORMS=(hyperliquid dydx okx_futures)
GEO_BLOCKED=(binance_futures binance_spot binance_web3 bybit bybit_spot)

echo "=== FAST PLATFORMS (90s timeout) ==="
for p in "${FAST_PLATFORMS[@]}"; do
  echo -n "  $p: "
  result=$(timeout 90 npx tsx scripts/fetch-worker.ts "$p" 2>/dev/null)
  exit_code=$?
  if [ $exit_code -eq 124 ]; then
    echo "TIMEOUT"
  elif [ -z "$result" ]; then
    echo "NO_OUTPUT (exit=$exit_code)"
  else
    echo "$result"
  fi
done

echo ""
echo "=== MEDIUM PLATFORMS (120s timeout) ==="
for p in "${MEDIUM_PLATFORMS[@]}"; do
  echo -n "  $p: "
  result=$(timeout 120 npx tsx scripts/fetch-worker.ts "$p" 2>/dev/null)
  exit_code=$?
  if [ $exit_code -eq 124 ]; then
    echo "TIMEOUT"
  elif [ -z "$result" ]; then
    echo "NO_OUTPUT (exit=$exit_code)"
  else
    echo "$result"
  fi
done

echo ""
echo "=== SLOW PLATFORMS (600s timeout) ==="
for p in "${SLOW_PLATFORMS[@]}"; do
  echo -n "  $p: "
  result=$(timeout 600 npx tsx scripts/fetch-worker.ts "$p" 2>/dev/null)
  exit_code=$?
  if [ $exit_code -eq 124 ]; then
    echo "TIMEOUT"
  elif [ -z "$result" ]; then
    echo "NO_OUTPUT (exit=$exit_code)"
  else
    echo "$result"
  fi
done

echo ""
echo "=== GEO-BLOCKED (skipped) ==="
for p in "${GEO_BLOCKED[@]}"; do
  echo "  $p: SKIPPED (geo-blocked from US)"
done

echo ""
echo "=== DONE $(date) ==="
