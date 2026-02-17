import { createClient } from '@supabase/supabase-js';

const c = createClient(
  'https://iknktzifjdyujdccyhsv.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE'
);

const sources = [
  'binance_futures','binance_spot','bitget_futures','bitget_spot','bingx',
  'bybit','bybit_spot','kucoin','okx','okx_web3','mexc','htx','gateio',
  'phemex','lbank','weex','toobit','btcc','blofin','dydx','hyperliquid',
  'gmx','gains','jupiter_perps','aevo','xt','bitfinex','binance_web3'
];

for (const src of sources) {
  try {
    const {count: total} = await c.from('leaderboard_ranks').select('*', {count:'exact', head:true}).eq('source', src);
    if (!total) { console.log(`${src}: 0 rows`); continue; }
    
    const {count: wrNull} = await c.from('leaderboard_ranks').select('*', {count:'exact', head:true}).eq('source', src).is('win_rate', null);
    const {count: ddNull} = await c.from('leaderboard_ranks').select('*', {count:'exact', head:true}).eq('source', src).is('max_drawdown', null);
    
    console.log(`${src}: total=${total} wr_null=${wrNull} dd_null=${ddNull}`);
  } catch(e) {
    console.log(`${src}: ERROR ${e.message}`);
  }
}
process.exit(0);
