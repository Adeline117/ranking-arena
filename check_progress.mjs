import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: '.env.local' })
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

const sources = ['bingx', 'bingx_spot', 'bitfinex', 'binance_web3', 'bybit_spot', 'dydx']
for (const src of sources) {
  const { data: mdd } = await sb.from('leaderboard_ranks').select('id').eq('source', src).is('max_drawdown', null).limit(500)
  const { data: wr } = await sb.from('leaderboard_ranks').select('id').eq('source', src).is('win_rate', null).limit(500)
  console.log(`${src}: MDD=${mdd?.length} WR=${wr?.length}`)
}
