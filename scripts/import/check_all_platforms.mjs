import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// Get latest snapshot for each source
const { data, error } = await supabase.from('trader_snapshots')
  .select('source, win_rate, max_drawdown, captured_at')
  .eq('season_id', '30D')
  .order('captured_at', { ascending: false })

if (error) {
  console.error('Error:', error.message)
  process.exit(1)
}

// Group by source and get stats
const bySource = {}
for (const row of data) {
  if (!bySource[row.source]) {
    bySource[row.source] = {
      total: 0,
      withWinRate: 0,
      withMDD: 0,
      latestCapture: row.captured_at
    }
  }
  bySource[row.source].total++
  if (row.win_rate !== null && row.win_rate !== 0) {
    bySource[row.source].withWinRate++
  }
  if (row.max_drawdown !== null && row.max_drawdown > 0) {
    bySource[row.source].withMDD++
  }
}

console.log('\n📊 Data Completeness by Platform (30D):')
console.log('='.repeat(80))
console.log('Platform'.padEnd(20) + 'Total'.padStart(8) + 'WinRate'.padStart(12) + 'MDD'.padStart(12) + 'Last Update')
console.log('='.repeat(80))

const sorted = Object.entries(bySource).sort((a, b) => b[1].total - a[1].total)

for (const [source, stats] of sorted) {
  const wrPct = stats.total > 0 ? ((stats.withWinRate / stats.total) * 100).toFixed(0) : '0'
  const mddPct = stats.total > 0 ? ((stats.withMDD / stats.total) * 100).toFixed(0) : '0'
  const wr = `${stats.withWinRate}/${stats.total} (${wrPct}%)`
  const mdd = `${stats.withMDD}/${stats.total} (${mddPct}%)`
  const time = stats.latestCapture ? stats.latestCapture.slice(11, 19) : 'N/A'

  // Highlight platforms with low coverage
  const wrFlag = parseInt(wrPct) < 50 ? ' ⚠' : ' ✓'
  const mddFlag = parseInt(mddPct) < 50 ? ' ⚠' : ' ✓'

  console.log(source.padEnd(20) + String(stats.total).padStart(8) + wr.padStart(18) + wrFlag + mdd.padStart(18) + mddFlag + '  ' + time)
}

console.log('='.repeat(80))

// Summary
const totalRecords = Object.values(bySource).reduce((a, b) => a + b.total, 0)
const totalWR = Object.values(bySource).reduce((a, b) => a + b.withWinRate, 0)
const totalMDD = Object.values(bySource).reduce((a, b) => a + b.withMDD, 0)

console.log(`\nTotal: ${totalRecords} records`)
console.log(`Win Rate coverage: ${totalWR}/${totalRecords} (${((totalWR/totalRecords)*100).toFixed(0)}%)`)
console.log(`MDD coverage: ${totalMDD}/${totalRecords} (${((totalMDD/totalRecords)*100).toFixed(0)}%)`)

// List platforms needing attention
console.log('\n⚠ Platforms needing attention:')
for (const [source, stats] of sorted) {
  const wrPct = stats.total > 0 ? (stats.withWinRate / stats.total) * 100 : 0
  const mddPct = stats.total > 0 ? (stats.withMDD / stats.total) * 100 : 0

  if (wrPct < 50 || mddPct < 50) {
    const issues = []
    if (wrPct < 50) issues.push(`WR ${wrPct.toFixed(0)}%`)
    if (mddPct < 50) issues.push(`MDD ${mddPct.toFixed(0)}%`)
    console.log(`  - ${source}: ${issues.join(', ')}`)
  }
}
