import { createClient } from '@supabase/supabase-js';

const c = createClient(
  'https://iknktzifjdyujdccyhsv.supabase.co',
  'REDACTED_SUPABASE_JWT'
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
