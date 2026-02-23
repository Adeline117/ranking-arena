import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: '.env.local' })

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

// For each target source, check nulls with pagination
const targetSources = ['bingx', 'bingx_spot', 'bitfinex', 'binance_web3', 'bybit_spot', 'dydx']
for (const src of targetSources) {
  const { data: mdd } = await sb.from('leaderboard_ranks').select('id, source_trader_id, handle').eq('source', src).is('max_drawdown', null).limit(100)
  const { data: wr } = await sb.from('leaderboard_ranks').select('id, source_trader_id, handle').eq('source', src).is('win_rate', null).limit(100)
  console.log(`${src}: MDD_nulls=${mdd?.length} WR_nulls=${wr?.length}`)
  if (mdd?.length && mdd.length <= 5) console.log('  MDD null samples:', mdd.map(r => r.source_trader_id || r.handle))
  if (wr?.length && wr.length <= 5) console.log('  WR null samples:', wr.map(r => r.source_trader_id || r.handle))
}
