import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(url, key)

// Check specific sources
const sources = ['weex', 'htx_futures', 'htx', 'mexc', 'binance_web3']

for (const source of sources) {
  const { data, error } = await supabase
    .from('trader_snapshots')
    .select('source_trader_id, roi, arena_score, season_id')
    .eq('source', source)
    .order('arena_score', { ascending: false })
    .limit(5)

  const count = data ? data.length : 0
  console.log('\n' + source + ': ' + count + ' 条数据')
  if (data && data.length > 0) {
    data.forEach((t, i) => {
      console.log('  ' + (i+1) + '. ' + t.season_id + ': ROI ' + t.roi + '%, Score ' + t.arena_score)
    })
  }
  if (error) console.log('  Error: ' + error.message)
}

// Get full count
const { data: all } = await supabase
  .from('trader_snapshots')
  .select('source')

const counts = {}
if (all) {
  all.forEach(r => {
    counts[r.source] = (counts[r.source] || 0) + 1
  })
}

console.log('\n\n=== 所有来源统计 ===')
Object.entries(counts)
  .sort((a,b) => b[1] - a[1])
  .forEach(([source, count]) => {
    console.log(source + ': ' + count + ' 条')
  })
