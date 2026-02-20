import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: '.env.local' })

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

for (const src of ['bingx', 'bingx_spot', 'bitfinex', 'binance_web3', 'bybit_spot', 'dydx']) {
  // Get MDD nulls grouped by season_id
  const { data: mddRows } = await sb.from('leaderboard_ranks')
    .select('season_id, source_trader_id')
    .eq('source', src).is('max_drawdown', null).limit(200)
  
  const seasonCounts = {}
  for (const r of mddRows || []) {
    seasonCounts[r.season_id] = (seasonCounts[r.season_id] || 0) + 1
  }
  
  const { data: wrRows } = await sb.from('leaderboard_ranks')
    .select('season_id')
    .eq('source', src).is('win_rate', null).limit(200)
  
  const wrSeasonCounts = {}
  for (const r of wrRows || []) {
    wrSeasonCounts[r.season_id] = (wrSeasonCounts[r.season_id] || 0) + 1
  }

  console.log(`\n${src}:`)
  console.log('  MDD null by season:', JSON.stringify(seasonCounts))
  console.log('  WR null by season:', JSON.stringify(wrSeasonCounts))
}
