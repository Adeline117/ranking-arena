import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const sources = [
  'binance_futures', 'binance_spot', 'binance_web3',
  'bybit', 'bitget_futures', 'bitget_spot',
  'mexc', 'coinex', 'okx_web3', 'kucoin', 'gmx'
]

console.log('\n📊 各来源最新 TOP 3 ROI (今天的数据):\n')

const today = new Date().toISOString().split('T')[0]

for (const source of sources) {
  const { data, error } = await supabase
    .from('trader_snapshots')
    .select('source_trader_id, roi, rank, captured_at')
    .eq('source', source)
    .eq('season_id', '7D')
    .gte('captured_at', today)
    .order('roi', { ascending: false })
    .limit(3)

  if (error || !data || data.length === 0) {
    console.log(`⚠️  ${source}: 今天无数据`)
    continue
  }

  const latestTime = data[0]?.captured_at
  const timeStr = new Date(latestTime).toLocaleTimeString('zh-CN')
  console.log(`✅ ${source} (${timeStr}):`)
  data.forEach((t, i) => {
    const id = t.source_trader_id?.length > 20 ? t.source_trader_id.slice(0, 17) + '...' : t.source_trader_id
    console.log(`   ${i + 1}. ${id}: ROI ${t.roi?.toFixed(2)}%`)
  })
  console.log()
}
