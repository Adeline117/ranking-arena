import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: '.env.local' })

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

// Get a sample of bitfinex null rows
const { data } = await sb.from('leaderboard_ranks')
  .select('id, source_trader_id, season_id, win_rate, max_drawdown, roi, pnl, rank, computed_at')
  .eq('source', 'bitfinex')
  .is('max_drawdown', null)
  .order('computed_at', { ascending: false })
  .limit(10)

console.log('Sample bitfinex null MDD rows:')
for (const r of data || []) {
  console.log(`  id=${r.id} trader="${r.source_trader_id}" season=${r.season_id} rank=${r.rank} wr=${r.win_rate} mdd=${r.max_drawdown} roi=${r.roi} pnl=${r.pnl} computed_at=${r.computed_at}`)
}

// Also check what WR values we DO have for bitfinex
const { data: hasWR } = await sb.from('leaderboard_ranks')
  .select('win_rate, max_drawdown')
  .eq('source', 'bitfinex')
  .not('win_rate', 'is', null)
  .limit(5)

console.log('\nBitfinex rows WITH win_rate:', hasWR?.map(r => `wr=${r.win_rate} mdd=${r.max_drawdown}`))

// Check most recent computed_at
const { data: newest } = await sb.from('leaderboard_ranks')
  .select('computed_at')
  .eq('source', 'bitfinex')
  .order('computed_at', { ascending: false })
  .limit(1)

console.log('\nNewest computed_at:', newest?.[0]?.computed_at)
