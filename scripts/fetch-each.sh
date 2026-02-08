#!/bin/bash
cd /Users/adelinewen/ranking-arena

PLATFORMS=(xt bitget_futures bitget_spot okx_web3 gmx gains jupiter_perps hyperliquid dydx okx_futures)

echo "=== FETCH EACH PLATFORM $(date) ==="

for p in "${PLATFORMS[@]}"; do
  echo -n "  $p: "
  
  # Run in background, capture output
  npx tsx -e "
import 'dotenv/config'
import { getInlineFetcher } from './lib/cron/fetchers'
import { createSupabaseAdmin } from './lib/cron/utils'
setTimeout(() => { console.log('TIMEOUT'); process.exit(1) }, 180000)
const supabase = createSupabaseAdmin()
const fetcher = getInlineFetcher('$p')
if (!fetcher || !supabase) { console.log('NO_FETCHER'); process.exit(0) }
const start = Date.now()
fetcher(supabase, ['7D','30D','90D']).then(r => {
  const dur = Math.round((Date.now()-start)/1000)
  const saved = Object.values(r.periods).reduce((s,v) => s + (v.saved||0), 0)
  const total = Object.values(r.periods).reduce((s,v) => s + (v.total||0), 0)
  console.log(JSON.stringify({p:'$p',total,saved,dur}))
  process.exit(0)
}).catch(e => {
  console.log(JSON.stringify({p:'$p',err:e.message,dur:Math.round((Date.now()-start)/1000)}))
  process.exit(1)
})
" 2>/dev/null &
  
  pid=$!
  
  # Wait up to 3 min
  count=0
  while kill -0 $pid 2>/dev/null && [ $count -lt 180 ]; do
    sleep 1
    count=$((count + 1))
  done
  
  # Kill if still running
  if kill -0 $pid 2>/dev/null; then
    kill -9 $pid 2>/dev/null
    wait $pid 2>/dev/null
    echo "KILLED after ${count}s"
  else
    wait $pid 2>/dev/null
    # Output should have been printed by the subprocess
  fi
  
  echo ""
done

echo "=== DONE $(date) ==="
