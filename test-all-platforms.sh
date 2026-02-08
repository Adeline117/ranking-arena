#!/bin/bash
AUTH="Authorization: Bearer arena-cron-secret-2025"
BASE="http://localhost:3000/api/cron/fetch-traders"

ALL=(
  binance_futures bybit bitget_futures okx_futures hyperliquid
  binance_spot okx_web3 bingx coinex kucoin
  bitget_spot binance_web3 htx weex phemex
  xt gmx gains lbank blofin
  jupiter_perps aevo dydx bybit_spot
)

for p in "${ALL[@]}"; do
  echo -n "$p: "
  result=$(curl -s --max-time 120 "$BASE/$p" -H "$AUTH" 2>&1)
  ok=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('ok','?'))" 2>/dev/null)
  dur=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('duration','?'))" 2>/dev/null)
  # Check for errors
  err=$(echo "$result" | python3 -c "
import sys,json
d=json.load(sys.stdin)
errs=[]
for k,v in d.get('periods',{}).items():
  if v.get('error'): errs.append(v['error'][:60])
print('; '.join(set(errs)) if errs else 'none')
" 2>/dev/null)
  saved=$(echo "$result" | python3 -c "
import sys,json
d=json.load(sys.stdin)
t=sum(v.get('saved',0) for v in d.get('periods',{}).values())
print(t)
" 2>/dev/null)
  echo "ok=$ok saved=$saved dur=${dur}ms err=$err"
done
