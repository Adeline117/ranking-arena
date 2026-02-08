#!/bin/bash
cd /Users/adelinewen/ranking-arena

run_with_timeout() {
  local timeout_sec=$1
  shift
  "$@" &
  local pid=$!
  (sleep "$timeout_sec" && kill "$pid" 2>/dev/null) &
  local watchdog=$!
  wait "$pid" 2>/dev/null
  local exit_code=$?
  kill "$watchdog" 2>/dev/null
  wait "$watchdog" 2>/dev/null
  return $exit_code
}

fetch_platform() {
  local p=$1
  local timeout=$2
  echo -n "  $p: "
  local tmpfile="/tmp/fetch-result-$p.json"
  run_with_timeout "$timeout" npx tsx scripts/fetch-worker.ts "$p" > "$tmpfile" 2>/dev/null
  local exit_code=$?
  if [ -s "$tmpfile" ]; then
    cat "$tmpfile"
  elif [ $exit_code -eq 143 ] || [ $exit_code -eq 137 ]; then
    echo "TIMEOUT (${timeout}s)"
  else
    echo "NO_OUTPUT (exit=$exit_code)"
  fi
  rm -f "$tmpfile"
}

echo "=== START $(date) ==="

FAST=(htx lbank blofin gmx gains jupiter_perps aevo synthetix kwenta mux vertex drift)
MEDIUM=(okx_web3 bitget_futures bitget_spot xt pionex bingx gateio mexc kucoin coinex phemex weex)
SLOW=(hyperliquid dydx okx_futures)

echo "--- FAST (90s) ---"
for p in "${FAST[@]}"; do fetch_platform "$p" 90; done

echo ""
echo "--- MEDIUM (120s) ---"
for p in "${MEDIUM[@]}"; do fetch_platform "$p" 120; done

echo ""
echo "--- SLOW (600s) ---"
for p in "${SLOW[@]}"; do fetch_platform "$p" 600; done

echo ""
echo "--- SKIPPED (geo-blocked) ---"
for p in binance_futures binance_spot binance_web3 bybit bybit_spot; do
  echo "  $p: SKIPPED"
done

echo ""
echo "=== DONE $(date) ==="
