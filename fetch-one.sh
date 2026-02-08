#!/bin/bash
# Usage: bash fetch-one.sh PLATFORM
p=$1
AUTH="Authorization: Bearer arena-cron-secret-2025"
echo "Fetching $p..."
result=$(curl -s --max-time 180 "http://localhost:3000/api/cron/fetch-traders/$p" -H "$AUTH" 2>&1)
echo "$result" | python3 -c "
import sys,json
try:
  d=json.load(sys.stdin)
  print(f\"ok={d.get('ok')} dur={d.get('duration')}ms\")
  for k,v in d.get('periods',{}).items():
    print(f\"  {k}: total={v.get('total',0)} saved={v.get('saved',0)} err={v.get('error','none')[:80]}\")
except: print(sys.stdin.read()[:300])
"
