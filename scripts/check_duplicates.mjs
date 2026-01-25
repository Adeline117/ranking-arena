import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// Check binance_web3 data
const { data, error } = await supabase
  .from('trader_snapshots')
  .select('source_trader_id, roi, captured_at')
  .eq('source', 'binance_web3')
  .eq('season_id', '7D')
  .order('captured_at', { ascending: false })
  .limit(20)

if (error) {
  console.error('Error:', error.message)
  process.exit(1)
}

console.log('Binance Web3 7D records:\n')
data.forEach((r, i) => {
  const time = new Date(r.captured_at).toLocaleString('zh-CN')
  console.log(`${i + 1}. ${r.source_trader_id}: ROI ${r.roi?.toFixed(2)}% (${time})`)
})
