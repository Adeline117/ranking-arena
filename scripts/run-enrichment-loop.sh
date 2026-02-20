#!/bin/bash
# Loop: run enrichment in 50-trader batches until nulls are gone
cd /Users/adelinewen/ranking-arena

for i in {1..20}; do
  echo ""
  echo "=== Batch $i ==="
  
  # Check remaining nulls
  NULL_WR=$(node -e "
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
sb.from('trader_snapshots').select('*',{count:'exact',head:true}).eq('source','bitget_futures').is('win_rate',null).then(r=>process.stdout.write(String(r.count)));
" 2>/dev/null)
  echo "NULL win_rate: $NULL_WR"
  
  if [ "$NULL_WR" = "0" ] || [ -z "$NULL_WR" ]; then
    echo "All done! No more NULL win_rates."
    break
  fi

  # Run enrichment for 50 traders
  node scripts/enrich-bitget-futures-wr-mdd.mjs --limit=50 2>&1
  EXIT_CODE=$?
  
  # Kill any leftover Chrome processes
  pkill -f "chrome-headless-shell" 2>/dev/null || true
  
  echo "Exit code: $EXIT_CODE"
  
  if [ $EXIT_CODE -ne 0 ] && [ $EXIT_CODE -ne 1 ]; then
    echo "Fatal error, stopping"
    break
  fi
  
  # Wait between batches
  sleep 5
done

echo ""
echo "=== Final null counts ==="
node -e "
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
async function main() {
  const { count: nullWR } = await sb.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', 'bitget_futures').is('win_rate', null);
  const { count: nullMDD } = await sb.from('trader_snapshots').select('*', { count: 'exact', head: true }).eq('source', 'bitget_futures').is('max_drawdown', null);
  console.log('Final NULL win_rate:', nullWR, '| NULL max_drawdown:', nullMDD);
}
main().catch(console.error);
" 2>/dev/null
