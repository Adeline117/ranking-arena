import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: '.env.local' })
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

const { data } = await sb.from('leaderboard_ranks')
  .select('id, source_trader_id, season_id, win_rate, max_drawdown')
  .eq('source', 'bingx')
  .is('max_drawdown', null)
  .limit(5)

console.log('bingx MDD null samples:')
for (const r of data || []) {
  console.log(`  id=${r.id} trader="${r.source_trader_id}" season=${r.season_id} wr=${r.win_rate}`)
}
