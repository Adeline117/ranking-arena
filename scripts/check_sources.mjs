import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(url, key)

// Get all unique sources
const { data } = await supabase
  .from('trader_snapshots')
  .select('source, arena_score, roi')

const stats = {}
data?.forEach(r => {
  if (!stats[r.source]) {
    stats[r.source] = { total: 0, withScore: 0, withRoi: 0 }
  }
  stats[r.source].total++
  if (r.arena_score && r.arena_score > 0) stats[r.source].withScore++
  if (r.roi !== null) stats[r.source].withRoi++
})

console.log('交易员来源完整统计:')
console.log('来源'.padEnd(20) + '总数'.padStart(8) + 'Arena Score'.padStart(14) + 'ROI'.padStart(10))
console.log('-'.repeat(52))
Object.entries(stats)
  .sort((a,b) => b[1].total - a[1].total)
  .forEach(([source, s]) => {
    console.log(source.padEnd(20) + String(s.total).padStart(8) + String(s.withScore).padStart(14) + String(s.withRoi).padStart(10))
  })
