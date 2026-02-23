import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: '.env.local' })
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

// Check 7D bitfinex rows
const { data } = await sb.from('leaderboard_ranks')
  .select('id, source_trader_id, win_rate, max_drawdown')
  .eq('source', 'bitfinex')
  .eq('season_id', '7D')
  .or('win_rate.is.null,max_drawdown.is.null')
  .limit(5)

console.log('7D bitfinex sample (null WR or MDD):')
for (const r of data || []) {
  console.log(`  "${r.source_trader_id}" wr=${r.win_rate} mdd=${r.max_drawdown}`)
}

// Check if 7D rows have WR
const { data: withWR } = await sb.from('leaderboard_ranks')
  .select('id, source_trader_id, win_rate, max_drawdown')
  .eq('source', 'bitfinex')
  .eq('season_id', '7D')
  .not('win_rate', 'is', null)
  .is('max_drawdown', null)
  .limit(5)

console.log('\n7D bitfinex rows WITH wr but null mdd:')
for (const r of withWR || []) {
  console.log(`  "${r.source_trader_id}" wr=${r.win_rate} mdd=${r.max_drawdown}`)
}

// Count 7D bitfinex WR nulls, MDD nulls
const { data: allD7 } = await sb.from('leaderboard_ranks')
  .select('win_rate, max_drawdown')
  .eq('source', 'bitfinex').eq('season_id', '7D').limit(1000)

let wrNull = 0, mddNull = 0
for (const r of allD7 || []) {
  if (r.win_rate == null) wrNull++
  if (r.max_drawdown == null) mddNull++
}
console.log(`\n7D total: ${allD7?.length} rows, WR null: ${wrNull}, MDD null: ${mddNull}`)
