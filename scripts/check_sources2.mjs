import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(url, key)

// Check trader_scores table (separate from snapshots)
const { data: scores, error } = await supabase
  .from('trader_scores')
  .select('source')

if (scores && scores.length > 0) {
  const counts = {}
  scores.forEach(r => {
    counts[r.source] = (counts[r.source] || 0) + 1
  })
  console.log('trader_scores 表来源统计:')
  Object.entries(counts).sort((a,b) => b[1] - a[1]).forEach(([source, count]) => {
    console.log('  ' + source + ': ' + count + ' 条')
  })
} else {
  console.log('trader_scores 表无数据或出错:', error?.message)
}

// Check trader_sources table
const { data: sources } = await supabase
  .from('trader_sources')
  .select('source')

if (sources && sources.length > 0) {
  const counts = {}
  sources.forEach(r => {
    counts[r.source] = (counts[r.source] || 0) + 1
  })
  console.log('\ntrader_sources 表来源统计:')
  Object.entries(counts).sort((a,b) => b[1] - a[1]).forEach(([source, count]) => {
    console.log('  ' + source + ': ' + count + ' 条')
  })
}
